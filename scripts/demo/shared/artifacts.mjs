// Per-role artifact autodetection + download for the linked scenario. The LSP needs the Groth16 verification
// key; the merchant needs the proving key and circuit wasm. Starting that scenario is explicit consent to
// fetch anything missing.
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "./config.mjs";

const NEED = { lsp: ["vk"], merchant: ["zkey", "wasm"] };
// The release ships these fixed names; map our logical keys onto them.
const RELEASE_FILE = { vk: "verification_key.json", zkey: "linkage.ark", wasm: "linkage.wasm" };

function fetchRelease(role, release, outDir) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(repoRoot, "scripts/fetch-artifacts.mjs"), "--release", release, "--role", role, "--out", outDir],
      { stdio: "inherit" });
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`fetch-artifacts exited ${c}`))));
  });
}

/**
 * Resolve the artifact paths a linked-scenario role needs. Reuses the demo cache first, then a local circuit
 * build, then downloads the configured release and throws if the required files cannot be obtained.
 */
export async function ensureArtifacts(role, cfg, options = {}) {
  const need = NEED[role] ?? [];
  const outDir = options.outDir ?? join(repoRoot, "scripts/demo/.artifacts");
  const cached = Object.fromEntries(need.map((k) => [k, join(outDir, RELEASE_FILE[k])]));
  if (need.every((k) => existsSync(cached[k]))) return cached;

  const built = Object.fromEntries(need.map((k) => [k, cfg.artifactsAbs[k]]));
  if (need.every((k) => existsSync(built[k]))) return built;

  if (!cfg.release) throw new Error(
    `[${role}] linked artifacts are incomplete in both the demo cache and configured build output, and the scenario config "release" is empty`,
  );
  await (options.fetchRelease ?? fetchRelease)(role, cfg.release, outDir);
  const got = Object.fromEntries(need.map((k) => [k, join(outDir, RELEASE_FILE[k])]));
  const stillMissing = need.filter((k) => !existsSync(got[k]));
  if (stillMissing.length) throw new Error(`download did not produce: ${stillMissing.join(", ")}`);
  return got;
}
