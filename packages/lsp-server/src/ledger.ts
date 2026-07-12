/**
 * LspLedger — reconciliation of what the LSP node has actually paid out, from the node's own durable
 * payment ledger (`list_payments`) rather than an in-memory tally that a restart would lose.
 *
 * For an LSP this is the on-chain-truth complement to the JIT order store: every leg forward it paid to a
 * merchant, every keysend, with routing fees — grouped by asset and settlement status. It turns "the demo
 * works" into "here is the operator's P&L", and underpins per-merchant settlement reports.
 *
 * NOTE: `list_payments` field shapes are docs-derived and not yet verified live (see `RawPayment`); the
 * aggregation is tolerant of missing `amount`/`fee` (treated as zero) so a partial node response degrades
 * gracefully instead of throwing.
 */
import { asBig, canonicalAssetId, udtAsset, CKB, type Asset } from "@fiberlsp/protocol";
import type { FiberChannelRpcClient, RawPayment } from "@fiberlsp/fiber";

export interface AssetLedgerLine {
  /** Canonical asset key: `"CKB"` or the UDT script's molecule hex. */
  asset: string;
  /** Total successfully-sent amount in this asset, base units, decimal. */
  sent: string;
  /** Total routing fees paid for those sends, base units, decimal. */
  fees: string;
  /** Number of successful payments in this asset. */
  count: number;
}

export interface LedgerSummary {
  total: number;
  succeeded: number;
  failed: number;
  inflight: number;
  /** Per-asset totals over the *successful* payments. */
  by_asset: AssetLedgerLine[];
}

const num = (hexOrDec?: string): bigint => (hexOrDec == null ? 0n : asBig(hexOrDec));

function assetKeyOf(p: RawPayment): string {
  const asset: Asset = p.udt_type_script ? udtAsset(p.udt_type_script) : CKB;
  return canonicalAssetId(asset) ?? "CKB";
}

/** Fold a list of payments into per-asset totals + a status breakdown. Pure; easy to test. */
export function summarizePayments(payments: RawPayment[]): LedgerSummary {
  const lines = new Map<string, { sent: bigint; fees: bigint; count: number }>();
  let succeeded = 0;
  let failed = 0;
  let inflight = 0;

  for (const p of payments) {
    if (p.status === "Success") {
      succeeded += 1;
      const key = assetKeyOf(p);
      const line = lines.get(key) ?? { sent: 0n, fees: 0n, count: 0 };
      line.sent += num(p.amount);
      line.fees += num(p.fee);
      line.count += 1;
      lines.set(key, line);
    } else if (p.status === "Failed") {
      failed += 1;
    } else {
      inflight += 1; // Created | Inflight
    }
  }

  const by_asset: AssetLedgerLine[] = [...lines.entries()]
    .map(([asset, l]) => ({ asset, sent: l.sent.toString(10), fees: l.fees.toString(10), count: l.count }))
    .sort((a, b) => a.asset.localeCompare(b.asset));

  return { total: payments.length, succeeded, failed, inflight, by_asset };
}

export class LspLedger {
  constructor(private readonly rpc: FiberChannelRpcClient) {}

  /** Pull the node's payment history and summarize it. */
  async summary(): Promise<LedgerSummary> {
    return summarizePayments(await this.rpc.listPayments());
  }
}
