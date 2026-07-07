// DEMO STEP 1 — the merchant's wallet DISCOVERS an LSP that sells RUSD inbound.
//
//   node <this>
//
// Discovery has two sources, and the wallet chooses:
//   • REGISTRY (the current default — fast, immediately orderable): a phonebook of LSP REST endpoints. You
//     resolve an endpoint, fetch its /info, and price the offer with `compareQuotes` — no graph scan needed.
//   • GOSSIP GRAPH (the more authentic, decentralized signal): every node broadcasts which UDTs it will
//     auto-accept, on-chain-verifiable and registry-free. It carries no REST endpoint yet (see the upstream
//     RFC), so today it's the trust/verification layer under the registry — the direction the ecosystem moves.
import { udtAsset } from "../../packages/protocol/dist/index.js";
import { FiberChannelRpcClient } from "../../packages/fiber/dist/index.js";
import { discoverFromGraph, compareQuotes } from "../../packages/client/dist/index.js";
import { writeFileSync } from "node:fs";

const RUSD = udtAsset(
  { code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a", hash_type: "type",
    args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b" }, "RUSD");

const DISCOVERY_RPC = process.env.DISCOVERY_RPC ?? "http://127.0.0.1:8247"; // any node's graph works (the merchant's)
const LSP_REST = process.env.LSP_REST ?? "http://127.0.0.1:8080";
const WANT = process.env.AMOUNT ?? "1000000000"; // 10 RUSD of inbound wanted
const n = (v) => Number(BigInt(v)) / 1e8;

console.log(`\n=== STEP 1 · Discover an LSP selling RUSD inbound ===`);

// (1) REGISTRY — the default path: resolve an orderable endpoint and price the offer (no graph scan needed).
console.log(`   [registry]      the default — resolve an orderable LSP endpoint + price it`);
const quotes = await compareQuotes(
  [{ name: "reference-lsp", base_url: LSP_REST, chain: "testnet" }],
  { asset: RUSD, amount: WANT, feeMode: "prepaid" },
);
const best = quotes.find((q) => q.fee);
if (!best) { console.error(`   ❌ ${quotes[0]?.error ?? "no orderable LSP could serve the request"}`); process.exit(1); }
console.log(`   ✅ orderable LSP ${best.provider.base_url}  (lsp ${best.info.lsp_pubkey.slice(0, 14)}…)`);
console.log(`      quote: fee ${best.fee.total_fee} shannons CKB for ${n(WANT)} RUSD inbound`);

// (2) GOSSIP GRAPH — the more authentic capability view: who can serve RUSD inbound, straight from the graph.
const rpc = new FiberChannelRpcClient({ rpcUrl: DISCOVERY_RPC });
const graph = await discoverFromGraph(rpc, { asset: RUSD, minAmount: WANT });
console.log(`   [gossip graph]  the authentic layer — ${graph.length} node(s) advertise RUSD auto-accept ≤ ${n(WANT)} RUSD (registry-free, on-chain-verifiable):`);
for (const g of graph.slice(0, 3)) console.log(`      • ${g.pubkey.slice(0, 20)}…  floor ${g.autoAcceptFloor ? n(g.autoAcceptFloor) + " RUSD" : "—"}`);
if (graph.length > 3) console.log(`      … and ${graph.length - 3} more`);

writeFileSync(new URL("./.lsp.json", import.meta.url), JSON.stringify({ base_url: best.provider.base_url, amount: WANT }, null, 2));
console.log("   (saved chosen LSP to scripts/demo/.lsp.json for step 2)");
