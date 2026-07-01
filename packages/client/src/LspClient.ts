/**
 * LspClient — wallet-side SDK for the LSPS-Fiber protocol.
 *
 * Talks to one LSP's REST API. The high-level `buyInboundLiquidity` runs the whole flow: quote → order →
 * pay fee → wait until the channel is active. Paying the fee is delegated to a caller-supplied callback so
 * the SDK stays wallet-agnostic (the client pays using its own FNN node / wallet).
 */
import type {
  Asset,
  CreateOrderRequest,
  FeeMode,
  LspInfo,
  Order,
} from "@fiberlsp/protocol";

export type HttpFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface LspClientConfig {
  baseUrl: string;
  fetchImpl?: HttpFetch;
}

export class LspApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "LspApiError";
  }
}

export interface BuyInboundParams {
  asset: Asset;
  /** Inbound capacity to buy, in the asset's base unit. */
  amount: string;
  feeMode: FeeMode;
  /** This wallet's own node pubkey (the channel is opened toward it). */
  targetPubkey: string;
  /** A multiaddr the LSP can reach this wallet's node at, if not already connected. */
  targetAddress?: string;
  /** For from_capacity (CKB only): this wallet's CKB contribution (>= fee). */
  clientBalance?: string;
  public?: boolean;
  /**
   * Pay the LSP's fee. For prepaid mode this is called with the fee invoice and must settle it (returning
   * once paid). For from_capacity it is called after the channel is active. Wallet-specific.
   */
  payFee?: (payment: Order["payment"], order: Order) => Promise<void>;
  waitOpts?: WaitOpts;
}

export interface WaitOpts {
  attempts?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class LspClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: HttpFetch;

  constructor(cfg: LspClientConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = cfg.fetchImpl ?? (globalThis.fetch as unknown as HttpFetch);
  }

  getInfo(): Promise<LspInfo> {
    return this.req<LspInfo>("GET", "/lsp/v1/info");
  }

  createOrder(req: CreateOrderRequest): Promise<Order> {
    return this.req<Order>("POST", "/lsp/v1/orders", req);
  }

  getOrder(id: string): Promise<Order> {
    return this.req<Order>("GET", `/lsp/v1/orders/${id}`);
  }

  /** Tell the LSP the prepaid fee has been paid, so it opens the channel. */
  settleFee(id: string): Promise<Order> {
    return this.req<Order>("POST", `/lsp/v1/orders/${id}/settle`);
  }

  /** Poll until the order reaches a terminal state (channel_active / failed / expired). */
  async waitUntilActive(id: string, opts: WaitOpts = {}): Promise<Order> {
    const attempts = opts.attempts ?? 60;
    const intervalMs = opts.intervalMs ?? 2000;
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let order = await this.getOrder(id);
    for (let i = 0; i < attempts && !isTerminal(order.state); i++) {
      await sleep(intervalMs);
      order = await this.getOrder(id);
    }
    return order;
  }

  /** End-to-end: quote → order → pay fee → wait for the channel to go active. */
  async buyInboundLiquidity(p: BuyInboundParams): Promise<Order> {
    const req: CreateOrderRequest = {
      target_pubkey: p.targetPubkey,
      target_address: p.targetAddress,
      asset: p.asset,
      lsp_balance: p.amount,
      client_balance: p.clientBalance,
      fee_mode: p.feeMode,
      public: p.public,
    };
    let order = await this.createOrder(req);

    if (order.state === "awaiting_payment") {
      // prepaid: pay the fee invoice, then notify the LSP.
      if (p.payFee) await p.payFee(order.payment, order);
      order = await this.settleFee(order.order_id);
    }

    order = await this.waitUntilActive(order.order_id, p.waitOpts);

    // from_capacity: settle the fee once the channel is usable.
    if (order.state === "channel_active" && order.payment.mode === "from_capacity" && p.payFee) {
      await p.payFee(order.payment, order);
    }
    return order;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as T | { error?: { code: string; message: string } };
    if (res.status >= 400) {
      const e = (json as { error?: { code: string; message: string } }).error;
      throw new LspApiError(res.status, e?.code ?? "error", e?.message ?? `HTTP ${res.status}`);
    }
    return json as T;
  }
}

function isTerminal(state: Order["state"]): boolean {
  return state === "channel_active" || state === "failed" || state === "expired";
}
