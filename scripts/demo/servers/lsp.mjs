// TERMINAL 1 — the LSP. Long-running; narrates every JIT order (JIT_LOG).
//
//   node scripts/demo/servers/lsp.mjs [--download]
//
// Starts the mock-fnn daemon for any role whose endpoint is mock, resolves the LSP's verification key (offers
// `linked` when it is present, downloading it with --download or a prompt), and runs the REAL reference server
// translated from demo.config.json. Two LSP endpoints ⇒ `same_hash` is offered too; one ⇒ `linked` only.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { loadConfig, demoRoot, repoRoot } from "../lib/config.mjs";
import { ensureArtifacts } from "../lib/artifacts.mjs";

const cfg = loadConfig();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const shutdown = () => { for (const c of children) c.kill("SIGINT"); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const pingNode = async (url) => {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node_info", params: [] }) });
    return res.ok;
  } catch { return false; }
};

if (cfg.needsMock) {
  console.log("[demo:lsp] starting mock-fnn daemon…");
  children.push(spawn(process.execPath, [join(demoRoot, "mock-fnn.mjs")], { stdio: "inherit" }));
  const mockRpcs = Object.values(cfg.roles).filter((r) => r.mock).map((r) => r.fnn[0]);
  for (let i = 0; i < 100; i++) { if ((await Promise.all(mockRpcs.map(pingNode))).every(Boolean)) break; if (i === 99) { console.error("[demo:lsp] mock-fnn did not come up"); shutdown(); } await sleep(100); }
  console.log("[demo:lsp] mock-fnn ready.");
}

const lspEndpoints = cfg.roles.lsp.fnn;
const twoNodes = lspEndpoints.length >= 2;
const download = process.argv.includes("--download");
// `linked` needs the vk; if it is absent we can still run when a second node offers same_hash.
const artifacts = await ensureArtifacts("lsp", cfg, { download, allowSkip: twoNodes });
const vkPath = artifacts?.vk;

const modes = [vkPath && "linked", twoNodes && "same_hash"].filter(Boolean);
if (modes.length === 0) { console.error("[demo:lsp] no JIT mode available: need the vk (linked) or two endpoints (same_hash)."); shutdown(); }
console.log(`[demo:lsp] JIT modes this LSP will advertise: ${modes.join(", ")}`);

const env = {
  ...process.env,
  PORT: String(new URL(cfg.lspRest).port),
  FIBER_RPC_URL: lspEndpoints[0],
  LSP_TRUST_SETTLE: "1",
  JIT_LOG: "1",
  READY_POLL_ATTEMPTS: cfg.needsMock ? "50" : "150",
  READY_POLL_INTERVAL_MS: cfg.needsMock ? "50" : "5000",
  ...(twoNodes ? { JIT_PAY_FIBER_RPC_URL: lspEndpoints[1] } : {}),
  ...(vkPath ? { LINKED_JIT_VK_PATH: vkPath } : {}),
  // JIT pricing/limits — kept small for the demo so any amount is orderable (the amount is the payer's choice).
  ...(cfg.jit?.minPayment !== undefined ? { JIT_MIN_PAYMENT: String(cfg.jit.minPayment) } : {}),
  ...(cfg.jit?.feeBase !== undefined ? { JIT_FEE_BASE: String(cfg.jit.feeBase) } : {}),
  ...(cfg.jit?.feeBps !== undefined ? { JIT_FEE_BPS: String(cfg.jit.feeBps) } : {}),
  ...(cfg.jit?.minCapacity !== undefined ? { JIT_MIN_CAPACITY: String(cfg.jit.minCapacity) } : {}),
};

const server = spawn(process.execPath, [join(repoRoot, "packages/lsp-server/dist/server.js")], { stdio: "inherit", env });
children.push(server);
server.on("close", (code) => { console.log(`[demo:lsp] server exited (${code})`); shutdown(); });
