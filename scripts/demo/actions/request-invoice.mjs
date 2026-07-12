// ACTION — tell the merchant to start a JIT checkout and print the resulting hold invoice.
//
//   node scripts/demo/actions/request-invoice.mjs [amount] [capacity]
//   npm run demo:invoice -- 5          # a 5 RUSD sale
//   npm run demo:invoice -- 5 20       # 5 RUSD sale, open a 20 RUSD channel
//
// Amounts are human units of the asset (e.g. RUSD); omit to use demo.config.json's defaults. The merchant
// server does the real work (mode negotiation, Groth16 proof, hold invoice) and logs it.
import { loadConfig } from "../lib/config.mjs";

const cfg = loadConfig();
const [amountArg, capacityArg] = process.argv.slice(2);
const body = {};
if (amountArg !== undefined) body.amount = cfg.toBase(amountArg);
if (capacityArg !== undefined) body.capacity = cfg.toBase(capacityArg);

const url = `http://127.0.0.1:${cfg.roles.merchant.control}/request-invoice`;
const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .catch((e) => { console.error(`cannot reach the merchant server at ${url} — is it up? (${e.message})`); process.exit(1); });
const out = await res.json();
if (!res.ok) { console.error(`merchant refused: ${out.error}`); process.exit(1); }

console.log(`mode: ${out.mode}`);
console.log(`hold invoice (the customer pays this):`);
console.log(`  ${out.invoice}`);
console.log(`merchant nets ${cfg.fmt(out.netAmount)} (fee ${cfg.fmt(out.fee)})`);
console.log(`\nnext: node scripts/demo/actions/pay.mjs`);
