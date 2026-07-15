import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { loadConfig } from "../../../scripts/demo/linked/config.mjs";
import {
  assertHostedMockConfig,
  createHostedOperations,
  createHostedProcessManager,
} from "../../../scripts/demo/shared/hosted-runtime.mjs";

class Child extends EventEmitter {
  killed: string[] = [];

  kill(signal: string) {
    this.killed.push(signal);
    queueMicrotask(() => this.emit("close", 0));
    return true;
  }
}

test("hosted demo accepts only the linked mock topology", () => {
  const cfg = loadConfig();
  assert.doesNotThrow(() => assertHostedMockConfig(cfg));
  assert.throws(
    () => assertHostedMockConfig({ ...cfg, topology: { ...cfg.topology, profile: "live" } }),
    /mock topology/i,
  );
  assert.throws(() => assertHostedMockConfig({ ...cfg, ckbRpc: "https://testnet.ckb.dev" }), /CKB RPC/i);
  assert.throws(() => assertHostedMockConfig({ ...cfg, mode: "same_hash" }), /linked/i);
});

test("hosted manager starts loopback services in order and resets the whole world", async () => {
  const cfg = loadConfig();
  const spawned: Array<{ role: string; child: Child }> = [];
  const probes: string[] = [];
  let clears = 0;
  const manager = createHostedProcessManager({
    cfg,
    spawnProcess(role: string) {
      const child = new Child();
      spawned.push({ role, child });
      return child;
    },
    async probe(url: string) {
      probes.push(url);
    },
    clearState() {
      clears += 1;
    },
  });

  await manager.start();
  assert.deepEqual(spawned.map(({ role }) => role), ["lsp", "merchant", "customer"]);
  assert.deepEqual(probes, [
    `${cfg.lspRest}/lsp/v1/info`,
    `http://127.0.0.1:${cfg.control.merchant}/`,
    `http://127.0.0.1:${cfg.control.customer}/`,
  ]);
  assert.deepEqual(manager.health(), { ready: true, profile: "mock", services: 3 });
  assert.equal(clears, 1);

  await manager.reset();
  assert.equal(clears, 2);
  assert.deepEqual(spawned.map(({ role }) => role), [
    "lsp", "merchant", "customer", "lsp", "merchant", "customer",
  ]);
  assert.ok(spawned.slice(0, 3).every(({ child }) => child.killed.includes("SIGINT")));

  await manager.stop();
  assert.deepEqual(manager.health(), { ready: false, profile: "mock", services: 0 });
  assert.ok(spawned.slice(3).every(({ child }) => child.killed.includes("SIGINT")));
});

test("hosted operations cap public rent batches without changing other actions", async () => {
  const calls: unknown[] = [];
  const operations = {
    requestInvoice: async (input: unknown) => input,
    payInvoice: async (input: unknown) => input,
    requestRegularInvoice: async (input: unknown) => input,
    payRegularInvoice: async (input: unknown) => input,
    streamRent: async (input: unknown) => {
      calls.push(input);
      return { periodsPaid: (input as { periods: number }).periods };
    },
  };
  const hosted = createHostedOperations(operations);

  assert.deepEqual(await hosted.requestInvoice({ amount: "1", capacity: "10" }), { amount: "1", capacity: "10" });
  assert.deepEqual(await hosted.streamRent({ channelId: "0xchannel", periods: 10 }), { periodsPaid: 10 });
  await assert.rejects(
    () => hosted.streamRent({ channelId: "0xchannel", periods: 11 }),
    /at most 10 rent periods/i,
  );
  assert.deepEqual(calls, [{ channelId: "0xchannel", periods: 10 }]);
});

test("hosted demo has one reproducible Render web service", () => {
  const rootPackage = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(rootPackage.scripts["demo:hosted"], "node scripts/demo/linked/hosted.mjs");
  assert.equal(rootPackage.scripts["demo:hosted:artifacts"], "node scripts/demo/linked/prepare-hosted-artifacts.mjs");
  assert.equal(existsSync(new URL("../../../scripts/demo/linked/hosted.mjs", import.meta.url)), true);

  const manifest = readFileSync(new URL("../../../render.yaml", import.meta.url), "utf8");
  assert.match(manifest, /type:\s*web/);
  assert.match(manifest, /buildCommand:\s*npm ci && npm run build && npm run demo:hosted:artifacts/);
  assert.match(manifest, /startCommand:\s*npm run demo:hosted/);
  assert.match(manifest, /healthCheckPath:\s*\/health/);
  assert.doesNotMatch(manifest, /FIBER_RPC|CKB_RPC|secret|private/i);
});
