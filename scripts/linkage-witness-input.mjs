#!/usr/bin/env node
/**
 * Build a circom witness input for dual_sha256_linkage.circom from secret hex S.
 * Usage: node scripts/linkage-witness-input.mjs 0x<secret>
 */
import {
  dualSha256,
  hashToLimbSignals,
} from "../packages/protocol/dist/linkageDualSha256.js";

const secret = process.argv[2];
if (!secret?.startsWith("0x")) {
  console.error("usage: node scripts/linkage-witness-input.mjs 0x<32-byte-secret-hex>");
  process.exit(1);
}

const { hold, merchantPaymentHash } = dualSha256(secret);

function hexToBytes(hex) {
  const h = hex.slice(2);
  return Array.from({ length: h.length / 2 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16));
}

const [holdHi, holdLo] = hashToLimbSignals(hold);
const [merchantHashHi, merchantHashLo] = hashToLimbSignals(merchantPaymentHash);

const out = {
  secret: hexToBytes(secret),
  hold_hi: holdHi,
  hold_lo: holdLo,
  merchant_hash_hi: merchantHashHi,
  merchant_hash_lo: merchantHashLo,
};

console.log(JSON.stringify(out, null, 2));
console.error(`publicSignals: [${[holdHi, holdLo, merchantHashHi, merchantHashLo].join(",")}]`);
