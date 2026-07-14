import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ensureArtifacts } from "../../../scripts/demo/shared/artifacts.mjs";

test("linked demo prefers a complete artifact cache over configured build output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fiberlsp-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const cacheDir = join(root, ".artifacts");
  const buildDir = join(root, "build");
  await Promise.all([mkdir(cacheDir), mkdir(buildDir)]);
  await Promise.all([
    writeFile(join(cacheDir, "linkage.ark"), "cached key"),
    writeFile(join(cacheDir, "linkage.wasm"), "cached circuit"),
    writeFile(join(buildDir, "linkage.ark"), "build key"),
    writeFile(join(buildDir, "linkage.wasm"), "build circuit"),
  ]);

  let fetches = 0;
  const artifacts = await ensureArtifacts(
    "merchant",
    {
      release: "https://example.invalid/release",
      artifactsAbs: {
        zkey: join(buildDir, "linkage.ark"),
        wasm: join(buildDir, "linkage.wasm"),
      },
    },
    {
      outDir: cacheDir,
      fetchRelease: async () => {
        fetches += 1;
      },
    },
  );

  assert.deepEqual(artifacts, {
    zkey: join(cacheDir, "linkage.ark"),
    wasm: join(cacheDir, "linkage.wasm"),
  });
  assert.equal(fetches, 0);
});

test("linked demo uses configured build output when the artifact cache is incomplete", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fiberlsp-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const cacheDir = join(root, ".artifacts");
  const buildDir = join(root, "build");
  await Promise.all([mkdir(cacheDir), mkdir(buildDir)]);
  await Promise.all([
    writeFile(join(cacheDir, "linkage.ark"), "partial cache"),
    writeFile(join(buildDir, "linkage.ark"), "build key"),
    writeFile(join(buildDir, "linkage.wasm"), "build circuit"),
  ]);

  let fetches = 0;
  const artifacts = await ensureArtifacts(
    "merchant",
    {
      release: "https://example.invalid/release",
      artifactsAbs: {
        zkey: join(buildDir, "linkage.ark"),
        wasm: join(buildDir, "linkage.wasm"),
      },
    },
    {
      outDir: cacheDir,
      fetchRelease: async () => {
        fetches += 1;
      },
    },
  );

  assert.deepEqual(artifacts, {
    zkey: join(buildDir, "linkage.ark"),
    wasm: join(buildDir, "linkage.wasm"),
  });
  assert.equal(fetches, 0);
});

test("linked demo downloads into the artifact cache when cache and build output are incomplete", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fiberlsp-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const cacheDir = join(root, ".artifacts");
  const buildDir = join(root, "build");
  await Promise.all([mkdir(cacheDir), mkdir(buildDir)]);

  const fetches: Array<{ role: string; release: string; outDir: string }> = [];
  const artifacts = await ensureArtifacts(
    "merchant",
    {
      release: "https://example.invalid/release",
      artifactsAbs: {
        zkey: join(buildDir, "linkage.ark"),
        wasm: join(buildDir, "linkage.wasm"),
      },
    },
    {
      outDir: cacheDir,
      fetchRelease: async (role: string, release: string, outDir: string) => {
        fetches.push({ role, release, outDir });
        await Promise.all([
          writeFile(join(outDir, "linkage.ark"), "downloaded key"),
          writeFile(join(outDir, "linkage.wasm"), "downloaded circuit"),
        ]);
      },
    },
  );

  assert.deepEqual(fetches, [{
    role: "merchant",
    release: "https://example.invalid/release",
    outDir: cacheDir,
  }]);
  assert.deepEqual(artifacts, {
    zkey: join(cacheDir, "linkage.ark"),
    wasm: join(cacheDir, "linkage.wasm"),
  });
});
