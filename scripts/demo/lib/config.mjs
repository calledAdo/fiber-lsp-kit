// The single source of demo configuration: scripts/demo/demo.config.json.
//
// One knob decides everything. Each role's `fnn` array is its Fiber node endpoint(s): leave it empty and a
// mock node stands in (auto-started); fill it with a real RPC URL and that role runs live — you own that
// node's funding and peering. The LSP with two endpoints offers `same_hash`; with one, it offers `linked`.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { udtAsset } from "../../../packages/protocol/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
export const demoRoot = join(here, "..");
export const repoRoot = resolve(demoRoot, "../..");
const stateDir = join(demoRoot, ".state");

export function loadConfig() {
  const cfg = JSON.parse(readFileSync(join(demoRoot, "demo.config.json"), "utf8"));
  cfg.udt = udtAsset(cfg.asset.script, cfg.asset.symbol);
  const dec = 10 ** cfg.asset.decimals;
  cfg.fmt = (v) => `${Number(BigInt(v)) / dec} ${cfg.asset.symbol}`;
  cfg.isAsset = (s) => s?.code_hash === cfg.asset.script.code_hash;

  // Empty fnn ⇒ this role uses a mock node; the daemon listens on mock.ports[role].
  for (const [role, r] of Object.entries(cfg.roles)) {
    r.mock = !r.fnn || r.fnn.length === 0;
    if (r.mock) r.fnn = [`http://127.0.0.1:${cfg.mock.ports[role]}`];
  }
  cfg.needsMock = Object.values(cfg.roles).some((r) => r.mock);
  cfg.artifactsAbs = Object.fromEntries(Object.entries(cfg.artifacts).map(([k, p]) => [k, resolve(repoRoot, p)]));
  return cfg;
}

export function saveState(key, value) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `${key}.json`), JSON.stringify(value, null, 2));
}

export function loadState(key) {
  const file = join(stateDir, `${key}.json`);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8"));
}
