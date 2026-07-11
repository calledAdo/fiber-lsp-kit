// Per-role artifact autodetection + download. The LSP needs the Groth16 verification key; the merchant needs
// the proving key and the circuit wasm. If they are already on disk (e.g. a local circuit build) they are
// used as-is; otherwise this offers to fetch them from the configured release — with `--download` it does so
// without asking, else it prompts.
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { repoRoot } from "./config.mjs";

const NEED = { lsp: ["vk"], merchant: ["zkey", "wasm"] };
// The release ships these fixed names; map our logical keys onto them.
const RELEASE_FILE = { vk: "verification_key.json", zkey: "linkage.ark", wasm: "linkage.wasm" };

function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(/^y(es)?$/i.test(a.trim())); }));
}

function fetchRelease(role, release, outDir) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(repoRoot, "scripts/fetch-artifacts.mjs"), "--release", release, "--role", role, "--out", outDir],
      { stdio: "inherit" });
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`fetch-artifacts exited ${c}`))));
  });
}

/**
 * Resolve the artifact paths a role needs. Returns a { key: path } map when available, or null when they are
 * missing and skipping is allowed (the caller then falls back — e.g. the LSP to same_hash). Throws when they
 * are required and cannot be obtained.
 */
export async function ensureArtifacts(role, cfg, { download = false, allowSkip = false } = {}) {
  const need = NEED[role] ?? [];
  const present = Object.fromEntries(need.map((k) => [k, cfg.artifactsAbs[k]]));
  const missing = need.filter((k) => !existsSync(present[k]));
  if (missing.length === 0) return present;

  const go = download || (cfg.release && (await ask(`[${role}] linked artifacts (${missing.join(", ")}) not found. Download from release now? [y/N] `)));
  if (go) {
    if (!cfg.release) throw new Error(`cannot download: demo.config.json "release" is empty`);
    const outDir = join(repoRoot, "scripts/demo/.artifacts");
    await fetchRelease(role, cfg.release, outDir);
    const got = Object.fromEntries(need.map((k) => [k, join(outDir, RELEASE_FILE[k])]));
    const stillMissing = need.filter((k) => !existsSync(got[k]));
    if (stillMissing.length) throw new Error(`download did not produce: ${stillMissing.join(", ")}`);
    return got;
  }

  if (allowSkip) return null;
  throw new Error(
    `[${role}] missing linked artifacts (${missing.join(", ")}). Options:\n` +
      `  • set "release" in scripts/demo/demo.config.json and rerun with --download\n` +
      `  • build the circuit (packages/protocol/circuits/dual-sha256-linkage/README.md)`,
  );
}
