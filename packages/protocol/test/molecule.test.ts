import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeScript, udtAsset, udtAssetFromHex, assetEquals, canonicalAssetId, CKB } from "@fiberlsp/protocol";

const RUSD_SCRIPT = {
  code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hash_type: "type" as const,
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};

// The exact molecule hex FNN returns for this RUSD udt_script — captured byte-for-byte from a live
// testnet node's invoice. This is a regression anchor: if the encoder drifts, this test breaks.
const RUSD_HEX =
  "0x550000001000000030000000310000001142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a0120000000878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b";

test("encodeScript matches the live-node RUSD molecule hex", () => {
  assert.equal(encodeScript(RUSD_SCRIPT), RUSD_HEX);
});

test("asset identity is stable across the two UDT encodings (Script object vs hex)", () => {
  const fromObject = udtAsset(RUSD_SCRIPT, "RUSD");
  const fromHex = udtAssetFromHex(RUSD_HEX, "RUSD");
  assert.equal(assetEquals(fromObject, fromHex), true);
  assert.equal(canonicalAssetId(fromObject), canonicalAssetId(fromHex));
});

test("CKB and a UDT are never equal", () => {
  assert.equal(assetEquals(CKB, udtAsset(RUSD_SCRIPT)), false);
  assert.equal(canonicalAssetId(CKB), "CKB");
});

test("encodeScript rejects a non-32-byte code_hash", () => {
  assert.throws(() => encodeScript({ ...RUSD_SCRIPT, code_hash: "0x1234" }));
});
