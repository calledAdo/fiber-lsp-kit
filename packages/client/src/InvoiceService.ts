/**
 * InvoiceService — the receiver side of getting paid on Fiber.
 *
 * Invoicing is node-native: any Fiber node issues its own invoices (`new_invoice`) and watches them settle
 * (`get_invoice`). The LSP's role ends once your *inbound* is delivered; this service runs over that inbound
 * afterwards, repeatedly. It adds three thin things around the raw RPCs:
 *
 *   1. a **readiness gate** — you can only receive an amount you have inbound for, so check first;
 *   2. optional **just-in-time provisioning** — if inbound is short, a caller-supplied hook tops it up
 *      (e.g. buy it from an LSP) before the invoice is issued;
 *   3. **settlement watching** — poll until the invoice is `Paid`, so integrators don't hand-roll it.
 *
 * It talks to the *receiver's own* FNN node (not an LSP). Inbound, from the receiver's point of view, is the
 * balance the counterparty holds — the `remote_balance` of each ready channel in the asset.
 */
import {
  type Asset,
  type InvoiceStatus,
  asBig,
  assetEquals,
  assetUdtScript,
  udtAsset,
} from "@fiberlsp/protocol";
import { isChannelReady, type FiberChannelRpcClient, type RawChannel } from "@fiberlsp/fiber";

export interface InvoiceServiceConfig {
  /** The receiver's own FNN node. */
  rpc: FiberChannelRpcClient;
  /** The receiver node's pubkey, used to scope list_channels. Optional (list_channels can be unfiltered). */
  pubkey?: string;
}

export interface ReceiveReadiness {
  asset: Asset;
  /** Amount the receiver wants to receive (base units, decimal). */
  amount: string;
  /** Inbound the receiver currently has in this asset (sum of ready channels' remote balances). */
  inbound: string;
  canReceive: boolean;
  /** How much more inbound is needed; `"0"` when ready. */
  shortfall: string;
}

export interface IssueRequest {
  asset: Asset;
  /** Amount to invoice, in the asset's base unit. */
  amount: string;
  description?: string;
  expirySeconds?: number;
  /** Invoice currency tag (defaults to the node's default, e.g. "Fibt" on testnet). */
  currency?: string;
}

export interface IssuedInvoice {
  /** The payable invoice string (`invoice_address`) the payer settles. */
  invoice: string;
  paymentHash: string;
  asset: Asset;
  amount: string;
  expirySeconds?: number;
}

export interface ReceiveOptions extends IssueRequest {
  /**
   * Called when inbound is short, with the current readiness, to provision more before the invoice is
   * issued (e.g. `LspClient.buyInboundLiquidity`). If omitted and inbound is short, `receive` throws.
   */
  ensureInbound?: (readiness: ReceiveReadiness) => Promise<void>;
}

export interface WaitOptions {
  attempts?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called on every status read, so callers can surface progress. */
  onUpdate?: (status: InvoiceStatus) => void;
}

export interface InvoiceOutcome {
  status: InvoiceStatus;
  /** True once the invoice reached the settled `Paid` state. */
  paid: boolean;
  paymentHash: string;
}

/** Thrown by `receive` when inbound can't cover the amount and wasn't (or couldn't be) provisioned. */
export class ReceiveNotReadyError extends Error {
  constructor(public readonly readiness: ReceiveReadiness) {
    super(
      `cannot receive ${readiness.amount}: only ${readiness.inbound} inbound, short by ${readiness.shortfall}`,
    );
    this.name = "ReceiveNotReadyError";
  }
}

/** `Paid` is settled; `Cancelled`/`Expired` are terminal failures. `Open`/`Received` are still in flight. */
function isInvoiceTerminal(status: InvoiceStatus): boolean {
  return status === "Paid" || status === "Cancelled" || status === "Expired";
}

/** The asset a channel is denominated in (CKB when there's no UDT funding script). */
function channelAsset(c: RawChannel): Asset {
  return c.funding_udt_type_script ? udtAsset(c.funding_udt_type_script) : { kind: "CKB" };
}

export class InvoiceService {
  private readonly rpc: FiberChannelRpcClient;
  private readonly pubkey?: string;

  constructor(cfg: InvoiceServiceConfig) {
    this.rpc = cfg.rpc;
    this.pubkey = cfg.pubkey;
  }

  /** Can this node receive `amount` of `asset` right now? Sums inbound over ready channels in that asset. */
  async checkReceiveReadiness(asset: Asset, amount: string): Promise<ReceiveReadiness> {
    const channels = await this.rpc.listChannels(this.pubkey);
    let inbound = 0n;
    for (const c of channels) {
      if (isChannelReady(c) && c.enabled && assetEquals(channelAsset(c), asset)) {
        inbound += asBig(c.remote_balance);
      }
    }
    const want = asBig(amount);
    const shortfall = inbound >= want ? 0n : want - inbound;
    return {
      asset,
      amount: want.toString(10),
      inbound: inbound.toString(10),
      canReceive: shortfall === 0n,
      shortfall: shortfall.toString(10),
    };
  }

  /** Issue a Fiber invoice for `asset`/`amount`. Does NOT check readiness — use `receive` to gate that. */
  async issue(req: IssueRequest): Promise<IssuedInvoice> {
    let udtTypeScript;
    if (req.asset.kind === "UDT") {
      udtTypeScript = assetUdtScript(req.asset);
      if (!udtTypeScript) {
        throw new Error(
          "issuing a UDT invoice needs the Script object; build the asset with udtAsset(script), not a bare hex",
        );
      }
    }
    const res = await this.rpc.newInvoice({
      amount: req.amount,
      currency: req.currency,
      description: req.description,
      udtTypeScript,
      expirySeconds: req.expirySeconds,
    });
    const paymentHash =
      res.invoice?.data?.payment_hash ?? (res as { payment_hash?: string }).payment_hash;
    if (!paymentHash) throw new Error("new_invoice returned no payment_hash");
    return {
      invoice: res.invoice_address,
      paymentHash,
      asset: req.asset,
      amount: asBig(req.amount).toString(10),
      expirySeconds: req.expirySeconds,
    };
  }

  /**
   * The full receive loop: gate on inbound readiness, optionally provision more inbound if short, then
   * issue the invoice. Returns the payable invoice; call `waitForPayment` on its `paymentHash` to settle.
   */
  async receive(opts: ReceiveOptions): Promise<IssuedInvoice> {
    let readiness = await this.checkReceiveReadiness(opts.asset, opts.amount);
    if (!readiness.canReceive) {
      if (!opts.ensureInbound) throw new ReceiveNotReadyError(readiness);
      await opts.ensureInbound(readiness);
      readiness = await this.checkReceiveReadiness(opts.asset, opts.amount);
      if (!readiness.canReceive) throw new ReceiveNotReadyError(readiness);
    }
    return this.issue(opts);
  }

  /** Poll `get_invoice` until the invoice settles (`Paid`) or reaches a terminal failure / the attempts run out. */
  async waitForPayment(paymentHash: string, opts: WaitOptions = {}): Promise<InvoiceOutcome> {
    const attempts = opts.attempts ?? 60;
    const intervalMs = opts.intervalMs ?? 2000;
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let status: InvoiceStatus = "Open";
    for (let i = 0; i < attempts; i++) {
      const inv = await this.rpc.getInvoice(paymentHash);
      status = inv.status;
      opts.onUpdate?.(status);
      if (isInvoiceTerminal(status)) break;
      if (i < attempts - 1) await sleep(intervalMs);
    }
    return { status, paid: status === "Paid", paymentHash };
  }
}
