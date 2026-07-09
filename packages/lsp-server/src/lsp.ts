/**
 * Lsp — the reference LSP engine. Turns an order into a provisioned inbound channel.
 *
 * Flow (see docs/LSPS-Fiber.md):
 *   createOrder ──prepaid──▶ awaiting_payment ──settleFee──▶ opening ──▶ channel_active
 *               └─from_capacity──▶ opening (channel opened immediately) ──▶ channel_active
 *
 * Every state-changing side effect goes through FiberChannelRpcClient, which can be backed by a replay
 * transport for offline tests — the same real code path runs in the demo against a live FNN node.
 */
import {
  type AssetLiquidity,
  type AssetOffering,
  type CreateOrderRequest,
  type FeeMode,
  type LiquiditySnapshot,
  type LspInfo,
  type FeeQuote,
  type Order,
  type OrderPayment,
  quoteFee,
  validateOrder,
  asBig,
  assetEquals,
  canonicalAssetId,
} from "@fiberlsp/protocol";
import { channelAsset, isChannelReady, openChannelAndAwait, type FiberChannelRpcClient } from "@fiberlsp/fiber";
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
   * Pricing policy: quote the fee for an order. Defaults to the offering's static `fee_schedule` via
   * `quoteFee`. Inject to implement dynamic / per-client / surge pricing — it is policy, not mechanism.
   */
  feeQuote?: (offering: AssetOffering, req: CreateOrderRequest) => FeeQuote;
  /**
   * For prepaid orders: confirm the fee invoice actually settled before opening the channel. Defaults to
   * trusting the explicit settleFee() call (fine for the demo). A production LSP injects a check that
   * queries the node's invoice status so a client can't get a channel without paying.
   */
  verifyFeePaid?: (order: Order) => Promise<boolean>;
  /**
   * Delivers an order webhook. Defaults to a POST via global fetch; injectable so tests don't hit the
   * network. Delivery is best-effort — a failure here never affects provisioning.
   */
  deliverWebhook?: (url: string, order: Order) => Promise<void>;
}

async function defaultDeliverWebhook(url: string, order: Order): Promise<void> {
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "order.updated", order }),
  });
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

  /**
   * A live snapshot of the LSP's capacity, grouped by asset — the data behind a liquidity dashboard.
   * `outbound` (summed local balances) is what the LSP can send / has already provisioned to peers;
   * `inbound` (summed remote balances) is what it can receive. Read straight from `list_channels`.
   */
  async liquidity(): Promise<LiquiditySnapshot> {
    const channels = await this.cfg.rpc.listChannels();
    const groups = new Map<string, AssetLiquidity>();
    for (const c of channels) {
      const asset = channelAsset(c);
      const key = canonicalAssetId(asset);
      if (key === null) continue;
      let g = groups.get(key);
      if (!g) {
        // Prefer the offering's asset descriptor so the dashboard shows the symbol (e.g. "RUSD").
        const offered = this.cfg.supportedAssets.find((o) => assetEquals(o.asset, asset));
        g = {
          asset: offered?.asset ?? asset,
          channel_count: 0,
          ready_channel_count: 0,
          outbound: "0",
          inbound: "0",
        };
        groups.set(key, g);
      }
      g.channel_count += 1;
      if (isChannelReady(c)) g.ready_channel_count += 1;
      g.outbound = (asBig(g.outbound) + asBig(c.local_balance)).toString();
      g.inbound = (asBig(g.inbound) + asBig(c.remote_balance)).toString();
    }
    return {
      lsp_pubkey: this.cfg.lspPubkey,
      generated_at: this.cfg.now(),
      assets: [...groups.values()],
    };
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

    const fee = (this.cfg.feeQuote ?? quoteFee)(offering, req);
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
      payment = {
        mode: "prepaid",
        fee_invoice: inv.invoice_address,
        amount: fee.total_fee,
        fee_payment_hash: inv.invoice?.data?.payment_hash,
      };
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
      const ready = await openChannelAndAwait(this.cfg.rpc, {
        pubkey: req.target_pubkey,
        address: req.target_address,
        fundingAmount: req.lsp_balance,
        asset: req.asset,
        public: req.public ?? true,
        readyPollAttempts: this.cfg.readyPollAttempts,
        pollIntervalMs: this.cfg.readyPollIntervalMs,
        sleep: this.cfg.sleep,
      });
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

  private requireOrder(id: string): Order {
    const order = this.cfg.store.get(id);
    if (!order) throw new OrderError("not_found", `order ${id} not found`);
    return order;
  }

  private update(id: string, patch: Partial<Order>): Order {
    const prev = this.requireOrder(id);
    const next = { ...prev, ...patch };
    this.cfg.store.put(next);
    if (patch.state && patch.state !== prev.state) this.fireWebhook(next);
    return next;
  }

  /** Best-effort webhook on a state transition; never throws into the state machine. */
  private fireWebhook(order: Order): void {
    const url = order.request.webhook_url;
    if (!url) return;
    const deliver = this.cfg.deliverWebhook ?? defaultDeliverWebhook;
    void deliver(url, order).catch((e) => {
      console.warn(`[lsp] webhook to ${url} failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
}

/**
 * A real fee verifier: confirms a prepaid order's CKB fee invoice actually settled (`get_invoice` →
 * `status === "Paid"`) before the LSP opens the channel. Wire this into `verifyFeePaid` so a client can't
 * obtain inbound liquidity without paying.
 *
 * Note on the zero-capital flagship flow: a client that auto-accepts a pure-UDT channel with 0 has no
 * Fiber outbound and therefore cannot settle a Fiber fee invoice — its fee must be paid out-of-band in
 * CKB (on-chain, or from a pre-existing CKB channel). For that case the LSP settles the order through an
 * out-of-band confirmation instead of this in-Fiber check. See docs/LSPS-Fiber.md §4.
 */
export function makeInvoiceFeeVerifier(rpc: FiberChannelRpcClient): (order: Order) => Promise<boolean> {
  return async (order: Order) => {
    if (order.payment.mode !== "prepaid") return true; // from_capacity settles in-channel, nothing to poll
    const hash = order.payment.fee_payment_hash;
    if (!hash) return false; // can't verify without a payment hash → refuse to provision
    const { status } = await rpc.getInvoice(hash);
    return status === "Paid";
  };
}
