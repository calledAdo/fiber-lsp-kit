/**
 * JIT channels: the customer's payment is held while the LSP opens a channel to the merchant, then forwarded.
 * Whichever mode is used, the merchant generates the secret, so the LSP can settle the hold only after the
 * merchant has been paid — deliver-or-refund is structural.
 *
 * The two modes differ only in how many nodes the LSP runs, and therefore in what the merchant must ship.
 *
 * `linked` — one LSP node. A single node cannot hold invoice(H) and also pay invoice(H), so the customer and
 * merchant payments need distinct hashes linked by one secret. The merchant must prove the link in zero
 * knowledge before the LSP commits capital (see `linkageDualSha256.ts`):
 *
 *   merchant_payment_hash = sha256(S)           -- merchant invoice; preimage is S (32 bytes)
 *   hold_hash = sha256(poseidon(S))             -- customer hold invoice; preimage is poseidon(S)
 *
 * `same_hash` — two LSP nodes: one holds, one pays. The collision is gone, both invoices carry sha256(S), and no
 * proof exists to generate or verify (see `sameHash.ts`). The merchant ships nothing but a `sha256`.
 */
import type { LinkageProof } from "./linkage.js";
import type { Asset } from "./types.js";

/**
 * How an LSP runs JIT. Advertised in `JitTerms.modes`; chosen per order in `CreateJitOrderRequest.mode`.
 *
 * - `linked`    — one LSP node; distinct hashes; merchant supplies a zero-knowledge linkage proof.
 * - `same_hash` — two LSP nodes (hold + pay); one hash on both invoices; no proof or ceremony.
 */
export type JitMode = "linked" | "same_hash";

/** JIT order lifecycle. Every failure path ends with the payer refunded (hold cancelled / expired). */
export type JitOrderState =
  | "created" // intent registered, hold invoice issued
  | "payment_held" // payer's funds locked at the LSP node; channel open triggered
  | "opening" // open_channel in flight
  | "forwarding" // channel ready; LSP paying the merchant invoice
  | "settled" // merchant paid, inbound hold settled
  | "refunded" // a step failed; hold cancelled, payer refunded
  | "expired"; // hold invoice expired unpaid

/** Body of `POST /lsp/v1/jit/orders` -- the merchant registers a JIT intent. */
export interface CreateJitOrderRequest {
  /** The merchant node's pubkey (the JIT channel is opened toward it). */
  target_pubkey: string;
  /**
   * Multiaddr the LSP can `connect_peer` to. Required: the LSP funds the channel and so must open an OUTBOUND
   * session to the acceptor — the path verified against FNN v0.9.0-rc5's inbound-peer behavior (see
   * docs/upstream-fiber-findings.md #12). The target address also avoids depending on ambient connectivity.
   */
  target_address: string;
  /** Channel asset (payment, fee and channel are all denominated in it). */
  asset: Asset;
  /** Which JIT construction to use. Must be one the LSP advertises in `JitTerms.modes`. Default `linked`. */
  mode?: JitMode;
  /** The customer-facing hold invoice hash: sha256(poseidon(S)) under `linked`, sha256(S) under `same_hash`. */
  hold_hash: string;
  /** sha256(S) -- must equal the merchant invoice's payment_hash. Equals `hold_hash` under `same_hash`. */
  merchant_payment_hash: string;
  /** The merchant invoice: net amount, hash = merchant_payment_hash. */
  merchant_invoice: string;
  /** Proof that hold_hash and merchant_payment_hash are linked by one secret S. Required by `linked`; absent for `same_hash`. */
  linkage_proof?: LinkageProof;
  /** Gross amount the payer will pay, in the asset's base unit. */
  amount: string;
  /** Requested channel capacity. Defaults to a multiplier of gross and is clamped to the offering floor. */
  channel_capacity?: string;
  /** Hold-invoice validity in seconds. Default 600, capped by terms. */
  expiry_seconds?: number;
  /** Optional webhook: POSTed `{ type: "jit.updated", order }` on every state change. */
  webhook_url?: string;
}

/** Stored/wire order request. The proof is verified on creation and not echoed back. `mode` is resolved. */
export type JitOrderRequest = Omit<CreateJitOrderRequest, "linkage_proof" | "mode"> & { mode: JitMode };

/** The LSP's JIT pricing, advertised in `LspInfo` per offering. */
export interface JitTerms {
  /**
   * The JIT constructions this LSP will serve. A merchant with no proving artifacts needs `same_hash`; an LSP
   * running a single node can only offer `linked`. Advertised, not operator-set: it follows from deployment.
   */
  modes?: JitMode[];
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
   * Per-order bearer token returned only by create. Follow-up GET/recovery-reveal/cancel calls must present it as
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
