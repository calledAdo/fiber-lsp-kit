/**
 * The settlement-record + webhook wire format, shared by receiver and server.
 *
 * A {@link Receipt} is the durable artifact filed when an invoice reaches a terminal state: what was
 * invoiced, whether it was paid, when, and any merchant metadata. It's produced for *any* terminal
 * outcome (paid, or Expired/Cancelled with `paid: false`), so a ledger reflects attempts, not only wins.
 *
 * It lives in the protocol package because both sides emit it identically: the client SDK's
 * `PaymentWatcher` (polling from the app) and the reference server's invoice-webhook service (polling from
 * a backend) build the same Receipt and POST the same `{ type, receipt }` event — so a merchant backend
 * consumes either interchangeably.
 */
import type { Asset } from "./types.js";

/** FNN invoice status (from `CkbInvoiceStatus`; serialized PascalCase). `Paid` == settled. */
export type InvoiceStatus = "Open" | "Cancelled" | "Expired" | "Received" | "Paid";

export interface Receipt {
  /** Stable id for this settlement record (not the payment hash — a merchant-facing handle). */
  receipt_id: string;
  /** The payable invoice string the payer settled. */
  invoice: string;
  /** The invoice's payment hash — the on-node identity, used for reconciliation. */
  payment_hash: string;
  asset: Asset;
  /** Amount invoiced, in the asset's base unit (decimal string). */
  amount: string;
  description?: string;
  /** The terminal invoice status this record was cut at (`Paid` / `Expired` / `Cancelled`). */
  status: InvoiceStatus;
  /** True iff `status === "Paid"`. */
  paid: boolean;
  /** Unix seconds the invoice was issued. */
  issued_at: number;
  /** Unix seconds the invoice settled; set only when `paid`. */
  settled_at?: number;
  /** LSP fee paid (CKB shannons) to provision the inbound this was received over, when known. */
  fee_paid?: string;
  /** Free-form merchant metadata (order id, cart id, customer ref, …). */
  metadata?: Record<string, string>;
}

/** The invoice bits a receipt is built from. Structurally satisfied by the client's `IssuedInvoice`. */
export interface SettledInvoice {
  invoice: string;
  paymentHash: string;
  asset: Asset;
  amount: string;
}

/** The terminal outcome a receipt is built from. Structurally satisfied by the client's `InvoiceOutcome`. */
export interface SettlementOutcome {
  status: InvoiceStatus;
  paid: boolean;
}

/** Context folded into a Receipt beyond what the invoice/outcome carry. Times/id are injectable for tests. */
export interface ReceiptContext {
  description?: string;
  issued_at?: number;
  settled_at?: number;
  fee_paid?: string;
  metadata?: Record<string, string>;
  idgen?: () => string;
  now?: () => number;
}

function defaultId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `rcpt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/**
 * Build a Receipt from a settled invoice and its terminal outcome. `settled_at` is stamped only when the
 * outcome is `Paid`; everything else (description, fee, metadata, clocks) comes from `ctx` so the caller
 * controls provenance and tests stay deterministic.
 */
export function buildReceipt(
  invoice: SettledInvoice,
  outcome: SettlementOutcome,
  ctx: ReceiptContext = {},
): Receipt {
  const now = ctx.now ?? (() => Math.floor(Date.now() / 1000));
  const idgen = ctx.idgen ?? defaultId;
  return {
    receipt_id: idgen(),
    invoice: invoice.invoice,
    payment_hash: invoice.paymentHash,
    asset: invoice.asset,
    amount: invoice.amount,
    description: ctx.description,
    status: outcome.status,
    paid: outcome.paid,
    issued_at: ctx.issued_at ?? now(),
    settled_at: outcome.paid ? (ctx.settled_at ?? now()) : undefined,
    fee_paid: ctx.fee_paid,
    metadata: ctx.metadata,
  };
}

/** The webhook event a settlement produces. Wire shape: `{ type, receipt }`. */
export type WebhookEventType = "invoice.paid" | "invoice.expired" | "invoice.cancelled";

export interface WebhookEvent {
  type: WebhookEventType;
  receipt: Receipt;
}

/** `Paid`/`Cancelled`/`Expired` are the terminal states; other statuses produce no event (`null`). */
export function webhookEventTypeFor(status: InvoiceStatus): WebhookEventType | null {
  switch (status) {
    case "Paid":
      return "invoice.paid";
    case "Expired":
      return "invoice.expired";
    case "Cancelled":
      return "invoice.cancelled";
    default:
      return null;
  }
}

/** True for the terminal invoice states (`Paid` settled; `Cancelled`/`Expired` terminal failures). */
export function isInvoiceTerminal(status: InvoiceStatus): boolean {
  return status === "Paid" || status === "Cancelled" || status === "Expired";
}
