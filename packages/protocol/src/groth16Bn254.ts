/**
 * Groth16 verification over BN254, with no proof-system dependency.
 *
 * The LSP verifies a linkage proof before it funds a channel and pays a merchant, so this is the code that
 * guards its money. It is deliberately small: parse a circom-format verification key and proof, then check the
 * single pairing equation. The only dependency is `@noble/curves` for BN254 arithmetic.
 *
 * The equation Groth16 verification reduces to is
 *
 *     e(A, B) = e(alpha, beta) · e(vk_x, gamma) · e(C, delta)        where vk_x = IC[0] + Σ pubᵢ·IC[i+1]
 *
 * which is checked in the equivalent product form `e(-A, B) · e(alpha, beta) · e(vk_x, gamma) · e(C, delta) = 1`
 * so that a single batched Miller loop and one final exponentiation suffice.
 *
 * Key/proof shape is the standard circom Groth16 JSON: G1 points are `[x, y, z]` decimal strings, G2 are
 * `[[x0, x1], [y0, y1], [z0, z1]]`, both in Jacobian-style projective form where a valid point always has
 * `z = 1` (every prover normalises before serialising). Anything else is rejected rather than normalised — a
 * verifier should not be in the business of repairing malformed input.
 */
import { bn254 } from "@noble/curves/bn254.js";

const { G1, G2, fields, pairingBatch } = bn254;
const Fp12 = fields.Fp12;

/** A circom Groth16 `verification_key.json` (bn128). Only the fields verification actually reads. */
export interface Groth16VerificationKey {
  protocol?: string;
  curve?: string;
  nPublic?: number;
  vk_alpha_1: string[];
  vk_beta_2: string[][];
  vk_gamma_2: string[][];
  vk_delta_2: string[][];
  IC: string[][];
}

/** A circom Groth16 proof JSON, as emitted by any conforming prover. */
export interface Groth16Proof {
  protocol?: string;
  curve?: string;
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}

const FP_ORDER = G1.Point.Fp.ORDER;
const FR_ORDER = bn254.fields.Fr.ORDER;

function fp(value: string): bigint {
  const v = BigInt(value);
  if (v < 0n || v >= FP_ORDER) throw new Error("coordinate out of field");
  return v;
}

/** A G1 point from `[x, y, z]`. Requires the affine form (`z = 1`). */
function g1(point: string[] | undefined): InstanceType<typeof G1.Point> {
  if (!Array.isArray(point) || point.length < 3) throw new Error("malformed G1 point");
  if (BigInt(point[2]!) !== 1n) throw new Error("G1 point is not normalised (z != 1)");
  const p = G1.Point.fromAffine({ x: fp(point[0]!), y: fp(point[1]!) });
  p.assertValidity(); // on-curve; BN254's G1 is prime-order so this also settles subgroup membership
  return p;
}

/** A G2 point from `[[x0, x1], [y0, y1], [z0, z1]]`. Requires the affine form. */
function g2(point: string[][] | undefined): InstanceType<typeof G2.Point> {
  if (!Array.isArray(point) || point.length < 3) throw new Error("malformed G2 point");
  const [z0, z1] = point[2]!;
  if (BigInt(z0!) !== 1n || BigInt(z1!) !== 0n) throw new Error("G2 point is not normalised (z != 1)");
  const p = G2.Point.fromAffine({
    x: { c0: fp(point[0]![0]!), c1: fp(point[0]![1]!) },
    y: { c0: fp(point[1]![0]!), c1: fp(point[1]![1]!) },
  });
  // BN254's G2 is not prime-order: a point can be on-curve yet outside the r-order subgroup, and a pairing
  // against such a point is meaningless. noble's `assertValidity` on G2 checks both — it fails these with
  // "not in prime-order subgroup" — so no separate `isTorsionFree` call is needed (it would just repeat the
  // scalar multiplication). `groth16Bn254.test.ts` pins that behaviour with a real off-subgroup point.
  p.assertValidity();
  return p;
}

/**
 * Verify a Groth16 proof against a circom verification key. Returns false on any malformed input rather than
 * throwing — a bad proof and an unparseable proof are the same answer to the caller.
 */
export function verifyGroth16Bn254(
  vk: Groth16VerificationKey,
  publicSignals: readonly string[],
  proof: Groth16Proof,
): boolean {
  try {
    if (vk.protocol && vk.protocol !== "groth16") return false;
    if (proof.protocol && proof.protocol !== "groth16") return false;
    // IC carries nPublic + 1 points; a key that disagrees with the signals cannot be the right key.
    if (!Array.isArray(vk.IC) || vk.IC.length !== publicSignals.length + 1) return false;
    if (typeof vk.nPublic === "number" && vk.nPublic !== publicSignals.length) return false;

    const alpha = g1(vk.vk_alpha_1);
    const beta = g2(vk.vk_beta_2);
    const gamma = g2(vk.vk_gamma_2);
    const delta = g2(vk.vk_delta_2);
    const a = g1(proof.pi_a);
    const b = g2(proof.pi_b);
    const c = g1(proof.pi_c);

    // vk_x = IC[0] + Σ pubᵢ · IC[i+1]
    let vkX = g1(vk.IC[0]);
    for (let i = 0; i < publicSignals.length; i++) {
      const s = BigInt(publicSignals[i]!);
      if (s < 0n || s >= FR_ORDER) return false; // an unreduced signal would verify a different statement
      vkX = vkX.add(g1(vk.IC[i + 1]).multiplyUnsafe(s));
    }

    // e(-A, B) · e(alpha, beta) · e(vk_x, gamma) · e(C, delta) == 1
    const product = pairingBatch([
      { g1: a.negate(), g2: b },
      { g1: alpha, g2: beta },
      { g1: vkX, g2: gamma },
      { g1: c, g2: delta },
    ]);
    return Fp12.eql(product, Fp12.ONE);
  } catch {
    return false;
  }
}
