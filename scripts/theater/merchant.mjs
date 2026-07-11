// TERMINAL 2 — the merchant, with ZERO channels.
//
//   NETWORK=local npm run demo:merchant   (after Terminal 1 is up)
//
// Runs the real JitCheckout against the LSP's REST API. It negotiates the mode the same way any wallet would:
//   • if the LSP offers `linked` AND the proving artifacts are present → build a REAL Groth16 proof (wasm
//     prover) and pin `linked`. This is the ZK path: the merchant proves the two invoice hashes share a
//     secret without revealing it, and the LSP verifies that proof in real code before opening a channel.
//   • else → `same_hash` (no proof, no key). Still a complete JIT sale.
//
// It prints the customer's HOLD invoice and writes it to .state/ for Terminal 3, then waits for the LSP to
// open the channel, forward the merchant leg, and settle — the first sale buying the channel.
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FiberChannelRpcClient } from "../../packages/fiber/dist/index.js";
import { JitCheckout, LspClient } from "../../packages/client/dist/index.js";
import { loadProfile, saveState } from "../live/lib/profile.mjs";

const P = loadProfile();
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const lsp = new LspClient({ baseUrl: P.nodes.lsp.rest });
const merchantRpc = new FiberChannelRpcClient({ rpcUrl: P.nodes.merchant.rpc });
const me = await merchantRpc.nodeInfo();
const merchantPubkey = me.pubkey ?? me.node_id ?? me.public_key ?? "";

console.log(`\n=== MERCHANT · a wallet with zero channels wants to get paid  [${P.name}] ===`);

const info = await lsp.getInfo();
const offered = info.jit?.modes ?? [];
if (offered.length === 0) { console.error("   ❌ the LSP advertises no JIT modes — is Terminal 1 (demo:lsp) up?"); process.exit(1); }
console.log(`   LSP at ${P.nodes.lsp.rest} offers JIT: ${offered.join(", ")}`);

// Decide the mode exactly as a real wallet would, given what the LSP offers and what we can build.
const zkeyPath = P.linked?.zkeyPath ? resolve(root, P.linked.zkeyPath) : undefined;
const wasmPath = P.linked?.wasmPath ? resolve(root, P.linked.wasmPath) : undefined;
const canProve = zkeyPath && wasmPath && existsSync(zkeyPath) && existsSync(wasmPath);

let mode, proveLinkage;
if (offered.includes("linked") && canProve) {
  mode = "linked";
  const { makeLinkedProver } = await import("../../packages/prover-linked/dist/index.js");
  const prover = makeLinkedProver({ zkeyPath, wasmPath }); // bundled wasm prover — no binary
  proveLinkage = async (holdHash, legHash, secretHex) => {
    console.log(`   [zk] proving linkage of hold=${holdHash.slice(0, 12)}… and leg=${legHash.slice(0, 12)}… (secret stays private)…`);
    const t = Date.now();
    const proof = await prover(holdHash, legHash, secretHex);
    console.log(`   [zk] Groth16 proof built in ${((Date.now() - t) / 1000).toFixed(1)}s — sending it to the LSP to verify`);
    return proof;
  };
} else if (offered.includes("same_hash")) {
  mode = "same_hash";
  console.log(`   [mode] using same_hash (no proof needed).${offered.includes("linked") ? " (linked available too, but proving artifacts are absent — build the circuit for the ZK path)" : ""}`);
} else {
  console.error(`   ❌ LSP offers only 'linked' but the proving artifacts are missing.`);
  console.error(`      build the circuit (packages/protocol/circuits/dual-sha256-linkage/README.md) or fetch a release, then retry.`);
  process.exit(1);
}

const checkout = new JitCheckout({ rpc: merchantRpc, lsp, merchantPubkey, mode, proveLinkage });

const session = await checkout.checkout({
  asset: P.udt,
  amount: P.amounts.jitPayment,
  channelCapacity: P.amounts.jitCapacity,
  description: "in-store sale #1",
});

console.log(`\n   ── mode: ${session.mode} ${session.mode === "linked" ? "(zero-knowledge linkage proof accepted ✓)" : "(two-node, no proof)"} ──`);
console.log(`   customer pays ${P.fmt(P.amounts.jitPayment)}; merchant nets ${P.fmt(session.netAmount)} (JIT fee ${P.fmt(session.fee)})`);
console.log(`   requested channel capacity: ${P.fmt(P.amounts.jitCapacity)}  (independent of the payment — headroom for later sales)`);
console.log(`\n   ┌─ HOLD INVOICE — show this to the customer (Terminal 3 pays it) ─`);
console.log(`   │  ${session.invoice}`);
console.log(`   └─────────────────────────────────────────────────────────────────`);

saveState("jit-hold", { invoice: session.invoice, paymentHash: session.paymentHash, mode: session.mode });
console.log(`   (written to scripts/live/.state/jit-hold.json — Terminal 3 reads it)\n`);
console.log(`   waiting for the customer to pay, then the LSP to open the channel + forward…`);

const settled = await session.settle({ attempts: 600, intervalMs: 1000 });
if (settled.state !== "settled") { console.error(`   ❌ order ${settled.state}`); process.exit(1); }

console.log(`\n   ✅ order ${settled.jit_order_id} → SETTLED`);
console.log(`   channel opened: ${settled.channel_outpoint}`);
console.log(`   the first sale bought the channel; the customer's payment was refundable until we were paid.`);
