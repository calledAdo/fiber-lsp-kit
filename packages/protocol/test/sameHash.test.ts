import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dualSha256, sameHashLink, verifySameHashLinkage } from "@fiberlsp/protocol";

const S = "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

test("the hash is sha256 of the secret and the preimage is the secret", () => {
  const link = sameHashLink(S);
  const expected = "0x" + createHash("sha256").update(Buffer.from(S.slice(2), "hex")).digest("hex");
  assert.equal(link.hash, expected);
  assert.equal(link.preimage, S);
});

test("bytes and hex inputs agree", () => {
  assert.deepEqual(sameHashLink(Uint8Array.from(Buffer.from(S.slice(2), "hex"))), sameHashLink(S));
});

test("the secret must be 32 bytes — a live FNN preimage is a fixed-width Hash256", () => {
  assert.throws(() => sameHashLink("0x" + "11".repeat(31)), /32 bytes/);
  assert.throws(() => sameHashLink("0x" + "11".repeat(33)), /32 bytes/);
});

test("the merchant preimage settles the hold, because the hold is the same hash", () => {
  const link = sameHashLink(S);
  assert.equal(verifySameHashLinkage(link.preimage, link.hash, link.hash), true);
});

test("linkage is rejected when the two hashes differ", () => {
  const link = sameHashLink(S);
  const other = sameHashLink("0x" + "22".repeat(32));
  assert.equal(verifySameHashLinkage(link.preimage, other.hash, link.hash), false);
  assert.equal(verifySameHashLinkage(link.preimage, link.hash, other.hash), false);
});

test("linkage is rejected for a preimage that does not hash to the pair", () => {
  const link = sameHashLink(S);
  const other = sameHashLink("0x" + "22".repeat(32));
  assert.equal(verifySameHashLinkage(other.preimage, link.hash, link.hash), false);
});

test("linkage is rejected for a preimage of the wrong width", () => {
  const link = sameHashLink(S);
  assert.equal(verifySameHashLinkage("0x" + "11".repeat(31), link.hash, link.hash), false);
});

test("the same secret drives both constructions, and same_hash reuses the linked merchant payment hash", () => {
  // merchant_payment_hash = sha256(S) in both modes; same_hash simply reuses it as the hold hash instead of
  // sha256(poseidon(S)). That is the entire difference, and it is why the proof disappears.
  const linked = dualSha256(S);
  const same = sameHashLink(S);
  assert.equal(same.hash, linked.merchantPaymentHash);
  assert.equal(same.preimage, linked.merchantPreimage);
  assert.notEqual(linked.hold, linked.merchantPaymentHash);
});
