/** Fee computation + order validation, shared by server (authoritative) and client (preview). */
import type { AssetOffering, CreateOrderRequest, FeeMode, FeeQuote, FeeSchedule } from "./types.js";
import { CKB, assetEquals } from "./assets.js";
import { asBig } from "./num.js";

/**
 * The LSP fee is ALWAYS denominated in CKB (shannons), never in the channel asset. Rationale:
 *  - A fresh client that wants to *buy* RUSD inbound has no RUSD yet — only faucet CKB. Charging the fee
 *    in CKB is the only way the flagship "buy per-asset inbound with no capital" flow works.
 *  - It keeps the LSP oracle-free: we never convert between a UDT and CKB.
 *
 * Consequently the proportional component (bps of capacity) is only meaningful when the *channel* asset
 * is itself CKB (same unit). For a UDT channel we charge the flat CKB `base_fee` only; pricing a UDT
 * channel proportionally would require a price oracle, which is out of scope for the MVP.
 *
 * Fee = base_fee + (channel is CKB ? ceil(proportional_bps * capacity / 10_000) : 0), in shannons.
 */
export function computeFee(
  schedule: FeeSchedule,
  capacity: string | bigint,
  applyProportional: boolean,
): { base: bigint; proportional: bigint; total: bigint } {
  const base = asBig(schedule.base_fee);
  const bps = BigInt(schedule.proportional_bps);
  // ceil division so the LSP never under-charges by a rounding unit
  const proportional = applyProportional ? (asBig(capacity) * bps + 9_999n) / 10_000n : 0n;
  return { base, proportional, total: base + proportional };
}

export function quoteFee(offering: AssetOffering, req: CreateOrderRequest): FeeQuote {
  const applyProportional = req.asset.kind === "CKB";
  const { base, proportional, total } = computeFee(
    offering.fee_schedule,
    req.lsp_balance,
    applyProportional,
  );
  return {
    asset: CKB, // the fee itself is always CKB
    base_fee: base.toString(10),
    proportional_fee: proportional.toString(10),
    total_fee: total.toString(10),
    fee_mode: req.fee_mode,
  };
}

export interface ValidationError {
  code:
    | "unsupported_asset"
    | "below_min_capacity"
    | "above_max_capacity"
    | "unsupported_fee_mode"
    | "from_capacity_requires_ckb"
    | "insufficient_client_balance";
  message: string;
}

/**
 * Validate an order against an offering. Two rules fall out of FNN's funding model + the CKB-fee decision:
 *  - "from_capacity" is CKB-channel-only: the fee is paid from the client's own outbound *on the new
 *    channel*, so that outbound must be CKB. A UDT channel can't pay a CKB fee from itself → use prepaid.
 *  - "from_capacity" requires client_balance (their CKB outbound) >= fee, because there is no push-at-open;
 *    the fee is an in-channel payment made right after the channel is ready.
 * See docs/LSPS-Fiber.md §Fee models.
 */
export function validateOrder(
  offering: AssetOffering,
  feeModes: FeeMode[],
  req: CreateOrderRequest,
): ValidationError | null {
  if (!assetEquals(offering.asset, req.asset)) {
    return { code: "unsupported_asset", message: "asset not offered by this LSP" };
  }
  const cap = asBig(req.lsp_balance);
  if (cap < asBig(offering.min_capacity)) {
    return {
      code: "below_min_capacity",
      message: `requested ${cap} < min ${offering.min_capacity}`,
    };
  }
  if (cap > asBig(offering.max_capacity)) {
    return {
      code: "above_max_capacity",
      message: `requested ${cap} > max ${offering.max_capacity}`,
    };
  }
  if (!feeModes.includes(req.fee_mode)) {
    return { code: "unsupported_fee_mode", message: `fee_mode ${req.fee_mode} not supported` };
  }
  if (req.fee_mode === "from_capacity") {
    if (req.asset.kind !== "CKB") {
      return {
        code: "from_capacity_requires_ckb",
        message: "from_capacity is only available for CKB channels; use prepaid for UDT assets",
      };
    }
    const fee = computeFee(offering.fee_schedule, req.lsp_balance, true).total;
    const clientBalance = asBig(req.client_balance ?? "0");
    if (clientBalance < fee) {
      return {
        code: "insufficient_client_balance",
        message: `from_capacity requires client_balance >= fee (${fee}); got ${clientBalance}`,
      };
    }
  }
  return null;
}
