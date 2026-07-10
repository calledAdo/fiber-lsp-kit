/**
 * Linked hold/leg hashes for single-node JIT — no blake2b circuit needed, and settleable through a real
 * FNN node.
 *
 * FNN invoice preimages are a fixed 32-byte `Hash256` (payment_hash = sha256/blake2b of exactly 32 bytes), so
 * every preimage here is kept to 32 bytes:
 *
 *   leg_preimage  = S                →  B = sha256(S)              (merchant leg invoice)
 *   hold_preimage = poseidon(S)      →  A = sha256(hold_preimage)  (customer hold invoice)
 *
 * Both preimages are 32 bytes, so both invoices issue and settle on a real node. A ≠ B, so one node holds
 * under A and pays under B with no collision. The leg preimage is S itself, so paying the leg reveals S and
 * the LSP derives hold_preimage = poseidon(S) with no merchant reveal RPC on the honest path.
 *
 * Only the two *invoice* hashes must be SHA-256 (FNN computes payment_hash that way). The derivation is ours
 * to choose, and it carries no security weight: hold_preimage stays unpredictable because reaching it means
 * inverting a SHA-256 — either A directly, or B to recover S. So Poseidon is used purely because it is cheap
 * in-circuit (~250 constraints vs ~30k for a SHA-256 block), which keeps the proving key small. It must only
 * be deterministic, 32-byte valued, and distinct from sha256(S) — otherwise hold_preimage would equal the
 * *public* leg hash B and anyone could settle the customer hold.
 *
 * The ZK statement is ∃S : sha256(S)=B ∧ sha256(poseidon(S))=A — two SHA-256 blocks.
 */
import { createHash } from "node:crypto";
import { poseidon2 } from "poseidon-lite";
import type { LinkageProof, LinkageVerifier } from "./linkage.js";

/** Length of the random secret S (bytes). It is also the leg preimage. */
export const JIT_LINK_SECRET_BYTES = 32;

export const EXPOSED_SECRET_SCHEME = "exposed-secret";
export const GROTH16_DUAL_SHA256_SCHEME = "groth16-dual-sha256";

export interface DualSha256Hashes {
  /** sha256(poseidon(S)) — hold invoice hash (customer pays). */
  hold: string;
  /** sha256(S) — leg invoice hash (LSP forwards). */
  leg: string;
  /** Leg preimage = S (32 bytes). Merchant issues the leg invoice with this + hash_algorithm sha256. */
  legPreimage: string;
  /** Hold preimage = poseidon(S) (32 bytes). LSP settles the hold with this. */
  holdPreimage: string;
}

function toBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("invalid hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(b: Uint8Array): string {
  return "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 over bytes or 0x-hex input, returned as 0x-hex. */
export function sha256Hex(input: Uint8Array | string): string {
  const b = typeof input === "string" ? toBytes(input) : input;
  return "0x" + createHash("sha256").update(b).digest("hex");
}

function eq(x: string, y: string): boolean {
  return x.toLowerCase() === y.toLowerCase();
}

/** The leg preimage is S itself (32 bytes) — a live FNN node can settle with it directly. */
export function deriveLegPreimageBytes(secret: Uint8Array): Uint8Array {
  if (secret.length !== JIT_LINK_SECRET_BYTES) {
    throw new Error(`JIT secret must be ${JIT_LINK_SECRET_BYTES} bytes`);
  }
  return secret.slice();
}

/**
 * Derive the 32-byte hold preimage `poseidon(S)` from secret bytes.
 *
 * S is split into two 128-bit big-endian limbs (a 32-byte value exceeds the BN254 field), fed to
 * `Poseidon(2)`, and the field element is encoded big-endian into 32 bytes. This must match
 * `dual_sha256_linkage.circom` exactly — a divergence makes the circuit unsatisfiable, so a mismatch fails at
 * proof generation rather than after the merchant leg has been paid.
 */
export function deriveHoldPreimageBytes(secret: Uint8Array): Uint8Array {
  if (secret.length !== JIT_LINK_SECRET_BYTES) {
    throw new Error(`JIT secret must be ${JIT_LINK_SECRET_BYTES} bytes`);
  }
  const hex = [...secret].map((b) => b.toString(16).padStart(2, "0")).join("");
  const hi = BigInt("0x" + hex.slice(0, 32));
  const lo = BigInt("0x" + hex.slice(32));
  const out = poseidon2([hi, lo]);
  return toBytes("0x" + out.toString(16).padStart(64, "0"));
}

/** The leg preimage is S directly; return it when it is a well-formed 32-byte value, else null. */
export function extractSecretFromLegPreimage(legPreimage: Uint8Array): Uint8Array | null {
  if (legPreimage.length !== JIT_LINK_SECRET_BYTES) return null;
  return legPreimage.slice();
}

/** Derive the hold preimage from the leg preimage (= S) using the public derivation. */
export function deriveHoldPreimageFromLeg(legPreimageHex: string): string | null {
  const secret = extractSecretFromLegPreimage(toBytes(legPreimageHex));
  if (!secret) return null;
  return toHex(deriveHoldPreimageBytes(secret));
}

/** Both invoice hashes + their 32-byte preimages, for a 32-byte secret (hex or bytes). */
export function dualSha256(secret: Uint8Array | string): DualSha256Hashes {
  const s = typeof secret === "string" ? toBytes(secret) : secret;
  const leg = deriveLegPreimageBytes(s);
  const hold = deriveHoldPreimageBytes(s);
  return {
    hold: sha256Hex(hold),
    leg: sha256Hex(leg),
    legPreimage: toHex(leg),
    holdPreimage: toHex(hold),
  };
}

/** Ground truth: does secret S link hold hash A and leg hash B? */
export function verifyDualSha256Secret(secretHex: string, holdHash: string, legHash: string): boolean {
  const { hold, leg } = dualSha256(secretHex);
  return eq(hold, holdHash) && eq(leg, legHash);
}

/** Settlement check given the leg preimage revealed by the forward payment. */
export function verifyDualSha256Linkage(
  legPreimageHex: string,
  holdHash: string,
  legHash: string,
): boolean {
  if (!eq(sha256Hex(toBytes(legPreimageHex)), legHash)) return false;
  const holdPreimage = deriveHoldPreimageFromLeg(legPreimageHex);
  if (!holdPreimage) return false;
  return eq(sha256Hex(toBytes(holdPreimage)), holdHash);
}

/**
 * Fraud proof when the leg preimage settles B but does not map to hold hash A under the derivation.
 * Returns (A, B, leg_preimage) for bond slashing / audit.
 */
export function fraudEvidenceDualSha256(
  legPreimageHex: string,
  holdHash: string,
  legHash: string,
): { a: string; b: string; preimage: string } | null {
  const legOk = eq(sha256Hex(toBytes(legPreimageHex)), legHash);
  const holdOk = verifyDualSha256Linkage(legPreimageHex, holdHash, legHash);
  return legOk && !holdOk ? { a: holdHash, b: legHash, preimage: legPreimageHex } : null;
}

/** Test/trusted only — reveals S to the LSP before forward (not zero-knowledge). */
export function exposedSecretProof(secretHex: string): LinkageProof {
  return { scheme: EXPOSED_SECRET_SCHEME, data: secretHex };
}

export const exposedSecretVerifier: LinkageVerifier = {
  scheme: EXPOSED_SECRET_SCHEME,
  verify(holdHash, legHash, proof) {
    if (proof.scheme !== EXPOSED_SECRET_SCHEME) return false;
    try {
      return verifyDualSha256Secret(proof.data, holdHash, legHash);
    } catch {
      return false;
    }
  },
};

/** Groth16 proof payload: snarkjs-format proof JSON + public signals (decimal strings). */
export interface Groth16DualSha256ProofPayload {
  proof: unknown;
  publicSignals: string[];
}

export interface Groth16DualSha256VerifierConfig {
  /** The pairing check. Defaults to `verifyGroth16Bn254` in practice; injectable for tests. */
  verifyGroth16: (vk: unknown, publicSignals: string[], proof: unknown) => Promise<boolean> | boolean;
  verificationKey: unknown;
}

/** Production linkage verifier — requires a trusted-setup vk and a Groth16 verify hook (see `groth16Bn254.ts`). */
export function createGroth16DualSha256Verifier(cfg: Groth16DualSha256VerifierConfig): LinkageVerifier {
  return {
    scheme: GROTH16_DUAL_SHA256_SCHEME,
    verify(holdHash, legHash, proof) {
      if (proof.scheme !== GROTH16_DUAL_SHA256_SCHEME) return false;
      let payload: Groth16DualSha256ProofPayload;
      try {
        payload = JSON.parse(proof.data) as Groth16DualSha256ProofPayload;
      } catch {
        return false;
      }
      if (!payload.proof || !Array.isArray(payload.publicSignals) || payload.publicSignals.length !== 4) {
        return false;
      }
      let expected: string[];
      try {
        expected = [...hashToLimbSignals(holdHash), ...hashToLimbSignals(legHash)];
      } catch {
        return false;
      }
      for (let i = 0; i < expected.length; i++) {
        if (normalizeSignal(payload.publicSignals[i]!) !== expected[i]) return false;
      }
      try {
        const ok = cfg.verifyGroth16(cfg.verificationKey, payload.publicSignals, payload.proof);
        return ok instanceof Promise ? ok.catch(() => false) : !!ok;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Map a 0x-hex 32-byte hash to the two 128-bit big-endian limbs the circuit exposes as public input:
 * `[hi, lo]` = bytes 0..15 and bytes 16..31, as decimal field elements.
 *
 * Limbs rather than 256 bit signals keep `nPublic` at 4 instead of 512, which shrinks the verification key
 * (its IC carries `nPublic + 1` group elements) and turns verification into a 5-point multi-scalar
 * multiplication instead of a 513-point one.
 */
export function hashToLimbSignals(hashHex: string): [string, string] {
  const h = hashHex.startsWith("0x") ? hashHex.slice(2) : hashHex;
  if (h.length !== 64 || !/^[0-9a-fA-F]+$/.test(h)) {
    throw new Error("hash must be a 32-byte hex string");
  }
  return [BigInt("0x" + h.slice(0, 32)).toString(10), BigInt("0x" + h.slice(32)).toString(10)];
}

export function groth16DualSha256Proof(payload: Groth16DualSha256ProofPayload): LinkageProof {
  return { scheme: GROTH16_DUAL_SHA256_SCHEME, data: JSON.stringify(payload) };
}

/** Accept proofs from any of the given verifiers (dispatch by `proof.scheme`). */
export function compositeLinkageVerifier(verifiers: LinkageVerifier[]): LinkageVerifier {
  const byScheme = new Map(verifiers.map((v) => [v.scheme, v]));
  return {
    scheme: "composite",
    verify(holdHash, legHash, proof) {
      const v = byScheme.get(proof.scheme);
      return v ? v.verify(holdHash, legHash, proof) : false;
    },
  };
}

function normalizeSignal(signal: string): string {
  try {
    return BigInt(signal).toString(10);
  } catch {
    return signal;
  }
}
