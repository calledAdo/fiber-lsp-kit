// Run the whole live flow end to end against real fnn nodes, in order, stopping at the first failure.
//
//   npm run demo:live                 # testnet profile
//   NETWORK=mainnet npm run demo:live # your mainnet profile (real funds — see scripts/live/README.md)
//
// A preflight checks the things that guarantee failure if wrong — every node reachable, the LSP REST server
// up — BEFORE any on-chain action. Softer conditions (peering, funding) are surfaced as warnings, since the
// steps themselves report them precisely. Each NN-*.mjs step runs as its own process inheriting NETWORK.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FiberChannelRpcClient } from "../../packages/fiber/dist/index.js";
import { loadProfile } from "./lib/profile.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const P = loadProfile();

const run = (script) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, script)], { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
  });

async function preflight() {
  console.log(`\n=== Preflight  [${P.name}] ===`);
  let fatal = false;

  // Every node's RPC must answer, or a step will fail cryptically mid-run.
  for (const [role, node] of Object.entries(P.nodes)) {
    try {
      const info = await new FiberChannelRpcClient({ rpcUrl: node.rpc }).call("node_info", []);
      const pk = info?.node_id ?? info?.public_key ?? info?.pubkey ?? "";
      console.log(`   ✓ ${role.padEnd(9)} ${node.rpc}  ${pk ? `(${pk.slice(0, 14)}…)` : ""}`);
      if (node.pubkey && pk && !pk.includes(node.pubkey.slice(2, 16))) {
        console.log(`     ⚠️  profile pubkey does not match this node — check networks/${P.name}.json`);
      }
    } catch (e) {
      console.error(`   ✗ ${role.padEnd(9)} ${node.rpc}  UNREACHABLE — ${e.message}`);
      fatal = true;
    }
  }

  // The LSP REST server (what the wallet orders from) must be up for steps 1–2.
  try {
    const res = await fetch(`${P.nodes.lsp.rest}/lsp/v1/info`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    console.log(`   ✓ lsp REST   ${P.nodes.lsp.rest}  (jit modes: ${info.jit?.modes?.join(", ") ?? "none"})`);
  } catch (e) {
    console.error(`   ✗ lsp REST   ${P.nodes.lsp.rest}  UNREACHABLE — ${e.message}`);
    console.error(`     start it: see scripts/live/README.md ("start the LSP reference server").`);
    fatal = true;
  }

  if (fatal) {
    console.error(`\n❌ preflight failed — fix the above and re-run. Nothing was sent on-chain.`);
    process.exit(1);
  }
  console.log(`   preflight ok.`);
}

await preflight();

const steps = readdirSync(here)
  .filter((f) => /^\d\d-.*\.mjs$/.test(f))
  .sort();

for (const step of steps) {
  await run(step);
}

console.log(`\n\x1b[32mALL STEPS PASSED ✅\x1b[0m — the full lifecycle ran live on ${P.name}.`);
