/**
 * Timing helpers for reading FNN's real deadlines instead of assuming them.
 *
 * Two deadlines matter for a held payment and the invoice that funds a forward:
 *   - the on-chain TLC expiry of a held payment (hard: past it the payer can force-close and reclaim), read
 *     from `list_channels` → `pending_tlcs[].expiry`;
 *   - an invoice's absolute expiry, computed from `parse_invoice`'s `data.timestamp` + its `expiry_time` attr.
 *
 * FNN encodes TLC expiry and invoice timestamp as **milliseconds** and the invoice `expiry_time` attr as
 * **seconds**; these helpers normalize to unix **seconds** so callers compare against a `now()` in seconds.
 */
import type { RawChannel } from "./rpc.js";

function hexToBig(v: string | undefined): bigint | undefined {
  if (!v) return undefined;
  try {
    return BigInt(v);
  } catch {
    return undefined;
  }
}

/**
 * The earliest on-chain expiry (unix **seconds**) among a node's in-flight TLCs matching `paymentHash`, or
 * `undefined` when none is found (TLC not yet locked in, or the node doesn't report `pending_tlcs`). Scans
 * every channel because a held payment can arrive over any of them.
 */
export function receivedTlcExpirySeconds(channels: RawChannel[], paymentHash: string): number | undefined {
  const want = paymentHash.toLowerCase();
  let earliestMs: bigint | undefined;
  for (const c of channels) {
    for (const tlc of c.pending_tlcs ?? []) {
      if (tlc.payment_hash?.toLowerCase() !== want) continue;
      const ms = hexToBig(tlc.expiry);
      if (ms !== undefined && (earliestMs === undefined || ms < earliestMs)) earliestMs = ms;
    }
  }
  return earliestMs === undefined ? undefined : Number(earliestMs / 1000n);
}

type ParsedInvoice = {
  invoice: { data?: { timestamp?: string; attrs?: Array<Record<string, unknown>> } };
};

/**
 * A parsed invoice's absolute expiry in unix **seconds**, from `data.timestamp` (ms) + the `expiry_time`
 * attr (seconds). Returns `undefined` if either is missing/unparseable.
 */
export function invoiceExpirySeconds(parsed: ParsedInvoice): number | undefined {
  const data = parsed.invoice?.data;
  const tsMs = hexToBig(data?.timestamp);
  if (tsMs === undefined) return undefined;
  const attr = (data?.attrs ?? []).find((a) => "expiry_time" in a);
  const expirySec = attr ? hexToBig(String(attr.expiry_time)) : undefined;
  if (expirySec === undefined) return undefined;
  return Number(tsMs / 1000n + expirySec);
}
