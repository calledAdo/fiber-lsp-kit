/**
 * StreamingLease — the merchant side of a rented inbound channel.
 *
 * Instead of paying the LSP one lump fee up front, the merchant streams a small rent each period to keep the
 * leased channel alive. This primitive drives that stream from the merchant's own node:
 *
 *   • Rent is paid by **keysend** (spontaneous pay to the LSP's pubkey) — no per-period invoice from the LSP.
 *     Verified live over UDT on FNN v0.9.0-rc5.
 *   • Rent is denominated in and paid over the **same channel** the LSP opened, in that channel's asset, out
 *     of received revenue — so no second channel and no CKB rail are needed once sales start.
 *   • Each period is a normal atomic Fiber payment, so trust is bounded to a single period: an LSP that
 *     closes early forfeits future rent, and the merchant never pre-pays for uptime it might not get.
 *
 * A useful side effect: paying rent back shifts balance toward the LSP, which **restores the merchant's
 * inbound headroom** — receiving depletes inbound, rent replenishes it (FNN treats keysend-to-self as the
 * native rebalance, and this is the same motion pointed at the LSP).
 *
 * `payDue()` is one pass (dry-run affordability check → keysend → confirm), easily tested; `start()` runs it
 * once per period with an injectable clock/sleep so it needs no real timers.
 */
import {
  type Asset,
  type LeaseTerms,
  asBig,
  assetEquals,
  assetUdtScript,
  rentPerPeriod,
} from "@fiberlsp/protocol";
import { channelAsset, isChannelReady, type FiberChannelRpcClient } from "@fiberlsp/fiber";

export interface RentPayment {
  /** 1-based index of this rent period within the lease's lifetime. */
  period: number;
  /** Rent owed for the period, in the asset's base unit. */
  amount: string;
  /** Live remaining inbound capacity used as this period's rent base. */
  remainingInbound?: string;
  asset: Asset;
  status: "paid" | "skipped";
  /** Set once a keysend is dispatched. */
  payment_hash?: string;
  /** Routing fee paid (hex shannons); `0x0` over a direct channel. */
  fee?: string;
  /** Why the period was skipped (e.g. no route / not yet affordable / payment failed). */
  reason?: string;
  /** Unix seconds the pass ran. */
  at: number;
}

export interface LapseInfo {
  consecutiveMisses: number;
  grace: number;
  at: number;
}

export interface LeaseHandlers {
  /** A period's rent settled. */
  onPaid?: (p: RentPayment) => void;
  /** A period was skipped (unaffordable, unroutable, or the payment failed). */
  onSkip?: (p: RentPayment) => void;
  /** Consecutive misses exceeded `grace_periods` — the LSP is now entitled to close the channel. */
  onLapse?: (info: LapseInfo) => void;
  /** A pass threw. The loop keeps running. */
  onError?: (err: unknown) => void;
}

export interface StreamingLeaseConfig {
  /** The merchant's own FNN node — the payer. */
  rpc: FiberChannelRpcClient;
  /** Exact leased `channel_id` or `channel_outpoint`; other channels are never included in this lease. */
  channelId: string;
  terms: LeaseTerms;
  handlers?: LeaseHandlers;
  now?: () => number;
  /** How long to wait for a rent keysend to reach a terminal state. */
  poll?: { attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> };
}

export interface LeaseStartOptions {
  /** Period length override in ms. Defaults to `terms.period_seconds * 1000`. */
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface LeaseHandle {
  stop: () => void;
  done: Promise<void>;
}

export interface CurrentRent {
  /** Canonical channel outpoint when available, otherwise its temporary/channel id. */
  channelId: string;
  /** Channel counterparty that receives rent, including a delegated paying node in a two-node JIT setup. */
  peerPubkey: string;
  /** Live remaining merchant inbound, capped at the capacity originally leased. */
  remainingInbound: string;
  /** Rent due now, in the channel asset's base unit. */
  amount: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class StreamingLease {
  private readonly rpc: FiberChannelRpcClient;
  private readonly channelId: string;
  private readonly terms: LeaseTerms;
  private readonly handlers: LeaseHandlers;
  private readonly now: () => number;
  private readonly poll: Required<NonNullable<StreamingLeaseConfig["poll"]>>;

  private _period = 0;
  private _paidCount = 0;
  private _totalPaid = 0n;
  private _consecutiveMisses = 0;
  private _lastPaidAt?: number;
  private _lapsed = false;

  constructor(cfg: StreamingLeaseConfig) {
    this.rpc = cfg.rpc;
    this.channelId = cfg.channelId;
    this.terms = cfg.terms;
    this.handlers = cfg.handlers ?? {};
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
    this.poll = {
      attempts: cfg.poll?.attempts ?? 30,
      intervalMs: cfg.poll?.intervalMs ?? 1000,
      sleep: cfg.poll?.sleep ?? defaultSleep,
    };
  }

  /** Initial maximum rent quote. `payDue()` prices the live bound-channel balance instead. */
  rent(): string {
    return rentPerPeriod(this.terms).toString(10);
  }

  /** Read and price the exact leased channel without moving funds. */
  async currentRent(): Promise<CurrentRent> {
    const channels = await this.rpc.listChannels();
    const channel = channels.find(
      (candidate) =>
        candidate.channel_id === this.channelId || candidate.channel_outpoint === this.channelId,
    );
    if (!channel) throw new Error(`bound lease channel ${this.channelId} not found`);
    if (!isChannelReady(channel) || !channel.enabled) {
      throw new Error(`bound lease channel ${this.channelId} is not ready and enabled`);
    }
    if (!assetEquals(channelAsset(channel), this.terms.asset)) {
      throw new Error(`bound lease channel ${this.channelId} uses a different asset`);
    }

    const original = asBig(this.terms.capacity);
    const live = asBig(channel.remote_balance);
    const remaining = live < original ? live : original;
    return {
      channelId: channel.channel_outpoint ?? channel.channel_id,
      peerPubkey: channel.pubkey,
      remainingInbound: remaining.toString(10),
      amount: rentPerPeriod(this.terms, remaining).toString(10),
    };
  }

  get periodsPaid(): number {
    return this._paidCount;
  }
  /** Total rent settled so far, in the asset's base unit. */
  get totalPaid(): string {
    return this._totalPaid.toString(10);
  }
  get consecutiveMisses(): number {
    return this._consecutiveMisses;
  }
  get lastPaidAt(): number | undefined {
    return this._lastPaidAt;
  }
  /** True once misses have exceeded grace — the LSP may close the channel. */
  get lapsed(): boolean {
    return this._lapsed;
  }

  /**
   * Attempt one period's rent: dry-run to confirm it's affordable/routable, then keysend it and confirm the
   * payment reached `Success`. A skip (unaffordable pre-revenue, no route, or a failed payment) counts as a
   * miss; once misses exceed `grace_periods`, `onLapse` fires.
   */
  async payDue(): Promise<RentPayment> {
    const period = ++this._period;
    const asset = this.terms.asset;
    const udtTypeScript = assetUdtScript(asset);
    const at = this.now();
    let amount = 0n;
    let remainingInbound: string | undefined;
    let rentRecipient: string | undefined;
    const base = () => ({ period, amount: amount.toString(10), remainingInbound, asset } as const);

    const skip = (reason: string): RentPayment => {
      const p: RentPayment = { ...base(), status: "skipped", reason, at };
      this._consecutiveMisses += 1;
      this.handlers.onSkip?.(p);
      if (!this._lapsed && this._consecutiveMisses > this.terms.grace_periods) {
        this._lapsed = true;
        this.handlers.onLapse?.({ consecutiveMisses: this._consecutiveMisses, grace: this.terms.grace_periods, at });
      }
      return p;
    };

    try {
      const current = await this.currentRent();
      amount = asBig(current.amount);
      remainingInbound = current.remainingInbound;
      rentRecipient = current.peerPubkey;
    } catch (err) {
      return skip(err instanceof Error ? err.message : "unable to read bound lease channel");
    }

    const recordPaid = (payment_hash?: string, fee?: string): RentPayment => {
      this._paidCount += 1;
      this._totalPaid += amount;
      this._consecutiveMisses = 0;
      this._lastPaidAt = at;
      const paid: RentPayment = { ...base(), status: "paid", payment_hash, fee, at };
      this.handlers.onPaid?.(paid);
      return paid;
    };

    // No LSP-funded balance remains exposed, so this period is satisfied without a zero-value RPC payment.
    if (amount === 0n) return recordPaid();

    // Pre-flight: build + price the route without moving funds. A fresh merchant with no revenue yet has no
    // spendable balance, so this cleanly defers rent until the first sale lands.
    try {
      const dry = await this.rpc.sendPayment({ targetPubkey: rentRecipient!, amount, keysend: true, udtTypeScript, dryRun: true });
      if (dry.status === "Failed") return skip(dry.failed_error || "route not payable (dry-run failed)");
    } catch (err) {
      return skip(err instanceof Error ? err.message : "dry-run rejected");
    }

    // Dispatch the real rent keysend and wait for it to settle.
    let hash: string;
    let fee: string | undefined;
    try {
      const sent = await this.rpc.sendPayment({ targetPubkey: rentRecipient!, amount, keysend: true, udtTypeScript, dryRun: false });
      hash = sent.payment_hash;
      fee = sent.fee;
      for (let i = 0; i < this.poll.attempts; i++) {
        if (sent.status === "Success") break;
        if (sent.status === "Failed") return { ...skip(sent.failed_error || "payment failed"), payment_hash: hash };
        await this.poll.sleep(this.poll.intervalMs);
        const got = await this.rpc.getPayment(hash);
        sent.status = got.status;
        fee = got.fee ?? fee;
        if (got.status === "Success") break;
        if (got.status === "Failed") return { ...skip(got.failed_error || "payment failed"), payment_hash: hash };
      }
      if (sent.status !== "Success") return { ...skip("payment did not confirm in time"), payment_hash: hash };
    } catch (err) {
      return skip(err instanceof Error ? err.message : "send rejected");
    }

    return recordPaid(hash, fee);
  }

  /** Pay rent once per period until `stop()`. Errors are routed to `onError`, never thrown out of the loop. */
  start(opts: LeaseStartOptions = {}): LeaseHandle {
    const intervalMs = opts.intervalMs ?? this.terms.period_seconds * 1000;
    const sleep = opts.sleep ?? defaultSleep;
    let running = true;
    const done = (async () => {
      while (running) {
        try {
          await this.payDue();
        } catch (err) {
          this.handlers.onError?.(err) ??
            console.warn(`[fiberlsp] lease rent pass failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (running) await sleep(intervalMs);
      }
    })();
    return { stop: () => void (running = false), done };
  }
}
