// ACTION — pay the plain (non-JIT) invoice directly over the open channel.
//
//   node scripts/demo/actions/direct-pay.mjs
//
// Unlike the JIT hold invoice, this settles immediately: the channel already exists, so there is no open,
// no forward, no hold — just a normal payment.
import { loadConfig, loadState } from "../lib/config.mjs";

const cfg = loadConfig();
const inv = loadState("direct-invoice");
if (!inv) { console.error("no direct invoice yet — run: node scripts/demo/actions/direct-invoice.mjs"); process.exit(1); }

const url = `http://127.0.0.1:${cfg.roles.customer.control}/pay`;
const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invoice: inv.invoice }) })
  .catch((e) => { console.error(`cannot reach the customer server at ${url} — is it up? (${e.message})`); process.exit(1); });
const out = await res.json();
if (!res.ok) { console.error(`customer refused: ${out.error}`); process.exit(1); }

console.log(`payment: ${out.status}`);
if (out.status === "Success") console.log(`paid directly over the existing channel — no JIT, no proof, no hold.`);
process.exit(out.status === "Success" ? 0 : 1);
