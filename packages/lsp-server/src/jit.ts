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
  asBig,
  assetEquals,
  assetUdtScript,
  deriveHoldPreimageFromLeg,
  fraudEvidenceDualSha256,
  jitFee,
  verifyDualSha256Linkage,
} from "@fiberlsp/protocol";
import {
  invoiceExpirySeconds,
  openChannelAndAwait,
  receivedTlcExpirySeconds,
  type FiberChannelRpcClient,
} from "@fiberlsp/fiber";
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
  /** Pricing policy: the fee deducted from a gross payment. Defaults to `jitFee` over the static terms. */
  feeFor?: (terms: JitTerms, gross: bigint) => bigint;
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
  /** Seconds reserved after the merchant-leg forward for the hold settle to land before expiry. Default 60. */
  settleMarginSeconds?: number;
  /** Hold expiry granted when the merchant does not request one (clamped to the safe floor). Default 600. */
  defaultExpirySeconds?: number;
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
      | "settleMarginSeconds"
      | "defaultExpirySeconds"
    >
  > &
    JitServiceConfig;
  private readonly openLock: KeyedLock = makeKeyedLock();
  // Serialize creation per leg hash so a concurrent duplicate cannot slip past assertNoDuplicate between
  // the check and the store write (the leg invoice is each order's natural unique key).
  private readonly createLock: KeyedLock = makeKeyedLock();

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
      settleMarginSeconds: 60,
      defaultExpirySeconds: 600,
      ...config,
    };
  }

  /** Advertised terms: the operator's pricing plus the computed minimum hold floor (for merchant inspection). */
  get terms(): JitTerms {
    return { ...this.cfg.terms, min_expiry_seconds: this.minExpirySeconds() };
  }

  getOrder(id: string, token?: string): JitOrder | undefined {
    const rec = this.cfg.store.get(id);
    if (!rec) return undefined;
    this.authorize(rec, token);
    return toWire(rec);
  }

  async createOrder(req: CreateJitOrderRequest): Promise<JitOrder> {
    return this.createLock.run(req.leg_hash, () => this.createOrderLocked(req));
  }

  private async createOrderLocked(req: CreateJitOrderRequest): Promise<JitOrder> {
    const offering = this.offeringFor(req);
    const gross = asBig(req.amount);
    if (gross < asBig(this.cfg.terms.min_payment)) {
      throw new JitError("amount_too_small", `amount below min_payment ${this.cfg.terms.min_payment}`);
    }
    await this.verifyLinkage(req);
    this.assertNoDuplicate(req);

    const fee = (this.cfg.feeFor ?? jitFee)(this.cfg.terms, gross);
    if (fee >= gross) {
      throw new JitError("fee_exceeds_amount", `payment ${gross} does not cover the JIT fee ${fee}`);
    }
    const forward = gross - fee;
    const parsed = await this.cfg.rpc.parseInvoice(req.merchant_invoice);
    if (parsed.invoice?.data?.payment_hash !== req.leg_hash) {
      throw new JitError("hash_mismatch", "merchant_invoice payment_hash != leg_hash");
    }
    if (parsed.invoice?.amount === undefined || asBig(parsed.invoice.amount) !== forward) {
      throw new JitError("amount_mismatch", `merchant_invoice must be for the net forward amount ${forward}`);
    }

    const capacity = this.channelCapacity(req, gross, forward, offering);
    // The hold must outlive an on-chain open + a merchant-leg forward + the settle, or the LSP could pay the
    // merchant and then find the customer's hold already expired (refunded) — losing the forwarded amount.
    const minExpiry = this.minExpirySeconds();
    if (minExpiry > this.cfg.terms.max_expiry_seconds) {
      throw new JitError(
        "expiry_unsafe",
        `channel-open budget needs a ${minExpiry}s hold but max_expiry_seconds is ${this.cfg.terms.max_expiry_seconds}`,
      );
    }
    const requested = req.expiry_seconds ?? Math.max(this.cfg.defaultExpirySeconds, minExpiry);
    const expirySeconds = Math.min(Math.max(requested, minExpiry), this.cfg.terms.max_expiry_seconds);

    // The merchant leg must outlive the hold, or it can expire before the LSP forwards — a doomed order that
    // still wastes an on-chain open. Reject up front when the leg invoice's absolute expiry is too short.
    const now = this.cfg.now();
    const holdExpiresAt = now + expirySeconds;
    const legExpiresAt = invoiceExpirySeconds(parsed);
    if (legExpiresAt !== undefined && legExpiresAt < holdExpiresAt) {
      throw new JitError(
        "leg_expiry_too_short",
        `merchant_invoice expires at ${legExpiresAt} but must outlive the hold (${holdExpiresAt})`,
      );
    }

    const hold = await this.cfg.rpc.newInvoice({
      amount: gross,
      description: "JIT channel order (hold)",
      udtTypeScript: assetUdtScript(offering.asset),
      expirySeconds,
      paymentHash: req.hold_hash,
      hashAlgorithm: "sha256",
    });

    const { linkage_proof: _proof, ...wireReq } = req;
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
      expires_at: holdExpiresAt,
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
        // Never pay the merchant into a hold that may expire before we can settle it. If capital is not yet
        // committed (leg not paid/in-flight) and too little lifetime remains, refund instead.
        const deadline = await this.effectiveHoldDeadline(rec);
        if (this.tooCloseToDeadline(deadline) && !(await this.merchantCommitted(rec))) {
          return toWire(await this.refund(id, "insufficient hold lifetime remaining to safely pay the merchant"));
        }
        const paid = await this.forward(id);
        if (!paid) return toWire(await this.refund(id, "forward to merchant failed"));
        return toWire(await this.settleWithRetry(id));
      }

      return toWire(rec);
    } catch (e) {
      return toWire(await this.refund(id, e instanceof Error ? e.message : String(e)));
    }
  }

  /**
   * Re-drive every non-terminal order after a restart. `run()` resumes from each order's persisted state, so
   * an order caught mid-flight — including one already `forwarding` (merchant paid) — is settled from the
   * persisted or re-derivable preimage instead of being stranded until the hold expires. Call once on boot.
   */
  resume(): void {
    for (const rec of this.cfg.store.all()) {
      if (rec.state === "settled" || rec.state === "refunded" || rec.state === "expired") continue;
      void this.run(rec.jit_order_id).catch((e) => {
        console.warn(`[jit] resume(${rec.jit_order_id}) failed: ${e instanceof Error ? e.message : String(e)}`);
      });
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

  /** Worst-case seconds one on-chain open (or one merchant-leg forward) can consume before giving up. */
  private openBudgetSeconds(): number {
    return Math.ceil((this.cfg.readyPollAttempts * this.cfg.pollIntervalMs) / 1000);
  }

  /** Shortest hold the LSP can safely grant: an open, a forward, and a settle must all fit inside it. */
  private minExpirySeconds(): number {
    return 2 * this.openBudgetSeconds() + this.cfg.settleMarginSeconds;
  }

  /**
   * The hold's effective deadline (unix seconds): the invoice expiry, tightened to the held payment's actual
   * on-chain TLC expiry when the node reports it. The TLC expiry is the hard ceiling — holding past it lets
   * the customer force-close and reclaim — so we never rely on the invoice expiry alone when we can read it.
   */
  private async effectiveHoldDeadline(rec: JitOrderRecord): Promise<number> {
    let deadline = rec.expires_at;
    try {
      const tlc = receivedTlcExpirySeconds(await this.cfg.rpc.listChannels(), rec.request.hold_hash);
      if (tlc !== undefined) deadline = Math.min(deadline, tlc);
    } catch {
      /* fall back to the invoice expiry */
    }
    return deadline;
  }

  /** True when too little time remains before `deadline` to forward and still settle. */
  private tooCloseToDeadline(deadline: number): boolean {
    const reserve = this.openBudgetSeconds() + this.cfg.settleMarginSeconds;
    return this.cfg.now() + reserve >= deadline;
  }

  /** True once the merchant leg is already paid or in flight — capital is committed; never refund past this. */
  private async merchantCommitted(rec: JitOrderRecord): Promise<boolean> {
    const s = (await this.cfg.rpc.getPayment(rec.request.leg_hash).catch(() => undefined))?.status;
    return s === "Success" || s === "Inflight";
  }

  /**
   * Retry settlement until it lands, the order becomes terminal, or the hold nears expiry. The leg preimage
   * can lag the payment's `Success` status by a moment, and a single attempt would strand the order (and the
   * LSP's forwarded funds) in `forwarding`. Bounded by the ready-poll budget and the hold deadline.
   */
  private async settleWithRetry(id: string): Promise<JitOrderRecord> {
    for (let i = 0; i < this.cfg.readyPollAttempts; i++) {
      const rec = await this.trySettle(id);
      if (rec.state !== "forwarding") return rec; // settled / refunded / expired
      if (this.cfg.now() + this.cfg.settleMarginSeconds >= rec.expires_at) return rec; // hold near expiry; stop
      if (i < this.cfg.readyPollAttempts - 1) await this.cfg.sleep(this.cfg.pollIntervalMs);
    }
    return this.require(id);
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
    if (!rec.preimage) {
      // The merchant leg is paid but get_payment has not surfaced the preimage yet. The hold stays held and
      // safe; settlement waits for the merchant's reveal. Surface it so the operator sees the open exposure.
      console.warn(
        `[jit] order ${rec.jit_order_id}: leg paid but preimage unavailable from get_payment; awaiting merchant reveal to settle`,
      );
      return rec;
    }

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
    const req = this.require(id).request;
    // Abandon a late-funding orphan on give-up so a stray retry can't strand the LSP's capacity.
    const ready = await openChannelAndAwait(this.cfg.rpc, {
      pubkey: req.target_pubkey,
      address: req.target_address,
      fundingAmount: req.channel_capacity as string,
      asset: req.asset,
      public: true,
      readyPollAttempts: this.cfg.readyPollAttempts,
      pollIntervalMs: this.cfg.pollIntervalMs,
      sleep: this.cfg.sleep,
      abandonOrphanOnTimeout: true,
    });
    return ready?.channel_outpoint ?? undefined;
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
