import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const demoScripts = [
  "../../../scripts/demo/shared/merchant-server.mjs",
  "../../../scripts/demo/shared/customer-server.mjs",
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
