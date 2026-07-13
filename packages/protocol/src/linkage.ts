/**
 * Shared linkage-proof interfaces.
 *
 * The canonical JIT linkage construction lives in `linkageDualSha256.ts`. This file intentionally contains
 * only the verifier/proof interface so the protocol does not expose legacy dual-hash JIT helpers.
 */

/**
 * An opaque proof that the public hold and merchant payment hashes are linked by the named statement.
 */
export interface LinkageProof {
  scheme: string;
  /** Backend-specific payload, e.g. a Groth16 proof. */
  data: string;
}

/** Verifies a merchant's linkage proof for a pair of public hashes. */
export interface LinkageVerifier {
  readonly scheme: string;
  verify(holdHash: string, merchantPaymentHash: string, proof: LinkageProof): boolean | Promise<boolean>;
}
