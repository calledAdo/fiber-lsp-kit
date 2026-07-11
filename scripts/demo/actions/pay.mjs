// ACTION — tell the customer to pay the current hold invoice.
//
//   node scripts/demo/actions/pay.mjs
//
// Reads the hold invoice the merchant just published and asks the customer server to pay it. The customer
// server logs the payment going Inflight → Success; the LSP server logs open → forward → settle.
import { loadConfig, loadState } from "../lib/config.mjs";

const cfg = loadConfig();
const hold = loadState("jit-hold");
if (!hold) { console.error("no hold invoice yet — run: node scripts/demo/actions/request-invoice.mjs"); process.exit(1); }

const url = `http://127.0.0.1:${cfg.roles.customer.control}/pay`;
const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invoice: hold.invoice }) })
  .catch((e) => { console.error(`cannot reach the customer server at ${url} — is it up? (${e.message})`); process.exit(1); });
const out = await res.json();
if (!res.ok) { console.error(`customer refused: ${out.error}`); process.exit(1); }

console.log(`payment: ${out.status}`);
if (out.status === "Success") console.log(`the merchant now has a channel-backed payment, and a channel. One sale did both.`);
process.exit(out.status === "Success" ? 0 : 1);
