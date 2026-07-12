// The single source of demo configuration: scripts/demo/demo.config.json.
//
// One knob decides everything. Each role's `fnn` array is its Fiber node endpoint(s): leave it empty and a
// mock node stands in (auto-started); fill it with a real RPC URL and that role runs live — you own that
// node's funding and peering. The LSP with two endpoints offers `same_hash`; with one, it offers `linked`.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { udtAsset } from "../../../packages/protocol/dist/index.js";

// A Fiber node's libp2p peer-id is base58btc(sha2-256 multihash of its compressed secp256k1 pubkey). Deriving
// it from the pubkey (which any node reports via node_info) means the operator only has to say WHERE their node
// listens for p2p, not restate its identity — see `peerAddr` below. Verified live against a testnet fnn node.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function nodePeerId(pubkeyHex) {
  const mh = Buffer.concat([Buffer.from([0x12, 0x20]), createHash("sha256").update(Buffer.from(pubkeyHex.replace(/^0x/, ""), "hex")).digest()]);
  let n = 0n;
  for (const b of mh) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of mh) { if (b === 0) s = "1" + s; else break; }
  return s;
}

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
  // Parse a human amount ("2", "2.5") into base units, exactly (no float) — for CLI args.
  cfg.toBase = (human) => {
    const [whole, frac = ""] = String(human).trim().split(".");
    if (frac.length > cfg.asset.decimals) throw new Error(`${cfg.asset.symbol} has ${cfg.asset.decimals} decimals; "${human}" has too many`);
    return (BigInt(whole || "0") * BigInt(dec) + BigInt((frac + "0".repeat(cfg.asset.decimals)).slice(0, cfg.asset.decimals))).toString(10);
  };

  // Empty fnn ⇒ this role uses a mock node; the daemon listens on mock.ports[role].
  for (const [role, r] of Object.entries(cfg.roles)) {
    r.mock = !r.fnn || r.fnn.length === 0;
    if (r.mock) r.fnn = [`http://127.0.0.1:${cfg.mock.ports[role]}`];
  }
  cfg.needsMock = Object.values(cfg.roles).some((r) => r.mock);
  // A dialable multiaddr for a live role's node, so a funder (the LSP) can (re)establish an OUTBOUND session to
  // it before opening a JIT channel — outbound sessions are exempt from FNN's inbound-no-channel eviction
  // (upstream finding #11). Undefined for a mock role or one with no `p2p` endpoint configured.
  cfg.peerAddr = (role, pubkey) => {
    const r = cfg.roles[role];
    return !r.mock && r.p2p && pubkey ? `${r.p2p}/p2p/${nodePeerId(pubkey)}` : undefined;
  };
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
