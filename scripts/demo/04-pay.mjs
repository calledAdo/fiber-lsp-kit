// DEMO STEP 3 — the customer PAYS THE INVOICE, routed through the LSP, and the merchant's backend books it.
//
//   node <this>
//
// Reads the invoice from step 2. The customer (node#2) has no direct channel to the merchant (node#3), so the
// payment ROUTES node#2 → node#1(LSP) → node#3. Then the merchant's server-side `InvoiceWebhookService` sees it
// settle, delivers an `invoice.paid` webhook to a real local sink, and `SettlementLedger` reconciles + exports.
import { FiberChannelRpcClient, udtAsset } from "../../packages/protocol/dist/index.js";
import { InvoiceWebhookService } from "../../packages/lsp-server/dist/index.js";
import { SettlementLedger } from "../../packages/client/dist/index.js";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUSD_SCRIPT = {
  code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hash_type: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const CUSTOMER_RPC = process.env.CUSTOMER_RPC ?? "http://127.0.0.1:8237";
const MERCHANT_RPC = process.env.MERCHANT_RPC ?? "http://127.0.0.1:8247";

const { invoice, payment_hash, amount } = JSON.parse(readFileSync(new URL("./.invoice.json", import.meta.url)));
const rpc2 = new FiberChannelRpcClient({ rpcUrl: CUSTOMER_RPC });
const rpc3 = new FiberChannelRpcClient({ rpcUrl: MERCHANT_RPC });
const sumRusd = (chs, field) =>
  chs.filter((c) => c.funding_udt_type_script?.code_hash === RUSD_SCRIPT.code_hash && c.state.state_name === "ChannelReady")
     .reduce((s, c) => s + BigInt(c[field]), 0n);
const spendable = async (rpc) => sumRusd(await rpc.listChannels(), "local_balance");
const n = (v) => Number(v) / 1e8;

function makeSink() {
  return new Promise((res) => {
    let hit; const received = new Promise((r) => (hit = r));
    const s = createServer((rq, rs) => { const c = []; rq.on("data", (x) => c.push(x));
      rq.on("end", () => { rs.writeHead(200); rs.end("{}"); hit(JSON.parse(Buffer.concat(c).toString("utf8"))); }); });
    s.listen(0, "127.0.0.1", () => res({ url: `http://127.0.0.1:${s.address().port}/hooks`, received, close: () => s.close() }));
  });
}

console.log(`\n=== STEP 4 · Customer pays ${n(BigInt(amount))} RUSD — routed customer → LSP → merchant ===`);
const cBefore = await spendable(rpc2), mBefore = await spendable(rpc3);
const sink = await makeSink();

// pay (retry while the LSP→merchant channel gossips into the customer's graph)
let sent;
for (let a = 1; a <= 20; a++) {
  try { sent = await rpc2.call("send_payment", [{ invoice }]); break; }
  catch (e) { if (/no path|route|pathfind/i.test(e.message)) { console.log("   no route yet (gossip propagating), wait 30s…"); await sleep(30000); } else throw e; }
}
if (!sent) { console.error("   ❌ no route found"); sink.close(); process.exit(1); }
const ph = sent.payment_hash ?? payment_hash;
let pay = sent;
for (let i = 0; i < 60; i++) { await sleep(2000); pay = await rpc2.call("get_payment", [{ payment_hash: ph }]); if (pay.status === "Success" || pay.status === "Failed") break; }
if (pay.status !== "Success") { console.error(`   ❌ payment ${pay.status} ${pay.failed_error ?? ""}`); sink.close(); process.exit(1); }

const cAfter = await spendable(rpc2), mAfter = await spendable(rpc3);
console.log(`   payment: ${pay.status}  (fee ${pay.fee})`);
console.log(`   customer RUSD spendable: ${n(cBefore)} → ${n(cAfter)}   (paid ${n(cBefore - cAfter)})`);
console.log(`   merchant RUSD spendable: ${n(mBefore)} → ${n(mAfter)}   (received ${n(mAfter - mBefore)})`);
console.log(`   → the gap (${n((cBefore - cAfter) - (mAfter - mBefore))} RUSD) is the LSP's forwarding fee: proof it routed through the hub`);

// merchant back-office: server-side invoice.paid webhook + settlement ledger
const webhooks = new InvoiceWebhookService({ rpc: rpc3, pollAttempts: 20, pollIntervalMs: 500 });
const watch = webhooks.watchExisting({ invoice, payment_hash: ph, asset: udtAsset(RUSD_SCRIPT, "RUSD"), amount, webhook_url: sink.url, description: "demo order" });
await webhooks.drain();
const event = await sink.received;
console.log(`   [webhook] ${event.type} → receipt ${event.receipt.receipt_id} · paid=${event.receipt.paid}`);
const ledger = new SettlementLedger(); ledger.record(webhooks.get(watch.watch_id).receipt);
console.log("   [ledger] accounting CSV:");
console.log(ledger.export("csv").split("\n").map((l) => "     " + l).join("\n"));
sink.close();

console.log("\n✅ DONE — customer paid the merchant, ROUTED through the LSP hub, and the merchant's backend booked it.");
