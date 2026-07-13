import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { loadConfig as loadSameHash } from "../../../scripts/demo/same-hash/config.mjs";
import { loadConfig as loadLinked } from "../../../scripts/demo/linked/config.mjs";

test("same-hash is an explicit four-node scenario with no proof artifacts", () => {
  const cfg = loadSameHash();
  assert.equal(cfg.mode, "same_hash");
  assert.equal(cfg.asset.kind, "UDT");
  assert.equal(cfg.assetScript.code_hash, cfg.asset.udt?.code_hash);
  assert.equal(cfg.topology.profile, "mock");
  assert.deepEqual(Object.keys(cfg.topology.nodes).sort(), ["customer", "hold", "merchant", "payment"]);
  assert.deepEqual(cfg.artifactsAbs, {});
});

test("linked is an explicit three-node scenario with release artifact metadata", () => {
  const cfg = loadLinked();
  assert.equal(cfg.mode, "linked");
  assert.equal(cfg.topology.profile, "mock");
  assert.deepEqual(Object.keys(cfg.topology.nodes).sort(), ["customer", "lsp", "merchant"]);
  assert.ok(cfg.release);
  assert.deepEqual(Object.keys(cfg.artifactsAbs).sort(), ["vk", "wasm", "zkey"]);
});

test("scenario entrypoints contain no interactive or environment mode selection", () => {
  for (const scenario of ["same-hash", "linked"]) {
    for (const file of ["lsp.mjs", "merchant.mjs", "customer.mjs", "mock-fnn.mjs", "e2e.mjs"]) {
      const source = readFileSync(new URL(`../../../scripts/demo/${scenario}/${file}`, import.meta.url), "utf8");
      assert.doesNotMatch(source, /DEMO_JIT_MODE|--mode|selectDemoMode|readline/i, `${scenario}/${file}`);
    }
  }
});

test("demo surface is limited to JIT checkout and channel-bound rent", () => {
  const rootPackage = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.equal(rootPackage.scripts["demo:linked:direct-invoice"], undefined);
  assert.equal(rootPackage.scripts["demo:linked:direct-pay"], undefined);

  for (const file of ["direct-invoice.mjs", "direct-pay.mjs"]) {
    assert.equal(
      existsSync(new URL(`../../../scripts/demo/linked/actions/${file}`, import.meta.url)),
      false,
      `${file} should not be part of the linked demo`,
    );
  }

  for (const file of ["shared/actions.mjs", "shared/merchant-server.mjs", "shared/e2e-flow.mjs", "linked/e2e.mjs"]) {
    const source = readFileSync(new URL(`../../../scripts/demo/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /direct-invoice|directInvoice|DirectSale|InvoiceService/);
  }
});
