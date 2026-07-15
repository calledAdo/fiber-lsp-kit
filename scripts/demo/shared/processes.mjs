import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { demoConsole } from "./console.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpcReady(url) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node_info", params: [] }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function createDemoRuntime(cfg) {
  const children = [];
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill("SIGINT");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  return {
    async startMock(mockEntrypoint) {
      if (cfg.topology.profile !== "mock") return;
      const child = spawn(process.execPath, [fileURLToPath(mockEntrypoint)], { stdio: "inherit" });
      children.push(child);
      const urls = Object.values(cfg.topology.nodes).map((node) => node.rpc);
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await Promise.all(urls.map(rpcReady))).every(Boolean)) return;
        if (attempt === 99) throw new Error("mock Fiber nodes did not become ready");
        await sleep(100);
      }
    },

    startReferenceComposition(extraEnv) {
      mkdirSync(cfg.stateDir, { recursive: true });
      const child = spawn(process.execPath, [join(cfg.repoRoot, "examples", "reference-lsp", "server.mjs")], {
        stdio: "inherit",
        env: {
          ...process.env,
          PORT: String(new URL(cfg.lspRest).port),
          JIT_LOG: "1",
          JIT_STORE_PATH: join(cfg.stateDir, "jit-orders.json"),
          READY_POLL_ATTEMPTS: cfg.topology.profile === "mock" ? "50" : "150",
          READY_POLL_INTERVAL_MS: cfg.topology.profile === "mock" ? "50" : "5000",
          ...(cfg.jit?.minPayment !== undefined ? { JIT_MIN_PAYMENT: String(cfg.jit.minPayment) } : {}),
          ...(cfg.jit?.feeBase !== undefined ? { JIT_FEE_BASE: String(cfg.jit.feeBase) } : {}),
          ...(cfg.jit?.feeBps !== undefined ? { JIT_FEE_BPS: String(cfg.jit.feeBps) } : {}),
          ...(cfg.jit?.minCapacity !== undefined ? { JIT_MIN_CAPACITY: String(cfg.jit.minCapacity) } : {}),
          ...extraEnv,
        },
      });
      children.push(child);
      child.on("close", (code) => {
        if (!stopping) demoConsole.warn("LSP composition exited", `code ${code}`);
        stop();
      });
      return child;
    },

    stop,
  };
}
