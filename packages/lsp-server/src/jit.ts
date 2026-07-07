/**
 * JitService -- single-node just-in-time channels via linked hold/leg hashes.
 *
 * The LSP node holds the customer payment under hold_hash, opens a channel to the merchant, pays the
 * merchant leg under leg_hash, then derives the hold preimage from the settled leg preimage.
 */
import { randomBytes } from "node:crypto";
import {
  type AssetOffering,
  type CreateJitOrderRequest,
  type JitOrder,
  type JitTerms,
  type LinkageVerifier,
  FiberChannelRpcClient,
  asBig,
  assetEquals,
  assetUdtScript,
  canonicalAssetId,
  deriveHoldPreimageFromLeg,
  fraudEvidenceDualSha256,
  isChannelReady,
  jitFee,
  jitForwardAmount,
  verifyDualSha256Linkage,
} from "@fiberlsp/protocol";
import { channelAsset } from "./lsp.js";
import { MemoryJitStore, type JitOrderRecord, type JitStore } from "./jitStore.js";
import { makeKeyedLock, type KeyedLock } from "./keyedLock.js";

export class JitError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "JitError";
  }
}

export interface JitServiceConfig {
  /** Single LSP node: issues/settles the hold, opens the channel, and pays the merchant leg. */
  rpc: FiberChannelRpcClient;
  terms: JitTerms;
  supportedAssets: AssetOffering[];
  linkageVerifier: LinkageVerifier;
  /** Channel capacity as a multiple of gross payment when merchant does not request one. */
  capacityMultiplier?: number;
  /** Optional floor above the offering min_capacity. */
  minCapacity?: string;
  store?: JitStore;
  now?: () => number;
  idgen?: () => string;
  tokenGenerator?: () => string;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  readyPollAttempts?: number;
  deliverWebhook?: (url: string, order: JitOrder) => Promise<void>;
  onFraud?: (evidence: { a: string; b: string; preimage: string }, order: JitOrder) => void;
}

async function defaultDeliverWebhook(url: string, order: JitOrder): Promise<void> {
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "jit.updated", order }),
  });
}

export class JitService {
  private readonly cfg: Required<
    Pick<
      JitServiceConfig,
      | "capacityMultiplier"
      | "store"
      | "now"
      | "idgen"
      | "tokenGenerator"
      | "sleep"
      | "pollIntervalMs"
      | "readyPollAttempts"
    >
  > &
    JitServiceConfig;
  private readonly openLock: KeyedLock = makeKeyedLock();

  constructor(config: JitServiceConfig) {
    this.cfg = {
      capacityMultiplier: 2,
      store: config.store ?? new MemoryJitStore(),
      now: () => Math.floor(Date.now() / 1000),
      idgen: () => (globalThis.crypto?.randomUUID?.() ?? `jit_${Date.now()}_${Math.random()}`),
      tokenGenerator: () => randomBytes(32).toString("hex"),
      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      pollIntervalMs: 2000,
      readyPollAttempts: 150,
      ...config,
    };
  }

  get terms(): JitTerms {
    return this.cfg.terms;
  }

  getOrder(id: string, token?: string): JitOrder | undefined {
    const rec = this.cfg.store.get(id);
    if (!rec) return undefined;
    this.authorize(rec, token);
    return toWire(rec);
  }

  async createOrder(req: CreateJitOrderRequest): Promise<JitOrder> {
    const offering = this.offeringFor(req);
    const gross = asBig(req.amount);
    if (gross < asBig(this.cfg.terms.min_payment)) {
      throw new JitError("amount_too_small", `amount below min_payment ${this.cfg.terms.min_payment}`);
    }
    await this.verifyLinkage(req);
    this.assertNoDuplicate(req);

    const forward = jitForwardAmount(this.cfg.terms, gross);
    const fee = jitFee(this.cfg.terms, gross);
    const parsed = await this.cfg.rpc.parseInvoice(req.merchant_invoice);
    if (parsed.invoice?.data?.payment_hash !== req.leg_hash) {
      throw new JitError("hash_mismatch", "merchant_invoice payment_hash != leg_hash");
    }
    if (parsed.invoice?.amount === undefined || asBig(parsed.invoice.amount) !== forward) {
      throw new JitError("amount_mismatch", `merchant_invoice must be for the net forward amount ${forward}`);
    }

    const capacity = this.channelCapacity(req, gross, forward, offering);
    const expirySeconds = Math.max(1, Math.min(req.expiry_seconds ?? 600, this.cfg.terms.max_expiry_seconds));

    const hold = await this.cfg.rpc.newInvoice({
      amount: gross,
      description: "JIT channel order (hold)",
      udtTypeScript: assetUdtScript(offering.asset),
      expirySeconds,
      paymentHash: req.hold_hash,
      hashAlgorithm: "sha256",
    });

    const { linkage_proof: _proof, ...wireReq } = req;
    const now = this.cfg.now();
    const rec: JitOrderRecord = {
      jit_order_id: this.cfg.idgen(),
      state: "created",
      request: {
        ...wireReq,
        asset: offering.asset,
        amount: gross.toString(10),
        channel_capacity: capacity.toString(10),
        expiry_seconds: expirySeconds,
      },
      hold_invoice: hold.invoice_address,
      forward_amount: forward.toString(10),
      fee: fee.toString(10),
      expires_at: now + expirySeconds,
      created_at: now,
      order_token: this.cfg.tokenGenerator(),
    };
    this.cfg.store.put(rec);
    return toWire(rec, true);
  }

  async run(id: string): Promise<JitOrder> {
    let rec = this.require(id);
    try {
      if (rec.state === "created") {
        const held = await this.waitForHold(rec);
        if (!held) return toWire(this.require(id));
        rec = this.update(id, { state: "payment_held" });
      }

      if (rec.state === "payment_held" || rec.state === "opening") {
        rec = this.update(id, { state: "opening" });
        const outpoint = await this.openLock.run(rec.request.target_pubkey, () => this.openAndAwait(id));
        if (!outpoint) return toWire(await this.refund(id, "channel did not reach ChannelReady in time"));
        rec = this.update(id, { state: "forwarding", channel_outpoint: outpoint });
      }

      if (rec.state === "forwarding") {
        const paid = await this.forward(id);
        if (!paid) return toWire(await this.refund(id, "forward to merchant failed"));
        return toWire(await this.trySettle(id));
      }

      return toWire(rec);
    } catch (e) {
      return toWire(await this.refund(id, e instanceof Error ? e.message : String(e)));
    }
  }

  async reveal(id: string, preimage: string, token?: string): Promise<JitOrder> {
    const rec = this.require(id);
    this.authorize(rec, token);
    if (rec.state === "settled" || rec.state === "refunded" || rec.state === "expired") return toWire(rec);
    if (!this.holdPreimageForSettle(rec, preimage)) {
      throw new JitError("bad_preimage", "preimage does not satisfy this JIT order's linked leg hash");
    }
    this.cfg.store.put({ ...rec, preimage });
    return toWire(await this.trySettle(id));
  }

  async cancel(id: string, token?: string): Promise<JitOrder> {
    const rec = this.require(id);
    this.authorize(rec, token);
    if (rec.state === "refunded" || rec.state === "expired") return toWire(rec);
    if (rec.state === "settled") throw new JitError("already_settled", "order already settled");
    if (rec.state === "opening" || rec.state === "forwarding") {
      throw new JitError("too_late", `order is ${rec.state}; capital is already committed`);
    }
    try {
      await this.cfg.rpc.cancelInvoice(rec.request.hold_hash);
    } catch {
      /* hold already gone */
    }
    return toWire(this.update(id, { state: "refunded", failure_reason: "cancelled by merchant" }));
  }

  private async verifyLinkage(req: CreateJitOrderRequest): Promise<void> {
    const ok = await Promise.resolve(this.cfg.linkageVerifier.verify(req.hold_hash, req.leg_hash, req.linkage_proof));
    if (!ok) throw new JitError("linkage_invalid", "hold_hash and leg_hash are not proven to share a secret");
  }

  private offeringFor(req: CreateJitOrderRequest): AssetOffering {
    const offering = this.cfg.supportedAssets.find((o) => assetEquals(o.asset, req.asset));
    if (!offering) throw new JitError("unsupported_asset", "asset not offered by this LSP");
    return offering;
  }

  private channelCapacity(
    req: CreateJitOrderRequest,
    gross: bigint,
    forward: bigint,
    offering: AssetOffering,
  ): bigint {
    let capacity = req.channel_capacity ? asBig(req.channel_capacity) : gross * BigInt(this.cfg.capacityMultiplier);
    const floor = maxBig(asBig(this.cfg.minCapacity ?? "0"), asBig(offering.min_capacity));
    if (capacity < floor) capacity = floor;
    if (capacity < forward) throw new JitError("capacity_too_small", "channel_capacity cannot cover the forwarded amount");
    if (capacity > asBig(offering.max_capacity)) {
      throw new JitError("capacity_too_large", `channel_capacity exceeds max ${offering.max_capacity}`);
    }
    return capacity;
  }

  private assertNoDuplicate(req: CreateJitOrderRequest): void {
    for (const rec of this.cfg.store.all()) {
      if (isTerminal(rec)) continue;
      if (
        rec.request.hold_hash === req.hold_hash ||
        rec.request.leg_hash === req.leg_hash ||
        rec.request.merchant_invoice === req.merchant_invoice
      ) {
        throw new JitError("duplicate_order", "an active JIT order already uses this hash or invoice");
      }
    }
  }

  private async trySettle(id: string): Promise<JitOrderRecord> {
    let rec = this.require(id);
    if (rec.state === "settled") return rec;
    if (rec.state !== "forwarding") return rec;

    if (!rec.preimage) {
      const preimage = await this.legPreimageFromPayment(rec.request.leg_hash);
      if (preimage) {
        rec = { ...rec, preimage };
        this.cfg.store.put(rec);
      }
    }
    if (!rec.preimage) return rec;

    const holdPreimage = this.holdPreimageForSettle(rec, rec.preimage);
    if (!holdPreimage) {
      const refunded = await this.refund(id, "linkage backstop failed");
      const ev = fraudEvidenceDualSha256(rec.preimage, rec.request.hold_hash, rec.request.leg_hash);
      if (ev && this.cfg.onFraud) this.cfg.onFraud(ev, toWire(refunded));
      return refunded;
    }

    const fwd = await this.cfg.rpc.getPayment(rec.request.leg_hash);
    if (fwd.status !== "Success") return rec;
    try {
      await this.cfg.rpc.settleInvoice(rec.request.hold_hash, holdPreimage);
    } catch (e) {
      return this.update(id, { failure_reason: `settle failed: ${e instanceof Error ? e.message : String(e)}` });
    }
    return this.update(id, { state: "settled", preimage: undefined });
  }

  private holdPreimageForSettle(rec: JitOrderRecord, legPreimage: string): string | null {
    if (!verifyDualSha256Linkage(legPreimage, rec.request.hold_hash, rec.request.leg_hash)) return null;
    return deriveHoldPreimageFromLeg(legPreimage);
  }

  private async legPreimageFromPayment(legHash: string): Promise<string | undefined> {
    try {
      const p = await this.cfg.rpc.getPayment(legHash);
      return p.status === "Success" ? p.payment_preimage : undefined;
    } catch {
      return undefined;
    }
  }

  private async waitForHold(rec: JitOrderRecord): Promise<boolean> {
    for (;;) {
      const { status } = await this.cfg.rpc.getInvoice(rec.request.hold_hash);
      if (status === "Received" || status === "Paid") return true;
      if (status === "Expired") {
        this.update(rec.jit_order_id, { state: "expired" });
        return false;
      }
      if (status === "Cancelled") {
        this.update(rec.jit_order_id, { state: "refunded", failure_reason: "hold cancelled" });
        return false;
      }
      if (this.cfg.now() >= rec.expires_at) {
        this.update(rec.jit_order_id, { state: "expired" });
        return false;
      }
      await this.cfg.sleep(this.cfg.pollIntervalMs);
    }
  }

  private async openAndAwait(id: string): Promise<string | undefined> {
    const rec = this.require(id);
    const req = rec.request;
    if (req.target_address) {
      const peers = await this.cfg.rpc.listPeers();
      if (!peers.some((p) => p.pubkey === req.target_pubkey)) await this.cfg.rpc.connectPeer(req.target_address);
    }
    const before = new Set((await this.cfg.rpc.listChannels(req.target_pubkey)).map((c) => c.channel_id));
    await this.cfg.rpc.openChannel({
      pubkey: req.target_pubkey,
      fundingAmount: req.channel_capacity as string,
      udtTypeScript: assetUdtScript(req.asset),
      public: true,
    });
    const wantId = canonicalAssetId(req.asset);
    for (let i = 0; i < this.cfg.readyPollAttempts; i++) {
      const chans = await this.cfg.rpc.listChannels(req.target_pubkey);
      const match = chans.find(
        (c) => !before.has(c.channel_id) && canonicalAssetId(channelAsset(c)) === wantId && isChannelReady(c),
      );
      if (match) return match.channel_outpoint ?? undefined;
      if (i < this.cfg.readyPollAttempts - 1) await this.cfg.sleep(this.cfg.pollIntervalMs);
    }
    try {
      for (const c of await this.cfg.rpc.listChannels(req.target_pubkey)) {
        if (!before.has(c.channel_id) && canonicalAssetId(channelAsset(c)) === wantId && !isChannelReady(c)) {
          await this.cfg.rpc.abandonChannel(c.channel_id);
        }
      }
    } catch {
      /* refund proceeds regardless */
    }
    return undefined;
  }

  private async forward(id: string): Promise<boolean> {
    const rec = this.require(id);
    const existing = await this.cfg.rpc.getPayment(rec.request.leg_hash).catch(() => undefined);
    if (existing?.status !== "Success" && existing?.status !== "Inflight") {
      try {
        await this.cfg.rpc.sendPayment({ invoice: rec.request.merchant_invoice });
      } catch {
        return false;
      }
    }
    for (let i = 0; i < this.cfg.readyPollAttempts; i++) {
      const p = await this.cfg.rpc.getPayment(rec.request.leg_hash).catch(() => undefined);
      if (p?.status === "Success") return true;
      if (p?.status === "Failed") return false;
      await this.cfg.sleep(this.cfg.pollIntervalMs);
    }
    return false;
  }

  private async refund(id: string, reason: string): Promise<JitOrderRecord> {
    try {
      await this.cfg.rpc.cancelInvoice(this.require(id).request.hold_hash);
    } catch {
      /* invoice already gone */
    }
    return this.update(id, { state: "refunded", failure_reason: reason });
  }

  private require(id: string): JitOrderRecord {
    const rec = this.cfg.store.get(id);
    if (!rec) throw new JitError("not_found", `jit order ${id} not found`);
    return rec;
  }

  private authorize(rec: JitOrderRecord, token?: string): void {
    if (!token || token !== rec.order_token) throw new JitError("unauthorized", "missing or invalid JIT order token");
  }

  private update(id: string, patch: Partial<JitOrderRecord>): JitOrderRecord {
    const prev = this.require(id);
    const next = { ...prev, ...patch };
    this.cfg.store.put(next);
    if (patch.state && patch.state !== prev.state) this.fireWebhook(next);
    return next;
  }

  private fireWebhook(order: JitOrderRecord): void {
    const url = order.request.webhook_url;
    if (!url) return;
    const deliver = this.cfg.deliverWebhook ?? defaultDeliverWebhook;
    void deliver(url, toWire(order)).catch((e) => {
      console.warn(`[jit] webhook to ${url} failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
}

function toWire(rec: JitOrderRecord, includeToken = false): JitOrder {
  const { preimage: _preimage, order_token, ...wire } = rec;
  return includeToken ? { ...wire, order_token } : wire;
}

function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function isTerminal(rec: JitOrderRecord): boolean {
  return rec.state === "settled" || rec.state === "refunded" || rec.state === "expired";
}
