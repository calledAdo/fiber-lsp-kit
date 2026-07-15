import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDemoConsole,
  shortId,
} from "../../../scripts/demo/shared/console.mjs";

test("demo console emits stable milestone markers without ANSI colors", () => {
  const lines: string[] = [];
  const output = createDemoConsole({ color: false, write: (line: string) => lines.push(line) });

  output.heading("Linked JIT", "LSP");
  output.ok("Live testnet profile", "3 nodes");
  output.run("API listening", "http://127.0.0.1:9180");
  output.info("Full diagnostics", "npm run demo:linked:status");
  output.warn("Retry required", "payment pending");
  output.fail("Checkout failed", "invoice expired");

  assert.deepEqual(lines, [
    "Linked JIT / LSP",
    "[ OK ] Live testnet profile · 3 nodes",
    "[RUN ] API listening · http://127.0.0.1:9180",
    "[INFO] Full diagnostics · npm run demo:linked:status",
    "[WARN] Retry required · payment pending",
    "[FAIL] Checkout failed · invoice expired",
  ]);
});

test("demo console colors only markers and shortens opaque identifiers", () => {
  const lines: string[] = [];
  const output = createDemoConsole({ color: true, write: (line: string) => lines.push(line) });

  output.ok("Merchant channel ready", "1 channel");

  assert.match(lines[0] ?? "", /^\x1b\[32m\[ OK \]\x1b\[0m Merchant channel ready/);
  assert.equal(shortId("0x1234567890abcdefghijklmnopqrstuvwxyz"), "0x1234567890...stuvwxyz");
  assert.equal(shortId("short"), "short");
});
