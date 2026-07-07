/**
 * InvoiceWebhookService — server-side settlement webhooks for a merchant.
 *
 * The client SDK's `PaymentWatcher` fires `invoice.*` webhooks from the app; this does the same from a
 * long-running backend, so a merchant gets `invoice.paid` pushes without holding a watcher in memory. It
 * polls the merchant's *own* FNN node (invoices are node-native — `get_invoice` only answers on the node
 * that issued them) and, on a terminal status, builds a {@link Receipt} and POSTs a `{ type, receipt }`
 * event identical to the client's — the receipt/event shapes come from `@fiberlsp/protocol`.
 *
 * Watches are persisted (see {@link WatchStore}); `resume()` re-attaches pending ones after a restart.
 */
import {
  type Asset,
  type InvoiceStatus,
  type WebhookEvent,
  FiberChannelRpcClient,
  assetUdtScript,
  buildReceipt,
  isInvoiceTerminal,
  toDecimal,
  webhookEventTypeFor,
} from "@fiberlsp/protocol";
import { MemoryWatchStore, type InvoiceWatch, type WatchStore } from "./watchStore.js";

/** Issue a fresh invoice on the merchant node and watch it. */
export interface RegisterInvoiceRequest {
  asset: Asset;
  /** Amount to invoice, in the asset's base unit. */
  amount: string;
  /** Where to POST the settlement webhook. */
  webhook_url: string;
  description?: string;
  expirySeconds?: number;
  currency?: string;
  metadata?: Record<string, string>;
}

/** Watch an invoice that was already issued elsewhere (its payment hash is known). */
export interface WatchExistingRequest {
  invoice: string;
  payment_hash: string;
  asset: Asset;
  amount: string;
  webhook_url: string;
  description?: string;
  metadata?: Record<string, string>;
}

export interface InvoiceWebhookConfig {
  /** The *merchant's* own FNN node (where invoices are issued and settle). */
  rpc: FiberChannelRpcClient;
  store?: WatchStore;
  /** Delivers a webhook event. Defaults to a `fetch` POST; injectable so tests don't hit the network. */
  deliver?: (url: string, event: WebhookEvent) => Promise<void>;
  /** Per-watch poll budget before giving up (leaves the watch pending, undelivered). */
  pollAttempts?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  idgen?: () => string;
}

async function defaultDeliver(url: string, event: WebhookEvent): Promise<void> {
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
}

export class InvoiceWebhookService {
  private readonly rpc: FiberChannelRpcClient;
  private readonly store: WatchStore;
  private readonly deliver: (url: string, event: WebhookEvent) => Promise<void>;
  private readonly pollAttempts: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly idgen: () => string;
  /** In-flight watch loops, keyed by watch_id — awaited by `drain()`. */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(cfg: InvoiceWebhookConfig) {
    this.rpc = cfg.rpc;
    this.store = cfg.store ?? new MemoryWatchStore();
    this.deliver = cfg.deliver ?? defaultDeliver;
    this.pollAttempts = cfg.pollAttempts ?? 60;
    this.pollIntervalMs = cfg.pollIntervalMs ?? 2000;
    this.sleep = cfg.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
    this.idgen =
      cfg.idgen ??
      (() => globalThis.crypto?.randomUUID?.() ?? `iw_${Date.now()}_${Math.random().toString(16).slice(2)}`);
  }

  /** Issue a new invoice on the merchant node, then watch it to settlement. */
  async register(req: RegisterInvoiceRequest): Promise<InvoiceWatch> {
    if (req.asset.kind === "UDT" && !assetUdtScript(req.asset)) {
      throw new Error(
        "issuing a UDT invoice needs the Script object; build the asset with udtAsset(script), not a bare hex",
      );
    }
    const inv = await this.rpc.newInvoice({
      amount: req.amount,
      currency: req.currency,
      description: req.description,
      udtTypeScript: assetUdtScript(req.asset),
      expirySeconds: req.expirySeconds,
    });
    const payment_hash = inv.invoice?.data?.payment_hash;
    if (!payment_hash) throw new Error("new_invoice returned no payment_hash");
    return this.begin({
      invoice: inv.invoice_address,
      payment_hash,
      asset: req.asset,
      amount: req.amount,
      webhook_url: req.webhook_url,
      description: req.description,
      metadata: req.metadata,
    });
  }

  /** Watch an already-issued invoice (payment hash supplied by the caller). */
  watchExisting(req: WatchExistingRequest): InvoiceWatch {
    return this.begin(req);
  }

  get(id: string): InvoiceWatch | undefined {
    return this.store.get(id);
  }

  list(): InvoiceWatch[] {
    return this.store.all();
  }

  /** Re-attach a poll loop to every persisted watch that isn't already terminal. Call once on boot. */
  resume(): void {
    for (const w of this.store.all()) {
      if (!w.receipt && !isInvoiceTerminal(w.status)) this.spawn(w.watch_id);
    }
  }

  /** Await all in-flight watch loops (including their webhook delivery). Mainly a test/shutdown aid. */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight.values()]);
    }
  }

  private begin(reg: Omit<WatchExistingRequest, "amount"> & { amount: string }): InvoiceWatch {
    const watch: InvoiceWatch = {
      watch_id: this.idgen(),
      webhook_url: reg.webhook_url,
      invoice: reg.invoice,
      payment_hash: reg.payment_hash,
      asset: reg.asset,
      amount: toDecimal(reg.amount),
      description: reg.description,
      metadata: reg.metadata,
      status: "Open",
      paid: false,
      created_at: this.now(),
    };
    this.store.put(watch);
    this.spawn(watch.watch_id);
    return watch;
  }

  private spawn(id: string): void {
    const p = this.run(id)
      .catch((e) =>
        console.warn(`[merchant] watch ${id} loop failed: ${e instanceof Error ? e.message : String(e)}`),
      )
      .finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
  }

  /** Poll the merchant node until the invoice reaches a terminal state, then finalize + deliver. */
  private async run(id: string): Promise<void> {
    for (let i = 0; i < this.pollAttempts; i++) {
      const watch = this.store.get(id);
      if (!watch || watch.receipt) return; // removed or already finalized

      let status: InvoiceStatus;
      try {
        ({ status } = await this.rpc.getInvoice(watch.payment_hash));
      } catch (e) {
        // Transient node error — keep polling rather than dropping the watch.
        console.warn(
          `[merchant] get_invoice(${watch.payment_hash}) failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        if (i < this.pollAttempts - 1) await this.sleep(this.pollIntervalMs);
        continue;
      }

      if (status !== watch.status) this.patch(id, { status });
      if (isInvoiceTerminal(status)) return this.finalize(id, status);
      if (i < this.pollAttempts - 1) await this.sleep(this.pollIntervalMs);
    }
  }

  private async finalize(id: string, status: InvoiceStatus): Promise<void> {
    const w = this.store.get(id);
    if (!w || w.receipt) return;
    const receipt = buildReceipt(
      { invoice: w.invoice, paymentHash: w.payment_hash, asset: w.asset, amount: w.amount },
      { status, paid: status === "Paid" },
      {
        description: w.description,
        metadata: w.metadata,
        issued_at: w.created_at,
        now: this.now,
        idgen: this.idgen,
      },
    );
    const updated = this.patch(id, {
      status,
      paid: receipt.paid,
      settled_at: receipt.settled_at,
      receipt,
    });
    const type = webhookEventTypeFor(status);
    if (type) await this.fire(updated.webhook_url, { type, receipt });
  }

  /** Best-effort delivery: a webhook failure is logged, never thrown into the loop. */
  private async fire(url: string, event: WebhookEvent): Promise<void> {
    try {
      await this.deliver(url, event);
    } catch (e) {
      console.warn(
        `[merchant] invoice webhook to ${url} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private patch(id: string, patch: Partial<InvoiceWatch>): InvoiceWatch {
    const prev = this.store.get(id);
    if (!prev) throw new Error(`watch ${id} not found`);
    const next = { ...prev, ...patch };
    this.store.put(next);
    return next;
  }
}
