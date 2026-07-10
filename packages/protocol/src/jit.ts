/**
 * Single-node JIT channels via linked hold/leg hashes.
 *
 * One Fiber node cannot safely hold invoice(H) and also pay a merchant invoice(H). The canonical JIT flow
 * therefore uses two SHA-256 hashes linked by one merchant secret, with both invoice preimages kept to the
 * 32 bytes a live FNN node accepts:
 *
 *   leg_hash  = sha256(S)                     -- merchant leg invoice; preimage is S (32 bytes)
 *   hold_hash = sha256(poseidon(S))           -- customer hold invoice; preimage is poseidon(S)
 *
 * The LSP verifies a zero-knowledge linkage proof before committing capital. After the merchant leg settles,
 * the LSP learns the leg preimage, derives the hold preimage, and settles the held customer payment.
 */
import type { LinkageProof } from "./linkage.js";
import type { Asset } from "./types.js";

/** JIT order lifecycle. Every failure path ends with the payer refunded (hold cancelled / expired). */
export type JitOrderState =
  | "created" // intent registered, hold invoice issued
  | "payment_held" // payer's funds locked at the LSP node; channel open triggered
  | "opening" // open_channel in flight
  | "forwarding" // channel ready; LSP paying the merchant leg
  | "settled" // merchant paid, inbound hold settled
  | "refunded" // a step failed; hold cancelled, payer refunded
  | "expired"; // hold invoice expired unpaid

/** Body of `POST /lsp/v1/jit/orders` -- the merchant registers a linked single-node JIT intent. */
export interface CreateJitOrderRequest {
  /** The merchant node's pubkey (the JIT channel is opened toward it). */
  target_pubkey: string;
  /** Multiaddr the LSP can `connect_peer` to. */
  target_address?: string;
  /** Channel asset (payment, fee and channel are all denominated in it). */
  asset: Asset;
  /** sha256(poseidon(S)) -- the customer-facing hold invoice hash. */
  hold_hash: string;
  /** sha256(S) -- must equal the merchant leg invoice's payment_hash (leg preimage is S). */
  leg_hash: string;
  /** The merchant's leg invoice: net amount, hash = leg_hash. */
  merchant_invoice: string;
  /** Proof that hold_hash and leg_hash are linked by one secret S. */
  linkage_proof: LinkageProof;
  /** Gross amount the payer will pay, in the asset's base unit. */
  amount: string;
  /** Requested channel capacity. Defaults to a multiplier of gross and is clamped to the offering floor. */
  channel_capacity?: string;
  /** Hold-invoice validity in seconds. Default 600, capped by terms. */
  expiry_seconds?: number;
  /** Optional webhook: POSTed `{ type: "jit.updated", order }` on every state change. */
  webhook_url?: string;
}

/** Stored/wire order request. The proof is verified on creation and not echoed back. */
export type JitOrderRequest = Omit<CreateJitOrderRequest, "linkage_proof">;

/** The LSP's JIT pricing, advertised in `LspInfo` per offering. */
export interface JitTerms {
  /** Fee deducted from the forwarded amount, in basis points of the gross payment. */
  fee_bps: number;
  /** Flat component of the deducted fee, in the channel asset's base unit. */
  fee_base: string;
  /** Smallest gross payment the LSP will provision a channel for. */
  min_payment: string;
  /** Longest hold window the LSP will grant, in seconds. */
  max_expiry_seconds: number;
  /**
   * Shortest hold the LSP will grant, in seconds — its open+forward+settle budget. Advertised (not
   * operator-set) so a merchant can inspect it and reject an LSP whose floor it dislikes before ordering.
   */
  min_expiry_seconds?: number;
}

/** Response of create/get JIT order. */
export interface JitOrder {
  jit_order_id: string;
  state: JitOrderState;
  request: JitOrderRequest;
  /**
   * The hold invoice issued by the LSP node, hash = hold_hash. This is what the merchant shows the payer.
   */
  hold_invoice: string;
  /** Net amount forwarded to the merchant: amount - fee. */
  forward_amount: string;
  /** Deducted JIT fee, in the channel asset. */
  fee: string;
  /** Set once the LSP has opened the channel. */
  channel_outpoint?: string;
  /** Unix seconds the hold invoice expires. */
  expires_at: number;
  created_at: number;
  failure_reason?: string;
  /**
   * Per-order bearer token returned only by create. Follow-up GET/reveal/cancel calls must present it as
   * `Authorization: Bearer <token>`.
   */
  order_token?: string;
}

/** Compute the JIT fee deducted from a gross payment. */
export function jitFee(terms: JitTerms, amount: string | bigint): bigint {
  const gross = typeof amount === "bigint" ? amount : BigInt(amount);
  const proportional = (gross * BigInt(Math.trunc(terms.fee_bps)) + 9_999n) / 10_000n;
  return proportional + BigInt(terms.fee_base);
}

/** Net amount forwarded to the merchant after the JIT fee. */
export function jitForwardAmount(terms: JitTerms, amount: string | bigint): bigint {
  const gross = typeof amount === "bigint" ? amount : BigInt(amount);
  const net = gross - jitFee(terms, gross);
  if (net <= 0n) throw new Error(`payment ${gross} does not cover the JIT fee ${jitFee(terms, gross)}`);
  return net;
}
