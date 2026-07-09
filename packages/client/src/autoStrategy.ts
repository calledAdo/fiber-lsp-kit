/**
 * autoStrategy — pick a ReceiveStrategy per request from current inbound readiness.
 *
 * Composes the bricks rather than hardcoding a path: it reads the receiver's inbound for the requested
 * amount, asks a `decide` policy which strategy fits, and delegates `originate` to it. The default policy is
 * "use what's cheapest to settle": if inbound already covers the amount, receive directly (no channel open);
 * otherwise open just-in-time. Override `decide` for any policy (e.g. amount thresholds, always-JIT, etc.).
 */
import type { InvoiceService, ReceiveReadiness } from "./InvoiceService.js";
import type { OriginateRequest, ReceiveHandle, ReceiveStrategy } from "./ReceiveStrategy.js";

export interface AutoStrategyConfig {
  /** Reads inbound readiness for the requested asset/amount. */
  invoices: InvoiceService;
  /** Strategy used when `decide` returns "direct". */
  direct: ReceiveStrategy;
  /** Strategy used when `decide` returns "jit". */
  jit: ReceiveStrategy;
  /** Policy: which strategy to use given readiness. Default: direct when inbound suffices, else jit. */
  decide?: (readiness: ReceiveReadiness) => "direct" | "jit";
}

/** A ReceiveStrategy that selects `direct` or `jit` per request from live inbound readiness. */
export function autoStrategy(cfg: AutoStrategyConfig): ReceiveStrategy {
  const decide = cfg.decide ?? ((r: ReceiveReadiness) => (r.canReceive ? "direct" : "jit"));
  return {
    name: "auto",
    async originate(req: OriginateRequest): Promise<ReceiveHandle> {
      const readiness = await cfg.invoices.checkReceiveReadiness(req.asset, req.amount);
      const chosen = decide(readiness) === "jit" ? cfg.jit : cfg.direct;
      return chosen.originate(req);
    },
  };
}
