// LIVE STEP 0 (setup convenience) — top up the CUSTOMER's RUSD outbound so the demo has headroom.
//
// The customer mints an invoice and the LSP — which holds RUSD outbound toward it — pays it, shifting balance
// so the customer has spendable RUSD to route in step 04. Demo-only; not part of the SDK.
//
// Config comes from the selected network profile (NETWORK=<name>, default testnet). See lib/profile.mjs.
import { FiberChannelRpcClient } from "../../packages/fiber/dist/index.js";
import { loadProfile } from "./lib/profile.mjs";

const P = loadProfile();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AMOUNT = P.amounts.topup;

const rpc1 = new FiberChannelRpcClient({ rpcUrl: P.nodes.lsp.rpc });
const rpc2 = new FiberChannelRpcClient({ rpcUrl: P.nodes.customer.rpc });
const customerOutbound = async () =>
  (await rpc2.listChannels())
    .filter((c) => P.isRusd(c.funding_udt_type_script) && c.state.state_name === "ChannelReady")
    .reduce((s, c) => s + BigInt(c.local_balance), 0n);

console.log(`\n=== STEP 0 · Top up the customer with ${P.fmt(AMOUNT)} of outbound  [${P.name}] ===`);
console.log(`   customer spendable before: ${P.fmt(await customerOutbound())}`);

const inv = await rpc2.newInvoice({ amount: AMOUNT, currency: "Fibt", description: "demo top-up", udtTypeScript: P.assetScript });
const invoice = inv.invoice_address;
const ph = inv.invoice?.data?.payment_hash;
const sent = await rpc1.call("send_payment", [{ invoice }]);
let pay = sent;
for (let i = 0; i < 40; i++) { await sleep(2000); pay = await rpc1.call("get_payment", [{ payment_hash: sent.payment_hash ?? ph }]); if (pay.status === "Success" || pay.status === "Failed") break; }
if (pay.status !== "Success") { console.error(`   ❌ top-up ${pay.status} ${pay.failed_error ?? ""}`); process.exit(1); }

console.log(`   customer spendable after:  ${P.fmt(await customerOutbound())}  ✓`);
