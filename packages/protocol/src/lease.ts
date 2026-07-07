/**
 * Streaming-lease terms + rent math, shared by the payer (client `StreamingLease`) and any server-side
 * lease bookkeeping. The design decision this encodes:
 *
 *   Inbound liquidity is *rented*, not bought. The LSP opens the channel once; the merchant then pays a
 *   small recurring rent to keep it alive — denominated in the **channel's own asset** and paid back **over
 *   that same channel** out of received revenue. No second channel, no CKB rail, no oracle.
 *
 * Why this shape beats a one-time fee: rent is paid per period after the fact, so (1) the merchant never
 * pre-pays for uptime it might not get, (2) an LSP that closes early forfeits future rent, and (3) each
 * period is settled by a normal atomic Fiber payment — trust is bounded to a single period.
 *
 * Rent is priced as basis points of the leased capacity per period, keeping the LSP oracle-free (it earns
 * in the asset it lent). Time enters via `period_seconds`; the LSP's yield is `rate_bps_per_period` per
 * period, i.e. a rate per (capacity × time) — the correct economic shape for locked liquidity.
 */
import type { Asset, AssetOffering, StreamTerms } from "./types.js";
import { asBig } from "./num.js";
import { CKB, describeAsset } from "./assets.js";
import { computeFee } from "./fee.js";

/** Resolved streaming terms for a specific channel: the advertised `StreamTerms` bound to an asset + capacity. */
export interface LeaseTerms extends StreamTerms {
  /** The channel asset the rent is denominated and paid in (the same channel — never a new one). */
  asset: Asset;
  /** Inbound capacity leased, in the asset's base unit. The rent base. */
  capacity: string;
}

/**
 * Rent owed for a single period: `ceil(rate_bps_per_period · capacity / 10_000)`, in the asset's base unit.
 * Ceil so the LSP never under-charges by a rounding unit (matches the fee model's convention).
 */
export function rentPerPeriod(terms: LeaseTerms): bigint {
  const cap = asBig(terms.capacity);
  const bps = BigInt(Math.trunc(terms.rate_bps_per_period));
  return (cap * bps + 9_999n) / 10_000n;
}

/** Whole rent periods elapsed between two unix-second timestamps (floored, never negative). */
export function periodsElapsed(sinceUnix: number, nowUnix: number, periodSeconds: number): number {
  if (periodSeconds <= 0) return 0;
  return Math.max(0, Math.floor((nowUnix - sinceUnix) / periodSeconds));
}

/** Human-readable one-liner for logs and demos, e.g. `10 RUSD @ 5bps/86400s (grace 2) → 0.005 RUSD/period`. */
export function describeLease(terms: LeaseTerms): string {
  const rent = rentPerPeriod(terms).toString(10);
  return (
    `${terms.capacity} ${describeAsset(terms.asset)} @ ${terms.rate_bps_per_period}bps/` +
    `${terms.period_seconds}s (grace ${terms.grace_periods}) → ${rent}/period`
  );
}

/** Bind an offering's advertised stream terms to a chosen capacity. Returns undefined for a purchase-only offering. */
export function leaseTermsFor(offering: AssetOffering, capacity: string | bigint): LeaseTerms | undefined {
  if (!offering.stream) return undefined;
  return { asset: offering.asset, capacity: asBig(capacity).toString(10), ...offering.stream };
}

/**
 * The two-phase price of a lease at a given capacity:
 *   • `activation` — the one-time **CKB** fee that opens the channel (the first payment / minimum stake),
 *     from the offering's `fee_schedule`. Oracle-free: priced in CKB independent of the channel asset.
 *   • `stream` — the recurring rent in the **channel asset**, present only when the offering is a lease.
 * A purchase-only offering (no `stream`) yields just `activation`.
 */
export interface LeaseQuote {
  activation: { asset: Asset; amount: string };
  stream?: { terms: LeaseTerms; rentPerPeriod: string };
}

export function quoteLease(offering: AssetOffering, capacity: string | bigint): LeaseQuote {
  // The activation fee follows the existing CKB fee model (proportional term only for CKB channels).
  const activation = computeFee(offering.fee_schedule, capacity, offering.asset.kind === "CKB").total;
  const quote: LeaseQuote = { activation: { asset: CKB, amount: activation.toString(10) } };
  const terms = leaseTermsFor(offering, capacity);
  if (terms) quote.stream = { terms, rentPerPeriod: rentPerPeriod(terms).toString(10) };
  return quote;
}
