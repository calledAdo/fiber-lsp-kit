/**
 * ReceiveStrategy — one composable brick for "become able to receive a payment, then settle it".
 *
 * A merchant needs inbound liquidity to be paid. There are several ways to get it, and this package treats
 * each as an interchangeable strategy behind one interface instead of a hardcoded flow:
 *
 *   - DirectReceive — issue over inbound you already have, or top it up first via an injected `ensureInbound`
 *     hook (e.g. `buyInboundFromLsp`). The customer pays a normal invoice on the merchant's own node.
 *   - JitReceive    — no inbound is provisioned ahead of time; the channel opens *on* the paying transaction
 *     via the LSP's hold/leg linkage. The customer pays the LSP's hold invoice.
 *
 * Both `originate()` a {@link ReceiveHandle}: the payable invoice plus a uniform `awaitSettlement()` that
 * resolves to the same {@link Receipt} shape, so callers (or `MerchantCheckout`, or `autoStrategy`) can swap
 * or select strategies without branching on the mechanism.
 */
import {
  buildReceipt,
  webhookEventTypeFor,
  type Asset,
  type Receipt,
  type SettlementOutcome,
} from "@fiberlsp/protocol";
import { InvoiceService, type ReceiveReadiness } from "./InvoiceService.js";
import { PaymentWatcher, type WatchOptions, type WebhookPoster } from "./PaymentWatcher.js";
import type { JitCheckout, JitCheckoutSession } from "./JitCheckout.js";

/** A charge request, mechanism-agnostic: the same shape every strategy originates from. */
export interface OriginateRequest {
  asset: Asset;
  /** Amount to charge, in the asset's base unit (decimal string). */
  amount: string;
  description?: string;
  expirySeconds?: number;
  /** Invoice currency tag (defaults to the node's default, e.g. "Fibt" on testnet). */
  currency?: string;
  /** Merchant metadata folded onto the settlement receipt. */
  metadata?: Record<string, string>;
  /** Default webhook URL for the settlement event; an `awaitSettlement` call can override it. */
  webhookUrl?: string;
}

/** The payable artifact a strategy produced, plus a uniform way to block until it settles into a Receipt. */
export interface ReceiveHandle {
  /** The payable invoice string the customer settles (a QR encodes exactly this). */
  invoice: string;
  payment_hash: string;
  asset: Asset;
  /** Amount the customer pays, in the asset's base unit. */
  amount: string;
  /** Unix seconds the invoice expires, when an expiry was requested. */
  expires_at?: number;
  /** Which strategy originated this handle ("direct" | "jit" | …) — for logging/branching. */
  strategy: string;
  /** Block until the payment reaches a terminal state; always resolves to a Receipt (paid or not). */
  awaitSettlement(opts?: WatchOptions): Promise<Receipt>;
}

/** One way to become able to receive a payment and settle it. Implementations: DirectReceive, JitReceive. */
export interface ReceiveStrategy {
  readonly name: string;
  originate(req: OriginateRequest): Promise<ReceiveHandle>;
}

async function defaultPostWebhook(url: string, event: unknown): Promise<void> {
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
}

/** Best-effort invoice-webhook delivery: a failure is logged, never thrown, never loses the receipt. */
async function deliverWebhook(post: WebhookPoster, url: string, receipt: Receipt): Promise<void> {
  const type = webhookEventTypeFor(receipt.status);
  if (!type) return;
  try {
    await post(url, { type, receipt });
  } catch (e) {
    console.warn(`[fiberlsp] invoice webhook to ${url} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface DirectReceiveConfig {
  invoices: InvoiceService;
  /** Provision inbound if short (e.g. `buyInboundFromLsp(lsp, …)`). Omit to require inbound already exists. */
  ensureInbound?: (readiness: ReceiveReadiness) => Promise<void>;
  postWebhook?: WebhookPoster;
  now?: () => number;
  idgen?: () => string;
}

/** Receive over the merchant's own node: gate readiness, optionally provision inbound, issue, then watch. */
export class DirectReceive implements ReceiveStrategy {
  readonly name = "direct";
  private readonly invoices: InvoiceService;
  private readonly ensureInbound?: (readiness: ReceiveReadiness) => Promise<void>;
  private readonly watcher: PaymentWatcher;
  private readonly now: () => number;

  constructor(cfg: DirectReceiveConfig) {
    this.invoices = cfg.invoices;
    this.ensureInbound = cfg.ensureInbound;
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
    this.watcher = new PaymentWatcher({
      invoices: cfg.invoices,
      postWebhook: cfg.postWebhook,
      now: cfg.now,
      idgen: cfg.idgen,
    });
  }

  async originate(req: OriginateRequest): Promise<ReceiveHandle> {
    const issued = await this.invoices.receive({
      asset: req.asset,
      amount: req.amount,
      description: req.description,
      expirySeconds: req.expirySeconds,
      currency: req.currency,
      ensureInbound: this.ensureInbound,
    });
    const created_at = this.now();
    return {
      invoice: issued.invoice,
      payment_hash: issued.paymentHash,
      asset: issued.asset,
      amount: issued.amount,
      expires_at: req.expirySeconds ? created_at + req.expirySeconds : undefined,
      strategy: this.name,
      awaitSettlement: (opts: WatchOptions = {}) =>
        this.watcher.watch(issued, {
          ...opts,
          webhookUrl: opts.webhookUrl ?? req.webhookUrl,
          receipt: { description: req.description, metadata: req.metadata, issued_at: created_at, ...opts.receipt },
        }),
    };
  }
}

export interface JitReceiveConfig {
  /** A pre-configured JitCheckout (carries the merchant node, LSP URL, and linkage prover). */
  jit: JitCheckout;
  postWebhook?: WebhookPoster;
  now?: () => number;
  idgen?: () => string;
}

/** Just-in-time receive: the channel opens on the paying transaction. The customer pays the LSP hold invoice. */
export class JitReceive implements ReceiveStrategy {
  readonly name = "jit";
  private readonly post: WebhookPoster;
  private readonly now: () => number;
  private readonly idgen?: () => string;

  constructor(private readonly cfg: JitReceiveConfig) {
    this.post = cfg.postWebhook ?? defaultPostWebhook;
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
    this.idgen = cfg.idgen;
  }

  async originate(req: OriginateRequest): Promise<ReceiveHandle> {
    const session = await this.cfg.jit.checkout({
      asset: req.asset,
      amount: req.amount,
      description: req.description,
      expirySeconds: req.expirySeconds,
      webhookUrl: req.webhookUrl,
    });
    const created_at = this.now();
    return {
      invoice: session.invoice,
      payment_hash: session.paymentHash,
      asset: req.asset,
      amount: req.amount,
      expires_at: session.order.expires_at,
      strategy: this.name,
      awaitSettlement: (opts: WatchOptions = {}) => this.settle(session, req, created_at, opts),
    };
  }

  /** Drive the JIT session to a terminal state and cut the same Receipt shape DirectReceive produces. */
  private async settle(
    session: JitCheckoutSession,
    req: OriginateRequest,
    created_at: number,
    opts: WatchOptions,
  ): Promise<Receipt> {
    let outcome: SettlementOutcome;
    try {
      const order = await session.settle({ attempts: opts.attempts, intervalMs: opts.intervalMs });
      outcome = jitStateOutcome(order.state);
    } catch (e) {
      // JitCheckout throws on refund/expiry/timeout; map the failure to an unpaid terminal receipt.
      outcome = jitErrorOutcome((e as { code?: string }).code);
    }
    const receipt = buildReceipt(
      { invoice: session.invoice, paymentHash: session.paymentHash, asset: req.asset, amount: req.amount },
      outcome,
      {
        description: req.description,
        metadata: req.metadata,
        issued_at: created_at,
        fee_paid: session.fee,
        now: this.now,
        idgen: this.idgen,
        ...opts.receipt,
      },
    );
    opts.onSettled?.(receipt);
    const url = opts.webhookUrl ?? req.webhookUrl;
    if (url) await deliverWebhook(this.post, url, receipt);
    return receipt;
  }
}

function jitStateOutcome(state: string): SettlementOutcome {
  switch (state) {
    case "settled":
      return { status: "Paid", paid: true };
    case "refunded":
      return { status: "Cancelled", paid: false };
    case "expired":
      return { status: "Expired", paid: false };
    default:
      return { status: "Open", paid: false };
  }
}

function jitErrorOutcome(code?: string): SettlementOutcome {
  if (code === "order_refunded" || code === "leg_cancelled") return { status: "Cancelled", paid: false };
  if (code === "order_expired" || code === "leg_expired") return { status: "Expired", paid: false };
  return { status: "Open", paid: false }; // timeout / unknown: non-terminal, no webhook fires
}
