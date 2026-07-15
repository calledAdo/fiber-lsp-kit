import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { loadConfig as loadSameHash } from "../../../scripts/demo/same-hash/config.mjs";
import { loadConfig as loadLinked } from "../../../scripts/demo/linked/config.mjs";

test("same-hash is an explicit four-node scenario with no proof artifacts", () => {
  const cfg = loadSameHash();
  assert.equal(cfg.mode, "same_hash");
  assert.equal(cfg.holdRole, "hold");
  assert.equal(cfg.asset.kind, "UDT");
  assert.equal(cfg.assetScript.code_hash, cfg.asset.udt?.code_hash);
  assert.equal(cfg.topology.profile, "mock");
  assert.deepEqual(Object.keys(cfg.topology.nodes).sort(), ["customer", "hold", "merchant", "payment"]);
  assert.deepEqual(cfg.artifactsAbs, {});
  assert.equal(cfg.amounts, undefined);
  assert.deepEqual(Object.keys(cfg.e2eFixtures).sort(), ["channelCapacity", "customerHoldCapacity", "paymentAmount"]);
});

test("linked is an explicit three-node scenario with release artifact metadata", () => {
  const cfg = loadLinked();
  assert.equal(cfg.mode, "linked");
  assert.equal(cfg.holdRole, "lsp");
  assert.match(cfg.topology.profile, /^(mock|live)$/);
  assert.deepEqual(Object.keys(cfg.topology.nodes).sort(), ["customer", "lsp", "merchant"]);
  assert.ok(cfg.release);
  assert.deepEqual(Object.keys(cfg.artifactsAbs).sort(), ["vk", "wasm", "zkey"]);
  assert.equal(cfg.amounts, undefined);
  assert.deepEqual(Object.keys(cfg.e2eFixtures).sort(), ["channelCapacity", "customerHoldCapacity", "paymentAmount"]);
});

test("both multi-terminal demos expose explicit status, invoice, pay, rent, and dashboard actions", () => {
  const rootPackage = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };

  for (const scenario of ["same-hash", "linked"]) {
    for (const action of ["status", "invoice", "pay", "rent", "dashboard"]) {
      assert.ok(rootPackage.scripts[`demo:${scenario}:${action}`], `${scenario}:${action} package script`);
    }
    assert.equal(
      existsSync(new URL(`../../../scripts/demo/${scenario}/actions/status.mjs`, import.meta.url)),
      true,
      `${scenario} status action`,
    );
    assert.equal(
      existsSync(new URL(`../../../scripts/demo/${scenario}/dashboard.mjs`, import.meta.url)),
      true,
      `${scenario} dashboard entrypoint`,
    );
  }
});

test("multi-terminal actions use explicit inputs and rent is not coupled to hidden server state", () => {
  const actions = readFileSync(new URL("../../../scripts/demo/shared/actions.mjs", import.meta.url), "utf8");
  const merchant = readFileSync(new URL("../../../scripts/demo/shared/merchant-server.mjs", import.meta.url), "utf8");

  assert.match(actions, /--amount is required/);
  assert.match(actions, /--capacity is required/);
  assert.match(actions, /--invoice.*--latest/);
  assert.match(actions, /--channel.*--latest/);
  assert.doesNotMatch(merchant, /loadState/);
  assert.doesNotMatch(merchant, /cfg\.amounts/);
  assert.doesNotMatch(merchant, /up with zero channels/i);
});

test("each LSP launcher uses compact milestones and leaves full state to status", () => {
  for (const scenario of ["same-hash", "linked"]) {
    const source = readFileSync(
      new URL(`../../../scripts/demo/${scenario}/lsp.mjs`, import.meta.url),
      "utf8",
    );
    assert.match(source, /inspectNodeState/);
    assert.match(source, /demoConsole/);
    assert.doesNotMatch(source, /formatNodeState/);
  }
});

test("one-process e2e uses its in-process merchant address, never a configured live address", () => {
  for (const scenario of ["same-hash", "linked"]) {
    const source = readFileSync(
      new URL(`../../../scripts/demo/${scenario}/e2e.mjs`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /cfg\.peerAddress/);
    assert.match(source, /nodes\.merchant\.port/);
  }
});

test("the central demo guide is the only README and documents every command contract", () => {
  const guide = readFileSync(new URL("../../../scripts/demo/README.md", import.meta.url), "utf8");

  assert.equal(existsSync(new URL("../../../scripts/demo/linked/README.md", import.meta.url)), false);
  assert.equal(existsSync(new URL("../../../scripts/demo/same-hash/README.md", import.meta.url)), false);
  assert.match(guide, /`--amount` is required/i);
  assert.match(guide, /`--capacity` is required/i);
  assert.match(guide, /pay[^\n]*--invoice[^\n]*--latest/i);
  assert.match(guide, /rent[^\n]*--channel[^\n]*--latest/i);
  assert.match(guide, /--periods[^\n]*defaults? to `?3`?/i);
  assert.match(guide, /no JIT order[^\n]*created/i);
  assert.match(guide, /dashboard is an optional\s+interactive adapter/i);
  assert.match(guide, /node_info[^\n]*list_peers[^\n]*list_channels/i);
  assert.match(guide, /x-demo-action/i);
  assert.match(guide, /trampoline_hops/);
  assert.match(guide, /shape alone does not give the customer full graph knowledge/i);
  assert.doesNotMatch(guide, /linked topology guarantees the required shape/i);
  assert.match(guide, /npm run demo:hosted/);
  assert.match(guide, /hosted simulation/i);
  assert.match(guide, /mock FNN transport/i);
  assert.match(guide, /0\.0\.0\.0[^\n]*PORT/i);
});

test("scenario entrypoints contain no interactive or environment mode selection", () => {
  for (const scenario of ["same-hash", "linked"]) {
    for (const file of ["lsp.mjs", "merchant.mjs", "customer.mjs", "mock-fnn.mjs", "e2e.mjs"]) {
      const source = readFileSync(new URL(`../../../scripts/demo/${scenario}/${file}`, import.meta.url), "utf8");
      assert.doesNotMatch(source, /DEMO_JIT_MODE|--mode|selectDemoMode|readline/i, `${scenario}/${file}`);
    }
  }
});

test("linked demo exposes post-JIT regular payment without claiming it for the split-node topology", () => {
  const rootPackage = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  for (const action of ["regular-invoice", "regular-pay"]) {
    assert.ok(rootPackage.scripts[`demo:linked:${action}`]);
    assert.equal(rootPackage.scripts[`demo:same-hash:${action}`], undefined);
  }

  for (const file of ["request-regular-invoice.mjs", "pay-regular-invoice.mjs"]) {
    assert.equal(
      existsSync(new URL(`../../../scripts/demo/linked/actions/${file}`, import.meta.url)),
      true,
      `${file} should be part of the linked demo`,
    );
  }
  const linkedE2e = readFileSync(new URL("../../../scripts/demo/linked/e2e.mjs", import.meta.url), "utf8");
  assert.match(linkedE2e, /runRegularSale/);
});
