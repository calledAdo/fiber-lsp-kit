/**
 * JIT mode strategies — the *only* things that differ between the two JIT constructions.
 *
 * The JitService lifecycle (hold → open → forward → settle, with all its timing and refund guards) is
 * identical for both modes. They diverge at exactly two points, captured here as one small object each:
 *
 *   - admission:      which hashes (and, for `linked`, which proof) the LSP will accept before moving capital.
 *   - settle key:     how the merchant preimage yields the value that settles the customer hold.
 *
 * Adding a future construction (e.g. a PTLC-based mode once Fiber ships adaptor signatures) is a new class
 * here, not an edit to the engine.
 */
import {
  type CreateJitOrderRequest,
  type JitMode,
  type LinkageVerifier,
  deriveHoldPreimageFromMerchant,
  fraudEvidenceDualSha256,
  verifyDualSha256Linkage,
  verifySameHashLinkage,
} from "@fiberlsp/protocol";
import { JitError } from "./jitError.js";

/** Evidence handed to `onFraud` when a merchant preimage does not unlock its claimed hold. */
export interface FraudEvidence {
  a: string;
  b: string;
  preimage: string;
}

/** One JIT construction's policy. The engine holds one of these per order and calls through it. */
export interface JitModeStrategy {
  readonly kind: JitMode;
  /** Reject the order before any capital moves unless the hashes — and, for `linked`, the proof — are valid. */
  admit(req: CreateJitOrderRequest): Promise<void>;
  /** The value that settles the hold given the merchant preimage, or null when it does not unlock it. */
  holdPreimageFor(merchantPreimage: string, holdHash: string, merchantPaymentHash: string): string | null;
  /** Fraud evidence for a failed backstop — non-null only where a proof stood between the two hashes. */
  fraudEvidence(merchantPreimage: string, holdHash: string, merchantPaymentHash: string): FraudEvidence | null;
}

/**
 * `linked` — one LSP node, two distinct hashes, and a zero-knowledge proof that they share a secret. The proof
 * is the LSP's only trust assumption: a forged one lets a merchant be paid without the hold ever settling.
 */
export class LinkedMode implements JitModeStrategy {
  readonly kind: JitMode = "linked";

  constructor(private readonly verifier: LinkageVerifier) {}

  async admit(req: CreateJitOrderRequest): Promise<void> {
    if (req.hold_hash.toLowerCase() === req.merchant_payment_hash.toLowerCase()) {
      throw new JitError("hash_mismatch", "linked mode requires distinct hold_hash and merchant_payment_hash");
    }
    if (!req.linkage_proof) throw new JitError("missing_linkage_proof", "linked mode requires a linkage_proof");
    const ok = await Promise.resolve(
      this.verifier.verify(req.hold_hash, req.merchant_payment_hash, req.linkage_proof),
    );
    if (!ok) {
      throw new JitError(
        "linkage_invalid",
        "hold_hash and merchant_payment_hash are not proven to share a secret",
      );
    }
  }

  holdPreimageFor(merchantPreimage: string, holdHash: string, merchantPaymentHash: string): string | null {
    if (!verifyDualSha256Linkage(merchantPreimage, holdHash, merchantPaymentHash)) return null;
    return deriveHoldPreimageFromMerchant(merchantPreimage);
  }

  fraudEvidence(merchantPreimage: string, holdHash: string, merchantPaymentHash: string): FraudEvidence | null {
    return fraudEvidenceDualSha256(merchantPreimage, holdHash, merchantPaymentHash);
  }
}

/**
 * `same_hash` — two LSP nodes (one holds, one pays) carrying one hash on both invoices. There is no relation
 * between two hashes to prove, so there is nothing to forge and no fraud to evidence.
 */
export class SameHashMode implements JitModeStrategy {
  readonly kind: JitMode = "same_hash";

  async admit(req: CreateJitOrderRequest): Promise<void> {
    if (req.hold_hash.toLowerCase() !== req.merchant_payment_hash.toLowerCase()) {
      throw new JitError("hash_mismatch", "same_hash mode requires hold_hash == merchant_payment_hash");
    }
  }

  holdPreimageFor(merchantPreimage: string, holdHash: string, merchantPaymentHash: string): string | null {
    return verifySameHashLinkage(merchantPreimage, holdHash, merchantPaymentHash) ? merchantPreimage : null;
  }

  fraudEvidence(): FraudEvidence | null {
    return null;
  }
}
