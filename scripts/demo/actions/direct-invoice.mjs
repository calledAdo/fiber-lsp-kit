// ACTION — after the JIT sale, issue a PLAIN invoice over the now-open channel (no hold, no proof).
//
//   node scripts/demo/actions/direct-invoice.mjs
//
// Run this after request-invoice + pay: the merchant already has a channel, so a repeat sale is an ordinary
// node-native invoice that settles directly.
import { loadConfig } from "../lib/config.mjs";

const cfg = loadConfig();
const url = `http://127.0.0.1:${cfg.roles.merchant.control}/direct-invoice`;
const res = await fetch(url, { method: "POST" }).catch((e) => { console.error(`cannot reach the merchant server at ${url} — is it up? (${e.message})`); process.exit(1); });
const out = await res.json();
if (!res.ok) { console.error(`merchant refused: ${out.error}`); process.exit(1); }

console.log(`direct invoice (channel already open, ${cfg.fmt(cfg.amounts.jitPayment)}):`);
console.log(`  ${out.invoice}`);
console.log(`\nnext: node scripts/demo/actions/direct-pay.mjs`);
