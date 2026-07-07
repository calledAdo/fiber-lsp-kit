/**
 * LiquidityMonitor — keeps a merchant's *inbound* headroom above a floor so a sale never fails on "can't
 * receive".
 *
 * `MerchantCheckout` provisions inbound just-in-time, which can make the customer wait while a channel
 * opens. This monitor moves that work off the critical path: it watches inbound per asset and, when it
 * drops below a low-water mark, raises an alert and/or tops up ahead of demand — reusing the very same
 * `ensureInbound` hook (e.g. `buyInboundFromLsp(lsp, …)`) the checkout would have called reactively.
 *
 * `check()` is one pass (pure, easily tested); `start()` runs it on an interval with an injectable sleep so
 * it's driveable without real timers.
 */
import { type Asset, asBig } from "@fiberlsp/protocol";
import type { InvoiceService, ReceiveReadiness } from "./InvoiceService.js";

export interface LiquidityTarget {
  asset: Asset;
  /** Raise an alert / top up when inbound in this asset drops below this floor (base units). */
  minInbound: string;
  /** Provision back up to this level when triggered (base units). Defaults to `minInbound`. */
  targetInbound?: string;
}

export interface LiquidityAlert {
  asset: Asset;
  /** Inbound currently available in this asset (base units). */
  inbound: string;
  /** The floor that was breached. */
  minInbound: string;
  /** How much more inbound is needed to reach `targetInbound` (base units). */
  shortfall: string;
  /** Unix seconds the alert was raised. */
  at: number;
}

export interface MonitorHandlers {
  /** Auto top-up when a floor is breached (e.g. `buyInboundFromLsp(lsp, …)`). Omit for alert-only. */
  ensureInbound?: (readiness: ReceiveReadiness) => Promise<void>;
  /** Notified whenever a floor is breached, before any top-up runs. */
  onAlert?: (alert: LiquidityAlert) => void;
}

export interface MonitorConfig {
  invoices: InvoiceService;
  targets: LiquidityTarget[];
  handlers?: MonitorHandlers;
  now?: () => number;
}

export interface StartOptions {
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called if a `check()` pass throws; defaults to a console warning. The loop keeps running. */
  onError?: (err: unknown) => void;
}

export interface MonitorHandle {
  /** Stop the loop after the current pass. */
  stop: () => void;
  /** Resolves when the loop has fully stopped. */
  done: Promise<void>;
}

export class LiquidityMonitor {
  private readonly invoices: InvoiceService;
  private readonly targets: LiquidityTarget[];
  private readonly handlers: MonitorHandlers;
  private readonly now: () => number;

  constructor(cfg: MonitorConfig) {
    this.invoices = cfg.invoices;
    this.targets = cfg.targets;
    this.handlers = cfg.handlers ?? {};
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * One pass over every target: alert (and optionally top up) any asset whose inbound is below its floor.
   * Returns the alerts raised this pass. Top-ups run sequentially so a shared provisioner isn't hammered.
   */
  async check(): Promise<LiquidityAlert[]> {
    const alerts: LiquidityAlert[] = [];
    for (const t of this.targets) {
      // Readiness against the floor tells us the current inbound; against the target tells us the top-up size.
      const atFloor = await this.invoices.checkReceiveReadiness(t.asset, t.minInbound);
      if (asBig(atFloor.inbound) >= asBig(t.minInbound)) continue; // above the floor, nothing to do

      const target = t.targetInbound ?? t.minInbound;
      const toTarget = await this.invoices.checkReceiveReadiness(t.asset, target);
      const alert: LiquidityAlert = {
        asset: t.asset,
        inbound: atFloor.inbound,
        minInbound: t.minInbound,
        shortfall: toTarget.shortfall,
        at: this.now(),
      };
      alerts.push(alert);
      this.handlers.onAlert?.(alert);
      if (this.handlers.ensureInbound && asBig(toTarget.shortfall) > 0n) {
        await this.handlers.ensureInbound(toTarget);
      }
    }
    return alerts;
  }

  /** Run `check()` every `intervalMs` until `stop()` is called. Errors are routed to `onError`, not thrown. */
  start(opts: StartOptions): MonitorHandle {
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const onError =
      opts.onError ??
      ((err: unknown) =>
        console.warn(
          `[fiberlsp] liquidity monitor pass failed: ${err instanceof Error ? err.message : String(err)}`,
        ));
    let running = true;
    const done = (async () => {
      while (running) {
        try {
          await this.check();
        } catch (err) {
          onError(err);
        }
        if (running) await sleep(opts.intervalMs);
      }
    })();
    return { stop: () => void (running = false), done };
  }
}
