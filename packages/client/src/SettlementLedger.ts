/**
 * SettlementLedger — the merchant's book of received Fiber payments.
 *
 * It stores {@link Receipt}s, rolls them up per asset, reconciles them against the node's own invoice
 * state, and exports them for accounting. The store is pluggable behind {@link LedgerStore}:
 * `MemoryLedgerStore` (default) is fine for a demo/test; `FileLedgerStore` (separate module, Node-only)
 * survives a restart. This module stays dependency-free so it runs anywhere.
 */
import {
  type Asset,
  type InvoiceStatus,
  type Receipt,
  asBig,
  canonicalAssetId,
  describeAsset,
} from "@fiberlsp/protocol";

export interface LedgerStore {
  put(receipt: Receipt): void;
  get(id: string): Receipt | undefined;
  all(): Receipt[];
}

export class MemoryLedgerStore implements LedgerStore {
  private readonly receipts = new Map<string, Receipt>();
  put(receipt: Receipt): void {
    this.receipts.set(receipt.receipt_id, receipt);
  }
  get(id: string): Receipt | undefined {
    return this.receipts.get(id);
  }
  all(): Receipt[] {
    return [...this.receipts.values()];
  }
}

/** Per-asset rollup for a reconciliation dashboard. Amounts are decimal strings in the asset's base unit. */
export interface AssetTotals {
  asset: Asset;
  label: string;
  receipt_count: number;
  paid_count: number;
  /** Sum of `amount` over *paid* receipts. */
  received: string;
  /** Sum of `fee_paid` over receipts that recorded a fee. */
  fees_paid: string;
}

/** One receipt whose recorded outcome disagrees with the node's current invoice status. */
export interface ReconcileDiscrepancy {
  receipt_id: string;
  payment_hash: string;
  recorded_status: InvoiceStatus;
  node_status: InvoiceStatus;
}

export interface ReconcileReport {
  checked: number;
  matched: number;
  discrepancies: ReconcileDiscrepancy[];
}

/** Minimal node surface the ledger needs to reconcile — satisfied by `FiberChannelRpcClient`. */
export interface InvoiceStatusSource {
  getInvoice(paymentHash: string): Promise<{ status: InvoiceStatus }>;
}

export interface ListFilter {
  /** Only receipts in this asset. */
  asset?: Asset;
  /** `true` → only paid, `false` → only unpaid. Omit for all. */
  paid?: boolean;
  /** Only receipts issued at or after this unix-seconds bound. */
  since?: number;
  /** Only receipts issued at or before this unix-seconds bound. */
  until?: number;
}

export class SettlementLedger {
  constructor(private readonly store: LedgerStore = new MemoryLedgerStore()) {}

  /** File a receipt. Idempotent by `receipt_id`. */
  record(receipt: Receipt): void {
    this.store.put(receipt);
  }

  get(id: string): Receipt | undefined {
    return this.store.get(id);
  }

  /** All receipts (newest-issued first), optionally filtered. */
  list(filter: ListFilter = {}): Receipt[] {
    const wantAsset = filter.asset ? canonicalAssetId(filter.asset) : undefined;
    return this.store
      .all()
      .filter((r) => {
        if (filter.paid !== undefined && r.paid !== filter.paid) return false;
        if (wantAsset !== undefined && canonicalAssetId(r.asset) !== wantAsset) return false;
        if (filter.since !== undefined && r.issued_at < filter.since) return false;
        if (filter.until !== undefined && r.issued_at > filter.until) return false;
        return true;
      })
      .sort((a, b) => b.issued_at - a.issued_at);
  }

  /** Roll receipts up per asset — the numbers behind a reconciliation dashboard. */
  totals(): AssetTotals[] {
    const groups = new Map<string, AssetTotals & { _received: bigint; _fees: bigint }>();
    for (const r of this.store.all()) {
      const key = canonicalAssetId(r.asset);
      if (key === null) continue;
      let g = groups.get(key);
      if (!g) {
        g = {
          asset: r.asset,
          label: describeAsset(r.asset),
          receipt_count: 0,
          paid_count: 0,
          received: "0",
          fees_paid: "0",
          _received: 0n,
          _fees: 0n,
        };
        groups.set(key, g);
      }
      g.receipt_count += 1;
      if (r.paid) {
        g.paid_count += 1;
        g._received += asBig(r.amount);
      }
      if (r.fee_paid) g._fees += asBig(r.fee_paid);
    }
    return [...groups.values()].map(({ _received, _fees, ...t }) => ({
      ...t,
      received: _received.toString(10),
      fees_paid: _fees.toString(10),
    }));
  }

  /**
   * Cross-check recorded receipts against the node's live invoice status. Flags any receipt whose recorded
   * outcome disagrees with what the node now reports — e.g. a payment that landed after the merchant gave
   * up waiting (recorded unpaid, node `Paid`), or a status that changed underneath. Read-only.
   */
  async reconcile(node: InvoiceStatusSource): Promise<ReconcileReport> {
    const receipts = this.store.all();
    const discrepancies: ReconcileDiscrepancy[] = [];
    for (const r of receipts) {
      const { status } = await node.getInvoice(r.payment_hash);
      if (status !== r.status) {
        discrepancies.push({
          receipt_id: r.receipt_id,
          payment_hash: r.payment_hash,
          recorded_status: r.status,
          node_status: status,
        });
      }
    }
    return {
      checked: receipts.length,
      matched: receipts.length - discrepancies.length,
      discrepancies,
    };
  }

  /** Export the (optionally filtered) ledger for accounting. `json` is the raw receipts; `csv` is flat rows. */
  export(format: "csv" | "json", filter: ListFilter = {}): string {
    const rows = this.list(filter);
    if (format === "json") return JSON.stringify(rows, null, 2);
    return toCsv(rows);
  }
}

const CSV_COLUMNS = [
  "receipt_id",
  "status",
  "paid",
  "asset",
  "amount",
  "fee_paid",
  "issued_at",
  "settled_at",
  "payment_hash",
  "description",
] as const;

function toCsv(rows: Receipt[]): string {
  const header = CSV_COLUMNS.join(",");
  const body = rows.map((r) =>
    [
      r.receipt_id,
      r.status,
      String(r.paid),
      describeAsset(r.asset),
      r.amount,
      r.fee_paid ?? "",
      isoOrEmpty(r.issued_at),
      isoOrEmpty(r.settled_at),
      r.payment_hash,
      r.description ?? "",
    ]
      .map(csvCell)
      .join(","),
  );
  return [header, ...body].join("\n");
}

/** Render a unix-seconds timestamp as ISO 8601 for accounting readability; empty when unset. */
function isoOrEmpty(sec: number | undefined): string {
  return sec === undefined ? "" : new Date(sec * 1000).toISOString();
}

/** RFC-4180 quote a cell only when it contains a comma, quote, or newline. */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
