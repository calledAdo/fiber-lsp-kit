// TERMINAL 1 — the LSP operator.
//
//   NETWORK=local npm run demo:lsp     # local: starts the mock-fnn daemon, then the reference LSP server
//   NETWORK=testnet npm run demo:lsp   # live: assumes real fnn nodes are up; just starts the server
//
// This is the LSP's whole terminal. It translates the active profile into the reference server's env and runs
// the REAL server (packages/lsp-server) — the same binary an operator runs in production. On a `fnn: "mock"`
// profile it first brings up the mock-fnn daemon so the node RPCs answer; on `fnn: "live"` it does not, and
// the identical server talks to the real nodes named in the profile.
//
// The server advertises `linked` when the profile's verification key exists, and `same_hash` when a paying
// node is configured — so on this machine (artifacts present) it offers both, and the merchant chooses.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { loadProfile } from "../live/lib/profile.mjs";

const P = loadProfile();
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const shutdown = () => { for (const c of children) c.kill("SIGINT"); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function nodeUp(rpc) {
  try {
    const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node_info", params: [] }) });
    return res.ok;
  } catch { return false; }
}

// LOCAL: bring up the mock-fnn daemon and wait until every node answers.
if (P.fnn === "mock") {
  console.log(`[demo:lsp] local profile — starting mock-fnn daemon…`);
  const daemon = spawn(process.execPath, [join(root, "scripts/theater/mock-fnn.mjs")], { stdio: "inherit", env: process.env });
  children.push(daemon);
  const rpcs = Object.values(P.nodes).map((n) => n.rpc).filter(Boolean);
  for (let i = 0; i < 100; i++) {
    if ((await Promise.all(rpcs.map(nodeUp))).every(Boolean)) break;
    if (i === 99) { console.error("[demo:lsp] mock-fnn did not come up"); shutdown(); }
    await sleep(100);
  }
  console.log(`[demo:lsp] mock-fnn ready.`);
}

// Translate the profile into the reference server's env. Everything the server needs is env-driven.
const vkPath = P.linked?.vkPath ? resolve(root, P.linked.vkPath) : undefined;
const linkedOffered = vkPath && existsSync(vkPath);
const env = {
  ...process.env,
  PORT: String(new URL(P.nodes.lsp.rest).port),
  FIBER_RPC_URL: P.nodes.lsp.rpc,
  LSP_TRUST_SETTLE: "1",
  JIT_LOG: "1", // narrate each JIT order's lifecycle — the operator's view
  READY_POLL_ATTEMPTS: process.env.READY_POLL_ATTEMPTS ?? "50",
  READY_POLL_INTERVAL_MS: process.env.READY_POLL_INTERVAL_MS ?? (P.fnn === "mock" ? "50" : "5000"),
  ...(P.nodes.lspPay?.rpc ? { JIT_PAY_FIBER_RPC_URL: P.nodes.lspPay.rpc } : {}), // enables same_hash
  ...(linkedOffered ? { LINKED_JIT_VK_PATH: vkPath } : {}), // enables linked
};

console.log(`[demo:lsp] JIT modes this LSP will advertise: ${[linkedOffered && "linked", P.nodes.lspPay && "same_hash"].filter(Boolean).join(", ") || "none"}`);
if (!linkedOffered) console.log(`[demo:lsp] (no verification key at ${P.linked?.vkPath ?? "<unset>"} — 'linked' off; build the circuit per packages/protocol/circuits/dual-sha256-linkage/README.md to enable the ZK path)`);

const server = spawn(process.execPath, [join(root, "packages/lsp-server/dist/server.js")], { stdio: "inherit", env });
children.push(server);
server.on("close", (code) => { console.log(`[demo:lsp] server exited (${code})`); shutdown(); });
