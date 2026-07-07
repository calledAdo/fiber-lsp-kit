/**
 * PaymentWatcher — turns "an invoice was issued" into "the merchant was notified it settled".
 *
 * It waits on `InvoiceService.waitForPayment`, mints a {@link Receipt} for the terminal outcome, then (a)
 * hands it to an `onSettled` callback and (b) POSTs an `invoice.*` webhook to the merchant's backend, if a
 * URL is given. This is the *invoice*-level webhook — distinct from the LSP server's *order*-level
 * `order.updated` webhook (which fires while inbound is being provisioned). Delivery is best-effort: a
 * webhook failure is logged, never thrown, and never loses the receipt (which is returned regardless).
 *
 * The receipt and event shapes come from `@fiberlsp/protocol`, so this app-side watcher and the reference
 * server's backend-side invoice-webhook service emit byte-identical `{ type, receipt }` events.
 */
import {
  buildReceipt,
  webhookEventTypeFor,
  type Receipt,
  type ReceiptContext,
  type WebhookEvent,
} from "@fiberlsp/protocol";
import type { InvoiceService, IssuedInvoice, WaitOptions } from "./InvoiceService.js";

/** Posts a webhook event. Injectable so tests don't hit the network; defaults to a `fetch` POST. */
export type WebhookPoster = (url: string, event: WebhookEvent) => Promise<void>;

export interface PaymentWatcherConfig {
  invoices: InvoiceService;
  /** Override webhook delivery (tests, custom signing/headers). */
  postWebhook?: WebhookPoster;
  now?: () => number;
  idgen?: () => string;
}

export interface WatchOptions extends WaitOptions {
  /** POST an `invoice.*` event here when the invoice settles. Best-effort. */
  webhookUrl?: string;
  /** Called with the receipt once the invoice reaches a terminal state. */
  onSettled?: (receipt: Receipt) => void;
  /** Description / fee / metadata folded into the emitted receipt. */
  receipt?: Omit<ReceiptContext, "idgen" | "now">;
}

async function defaultPostWebhook(url: string, event: WebhookEvent): Promise<void> {
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
}

export class PaymentWatcher {
  private readonly invoices: InvoiceService;
  private readonly postWebhook: WebhookPoster;
  private readonly now: () => number;
  private readonly idgen?: () => string;

  constructor(cfg: PaymentWatcherConfig) {
    this.invoices = cfg.invoices;
    this.postWebhook = cfg.postWebhook ?? defaultPostWebhook;
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
    this.idgen = cfg.idgen;
  }

  /**
   * Wait for `issued` to settle, cut a receipt, notify. Returns the receipt (paid or not). The webhook,
   * when configured, is delivered best-effort *before* returning so a caller that awaits `watch` knows the
   * notification was at least attempted.
   */
  async watch(issued: IssuedInvoice, opts: WatchOptions = {}): Promise<Receipt> {
    const outcome = await this.invoices.waitForPayment(issued.paymentHash, opts);
    const receipt = buildReceipt(issued, outcome, {
      ...opts.receipt,
      now: this.now,
      idgen: this.idgen,
    });
    opts.onSettled?.(receipt);
    if (opts.webhookUrl) await this.deliver(opts.webhookUrl, receipt);
    return receipt;
  }

  private async deliver(url: string, receipt: Receipt): Promise<void> {
    const type = webhookEventTypeFor(receipt.status);
    if (!type) return; // non-terminal status never produces an event
    try {
      await this.postWebhook(url, { type, receipt });
    } catch (e) {
      console.warn(
        `[fiberlsp] invoice webhook to ${url} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
