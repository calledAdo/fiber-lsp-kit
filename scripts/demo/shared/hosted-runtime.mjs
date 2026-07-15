import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function configuredNodeValues(nodes) {
  return Object.values(nodes ?? {}).flatMap((node) => Object.values(node ?? {}));
}

export function assertHostedMockConfig(cfg) {
  if (cfg.mode !== "linked") throw new Error("the hosted demo supports linked mode only");
  if (cfg.topology?.profile !== "mock") throw new Error("the hosted demo requires the mock topology");
  if (configuredNodeValues(cfg.nodes).some((value) => typeof value === "string" && value.trim())) {
    throw new Error("the hosted demo requires blank configured node endpoints");
  }
  if (typeof cfg.ckbRpc === "string" && cfg.ckbRpc.trim()) {
    throw new Error("the hosted demo must not configure a CKB RPC endpoint");
  }
}

export async function waitForHttp(url, {
  fetchImpl = fetch,
  attempts = 300,
  intervalMs = 100,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await fetchImpl(url, { cache: "no-store" });
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(intervalMs);
    }
  }
  throw new Error(`service did not become reachable at ${url}: ${lastError?.message ?? lastError ?? "timeout"}`);
}

export function createHostedOperations(operations, { maxRentPeriods = 10 } = {}) {
  return {
    ...operations,
    async streamRent(input = {}) {
      if (!Number.isSafeInteger(input.periods) || input.periods <= 0 || input.periods > maxRentPeriods) {
        throw new Error(`hosted demo accepts at most ${maxRentPeriods} rent periods per request`);
      }
      return operations.streamRent(input);
    },
  };
}

function defaultSpawn(_role, entrypoint) {
  return spawn(process.execPath, [entrypoint], {
    stdio: "inherit",
    env: { ...process.env, HOSTED_DEMO_INTERNAL: "1" },
  });
}

function defaultClearState(cfg) {
  rmSync(cfg.stateDir, { recursive: true, force: true });
  mkdirSync(cfg.stateDir, { recursive: true });
}

async function stopChild(child, timeoutMs = 5_000) {
  if (child.exitCode !== undefined && child.exitCode !== null) return;
  await new Promise((resolve) => {
    let done = false;
    let timer;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    child.once("close", finish);
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, timeoutMs);
    child.kill("SIGINT");
  });
}

export function createHostedProcessManager({
  cfg,
  spawnProcess = defaultSpawn,
  probe = waitForHttp,
  clearState = () => defaultClearState(cfg),
} = {}) {
  assertHostedMockConfig(cfg);
  let children = [];
  let ready = false;
  let transition = Promise.resolve();

  const services = [
    { role: "lsp", entrypoint: join(cfg.scenarioRoot, "lsp.mjs"), url: `${cfg.lspRest}/lsp/v1/info` },
    { role: "merchant", entrypoint: join(cfg.scenarioRoot, "merchant.mjs"), url: `http://127.0.0.1:${cfg.control.merchant}/` },
    { role: "customer", entrypoint: join(cfg.scenarioRoot, "customer.mjs"), url: `http://127.0.0.1:${cfg.control.customer}/` },
  ];

  async function stopNow() {
    ready = false;
    const stopping = children.reverse();
    children = [];
    await Promise.all(stopping.map((child) => stopChild(child)));
  }

  async function startNow() {
    assertHostedMockConfig(cfg);
    clearState();
    try {
      for (const service of services) {
        const child = spawnProcess(service.role, service.entrypoint);
        children.push(child);
        child.on("close", () => {
          if (children.includes(child)) ready = false;
        });
        await probe(service.url);
        if (child.exitCode !== undefined && child.exitCode !== null) {
          throw new Error(`${service.role} service exited during startup`);
        }
      }
      ready = true;
    } catch (error) {
      await stopNow();
      throw error;
    }
  }

  function serialize(operation) {
    const next = transition.then(operation, operation);
    transition = next.catch(() => {});
    return next;
  }

  return {
    start: () => serialize(startNow),
    reset: () => serialize(async () => {
      await stopNow();
      await startNow();
      return { reset: true };
    }),
    stop: () => serialize(stopNow),
    health: () => ({ ready, profile: "mock", services: children.length }),
  };
}
