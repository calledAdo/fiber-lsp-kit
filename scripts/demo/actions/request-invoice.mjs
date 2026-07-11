// ACTION — tell the merchant to start a JIT checkout and print the resulting hold invoice.
//
//   node scripts/demo/actions/request-invoice.mjs
//
// The merchant server does the real work (mode negotiation, Groth16 proof, hold invoice) and logs it; this
// just triggers it and shows the invoice a customer would pay.
import { loadConfig } from "../lib/config.mjs";

const cfg = loadConfig();
const url = `http://127.0.0.1:${cfg.roles.merchant.control}/request-invoice`;

const res = await fetch(url, { method: "POST" }).catch((e) => { console.error(`cannot reach the merchant server at ${url} — is it up? (${e.message})`); process.exit(1); });
const out = await res.json();
if (!res.ok) { console.error(`merchant refused: ${out.error}`); process.exit(1); }

console.log(`mode: ${out.mode}`);
console.log(`hold invoice (the customer pays this):`);
console.log(`  ${out.invoice}`);
console.log(`merchant nets ${cfg.fmt(out.netAmount)} of ${cfg.fmt(cfg.amounts.jitPayment)} (fee ${cfg.fmt(out.fee)})`);
console.log(`\nnext: node scripts/demo/actions/pay.mjs`);
