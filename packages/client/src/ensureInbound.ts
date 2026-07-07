/**
 * `ensureInbound` glue — the seam between "I need to receive X" and "make sure I can".
 *
 * `InvoiceService.receive` calls a caller-supplied `ensureInbound(readiness)` hook when inbound is short. It
 * deliberately doesn't know *how* to top up. This module supplies the common implementation: buy the
 * shortfall from an LSP. Kept separate so `InvoiceService` stays standalone (no hard LspClient dependency)
 * and the hook stays swappable (pool, manual approval, a different provider, …).
 */
import { LspClient, type BuyInboundParams } from "./LspClient.js";
import type { ReceiveReadiness } from "./InvoiceService.js";

export interface BuyInboundEnsureOptions extends Omit<BuyInboundParams, "asset" | "amount"> {
  /**
   * How much inbound to buy, given the current shortfall. Defaults to buying exactly the shortfall. Return
   * more to provision a buffer so later receives don't re-provision — e.g. `(s) => (BigInt(s) * 4n).toString()`.
   * Note: the amount must satisfy the LSP's `min_capacity` for the asset, so size accordingly.
   */
  amountFor?: (shortfall: string, readiness: ReceiveReadiness) => string;
}

/**
 * Build an `ensureInbound` hook that provisions the shortfall by buying inbound from `lsp`.
 *
 * `asset` and `amount` come from the readiness at call time; everything else (`targetPubkey`, `feeMode`,
 * `payFee`, `waitOpts`, …) comes from `opts`. Throws if the order doesn't reach `channel_active`, so the
 * caller's post-provision readiness re-check fails loudly rather than issuing an unpayable invoice.
 *
 * ```ts
 * await svc.receive({
 *   asset: RUSD, amount: "30 RUSD",
 *   ensureInbound: buyInboundFromLsp(lsp, { feeMode: "prepaid", targetPubkey: myNode, payFee }),
 * });
 * ```
 */
export function buyInboundFromLsp(
  lsp: LspClient,
  opts: BuyInboundEnsureOptions,
): (readiness: ReceiveReadiness) => Promise<void> {
  const { amountFor, ...buyParams } = opts;
  return async (readiness) => {
    const amount = amountFor ? amountFor(readiness.shortfall, readiness) : readiness.shortfall;
    const order = await lsp.buyInboundLiquidity({
      ...buyParams,
      asset: readiness.asset,
      amount,
    });
    if (order.state !== "channel_active") {
      throw new Error(
        `inbound provisioning did not complete: order ${order.order_id} is "${order.state}"` +
          (order.failure_reason ? ` (${order.failure_reason})` : ""),
      );
    }
  };
}
