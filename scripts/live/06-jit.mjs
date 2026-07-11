// LIVE STEP 6 — JIT CHECKOUT: a merchant with ZERO channels gets paid, and the first sale buys the channel.
//
// The customer pays the LSP's hold invoice; the LSP opens a fresh channel to the merchant and pays the merchant
// leg; settling the leg reveals the secret that settles the hold. Deliver-or-refund is structural.
//
// The LSP advertises which mode it serves (GET /lsp/v1/info → jit.modes); this script reads that and adapts:
//   • same_hash — the LSP runs a second (paying) node. Nothing to prove; no key, no wasm.
//   • linked    — the LSP runs one node, so the merchant supplies a Groth16 linkage proof. Needs the .ark/.wasm
//                 artifacts (env LINKED_ARK_PATH / LINKED_WASM_PATH, default ./linkage-artifacts/*).
//
// Config comes from the selected network profile (NETWORK=<name>, default testnet). See lib/profile.mjs.
import { FiberChannelRpcClient } from "../../packages/fiber/dist/index.js";
import { JitCheckout, LspClient } from "../../packages/client/dist/index.js";
import { loadProfile } from "./lib/profile.mjs";

const P = loadProfile();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GROSS = P.amounts.invoice; // the customer pays this; the merchant nets it minus the JIT fee
const CAPACITY = P.amounts.capacity; // channel size to request, independent of the payment

const lsp = new LspClient({ baseUrl: P.nodes.lsp.rest });
const merchantRpc = new FiberChannelRpcClient({ rpcUrl: P.nodes.merchant.rpc });
const customerRpc = new FiberChannelRpcClient({ rpcUrl: P.nodes.customer.rpc });

console.log(`\n=== STEP 6 · JIT checkout — merchant with zero channels gets paid  [${P.name}] ===`);

const info = await lsp.getInfo();
const modes = info.jit?.modes ?? [];
if (modes.length === 0) {
  console.log("   ⏭  this LSP advertises no JIT modes (GET /lsp/v1/info has no jit.modes).");
  console.log("      start the server with JIT_PAY_FIBER_RPC_URL (same_hash) or LINKED_JIT_VK_PATH (linked).");
  process.exit(0);
}
console.log(`   LSP offers JIT modes: ${modes.join(", ")}`);

// Build the linkage prover only if we will actually use `linked` (same_hash needs none).
let proveLinkage;
if (!modes.includes("same_hash") && modes.includes("linked")) {
  const arkPath = process.env.LINKED_ARK_PATH ?? "./linkage-artifacts/linkage.ark";
  const wasmPath = process.env.LINKED_WASM_PATH ?? "./linkage-artifacts/linkage.wasm";
  const { existsSync } = await import("node:fs");
  if (!existsSync(arkPath) || !existsSync(wasmPath)) {
    console.log(`   ⏭  LSP offers only 'linked', which needs the proving artifacts.`);
    console.log(`      fetch them: node scripts/fetch-artifacts.mjs --release <url> --role merchant`);
    console.log(`      then set LINKED_ARK_PATH / LINKED_WASM_PATH (looked for ${arkPath}, ${wasmPath}).`);
    process.exit(0);
  }
  const { makeLinkedProver } = await import("../../packages/prover-linked/dist/index.js");
  proveLinkage = makeLinkedProver({ zkeyPath: arkPath, wasmPath });
}

const checkout = new JitCheckout({
  rpc: merchantRpc,
  lsp,
  merchantPubkey: P.nodes.merchant.pubkey,
  merchantAddress: P.nodes.merchant.address,
  proveLinkage, // undefined for same_hash
});

const session = await checkout.checkout({
  asset: P.udt,
  amount: GROSS,
  channelCapacity: CAPACITY,
  description: "jit checkout demo",
});

console.log(`   mode negotiated: ${session.mode}`);
console.log(`   customer pays ${P.fmt(GROSS)}; merchant nets ${P.fmt(session.netAmount)} (JIT fee ${P.fmt(session.fee)})`);
console.log(`   hold invoice (show to customer): ${session.invoice.slice(0, 42)}…`);

// The customer pays the hold invoice; it stays held until the LSP forwards + settles. Fire it and don't block
// on completion — session.settle() drives the LSP to open the channel, forward the leg, and settle the hold.
console.log(`   [customer] paying the hold invoice…`);
const sent = await customerRpc.call("send_payment", [{ invoice: session.invoice }]);
const holdPh = sent.payment_hash ?? session.paymentHash;

console.log(`   [lsp] opening channel → paying merchant leg → settling hold (may take minutes on-chain)…`);
const settled = await session.settle({ attempts: 300, intervalMs: 5000 });
console.log(`   order ${settled.jit_order_id} → ${settled.state}`);
if (settled.state !== "settled") { console.error(`   ❌ ${settled.state}`); process.exit(1); }

// Confirm the customer's held payment has now completed (the settle released it).
let pay;
for (let i = 0; i < 30; i++) { pay = await customerRpc.call("get_payment", [{ payment_hash: holdPh }]); if (pay.status === "Success" || pay.status === "Failed") break; await sleep(2000); }
console.log(`   [customer] hold payment: ${pay?.status ?? "?"}`);

console.log(`\n✅ DONE — merchant started with no channel, got paid via a ${session.mode} JIT open, and the sale funded the channel.`);
