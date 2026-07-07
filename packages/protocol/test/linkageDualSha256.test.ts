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
  hashToBitSignals,
  JIT_LINK_SECRET_BYTES,
} from "@fiberlsp/protocol";

const S = "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

test("dualSha256: hold and leg hashes differ under domain tags", () => {
  const { hold, leg, legPreimage, holdPreimage } = dualSha256(S);
  assert.notEqual(hold, leg);
  assert.equal(verifyDualSha256Secret(S, hold, leg), true);
  assert.equal(deriveHoldPreimageFromLeg(legPreimage), holdPreimage);
});

test("verifyDualSha256Linkage accepts the leg preimage and rejects a wrong tag", () => {
  const { hold, leg, legPreimage } = dualSha256(S);
  assert.equal(verifyDualSha256Linkage(legPreimage, hold, leg), true);
  assert.equal(verifyDualSha256Linkage(S, hold, leg), false);
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
  const publicSignals = [...hashToBitSignals(hold), ...hashToBitSignals(leg)];
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

test("hashToBitSignals returns 256 big-endian public bit signals", () => {
  const bits = hashToBitSignals("0x80" + "00".repeat(31));
  assert.equal(bits.length, 256);
  assert.equal(bits[0], "1");
  assert.equal(bits[1], "0");
  assert.equal(bits[7], "0");
  assert.equal(bits[255], "0");
});

test("Groth16 verifier binds hold and leg hashes as 512 public bit signals", async () => {
  const { hold, leg } = dualSha256(S);
  const publicSignals = [...hashToBitSignals(hold), ...hashToBitSignals(leg)];
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
  tampered[0] = tampered[0] === "1" ? "0" : "1";
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
  const publicSignals = [...hashToBitSignals(hold), ...hashToBitSignals(leg)];

  assert.equal(await verifier.verify(hold, leg, { scheme: "groth16-dual-sha256-v1", data: "{" }), false);
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
