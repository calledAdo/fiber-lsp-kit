// TERMINAL 3 — the customer.
//
//   NETWORK=local npm run demo:customer   (after Terminal 2 has printed the hold invoice)
//
// Reads the hold invoice the merchant published and pays it. The payment is captured and HELD: the customer's
// funds are committed but not yet the merchant's, and stay refundable until the LSP has actually paid the
// merchant. This script shows the payment go Inflight → Success as the LSP settles the hold.
import { FiberChannelRpcClient } from "../../packages/fiber/dist/index.js";
import { loadProfile, loadState } from "../live/lib/profile.mjs";

const P = loadProfile();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { invoice, paymentHash, mode } = loadState("jit-hold");
const rpc = new FiberChannelRpcClient({ rpcUrl: P.nodes.customer.rpc });

console.log(`\n=== CUSTOMER · pay the merchant's hold invoice  [${P.name}] ===`);
console.log(`   mode: ${mode}`);
console.log(`   paying: ${invoice.slice(0, 48)}…`);

const sent = await rpc.call("send_payment", [{ invoice }]);
const ph = sent.payment_hash ?? paymentHash;
console.log(`   payment ${ph.slice(0, 16)}… → ${sent.status ?? "sent"}  (captured + HELD while the LSP opens the channel)`);

// Watch it settle: the hold releases only once the LSP has forwarded to the merchant.
for (let i = 0; i < 120; i++) {
  const pay = await rpc.call("get_payment", [{ payment_hash: ph }]);
  if (pay.status === "Success") {
    console.log(`   ✅ payment SUCCESS — the LSP settled the hold (it paid the merchant first).`);
    console.log(`      the customer got a channel-backed payment; the merchant got a channel. One sale did both.`);
    process.exit(0);
  }
  if (pay.status === "Failed") { console.error(`   ❌ payment failed / refunded`); process.exit(1); }
  await sleep(1000);
}
console.error(`   ⏱  timed out waiting for settlement — check Terminal 1 (LSP) logs.`);
process.exit(1);
