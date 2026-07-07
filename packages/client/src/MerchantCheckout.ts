/**
 * MerchantCheckout — a drop-in "accept a Fiber payment" flow for merchants.
 *
 * It composes the receiver-side pieces into one object so an app doesn't hand-wire them:
 *
 *   createIntent ──▶ ensure inbound (optional) ──▶ issue invoice ──▶ PaymentIntent { invoice, qr_payload }
 *        settle  ──▶ wait for payment ──▶ Receipt ──▶ invoice webhook
 *
 * `createIntent` gates on receive-readiness (a merchant should know it can be paid *before* showing a
 * payment request) and, if inbound is short, provisions it via a supplied `ensureInbound` hook — e.g.
 * `buyInboundFromLsp(lsp, …)`. It stays UI-agnostic: `qr_payload` is just the payable invoice string, so
 * any QR renderer can encode it; the SDK pulls in no rendering dependency.
 */
import type { Asset, Receipt } from "@fiberlsp/protocol";
import type { InvoiceService, IssuedInvoice, ReceiveReadiness } from "./InvoiceService.js";
import { PaymentWatcher, type WatchOptions, type WebhookPoster } from "./PaymentWatcher.js";

export interface PaymentIntent {
  intent_id: string;
  /** The payable invoice string the customer settles. */
  invoice: string;
  payment_hash: string;
  asset: Asset;
  /** Amount requested, in the asset's base unit (decimal string). */
  amount: string;
  description?: string;
  /** What a wallet QR should encode — the payable invoice string. */
  qr_payload: string;
  created_at: number;
  /** Unix seconds the invoice expires, when an expiry was requested. */
  expires_at?: number;
  metadata?: Record<string, string>;
}

export interface CheckoutRequest {
  asset: Asset;
  /** Amount to charge, in the asset's base unit. */
  amount: string;
  description?: string;
  expirySeconds?: number;
  /** Invoice currency tag (defaults to the node's default, e.g. "Fibt" on testnet). */
  currency?: string;
  /** Merchant metadata carried through onto the intent and its receipt. */
  metadata?: Record<string, string>;
  /**
   * Provision inbound if short (e.g. `buyInboundFromLsp(lsp, …)`). Overrides the instance default set in
   * the constructor. If neither is set and inbound is short, `createIntent` throws `ReceiveNotReadyError`.
   */
  ensureInbound?: (readiness: ReceiveReadiness) => Promise<void>;
}

export interface MerchantCheckoutConfig {
  invoices: InvoiceService;
  /** Default inbound provisioner used when a request doesn't supply its own. */
  ensureInbound?: (readiness: ReceiveReadiness) => Promise<void>;
  /** Default webhook URL for settlement events; a `settle`/`checkout` call can override it. */
  webhookUrl?: string;
  /** Override webhook delivery (tests, signing/headers). */
  postWebhook?: WebhookPoster;
  now?: () => number;
  idgen?: () => string;
}

function defaultId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `pi_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export class MerchantCheckout {
  private readonly invoices: InvoiceService;
  private readonly ensureInbound?: (readiness: ReceiveReadiness) => Promise<void>;
  private readonly webhookUrl?: string;
  private readonly watcher: PaymentWatcher;
  private readonly now: () => number;
  private readonly idgen: () => string;

  constructor(cfg: MerchantCheckoutConfig) {
    this.invoices = cfg.invoices;
    this.ensureInbound = cfg.ensureInbound;
    this.webhookUrl = cfg.webhookUrl;
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
    this.idgen = cfg.idgen ?? defaultId;
    this.watcher = new PaymentWatcher({
      invoices: cfg.invoices,
      postWebhook: cfg.postWebhook,
      now: this.now,
      idgen: this.idgen,
    });
  }

  /**
   * Gate readiness → provision inbound if short → issue the invoice → return a PaymentIntent. Throws
   * `ReceiveNotReadyError` if inbound is short and no provisioner (request or instance default) is set.
   */
  async createIntent(req: CheckoutRequest): Promise<PaymentIntent> {
    const issued = await this.invoices.receive({
      asset: req.asset,
      amount: req.amount,
      description: req.description,
      expirySeconds: req.expirySeconds,
      currency: req.currency,
      ensureInbound: req.ensureInbound ?? this.ensureInbound,
    });
    const created_at = this.now();
    return {
      intent_id: this.idgen(),
      invoice: issued.invoice,
      payment_hash: issued.paymentHash,
      asset: issued.asset,
      amount: issued.amount,
      description: req.description,
      qr_payload: issued.invoice,
      created_at,
      expires_at: req.expirySeconds ? created_at + req.expirySeconds : undefined,
      metadata: req.metadata,
    };
  }

  /**
   * Wait for a previously-created intent to settle and produce a Receipt, firing an invoice webhook. The
   * intent's description/metadata are folded onto the receipt; `webhookUrl` falls back to the instance's.
   */
  async awaitSettlement(intent: PaymentIntent, opts: WatchOptions = {}): Promise<Receipt> {
    const issued: IssuedInvoice = {
      invoice: intent.invoice,
      paymentHash: intent.payment_hash,
      asset: intent.asset,
      amount: intent.amount,
    };
    return this.watcher.watch(issued, {
      ...opts,
      webhookUrl: opts.webhookUrl ?? this.webhookUrl,
      receipt: {
        description: intent.description,
        metadata: intent.metadata,
        issued_at: intent.created_at,
        ...opts.receipt,
      },
    });
  }

  /** Convenience: `createIntent` then block on `awaitSettlement`. Returns both the intent and its receipt. */
  async checkout(
    req: CheckoutRequest,
    opts: WatchOptions = {},
  ): Promise<{ intent: PaymentIntent; receipt: Receipt }> {
    const intent = await this.createIntent(req);
    const receipt = await this.awaitSettlement(intent, opts);
    return { intent, receipt };
  }
}
