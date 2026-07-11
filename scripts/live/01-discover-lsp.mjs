// LIVE STEP 1 — the merchant's wallet DISCOVERS an LSP that sells RUSD inbound.
//
// Discovery has two sources, and the wallet chooses:
//   • REGISTRY (the current default — fast, immediately orderable): a phonebook of LSP REST endpoints. You
//     resolve an endpoint, fetch its /info, and price the offer with `compareQuotes` — no graph scan needed.
//   • GOSSIP GRAPH (the more authentic, decentralized signal): every node broadcasts which UDTs it will
//     auto-accept, on-chain-verifiable and registry-free. It carries no REST endpoint yet (see the upstream
//     RFC), so today it's the trust/verification layer under the registry — the direction the ecosystem moves.
//
// Config comes from the selected network profile (NETWORK=<name>, default testnet). See lib/profile.mjs.
import { FiberChannelRpcClient } from "../../packages/fiber/dist/index.js";
import { discoverFromGraph, compareQuotes } from "../../packages/client/dist/index.js";
import { loadProfile, saveState } from "./lib/profile.mjs";

const P = loadProfile();
const WANT = P.amounts.inbound;

console.log(`\n=== STEP 1 · Discover an LSP selling ${P.asset.symbol} inbound  [${P.name}] ===`);

// (1) REGISTRY — the default path: resolve an orderable endpoint and price the offer (no graph scan needed).
console.log(`   [registry]      the default — resolve an orderable LSP endpoint + price it`);
const quotes = await compareQuotes(
  [{ name: "reference-lsp", base_url: P.nodes.lsp.rest, chain: P.chain }],
  { asset: P.udt, amount: WANT, feeMode: "prepaid" },
);
const best = quotes.find((q) => q.fee);
if (!best) { console.error(`   ❌ ${quotes[0]?.error ?? "no orderable LSP could serve the request"}`); process.exit(1); }
console.log(`   ✅ orderable LSP ${best.provider.base_url}  (lsp ${best.info.lsp_pubkey.slice(0, 14)}…)`);
console.log(`      quote: fee ${best.fee.total_fee} shannons CKB for ${P.fmt(WANT)} inbound`);

// (2) GOSSIP GRAPH — the more authentic capability view: who can serve inbound, straight from the graph.
const rpc = new FiberChannelRpcClient({ rpcUrl: P.nodes.merchant.rpc }); // any node's graph works (the merchant's)
const graph = await discoverFromGraph(rpc, { asset: P.udt, minAmount: WANT });
console.log(`   [gossip graph]  the authentic layer — ${graph.length} node(s) advertise ${P.asset.symbol} auto-accept ≤ ${P.fmt(WANT)} (registry-free, on-chain-verifiable):`);
for (const g of graph.slice(0, 3)) console.log(`      • ${g.pubkey.slice(0, 20)}…  floor ${g.autoAcceptFloor ? P.fmt(g.autoAcceptFloor) : "—"}`);
if (graph.length > 3) console.log(`      … and ${graph.length - 3} more`);

saveState("lsp", { base_url: best.provider.base_url, amount: WANT });
console.log("   (saved chosen LSP to scripts/live/.state/lsp.json for step 2)");
