/**
 * Core domain types for the LSPS-Fiber protocol.
 *
 * An LSP (Liquidity Service Provider) sells *inbound* liquidity: it opens and funds a channel toward a
 * client so the client can receive payments. Fiber's unique twist over Lightning is that this works
 * per asset — a client can buy inbound liquidity denominated in a specific UDT (e.g. RUSD), because
 * FNN's `open_channel` funds channels with a `funding_udt_type_script`.
 */

/** A CKB Script object as FNN's JSON-RPC returns/accepts it. */
export interface UdtTypeScript {
  code_hash: string;
  hash_type: "data" | "type" | "data1" | "data2";
  args: string;
}

/**
 * The asset a channel / order is denominated in. CKB is native; a UDT is identified by its Script.
 * `scriptHex` is the canonical molecule encoding (see molecule.ts) used to compare the two encodings
 * FNN uses (invoice `udt_script` hex vs channel `funding_udt_type_script` object).
 */
export type Asset =
  | { kind: "CKB" }
  | { kind: "UDT"; udt?: UdtTypeScript; scriptHex?: string; symbol?: string };

/**
 * How the client pays the LSP's opening fee. Grounded in what FNN actually supports (there is no
 * native push/opening-fee at channel open — verified against FNN v0.9 source):
 *
 * The fee itself is always denominated in CKB (see fee.ts for why).
 *
 *  - "from_capacity": CKB-channel-only. The client dual-funds the channel with CKB (`client_balance` >=
 *    fee as its own outbound), then pays the fee to the LSP as an in-channel payment right after the
 *    channel is ready. There is no push-at-open in FNN, so the fee cannot be netted atomically. (LSPS1-style.)
 *
 *  - "prepaid": the client settles a CKB fee invoice BEFORE the channel opens. Works for pure-inbound
 *    orders where the client contributes zero of the channel asset — the only viable mode for the
 *    flagship "buy RUSD inbound with no RUSD capital" flow (the client pays the fee in CKB it already has).
 */
export type FeeMode = "from_capacity" | "prepaid";

/** LSPS-Fiber order lifecycle. Mirrors LSPS1's order states, adapted to Fiber's flow. */
export type OrderState =
  | "created" // order accepted, fee quoted
  | "awaiting_payment" // prepaid mode: waiting for the client to settle the fee invoice
  | "opening" // LSP has issued open_channel; funding tx propagating
  | "channel_active" // channel Ready; inbound liquidity delivered
  | "failed"
  | "expired";

export interface FeeSchedule {
  /** Flat fee in CKB shannons (the fee is always CKB, regardless of channel asset). */
  base_fee: string;
  /**
   * Proportional fee in basis points of the requested inbound capacity (1 bp = 0.01%). Only applied to
   * CKB channels (same unit); ignored for UDT channels, which are charged the flat base_fee only.
   */
  proportional_bps: number;
}

export interface AssetOffering {
  asset: Asset;
  /** Minimum inbound capacity the LSP will provision, in the asset's base unit. */
  min_capacity: string;
  /** Maximum inbound capacity the LSP will provision, in the asset's base unit. */
  max_capacity: string;
  fee_schedule: FeeSchedule;
}

/** Response of `GET /lsp/v1/info` — the LSP's self-description. */
export interface LspInfo {
  lsp_pubkey: string;
  /** Multiaddrs the client should `connect_peer` to before ordering. */
  addresses: string[];
  chain: "testnet" | "mainnet" | string;
  supported_assets: AssetOffering[];
  fee_modes: FeeMode[];
  /** How long an order stays open before it expires, in seconds. */
  order_expiry_seconds: number;
  /** Optional human-facing metadata. */
  operator?: string;
  version?: string;
}

/** Body of `POST /lsp/v1/orders` — the client's request to buy inbound liquidity. */
export interface CreateOrderRequest {
  /** The client node's pubkey (the channel is opened toward this peer). */
  target_pubkey: string;
  /** A multiaddr the LSP can reach the client at, if not already connected. */
  target_address?: string;
  /** Which asset to denominate the channel in. */
  asset: Asset;
  /** Inbound capacity requested (LSP-funded side), in the asset's base unit. */
  lsp_balance: string;
  /** Optional client-funded contribution (their outbound). Required to be >= fee for "from_capacity". */
  client_balance?: string;
  fee_mode: FeeMode;
  /** Whether the channel should be public (announced/forwardable). Default true. */
  public?: boolean;
}

/** Fee quote returned with an order. */
export interface FeeQuote {
  asset: Asset;
  base_fee: string;
  proportional_fee: string;
  total_fee: string;
  fee_mode: FeeMode;
}

/** Payment instructions the client must act on. Shape depends on fee_mode. */
export type OrderPayment =
  | {
      mode: "prepaid";
      /** BOLT11-style Fiber invoice the client settles to release the channel open. */
      fee_invoice: string;
      amount: string;
    }
  | {
      mode: "from_capacity";
      /** After the channel is active, pay this amount to `lsp_pubkey` to settle the fee. */
      amount: string;
      lsp_pubkey: string;
    };

/** Response of create/get order — the full order record. */
export interface Order {
  order_id: string;
  state: OrderState;
  request: CreateOrderRequest;
  fee: FeeQuote;
  payment: OrderPayment;
  /** Set once the channel is opening/active. */
  channel_outpoint?: string;
  /** Unix seconds when this order expires if not paid. */
  expires_at: number;
  created_at: number;
  /** Human-readable reason when state === "failed". */
  failure_reason?: string;
}
