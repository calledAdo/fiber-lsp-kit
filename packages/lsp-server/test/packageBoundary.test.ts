import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("the runnable LSP composition lives outside the published server package", () => {
  const examplePath = join(repoRoot, "examples/reference-lsp/server.mjs");
  const packageServerPath = join(repoRoot, "packages/lsp-server/src/server.ts");
  const packageJson = JSON.parse(
    readFileSync(join(repoRoot, "packages/lsp-server/package.json"), "utf8"),
  ) as { files?: string[]; scripts?: Record<string, string> };
  const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  assert.equal(existsSync(packageServerPath), false, "the package must not own an executable composition root");
  assert.equal(existsSync(examplePath), true, "the repository must retain a runnable reference composition");
  assert.equal(packageJson.scripts?.start, undefined, "the building-block package must not advertise a server process");
  assert.deepEqual(packageJson.files, ["dist", "!dist/server.*"], "stale executable output must be excluded");
  assert.equal(rootPackageJson.scripts?.server, undefined, "the root must not present the example as package behavior");
  assert.equal(
    rootPackageJson.scripts?.["example:lsp"],
    "npm run build && node examples/reference-lsp/server.mjs",
  );
});

test("the reference composition consumes public package APIs and derives its observer endpoint", () => {
  const source = readFileSync(join(repoRoot, "examples/reference-lsp/server.mjs"), "utf8");

  assert.match(source, /from ["']@fiberlsp\/protocol["']/);
  assert.match(source, /from ["']@fiberlsp\/fiber["']/);
  assert.match(source, /from ["']@fiberlsp\/server["']/);
  assert.doesNotMatch(source, /packages\/(?:protocol|fiber|lsp-server)\/(?:src|dist)/);
  assert.doesNotMatch(source, /JIT_PREIMAGE_WS_URL/);
  assert.match(source, /rpcUrl:\s*payRpcUrl\s*\|\|\s*FIBER_RPC_URL/);
});

test("demo process management launches the external reference composition", () => {
  const source = readFileSync(join(repoRoot, "scripts/demo/shared/processes.mjs"), "utf8");

  assert.match(source, /startReferenceComposition\(extraEnv\)/);
  assert.doesNotMatch(source, /startReferenceServer/);
  assert.match(source, /examples["'],\s*["']reference-lsp["'],\s*["']server\.mjs["']/);
  assert.doesNotMatch(source, /packages\/lsp-server\/dist\/server\.js/);
});
