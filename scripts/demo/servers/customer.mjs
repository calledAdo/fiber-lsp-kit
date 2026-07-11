// TERMINAL 3 — the customer. Long-running; logs payments.
//
//   node scripts/demo/servers/customer.mjs
//
// Exposes a tiny local control port. `actions/pay.mjs` POSTs the hold invoice to it; the customer pays it and
// watches it go Inflight → Success as the LSP settles (the LSP pays the merchant first, so the money is
// refundable until the merchant is actually paid).
import { createServer } from "node:http";
import { FiberChannelRpcClient } from "../../../packages/fiber/dist/index.js";
import { loadConfig } from "../lib/config.mjs";

const cfg = loadConfig();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = new FiberChannelRpcClient({ rpcUrl: cfg.roles.customer.fnn[0] });

async function pay(invoice) {
  // The amount is encoded in the invoice — the payer never supplies one. Read it back to show what we're paying.
  const parsed = await rpc.parseInvoice(invoice).catch(() => undefined);
  const amount = parsed?.invoice?.amount;
  console.log(`[customer] paying ${amount ? cfg.fmt(amount) : "invoice"} — ${invoice}…`);
  const sent = await rpc.sendPayment({ invoice });
  const ph = sent.payment_hash;
  console.log(`[customer] ${ph.slice(0, 16)}… → ${sent.status ?? "sent"} (captured + HELD while the LSP opens the channel)`);
  for (let i = 0; i < 120; i++) {
    const p = await rpc.getPayment(ph);
    if (p.status === "Success") { console.log(`[customer] ✅ SUCCESS — the LSP settled the hold (it paid the merchant first)`); return { status: "Success", payment_hash: ph }; }
    if (p.status === "Failed") { console.log(`[customer] ❌ failed / refunded`); return { status: "Failed", payment_hash: ph }; }
    await sleep(1000);
  }
  return { status: "Timeout", payment_hash: ph };
}

createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/pay") { res.writeHead(404).end(); return; }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const { invoice } = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!invoice) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "body must be { invoice }" })); return; }
    pay(invoice)
      .then((out) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out)); })
      .catch((e) => { console.error(`[customer] ${e.message}`); res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
  });
}).listen(cfg.roles.customer.control, "127.0.0.1", () =>
  console.log(`[customer] up — control on http://127.0.0.1:${cfg.roles.customer.control}  (fnn ${cfg.roles.customer.fnn[0]}${cfg.roles.customer.mock ? " · mock" : ""})`));
