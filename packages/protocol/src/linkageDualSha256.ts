/**
 * Domain-separated dual-sha256 linkage — trustless single-node JIT without blake2b circuits, and
 * settleable through a real FNN node.
 *
 * FNN invoice preimages are a fixed 32-byte `Hash256` (payment_hash = sha256/blake2b of exactly 32 bytes), so
 * every preimage here is kept to 32 bytes while preserving the linkage guarantee, using one algorithm
 * (sha256) throughout:
 *
 *   leg_preimage  = S                          →  B = sha256(S)                     (merchant leg invoice)
 *   hold_preimage = sha256(TAG_HOLD || S)       →  A = sha256(hold_preimage)         (customer hold invoice)
 *
 * Both preimages are 32 bytes, so both invoices issue and settle on a real node. A ≠ B, so one node holds
 * under A and pays under B with no collision. The leg preimage is S itself, so paying the leg reveals S and
 * the LSP derives hold_preimage = sha256(TAG_HOLD||S) with no merchant reveal RPC on the honest path. The
 * TAG_HOLD is essential: without it hold_preimage would be sha256(S) = the *public* leg hash B, letting
 * anyone settle the customer hold. The ZK statement is ∃S : sha256(S)=B ∧ sha256(sha256(TAG_HOLD||S))=A —
 * three SHA-256 blocks, still practical Groth16.
 */
import { createHash } from "node:crypto";
import type { LinkageProof, LinkageVerifier } from "./linkage.js";

/** Domain tag prepended to S for the customer hold preimage (hashed to 32 bytes). */
export const JIT_LINK_HOLD_TAG = "LSPS-FIBER/JIT/HOLD\0";
/** Length of the random secret S (bytes). It is also the leg preimage. */
export const JIT_LINK_SECRET_BYTES = 32;

export const EXPOSED_SECRET_SCHEME = "exposed-secret";
export const GROTH16_DUAL_SHA256_SCHEME = "groth16-dual-sha256";

export interface DualSha256Hashes {
  /** sha256(sha256(TAG_HOLD || S)) — hold invoice hash (customer pays). */
  hold: string;
  /** sha256(S) — leg invoice hash (LSP forwards). */
  leg: string;
  /** Leg preimage = S (32 bytes). Merchant issues the leg invoice with this + hash_algorithm sha256. */
  legPreimage: string;
  /** Hold preimage = sha256(TAG_HOLD || S) (32 bytes). LSP settles the hold with this. */
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

/** Build a tagged preimage: UTF-8 tag bytes || secret bytes. */
export function taggedPreimage(tag: string, secret: Uint8Array): Uint8Array {
  const tagBytes = new TextEncoder().encode(tag);
  const out = new Uint8Array(tagBytes.length + secret.length);
  out.set(tagBytes, 0);
  out.set(secret, tagBytes.length);
  return out;
}

/** The leg preimage is S itself (32 bytes) — a live FNN node can settle with it directly. */
export function deriveLegPreimageBytes(secret: Uint8Array): Uint8Array {
  if (secret.length !== JIT_LINK_SECRET_BYTES) {
    throw new Error(`JIT secret must be ${JIT_LINK_SECRET_BYTES} bytes`);
  }
  return secret.slice();
}

/** Derive the 32-byte hold preimage sha256(TAG_HOLD || S) from secret bytes. */
export function deriveHoldPreimageBytes(secret: Uint8Array): Uint8Array {
  if (secret.length !== JIT_LINK_SECRET_BYTES) {
    throw new Error(`JIT secret must be ${JIT_LINK_SECRET_BYTES} bytes`);
  }
  return toBytes(sha256Hex(taggedPreimage(JIT_LINK_HOLD_TAG, secret)));
}

/** The leg preimage is S directly; return it when it is a well-formed 32-byte value, else null. */
export function extractSecretFromLegPreimage(legPreimage: Uint8Array): Uint8Array | null {
  if (legPreimage.length !== JIT_LINK_SECRET_BYTES) return null;
  return legPreimage.slice();
}

/** Derive the hold preimage from the leg preimage (= S) using the public tag mapping. */
export function deriveHoldPreimageFromLeg(legPreimageHex: string): string | null {
  const secret = extractSecretFromLegPreimage(toBytes(legPreimageHex));
  if (!secret) return null;
  return toHex(deriveHoldPreimageBytes(secret));
}

/** Both invoice hashes + tagged preimages for a 32-byte secret (hex or bytes). */
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
 * Fraud proof when the leg preimage settles B but does not map to hold hash A under the domain tag.
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

/** Groth16 proof payload: snarkjs-compatible proof + public signals [A, B as decimal strings]. */
export interface Groth16DualSha256ProofPayload {
  proof: unknown;
  publicSignals: string[];
}

export interface Groth16DualSha256VerifierConfig {
  /** snarkjs `groth16.verify(vk, publicSignals, proof)` — inject for tests or load vk from disk. */
  verifyGroth16: (vk: unknown, publicSignals: string[], proof: unknown) => Promise<boolean> | boolean;
  verificationKey: unknown;
}

/** Production linkage verifier — requires a trusted-setup vk + snarkjs (or compatible) verify hook. */
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
      if (!payload.proof || !Array.isArray(payload.publicSignals) || payload.publicSignals.length !== 512) {
        return false;
      }
      let expected: string[];
      try {
        expected = [...hashToBitSignals(holdHash), ...hashToBitSignals(legHash)];
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

/** Map a 0x-hex 32-byte hash to the 256 big-endian bit strings the circuit exposes as public input. */
export function hashToBitSignals(hashHex: string): string[] {
  const h = hashHex.startsWith("0x") ? hashHex.slice(2) : hashHex;
  if (h.length !== 64 || !/^[0-9a-fA-F]+$/.test(h)) {
    throw new Error("hash must be a 32-byte hex string");
  }
  const out: string[] = [];
  for (let i = 0; i < h.length; i += 2) {
    const byte = parseInt(h.slice(i, i + 2), 16);
    for (let bit = 7; bit >= 0; bit--) out.push(String((byte >> bit) & 1));
  }
  return out;
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
