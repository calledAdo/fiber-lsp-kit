import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dualSha256,
  verifyDualSha256Linkage,
  verifyDualSha256Secret,
  fraudEvidenceDualSha256,
  deriveHoldPreimageFromLeg,
  exposedSecretVerifier,
  exposedSecretProof,
  compositeLinkageVerifier,
  createGroth16DualSha256Verifier,
  groth16DualSha256Proof,
  hashToLimbSignals,
  JIT_LINK_SECRET_BYTES,
} from "@fiberlsp/protocol";

const S = "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

test("dualSha256: hold and leg hashes differ under domain tags", () => {
  const { hold, leg, legPreimage, holdPreimage } = dualSha256(S);
  assert.notEqual(hold, leg);
  assert.equal(verifyDualSha256Secret(S, hold, leg), true);
  assert.equal(deriveHoldPreimageFromLeg(legPreimage), holdPreimage);
});

test("verifyDualSha256Linkage accepts the leg preimage (S) and rejects a mismatched secret", () => {
  const { hold, leg, legPreimage } = dualSha256(S);
  assert.equal(legPreimage, S); // v2: the leg preimage is S itself (32 bytes, FNN-settleable)
  assert.equal(verifyDualSha256Linkage(legPreimage, hold, leg), true);
  // a different secret's preimage settles neither the leg hash nor the derived hold hash
  const other = dualSha256("0x" + "aa".repeat(JIT_LINK_SECRET_BYTES));
  assert.equal(verifyDualSha256Linkage(other.legPreimage, hold, leg), false);
});

test("linked hash helpers reject malformed hex instead of coercing it", () => {
  const { hold, leg, legPreimage } = dualSha256(S);
  const malformedPreimage = legPreimage.slice(0, -2) + "zz";

  assert.throws(() => dualSha256("0x" + "00".repeat(31) + "zz"), /invalid hex/);
  assert.throws(() => deriveHoldPreimageFromLeg(malformedPreimage), /invalid hex/);
  assert.throws(() => verifyDualSha256Linkage(malformedPreimage, hold, leg), /invalid hex/);
});

test("fraudEvidenceDualSha256 flags mismatched hold/leg secrets", () => {
  const good = dualSha256(S);
  const other = dualSha256("0x" + "22".repeat(JIT_LINK_SECRET_BYTES));
  const ev = fraudEvidenceDualSha256(other.legPreimage, good.hold, other.leg);
  assert.ok(ev);
  assert.equal(ev!.a, good.hold);
  assert.equal(fraudEvidenceDualSha256(good.legPreimage, good.hold, good.leg), null);
});

test("exposedSecretVerifier accepts a valid secret proof", () => {
  const { hold, leg } = dualSha256(S);
  assert.equal(exposedSecretVerifier.verify(hold, leg, exposedSecretProof(S)), true);
  assert.equal(exposedSecretVerifier.verify(hold, leg, exposedSecretProof("0x" + "ff".repeat(32))), false);
});

test("linkage verifiers reject malformed inputs without throwing", async () => {
  const { hold, leg } = dualSha256(S);
  const publicSignals = [...hashToLimbSignals(hold), ...hashToLimbSignals(leg)];
  const verifier = createGroth16DualSha256Verifier({
    verificationKey: { vk: true },
    verifyGroth16: () => true,
  });

  assert.equal(exposedSecretVerifier.verify(hold, leg, exposedSecretProof("0x" + "00".repeat(31) + "zz")), false);
  assert.equal(
    await verifier.verify(
      "0x" + "00".repeat(31) + "zz",
      leg,
      groth16DualSha256Proof({ proof: { pi: true }, publicSignals }),
    ),
    false,
  );
});

test("compositeLinkageVerifier dispatches by scheme", () => {
  const { hold, leg } = dualSha256(S);
  const any = compositeLinkageVerifier([exposedSecretVerifier]);
  assert.equal(any.verify(hold, leg, exposedSecretProof(S)), true);
  assert.equal(any.verify(hold, leg, { scheme: "unknown", data: "" }), false);
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

test("Groth16 verifier binds hold and leg hashes as 4 public limb signals", async () => {
  const { hold, leg } = dualSha256(S);
  const publicSignals = [...hashToLimbSignals(hold), ...hashToLimbSignals(leg)];
  let verifiedSignals: string[] | undefined;
  const verifier = createGroth16DualSha256Verifier({
    verificationKey: { vk: true },
    verifyGroth16: (_vk, signals) => {
      verifiedSignals = signals;
      return true;
    },
  });

  assert.equal(
    await verifier.verify(hold, leg, groth16DualSha256Proof({ proof: { pi: true }, publicSignals })),
    true,
  );
  assert.deepEqual(verifiedSignals, publicSignals);

  const tampered = [...publicSignals];
  tampered[0] = (BigInt(tampered[0]!) + 1n).toString(10); // a limb that no longer matches hold_hash
  assert.equal(
    await verifier.verify(hold, leg, groth16DualSha256Proof({ proof: { pi: true }, publicSignals: tampered })),
    false,
  );

  assert.equal(
    await verifier.verify(leg, hold, groth16DualSha256Proof({ proof: { pi: true }, publicSignals })),
    false,
  );
});

test("Groth16 verifier rejects malformed proof payloads without calling the verifier hook", async () => {
  const { hold, leg } = dualSha256(S);
  let calls = 0;
  const verifier = createGroth16DualSha256Verifier({
    verificationKey: { vk: true },
    verifyGroth16: () => {
      calls++;
      return true;
    },
  });
  const publicSignals = [...hashToLimbSignals(hold), ...hashToLimbSignals(leg)];

  assert.equal(await verifier.verify(hold, leg, { scheme: "groth16-dual-sha256", data: "{" }), false);
  assert.equal(
    await verifier.verify(
      hold,
      leg,
      groth16DualSha256Proof({ proof: { pi: true }, publicSignals: publicSignals.slice(0, -1) }),
    ),
    false,
  );
  assert.equal(
    await verifier.verify(
      hold,
      leg,
      groth16DualSha256Proof({ proof: { pi: true }, publicSignals: [...publicSignals.slice(0, -1), "2"] }),
    ),
    false,
  );
  assert.equal(calls, 0);
});
