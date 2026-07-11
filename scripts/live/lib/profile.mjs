// The one place the live harness reads its configuration from.
//
// A network profile (scripts/live/networks/<name>.json) holds everything a run needs: which UDT is being
// moved, and every node's RPC/pubkey/address. Pick one with NETWORK=<name> (default "testnet"). To run against
// mainnet or your own nodes, copy testnet.json, edit the values, and select it — no script edits.
//
// This replaces the scattered per-script env vars: the profile is authoritative, and steps hand state to each
// other through scripts/live/.state/ instead of loose files in the repo.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { udtAsset } from "../../../packages/protocol/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const liveRoot = join(here, "..");
const stateDir = join(liveRoot, ".state");

/** Load the selected network profile (NETWORK env, default "testnet"). */
export function loadProfile() {
  const name = process.env.NETWORK ?? "testnet";
  const file = join(liveRoot, "networks", `${name}.json`);
  if (!existsSync(file)) {
    console.error(`unknown network "${name}": no ${file}`);
    console.error(`create it by copying networks/testnet.json (see scripts/live/README.md).`);
    process.exit(2);
  }
  const p = JSON.parse(readFileSync(file, "utf8"));
  p.name = name;
  p.assetScript = p.asset.script;
  p.udt = udtAsset(p.asset.script, p.asset.symbol);
  const dec = 10 ** p.asset.decimals;
  // Format/parse base units as a human amount of the profile's asset.
  p.fmt = (v) => `${Number(BigInt(v)) / dec} ${p.asset.symbol}`;
  p.isRusd = (script) => script?.code_hash === p.asset.script.code_hash;
  return p;
}

/** Persist a small handoff object (e.g. the resolved LSP, the issued invoice) for a later step. */
export function saveState(key, value) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `${key}.json`), JSON.stringify(value, null, 2));
}

/** Read a handoff object an earlier step saved; exits with a clear message if the step was skipped. */
export function loadState(key) {
  const file = join(stateDir, `${key}.json`);
  if (!existsSync(file)) {
    console.error(`missing ${key} state — run the earlier step first (looked in ${file}).`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}
