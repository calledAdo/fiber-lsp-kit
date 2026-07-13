import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dualSha256,
  verifyDualSha256Linkage,
  verifyDualSha256Secret,
  fraudEvidenceDualSha256,
  deriveHoldPreimageFromMerchant,
  exposedSecretVerifier,
  exposedSecretProof,
  compositeLinkageVerifier,
  createGroth16DualSha256Verifier,
  groth16DualSha256Proof,
  hashToLimbSignals,
  JIT_LINK_SECRET_BYTES,
} from "@fiberlsp/protocol";

const S = "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

test("dualSha256: hold and merchant payment hashes differ, and the hold preimage derives from the merchant preimage", () => {
  const { hold, merchantPaymentHash, merchantPreimage, holdPreimage } = dualSha256(S);
  assert.notEqual(hold, merchantPaymentHash);
  assert.equal(verifyDualSha256Secret(S, hold, merchantPaymentHash), true);
  assert.equal(deriveHoldPreimageFromMerchant(merchantPreimage), holdPreimage);
  // hold_preimage must never equal the *public* merchant payment hash, or anyone could settle the customer hold
  assert.notEqual(holdPreimage, merchantPaymentHash);
});

// The JS derivation must agree with poseidon.circom bit-for-bit, or the circuit is unsatisfiable. Pin the
// canonical circomlib Poseidon(2) vector so a poseidon-lite bump cannot silently diverge from the circuit.
test("poseidon-lite matches the circomlib Poseidon(2) reference vector", async () => {
  const { poseidon2 } = await import("poseidon-lite");
  assert.equal(
    poseidon2([1n, 2n]).toString(),
    "7853200120776062878684798364095072458815029376092732009249414926327459813530",
  );
});

test("hold preimage is poseidon(S) encoded big-endian into 32 bytes", async () => {
  const { poseidon2 } = await import("poseidon-lite");
  const hi = BigInt("0x" + S.slice(2, 34));
  const lo = BigInt("0x" + S.slice(34));
  const expected = "0x" + poseidon2([hi, lo]).toString(16).padStart(64, "0");
  assert.equal(dualSha256(S).holdPreimage, expected);
});

test("verifyDualSha256Linkage accepts the merchant preimage (S) and rejects a mismatched secret", () => {
  const { hold, merchantPaymentHash, merchantPreimage } = dualSha256(S);
  assert.equal(merchantPreimage, S); // v2: the merchant preimage is S itself (32 bytes, FNN-settleable)
  assert.equal(verifyDualSha256Linkage(merchantPreimage, hold, merchantPaymentHash), true);
  // a different secret's preimage settles neither the merchant payment hash nor the derived hold hash
  const other = dualSha256("0x" + "aa".repeat(JIT_LINK_SECRET_BYTES));
  assert.equal(verifyDualSha256Linkage(other.merchantPreimage, hold, merchantPaymentHash), false);
});

test("linked hash helpers reject malformed hex instead of coercing it", () => {
  const { hold, merchantPaymentHash, merchantPreimage } = dualSha256(S);
  const malformedPreimage = merchantPreimage.slice(0, -2) + "zz";

  assert.throws(() => dualSha256("0x" + "00".repeat(31) + "zz"), /invalid hex/);
  assert.throws(() => deriveHoldPreimageFromMerchant(malformedPreimage), /invalid hex/);
  assert.throws(() => verifyDualSha256Linkage(malformedPreimage, hold, merchantPaymentHash), /invalid hex/);
});

test("fraudEvidenceDualSha256 flags mismatched hold and merchant payment secrets", () => {
  const good = dualSha256(S);
  const other = dualSha256("0x" + "22".repeat(JIT_LINK_SECRET_BYTES));
  const ev = fraudEvidenceDualSha256(other.merchantPreimage, good.hold, other.merchantPaymentHash);
  assert.ok(ev);
  assert.equal(ev!.a, good.hold);
  assert.equal(fraudEvidenceDualSha256(good.merchantPreimage, good.hold, good.merchantPaymentHash), null);
});

test("exposedSecretVerifier accepts a valid secret proof", () => {
  const { hold, merchantPaymentHash } = dualSha256(S);
  assert.equal(exposedSecretVerifier.verify(hold, merchantPaymentHash, exposedSecretProof(S)), true);
  assert.equal(exposedSecretVerifier.verify(hold, merchantPaymentHash, exposedSecretProof("0x" + "ff".repeat(32))), false);
});

test("linkage verifiers reject malformed inputs without throwing", async () => {
  const { hold, merchantPaymentHash } = dualSha256(S);
  const publicSignals = [...hashToLimbSignals(hold), ...hashToLimbSignals(merchantPaymentHash)];
  const verifier = createGroth16DualSha256Verifier({
    verificationKey: { vk: true },
    verifyGroth16: () => true,
  });

  assert.equal(exposedSecretVerifier.verify(hold, merchantPaymentHash, exposedSecretProof("0x" + "00".repeat(31) + "zz")), false);
  assert.equal(
    await verifier.verify(
      "0x" + "00".repeat(31) + "zz",
      merchantPaymentHash,
      groth16DualSha256Proof({ proof: { pi: true }, publicSignals }),
    ),
    false,
  );
});

test("compositeLinkageVerifier dispatches by scheme", () => {
  const { hold, merchantPaymentHash } = dualSha256(S);
  const any = compositeLinkageVerifier([exposedSecretVerifier]);
  assert.equal(any.verify(hold, merchantPaymentHash, exposedSecretProof(S)), true);
  assert.equal(any.verify(hold, merchantPaymentHash, { scheme: "unknown", data: "" }), false);
});

test("hashToLimbSignals splits a hash into two 128-bit big-endian limbs", () => {
  // hi = bytes 0..15, lo = bytes 16..31
  const [hi, lo] = hashToLimbSignals("0x80" + "00".repeat(31));
  assert.equal(hi, (1n << 127n).toString(10));
  assert.equal(lo, "0");

  const [hi2, lo2] = hashToLimbSignals("0x" + "00".repeat(31) + "ff");
  assert.equal(hi2, "0");
  assert.equal(lo2, "255");

  assert.throws(() => hashToLimbSignals("0xdeadbeef"), /32-byte hex/);
});

test("Groth16 verifier binds hold and merchant payment hashes as 4 public limb signals", async () => {
  const { hold, merchantPaymentHash } = dualSha256(S);
  const publicSignals = [...hashToLimbSignals(hold), ...hashToLimbSignals(merchantPaymentHash)];
  let verifiedSignals: string[] | undefined;
  const verifier = createGroth16DualSha256Verifier({
    verificationKey: { vk: true },
    verifyGroth16: (_vk, signals) => {
      verifiedSignals = signals;
      return true;
    },
  });

  assert.equal(
    await verifier.verify(hold, merchantPaymentHash, groth16DualSha256Proof({ proof: { pi: true }, publicSignals })),
    true,
  );
  assert.deepEqual(verifiedSignals, publicSignals);

  const tampered = [...publicSignals];
  tampered[0] = (BigInt(tampered[0]!) + 1n).toString(10); // a limb that no longer matches hold_hash
  assert.equal(
    await verifier.verify(hold, merchantPaymentHash, groth16DualSha256Proof({ proof: { pi: true }, publicSignals: tampered })),
    false,
  );

  assert.equal(
    await verifier.verify(merchantPaymentHash, hold, groth16DualSha256Proof({ proof: { pi: true }, publicSignals })),
    false,
  );
});

test("Groth16 verifier rejects malformed proof payloads without calling the verifier hook", async () => {
  const { hold, merchantPaymentHash } = dualSha256(S);
  let calls = 0;
  const verifier = createGroth16DualSha256Verifier({
    verificationKey: { vk: true },
    verifyGroth16: () => {
      calls++;
      return true;
    },
  });
  const publicSignals = [...hashToLimbSignals(hold), ...hashToLimbSignals(merchantPaymentHash)];

  assert.equal(await verifier.verify(hold, merchantPaymentHash, { scheme: "groth16-dual-sha256", data: "{" }), false);
  assert.equal(
    await verifier.verify(
      hold,
      merchantPaymentHash,
      groth16DualSha256Proof({ proof: { pi: true }, publicSignals: publicSignals.slice(0, -1) }),
    ),
    false,
  );
  assert.equal(
    await verifier.verify(
      hold,
      merchantPaymentHash,
      groth16DualSha256Proof({ proof: { pi: true }, publicSignals: [...publicSignals.slice(0, -1), "2"] }),
    ),
    false,
  );
  assert.equal(calls, 0);
});
