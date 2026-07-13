// ACTION — stream rent to the LSP for a few periods, out of revenue over the same channel.
//
//   node scripts/demo/actions/stream-rent.mjs
//
// The merchant server drives StreamingLease.payDue() (keysend to the LSP) and logs each period; this triggers
// it and prints the totals.
import { loadConfig } from "../lib/config.mjs";

const cfg = loadConfig();
const url = `http://127.0.0.1:${cfg.roles.merchant.control}/stream-rent`;
const res = await fetch(url, { method: "POST" }).catch((e) => { console.error(`cannot reach the merchant server at ${url} — is it up? (${e.message})`); process.exit(1); });
const out = await res.json();
if (!res.ok) { console.error(`merchant refused: ${out.error}`); process.exit(1); }

console.log(`rent streamed: ${out.periodsPaid} live-priced period(s), total ${cfg.fmt(out.totalPaid)}`);
