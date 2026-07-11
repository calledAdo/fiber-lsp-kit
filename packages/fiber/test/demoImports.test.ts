import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const demoScripts = [
  "../../../scripts/live/00-setup.mjs",
  "../../../scripts/live/01-discover-lsp.mjs",
  "../../../scripts/live/03-invoice.mjs",
  "../../../scripts/live/04-pay.mjs",
  "../../../scripts/live/05-stream-rent.mjs",
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
