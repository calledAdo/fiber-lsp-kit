#!/usr/bin/env node
/**
 * Build a circom witness input for dual_sha256_linkage.circom from secret hex S.
 * Usage: node scripts/linkage-witness-input.mjs 0x<secret>
 */
import {
  dualSha256,
  hashToBitSignals,
} from "../packages/protocol/dist/linkageDualSha256.js";

const secret = process.argv[2];
if (!secret?.startsWith("0x")) {
  console.error("usage: node scripts/linkage-witness-input.mjs 0x<32-byte-secret-hex>");
  process.exit(1);
}

const { hold, leg } = dualSha256(secret);

function hexToBytes(hex) {
  const h = hex.slice(2);
  return Array.from({ length: h.length / 2 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16));
}

const secretBytes = hexToBytes(secret);

const out = {
  secret: secretBytes,
  hold_hash: hashToBitSignals(hold).map(Number),
  leg_hash: hashToBitSignals(leg).map(Number),
};

console.log(JSON.stringify(out, null, 2));
console.error(`publicSignals: [${[...hashToBitSignals(hold), ...hashToBitSignals(leg)].join(",")}]`);
