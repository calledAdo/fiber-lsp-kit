// DEMO STEP 0 (setup convenience) — top up the CUSTOMER's RUSD outbound so the demo has headroom.
//
// The customer (node#2) mints an invoice and the LSP (node#1) — which holds RUSD outbound toward it — pays
// it, shifting balance so the customer has spendable RUSD to route in step 04. Demo-only; not part of the SDK.
import { udtAsset } from "../../packages/protocol/dist/index.js";
import { FiberChannelRpcClient } from "../../packages/fiber/dist/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUSD_SCRIPT = {
  code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hash_type: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const LSP_RPC = process.env.LSP_RPC ?? "http://127.0.0.1:8227";
const CUSTOMER_RPC = process.env.CUSTOMER_RPC ?? "http://127.0.0.1:8237";
const AMOUNT = process.env.AMOUNT ?? "500000000"; // 5 RUSD
const n = (v) => Number(BigInt(v)) / 1e8;

const rpc1 = new FiberChannelRpcClient({ rpcUrl: LSP_RPC });
const rpc2 = new FiberChannelRpcClient({ rpcUrl: CUSTOMER_RPC });
const customerOutbound = async () =>
  (await rpc2.listChannels())
    .filter((c) => c.funding_udt_type_script?.code_hash === RUSD_SCRIPT.code_hash && c.state.state_name === "ChannelReady")
    .reduce((s, c) => s + BigInt(c.local_balance), 0n);

console.log(`\n=== STEP 0 · Top up the customer with ${n(AMOUNT)} RUSD of outbound ===`);
console.log(`   customer RUSD spendable before: ${n(await customerOutbound())}`);

const inv = await rpc2.newInvoice({ amount: AMOUNT, currency: "Fibt", description: "demo top-up", udtTypeScript: RUSD_SCRIPT });
const invoice = inv.invoice_address;
const ph = inv.invoice?.data?.payment_hash;
const sent = await rpc1.call("send_payment", [{ invoice }]);
let pay = sent;
for (let i = 0; i < 40; i++) { await sleep(2000); pay = await rpc1.call("get_payment", [{ payment_hash: sent.payment_hash ?? ph }]); if (pay.status === "Success" || pay.status === "Failed") break; }
if (pay.status !== "Success") { console.error(`   ❌ top-up ${pay.status} ${pay.failed_error ?? ""}`); process.exit(1); }

console.log(`   customer RUSD spendable after:  ${n(await customerOutbound())}  ✓`);
