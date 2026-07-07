import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const demoScripts = [
  "../../../scripts/merchant-demo.mjs",
  "../../../scripts/demo/00-setup.mjs",
  "../../../scripts/demo/01-discover-lsp.mjs",
  "../../../scripts/demo/03-invoice.mjs",
  "../../../scripts/demo/04-pay.mjs",
  "../../../scripts/demo/05-stream-rent.mjs",
];

test("demo scripts import FiberChannelRpcClient from the fiber package", () => {
  for (const relative of demoScripts) {
    const url = new URL(relative, import.meta.url);
    const source = readFileSync(url, "utf8");

    assert.doesNotMatch(
      source,
      /import\s*\{[^}]*\bFiberChannelRpcClient\b[^}]*\}\s*from\s*["'][^"']*packages\/protocol\/dist\/index\.js["']/s,
      `${relative} must not import FiberChannelRpcClient from protocol`,
    );

    assert.match(
      source,
      /import\s*\{[^}]*\bFiberChannelRpcClient\b[^}]*\}\s*from\s*["'][^"']*packages\/fiber\/dist\/index\.js["']/s,
      `${relative} must import FiberChannelRpcClient from fiber`,
    );
  }
});
