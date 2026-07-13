/**
 * The LSP verifies a linkage proof before it funds a channel and pays a merchant, so this file guards money.
 * Completeness is easy to test and proves little; what matters is that every way of forging or mangling a
 * proof is rejected. The fixtures are a real proof from the shipped circuit, over the secret in
 * `groth16_secret.json`, produced by the development setup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createGroth16DualSha256Verifier,
  dualSha256,
  groth16DualSha256Proof,
  hashToLimbSignals,
  verifyGroth16Bn254,
  type Groth16Proof,
  type Groth16VerificationKey,
} from "@fiberlsp/protocol";

const here = dirname(fileURLToPath(import.meta.url));
const load = <T,>(name: string): T => JSON.parse(readFileSync(join(here, "fixtures", name), "utf8")) as T;

const vk = load<Groth16VerificationKey>("groth16_vk.json");
const proof = load<Groth16Proof>("groth16_proof.json");
const publicSignals = load<string[]>("groth16_public.json");
const secret = load<string>("groth16_secret.json");

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

test("accepts a real proof from the shipped circuit", () => {
  assert.equal(verifyGroth16Bn254(vk, publicSignals, proof), true);
});

test("the fixture's public signals are the limbs of the linked hashes", () => {
  const { hold, merchantPaymentHash } = dualSha256(secret);
  assert.deepEqual(publicSignals, [...hashToLimbSignals(hold), ...hashToLimbSignals(merchantPaymentHash)]);
});

test("rejects a tampered public signal", () => {
  const pub = clone(publicSignals);
  pub[0] = (BigInt(pub[0]!) + 1n).toString();
  assert.equal(verifyGroth16Bn254(vk, pub, proof), false);
});

test("rejects a public signal that is not field-reduced", () => {
  // s and s + r are the same field element; accepting the unreduced form would verify one statement while a
  // caller comparing decimal strings believes it verified another.
  const pub = clone(publicSignals);
  pub[0] = (BigInt(pub[0]!) + BN254_R).toString();
  assert.equal(verifyGroth16Bn254(vk, pub, proof), false);
});

test("rejects tampered proof points", () => {
  for (const field of ["pi_a", "pi_c"] as const) {
    const p = clone(proof);
    p[field][0] = (BigInt(p[field][0]!) + 1n).toString();
    assert.equal(verifyGroth16Bn254(vk, publicSignals, p), false, field);
  }
  const swapped = clone(proof);
  [swapped.pi_a, swapped.pi_c] = [swapped.pi_c, swapped.pi_a];
  assert.equal(verifyGroth16Bn254(vk, publicSignals, swapped), false, "swapped pi_a/pi_c");
});

test("rejects a G2 point that is on the curve but outside the r-order subgroup", () => {
  // BN254's G2 has a large cofactor, so most on-curve points are NOT in the r-order subgroup, and pairing
  // against one is meaningless. This point satisfies the curve equation (x = 2 + u, y = the Fp2 square root of
  // x^3 + b') and is genuinely off-subgroup — a verifier that only checked the curve equation would accept it.
  const p = clone(proof);
  p.pi_b[0] = ["2", "1"];
  p.pi_b[1] = [
    "7292567877523311580221095596750716176434782432868683424513645834767876293070",
    "19659275751359636165940301690575149581329631496732780143538578556285923319774",
  ];
  p.pi_b[2] = ["1", "0"];
  assert.equal(verifyGroth16Bn254(vk, publicSignals, p), false);
});

test("rejects a G2 point that is not on the curve at all", () => {
  const p = clone(proof);
  p.pi_b[0] = ["1", "0"];
  p.pi_b[1] = ["2", "0"];
  assert.equal(verifyGroth16Bn254(vk, publicSignals, p), false);
});

test("rejects a proof whose points are not normalised (z != 1)", () => {
  const p = clone(proof);
  p.pi_a[2] = "2";
  assert.equal(verifyGroth16Bn254(vk, publicSignals, p), false);
});

test("rejects a signal count that disagrees with the key's IC length", () => {
  assert.equal(verifyGroth16Bn254(vk, publicSignals.slice(0, 3), proof), false);
  assert.equal(verifyGroth16Bn254(vk, [...publicSignals, "1"], proof), false);
});

test("rejects garbage and never throws", () => {
  const garbage: Groth16Proof = {
    pi_a: ["1", "2", "1"],
    pi_b: [["1", "2"], ["3", "4"], ["1", "0"]],
    pi_c: ["1", "2", "1"],
  };
  assert.equal(verifyGroth16Bn254(vk, publicSignals, garbage), false);
  assert.equal(verifyGroth16Bn254(vk, publicSignals, {} as Groth16Proof), false);
  assert.equal(verifyGroth16Bn254({} as Groth16VerificationKey, publicSignals, proof), false);
  assert.equal(verifyGroth16Bn254(vk, ["not-a-number", "1", "2", "3"], proof), false);
});

test("rejects a non-groth16 protocol tag", () => {
  assert.equal(verifyGroth16Bn254({ ...vk, protocol: "plonk" }, publicSignals, proof), false);
});

test("the linkage verifier accepts the real proof for its hashes and rejects it for others", () => {
  const verifier = createGroth16DualSha256Verifier({ verificationKey: vk, verifyGroth16: verifyGroth16Bn254 as never });
  const { hold, merchantPaymentHash } = dualSha256(secret);
  const payload = groth16DualSha256Proof({ proof, publicSignals });

  assert.equal(verifier.verify(hold, merchantPaymentHash, payload), true);
  // Same valid proof, but bound to a different hash pair: the public-signal check must catch it before the
  // pairing ever runs, or an attacker could replay one honest proof against any order.
  const other = dualSha256("0x" + "22".repeat(32));
  assert.equal(verifier.verify(other.hold, merchantPaymentHash, payload), false);
  assert.equal(verifier.verify(hold, other.merchantPaymentHash, payload), false);
});
