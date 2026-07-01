/**
 * Lsp — the reference LSP engine. Turns an order into a provisioned inbound channel.
 *
 * Flow (see spec/LSPS-Fiber.md):
 *   createOrder ──prepaid──▶ awaiting_payment ──settleFee──▶ opening ──▶ channel_active
 *               └─from_capacity──▶ opening (channel opened immediately) ──▶ channel_active
 *
 * Every state-changing side effect goes through FiberChannelRpcClient, which can be backed by a replay
 * transport for offline tests — the same real code path runs in the demo against a live FNN node.
 */
import {
  type AssetOffering,
  type CreateOrderRequest,
  type FeeMode,
  type LspInfo,
  type Order,
  type OrderPayment,
  type RawChannel,
  type UdtTypeScript,
  FiberChannelRpcClient,
  quoteFee,
  validateOrder,
  assetEquals,
  assetUdtScript,
  canonicalAssetId,
  udtAsset,
  CKB,
  isChannelReady,
} from "@fiberlsp/protocol";
import { MemoryOrderStore, type OrderStore } from "./orderStore.js";

export class OrderError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "OrderError";
  }
}

export interface LspConfig {
  rpc: FiberChannelRpcClient;
  lspPubkey: string;
  addresses: string[];
  chain?: string;
  supportedAssets: AssetOffering[];
  feeModes: FeeMode[];
  orderExpirySeconds?: number;
  operator?: string;
  version?: string;
  store?: OrderStore;
  /** seconds; injectable for tests */
  now?: () => number;
  idgen?: () => string;
  readyPollAttempts?: number;
  readyPollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * For prepaid orders: confirm the fee invoice actually settled before opening the channel. Defaults to
   * trusting the explicit settleFee() call (fine for the demo). A production LSP injects a check that
   * queries the node's invoice status so a client can't get a channel without paying.
   */
  verifyFeePaid?: (order: Order) => Promise<boolean>;
}

export class Lsp {
  private readonly cfg: Required<
    Pick<
      LspConfig,
      | "orderExpirySeconds"
      | "chain"
      | "readyPollAttempts"
      | "readyPollIntervalMs"
      | "now"
      | "idgen"
      | "sleep"
      | "store"
    >
  > &
    LspConfig;

  constructor(config: LspConfig) {
    this.cfg = {
      chain: "testnet",
      orderExpirySeconds: 3600,
      readyPollAttempts: 30,
      readyPollIntervalMs: 2000,
      now: () => Math.floor(Date.now() / 1000),
      idgen: () => (globalThis.crypto?.randomUUID?.() ?? `order_${Date.now()}_${Math.random()}`),
      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      store: config.store ?? new MemoryOrderStore(),
      ...config,
    };
  }

  getInfo(): LspInfo {
    return {
      lsp_pubkey: this.cfg.lspPubkey,
      addresses: this.cfg.addresses,
      chain: this.cfg.chain,
      supported_assets: this.cfg.supportedAssets,
      fee_modes: this.cfg.feeModes,
      order_expiry_seconds: this.cfg.orderExpirySeconds,
      operator: this.cfg.operator,
      version: this.cfg.version,
    };
  }

  getOrder(id: string): Order | undefined {
    return this.cfg.store.get(id);
  }

  private offeringFor(req: CreateOrderRequest): AssetOffering {
    const offering = this.cfg.supportedAssets.find((o) => assetEquals(o.asset, req.asset));
    if (!offering) throw new OrderError("unsupported_asset", "asset not offered by this LSP");
    return offering;
  }

  async createOrder(req: CreateOrderRequest): Promise<Order> {
    const offering = this.offeringFor(req);
    const err = validateOrder(offering, this.cfg.feeModes, req);
    if (err) throw new OrderError(err.code, err.message);

    const fee = quoteFee(offering, req);
    const now = this.cfg.now();
    const order_id = this.cfg.idgen();

    let payment: OrderPayment;
    let state: Order["state"];
    if (req.fee_mode === "prepaid") {
      // The fee is CKB, so a plain CKB invoice (no udt_type_script).
      const inv = await this.cfg.rpc.newInvoice({
        amount: fee.total_fee,
        description: `LSP inbound liquidity order ${order_id}`,
        expirySeconds: this.cfg.orderExpirySeconds,
      });
      payment = { mode: "prepaid", fee_invoice: inv.invoice_address, amount: fee.total_fee };
      state = "awaiting_payment";
    } else {
      payment = { mode: "from_capacity", amount: fee.total_fee, lsp_pubkey: this.cfg.lspPubkey };
      state = "created";
    }

    const order: Order = {
      order_id,
      state,
      request: req,
      fee,
      payment,
      expires_at: now + this.cfg.orderExpirySeconds,
      created_at: now,
    };
    this.cfg.store.put(order);

    // from_capacity opens the channel immediately (the fee is collected in-channel afterwards).
    if (req.fee_mode === "from_capacity") return this.provision(order_id);
    return order;
  }

  /** Called once a prepaid fee invoice is settled. Verifies (if configured) then provisions. */
  async settleFee(id: string): Promise<Order> {
    const order = this.requireOrder(id);
    if (order.state === "channel_active" || order.state === "opening") return order; // idempotent
    if (order.state !== "awaiting_payment") {
      throw new OrderError("invalid_state", `order ${id} is ${order.state}, not awaiting_payment`);
    }
    if (this.cfg.verifyFeePaid) {
      const paid = await this.cfg.verifyFeePaid(order);
      if (!paid) throw new OrderError("fee_unpaid", "fee invoice has not settled yet");
    }
    return this.provision(id);
  }

  /** Connect to the client, open the (LSP-funded) channel, and poll until it is ChannelReady. */
  async provision(id: string): Promise<Order> {
    let order = this.requireOrder(id);
    if (order.state === "channel_active") return order;
    order = this.update(id, { state: "opening" });

    const req = order.request;
    try {
      // Connect only if not already peered: a redundant connect_peer can crash the acceptor's gossip
      // actor (ActorAlreadyRegistered), verified live against FNN v0.9.
      if (req.target_address) {
        const peers = await this.cfg.rpc.listPeers();
        if (!peers.some((p) => p.pubkey === req.target_pubkey)) {
          await this.cfg.rpc.connectPeer(req.target_address);
        }
      }

      // Snapshot channels to this peer BEFORE opening, so we can identify the one we just opened
      // (matching by exact balance is wrong — CKB channels reserve occupied cell capacity, so the
      // LSP's local_balance is less than the requested funding amount).
      const before = new Set(
        (await this.cfg.rpc.listChannels(req.target_pubkey)).map((c) => c.channel_id),
      );
      await this.cfg.rpc.openChannel({
        pubkey: req.target_pubkey,
        fundingAmount: req.lsp_balance,
        udtTypeScript: assetUdtScript(req.asset),
        public: req.public ?? true,
      });

      const ready = await this.pollForReadyChannel(req, before);
      if (!ready) {
        return this.update(id, {
          state: "failed",
          failure_reason: "channel did not reach ChannelReady before timeout",
        });
      }
      return this.update(id, {
        state: "channel_active",
        channel_outpoint: ready.channel_outpoint ?? undefined,
      });
    } catch (e) {
      return this.update(id, {
        state: "failed",
        failure_reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Find the channel we just provisioned: a channel to this peer, in the requested asset, that reached
   * ChannelReady and did not exist before we opened it (`before` = channel_ids present pre-open). We
   * identify by novelty + peer + asset rather than exact balance, because a CKB channel's occupied cell
   * reserve makes the LSP's local_balance smaller than the requested funding amount.
   */
  private async pollForReadyChannel(
    req: CreateOrderRequest,
    before: Set<string>,
  ): Promise<RawChannel | null> {
    const wantId = canonicalAssetId(req.asset);
    for (let i = 0; i < this.cfg.readyPollAttempts; i++) {
      const channels = await this.cfg.rpc.listChannels(req.target_pubkey);
      const match = channels.find(
        (c) =>
          !before.has(c.channel_id) &&
          canonicalAssetId(channelAsset(c)) === wantId &&
          isChannelReady(c),
      );
      if (match) return match;
      if (i < this.cfg.readyPollAttempts - 1) await this.cfg.sleep(this.cfg.readyPollIntervalMs);
    }
    return null;
  }

  private requireOrder(id: string): Order {
    const order = this.cfg.store.get(id);
    if (!order) throw new OrderError("not_found", `order ${id} not found`);
    return order;
  }

  private update(id: string, patch: Partial<Order>): Order {
    const next = { ...this.requireOrder(id), ...patch };
    this.cfg.store.put(next);
    return next;
  }
}

/** The asset a channel is denominated in, from its funding_udt_type_script (null ⇒ CKB). */
export function channelAsset(c: RawChannel): { kind: "CKB" } | ReturnType<typeof udtAsset> {
  const s = c.funding_udt_type_script as UdtTypeScript | null | undefined;
  return s ? udtAsset(s) : CKB;
}
