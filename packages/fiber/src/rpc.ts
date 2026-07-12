/**
 * FiberChannelRpcClient — a typed wrapper over the FNN JSON-RPC surface the LSP needs.
 *
 * Field shapes are pinned to FNN v0.9 (read from source):
 *   Peer:    connect_peer { address?, pubkey?, save? }
 *   Channel: open_channel { pubkey, funding_amount(hex), funding_udt_type_script?, public?, ... }
 *              -> { temporary_channel_id }
 *            list_channels { pubkey?, include_closed?, only_pending? } -> { channels: [...] }
 *   Invoice: new_invoice { amount(hex), currency, udt_type_script?, expiry(hex)? }
 *              -> { invoice_address, invoice: { data: { payment_hash, .. } } }   (verified live, v0.9.0-rc5)
 *   Info:    node_info -> { pubkey, addresses, ... }   (field is `pubkey`, verified live)
 *
 * FNN encodes u64/u128 as 0x-hex strings; we convert amounts via num.ts at this boundary only.
 */
import type { InvoiceStatus, UdtTypeScript } from "@fiberlsp/protocol";
import { asBig, toHex } from "@fiberlsp/protocol";

export type FetchLike = (url: string, init: RequestInit) => Promise<{ json(): Promise<unknown> }>;

export interface RpcClientConfig {
  rpcUrl: string;
  fetchImpl?: FetchLike;
  /**
   * Optional bearer token sent as `Authorization: Bearer <token>` on every call. FNN supports Biscuit
   * bearer-token auth and requires it when the RPC is bound publicly — a production LSP dialing a public
   * node needs this. Omit for a local/trusted node. The mock node ignores it, so it's transport-only and
   * doesn't disturb mock-vs-live indistinguishability.
   */
  authToken?: string;
}

/** A peer as returned by list_peers (verified live: each entry has `pubkey`, and `address` once known). */
export interface RawPeer {
  pubkey: string;
  address?: string;
}

/** A channel as returned by list_channels (fields the LSP cares about). */
/** A pending TLC (HTLC) on a channel, as returned in `list_channels` → `pending_tlcs`. */
export interface RawHtlc {
  id?: string;
  amount?: string; // hex u128
  payment_hash: string;
  /** Absolute on-chain expiry of this TLC, hex u64 **milliseconds** since epoch. */
  expiry: string;
  status?: unknown;
}

export interface RawChannel {
  channel_id: string;
  channel_outpoint?: string | null;
  pubkey: string;
  funding_udt_type_script?: UdtTypeScript | null;
  state: { state_name: string; state_flags?: unknown };
  local_balance: string; // hex u128
  remote_balance: string; // hex u128
  /** In-flight TLCs on this channel (present in FNN list_channels; may be omitted by older nodes). */
  pending_tlcs?: RawHtlc[];
  enabled: boolean;
}

/**
 * A node as advertised in the gossip network graph (`graph_nodes` → `NodeInfo`, FNN v0.9).
 *
 * This is the raw material for decentralized, registry-free LSP discovery: every node broadcasts its
 * reachable addresses plus, per asset, the minimum funding it will auto-accept. FNN's own channel-opener
 * reads exactly these fields to predict whether a peer will auto-accept a channel, so they are a
 * first-class capability signal — not an accident of the schema.
 *
 * Numeric fields arrive as 0x-hex strings (CKB convention); convert with `asBig` at the boundary.
 */
export interface GraphUdtScript {
  code_hash: string;
  hash_type: UdtTypeScript["hash_type"];
  args: string;
}

export interface GraphUdtArgInfo {
  /** Human name the operator gave this UDT (e.g. "RUSD"). */
  name: string;
  script: GraphUdtScript;
  /** Minimum channel funding (base units, hex) the node will auto-accept for this UDT; absent = not auto-accepting. */
  auto_accept_amount?: string | null;
  cell_deps?: unknown[];
}

export interface GraphNodeInfo {
  node_name: string;
  version: string;
  /** Reachable p2p multiaddrs (transport addresses — NOT a REST endpoint). */
  addresses: string[];
  /** Enabled protocol feature names. A future "LSP provider" advertisement would surface here. */
  features: string[];
  /** secp256k1 compressed identity key (same value as `pubkey` in list_peers). */
  pubkey: string;
  timestamp: string; // hex u64
  chain_hash: string;
  /** Minimum CKB funding the node auto-accepts; `0x0` means CKB auto-accept is disabled. */
  auto_accept_min_ckb_funding_amount: string; // hex u64
  /** Per-UDT auto-accept configuration the node broadcasts. */
  udt_cfg_infos: GraphUdtArgInfo[];
}

/** One page of `graph_nodes`. `last_cursor` (`0x…`) feeds the next call's `after`; `0x` when exhausted. */
export interface GraphNodesPage {
  nodes: GraphNodeInfo[];
  last_cursor: string;
}

export interface OpenChannelArgs {
  pubkey: string;
  /** LSP-funded amount = the client's inbound capacity, in the asset's base unit (decimal or bigint). */
  fundingAmount: string | bigint;
  udtTypeScript?: UdtTypeScript;
  public?: boolean;
}

/** FNN payment lifecycle (from `PaymentSessionStatus`): `Created → Inflight → Success | Failed`. */
export type PaymentStatus = "Created" | "Inflight" | "Success" | "Failed";

export interface PaymentResult {
  payment_hash: string;
  status: PaymentStatus;
  /** Routing fee actually paid, hex shannons. `0x0` for a direct-channel hop. */
  fee?: string;
  failed_error?: string | null;
  /** Present once the payment succeeds — the preimage that unlocked the hash (upstream may omit). */
  payment_preimage?: string;
}

/**
 * A payment as returned by `list_payments` — the node's durable payment ledger.
 *
 * **Verified live (v0.9.0-rc5, testnet, 2026-07-12) against both `list_payments` and `get_payment`:** the
 * live response is `{ payment_hash, status, created_at, last_updated_at, failed_error, fee, custom_records }`
 * — `amount` and `udt_type_script` are declared here (docs mention them) but were **absent from every live
 * record observed**, including settled UDT payments. Treat them as optional/best-effort, not reliable for
 * accounting; `fee` and `status` were present and trustworthy. Numeric fields follow CKB's 0x-hex convention.
 */
export interface RawPayment {
  payment_hash: string;
  status: PaymentStatus;
  /** Amount paid, hex base units of the payment asset. Not populated by FNN v0.9.0-rc5 — see note above. */
  amount?: string;
  /** Routing fee paid, hex shannons. Verified live — reliably present. */
  fee?: string;
  /** The channel asset this payment moved. Not populated by FNN v0.9.0-rc5 — see note above. */
  udt_type_script?: UdtTypeScript | null;
  /** Creation time, hex u64 ms since epoch. */
  created_at?: string;
  payment_preimage?: string;
}

export interface ShutdownChannelArgs {
  channelId: string;
  /** Force-close (unilateral) instead of a cooperative mutual close. Default cooperative (false). */
  force?: boolean;
  /** Fee rate for the closing tx, hex/decimal shannons-per-kB. Omit to let the node choose. */
  feeRate?: string | bigint;
}

export interface SendPaymentArgs {
  /** Pay to this node pubkey directly — required for keysend (no invoice). */
  targetPubkey?: string;
  /** Amount in the asset's base unit (shannons for CKB); decimal or bigint. Optional when an invoice sets it. */
  amount?: string | bigint;
  /** A Fiber invoice to settle instead of a keysend. Mutually exclusive with `keysend`. */
  invoice?: string;
  /** Spontaneous payment: FNN generates a random preimage, no invoice needed. Verified live over UDT. */
  keysend?: boolean;
  /** UDT to denominate the payment in (omit for CKB). Keysend works over UDT (verified live, v0.9.0-rc5). */
  udtTypeScript?: UdtTypeScript;
  /** Only build/price the route without paying — a free affordability + reachability pre-check. */
  dryRun?: boolean;
  /** Cap the routing fee, hex/decimal/bigint shannons. */
  maxFeeAmount?: string | bigint;
}

export class FiberChannelRpcClient {
  private readonly url: string;
  private readonly fetchImpl: FetchLike;
  private readonly authHeader?: string;
  private id = 0;

  constructor(cfg: RpcClientConfig) {
    this.url = cfg.rpcUrl;
    this.fetchImpl = cfg.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.authHeader = cfg.authToken ? `Bearer ${cfg.authToken}` : undefined;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const payload = { jsonrpc: "2.0" as const, id: (this.id += 1), method, params };
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.authHeader ? { authorization: this.authHeader } : {}),
      },
      body: JSON.stringify(payload),
    });
    const { result, error } = (await res.json()) as { result?: T; error?: { message: string } };
    if (error) throw new Error(`FNN rpc "${method}" errored: ${error.message}`);
    return result as T;
  }

  nodeInfo(): Promise<{
    /** FNN returns the node identity as `pubkey` (verified live, v0.9.0-rc5). */
    pubkey?: string;
    /** Older/aliased fields — kept for forward-compat, but live nodes send `pubkey`. */
    node_id?: string;
    public_key?: string;
    addresses?: string[];
  }> {
    return this.call("node_info", []);
  }

  /**
   * Connect to a peer by multiaddr. NOTE (verified live): the `/p2p/<id>` suffix, if present, must be a
   * base58 libp2p peer id — NOT the hex node pubkey. For a local/unannounced peer, dial the plain
   * transport multiaddr with no `/p2p/` suffix, e.g. `/ip4/127.0.0.1/tcp/8238`.
   */
  connectPeer(address: string, save = true): Promise<null> {
    return this.call("connect_peer", [{ address, save }]);
  }

  /** Open a channel toward `pubkey`, funding it entirely from the LSP (that becomes the peer's inbound). */
  async openChannel(args: OpenChannelArgs): Promise<{ temporary_channel_id: string }> {
    const params: Record<string, unknown> = {
      pubkey: args.pubkey,
      funding_amount: toHex(args.fundingAmount),
      public: args.public ?? true,
    };
    if (args.udtTypeScript) params.funding_udt_type_script = args.udtTypeScript;
    return this.call("open_channel", [params]);
  }

  async listChannels(pubkey?: string): Promise<RawChannel[]> {
    const r = await this.call<{ channels?: RawChannel[] }>("list_channels", [
      pubkey ? { pubkey } : {},
    ]);
    return r.channels ?? [];
  }

  /** Currently-connected peers. Used to avoid a redundant connect_peer (which can crash the acceptor). */
  async listPeers(): Promise<RawPeer[]> {
    const r = await this.call<{ peers?: RawPeer[] }>("list_peers", []);
    return r.peers ?? [];
  }

  /**
   * Create an invoice (used for the prepaid fee and the JIT legs). `amount` in base unit; UDT optional.
   *
   * Exactly one of `paymentPreimage` / `paymentHash` may be set (FNN: "if hash is set, preimage must be
   * absent"). Passing only `paymentHash` creates a **hold invoice**: the node accepts and HOLDS the
   * incoming TLC until `settleInvoice` supplies the preimage (or `cancelInvoice`/expiry refunds the payer).
   * The hold window is the invoice `expiry` — verified live, v0.9.0-rc5. Neither set ⇒ node-random preimage.
   */
  newInvoice(args: {
    amount: string | bigint;
    currency?: string;
    description?: string;
    udtTypeScript?: UdtTypeScript;
    expirySeconds?: number;
    /** Preimage this node will settle with (normal invoice, caller-chosen preimage). */
    paymentPreimage?: string;
    /** Hash-only ⇒ hold invoice; this node cannot settle until told the preimage. */
    paymentHash?: string;
    /** Hash function for `paymentHash` — "ckb_hash" (blake2b, default) or "sha256". Linked JIT uses sha256. */
    hashAlgorithm?: "ckb_hash" | "sha256";
    /**
     * `invoice_address` is the payable BOLT-style string the client settles.
     * `payment_hash` lives under `invoice.data` on live nodes (v0.9.0-rc5), not top-level.
     */
  }): Promise<{ invoice_address: string; invoice?: { data?: { payment_hash?: string } } }> {
    const params: Record<string, unknown> = {
      amount: toHex(args.amount),
      currency: args.currency ?? "Fibt",
    };
    if (args.description) params.description = args.description;
    if (args.udtTypeScript) params.udt_type_script = args.udtTypeScript;
    if (args.expirySeconds) params.expiry = toHex(args.expirySeconds);
    if (args.paymentPreimage) params.payment_preimage = args.paymentPreimage;
    if (args.paymentHash) params.payment_hash = args.paymentHash;
    if (args.hashAlgorithm) params.hash_algorithm = args.hashAlgorithm;
    return this.call("new_invoice", [params]);
  }

  /**
   * Settle a hold invoice by revealing its preimage — the held TLC fulfills and the payer's payment flips
   * to Success (verified live: a 150s-held TLC settled in ~2s). The JIT release step.
   */
  settleInvoice(paymentHash: string, paymentPreimage: string): Promise<void> {
    return this.call("settle_invoice", [{ payment_hash: paymentHash, payment_preimage: paymentPreimage }]);
  }

  /**
   * Cancel an invoice. On a hold invoice with a held TLC this rejects the TLC backward — the payer is
   * automatically refunded (verified live). The JIT deliver-or-refund guarantee.
   */
  cancelInvoice(paymentHash: string): Promise<{ invoice_address?: string }> {
    return this.call("cancel_invoice", [{ payment_hash: paymentHash }]);
  }

  /**
   * Abandon a channel that never reached Ready (accepts temporary or real channel ids; FNN refuses for
   * Ready/Closed channels). Used when a JIT open times out, so the node's own funding retries don't open
   * — and strand capital in — a channel nobody is waiting for anymore.
   */
  abandonChannel(channelId: string): Promise<null> {
    return this.call("abandon_channel", [{ channel_id: channelId }]);
  }

  /**
   * Cooperatively close a Ready channel and return its funds on-chain — the counterpart to `abandonChannel`
   * (which only drops a never-Ready open). This is how an LSP reclaims capital from a lease the merchant
   * stopped paying rent on, or how a merchant ends a lease it no longer wants. Either party may initiate.
   *
   * **Param shape verified live** (v0.9.0-rc5, testnet, 2026-07-12): `channel_id`/`force`/`fee_rate` are all
   * accepted by the node (a bogus channel id reaches "Channel not found", never a param-shape error). The
   * actual close/return-of-funds behavior was NOT exercised live — only the request shape was probed, to
   * avoid closing a real channel outside a deliberate test.
   */
  shutdownChannel(args: ShutdownChannelArgs): Promise<null> {
    const params: Record<string, unknown> = { channel_id: args.channelId };
    if (args.force !== undefined) params.force = args.force;
    if (args.feeRate !== undefined) params.fee_rate = toHex(args.feeRate);
    return this.call("shutdown_channel", [params]);
  }

  /**
   * Decode an invoice string without touching it. Used by the LSP to validate a merchant's JIT leg
   * invoice (hash and amount must match the order) before issuing the hold invoice.
   */
  parseInvoice(invoice: string): Promise<{
    invoice: {
      amount?: string;
      data?: {
        payment_hash?: string;
        /** Invoice creation time, hex u128 **milliseconds** since epoch. */
        timestamp?: string;
        /** Externally-tagged attrs, e.g. `{ "expiry_time": "0xe10" }` (seconds), `{ "description": "…" }`. */
        attrs?: Array<Record<string, unknown>>;
      };
    };
  }> {
    return this.call("parse_invoice", [{ invoice }]);
  }

  /**
   * Look up an invoice by its payment hash. Used to verify a prepaid fee actually settled before the LSP
   * provisions — `status === "Paid"` is the definitive settled state (verified against FNN v0.9 source).
   */
  getInvoice(paymentHash: string): Promise<{ status: InvoiceStatus; invoice_address?: string }> {
    return this.call("get_invoice", [{ payment_hash: paymentHash }]);
  }

  /**
   * One page of the gossip network graph. `limit` is FNN-capped at 500 (encoded as hex, per the RPC's
   * U64Hex convention); pass the previous page's `last_cursor` as `after` to continue.
   */
  graphNodes(opts: { limit?: number; after?: string } = {}): Promise<GraphNodesPage> {
    const params: Record<string, unknown> = {};
    if (opts.limit !== undefined) params.limit = toHex(opts.limit);
    if (opts.after) params.after = opts.after;
    return this.call("graph_nodes", [params]);
  }

  /**
   * Page through the whole node graph. `pageSize` defaults to FNN's max (500); `maxNodes` caps the total
   * scanned so a large network can't run unbounded. Stops when a short page or an empty cursor is returned.
   */
  async graphNodesAll(opts: { pageSize?: number; maxNodes?: number } = {}): Promise<GraphNodeInfo[]> {
    const pageSize = opts.pageSize ?? 500;
    const maxNodes = opts.maxNodes ?? 5000;
    const all: GraphNodeInfo[] = [];
    let after: string | undefined;
    while (all.length < maxNodes) {
      const page = await this.graphNodes({ limit: pageSize, after });
      all.push(...page.nodes);
      const cursor = page.last_cursor;
      if (page.nodes.length < pageSize || !cursor || asBig(cursor) === 0n) break;
      after = cursor;
    }
    return all.slice(0, maxNodes);
  }

  /**
   * Send a payment. Supports both invoice settlement and **keysend** (spontaneous pay to a pubkey with no
   * invoice) — the latter is how streaming rent is paid, so the LSP need not issue a fresh invoice per
   * period. Set `dryRun` to only build + price the route (an affordability/reachability check that never
   * moves funds). Returns immediately with the initial state; poll `getPayment` for the terminal result.
   */
  sendPayment(args: SendPaymentArgs): Promise<PaymentResult> {
    const params: Record<string, unknown> = {};
    if (args.targetPubkey) params.target_pubkey = args.targetPubkey;
    if (args.amount !== undefined) params.amount = toHex(args.amount);
    if (args.invoice) params.invoice = args.invoice;
    if (args.keysend !== undefined) params.keysend = args.keysend;
    if (args.udtTypeScript) params.udt_type_script = args.udtTypeScript;
    if (args.dryRun) params.dry_run = true;
    if (args.maxFeeAmount !== undefined) params.max_fee_amount = toHex(args.maxFeeAmount);
    return this.call("send_payment", [params]);
  }

  /** Look up a payment by its hash — poll this until `status` is `Success` or `Failed`. */
  getPayment(paymentHash: string): Promise<PaymentResult> {
    return this.call("get_payment", [{ payment_hash: paymentHash }]);
  }

  /**
   * The node's durable payment ledger — every payment it has sent, across restarts. This is what lets an LSP
   * reconcile fee/status history without keeping its own in-memory tally (see `LspLedger`).
   *
   * **Verified live** (v0.9.0-rc5, testnet, 2026-07-12) — see `RawPayment` for the shape actually observed.
   * Note: `amount`/`udt_type_script` were absent from every live record, so gross-amount reconciliation
   * (`LspLedger`'s per-asset `sent` totals) is currently a docs-promised capability the live node doesn't
   * back — count/fee/status totals are trustworthy, `sent` is not, until cross-referenced against invoices.
   */
  async listPayments(): Promise<RawPayment[]> {
    const res = await this.call<{ payments?: RawPayment[] }>("list_payments", [{}]);
    return res?.payments ?? [];
  }
}

/** FNN's "channel is open and usable" state name. */
export const CHANNEL_READY = "ChannelReady";

export function isChannelReady(c: RawChannel): boolean {
  return c.state?.state_name === CHANNEL_READY;
}
