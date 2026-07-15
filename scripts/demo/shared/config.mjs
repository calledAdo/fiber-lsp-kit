import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { udtAsset } from "../../../packages/protocol/dist/index.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const sharedRoot = dirname(fileURLToPath(import.meta.url));
export const demoRoot = resolve(sharedRoot, "..");
export const repoRoot = resolve(sharedRoot, "../../..");

function valueAt(root, path) {
  return path.split(".").reduce((value, key) => value?.[key], root);
}

function isPresent(value) {
  return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;
}

/** Choose one complete node source. A partial live config can never leak into the mock profile. */
export function resolveCompleteProfile({ configuredNodes, mockNodes, requiredFields }) {
  const missing = requiredFields.filter((path) => !isPresent(valueAt(configuredNodes, path)));
  return {
    profile: missing.length === 0 ? "live" : "mock",
    missing,
    nodes: structuredClone(missing.length === 0 ? configuredNodes : mockNodes),
  };
}

/** Derive the base58 libp2p peer id used in a `/p2p/<id>` multiaddr from an FNN compressed pubkey. */
export function nodePeerId(pubkeyHex) {
  const key = Buffer.from(String(pubkeyHex).replace(/^0x/, ""), "hex");
  const mh = Buffer.concat([Buffer.from([0x12, 0x20]), createHash("sha256").update(key).digest()]);
  let n = 0n;
  for (const byte of mh) n = n * 256n + BigInt(byte);
  let encoded = "";
  while (n > 0n) {
    encoded = B58[Number(n % 58n)] + encoded;
    n /= 58n;
  }
  for (const byte of mh) {
    if (byte !== 0) break;
    encoded = "1" + encoded;
  }
  return encoded;
}

/** Load one scenario's static config and attach its complete live-or-mock runtime profile. */
export function loadScenarioConfig(configUrl, definition) {
  const configPath = fileURLToPath(configUrl);
  const scenarioRoot = dirname(configPath);
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  const topology = resolveCompleteProfile({
    configuredNodes: raw.nodes,
    mockNodes: definition.mockNodes,
    requiredFields: definition.requiredFields,
  });
  const asset = udtAsset(raw.asset.script, raw.asset.symbol);
  const scale = 10n ** BigInt(raw.asset.decimals);

  return {
    ...raw,
    asset,
    assetConfig: { symbol: raw.asset.symbol, decimals: raw.asset.decimals },
    assetDecimals: raw.asset.decimals,
    assetScript: raw.asset.script,
    topology,
    scenarioRoot,
    stateDir: join(scenarioRoot, ".state"),
    repoRoot,
    artifactsAbs: Object.fromEntries(
      Object.entries(raw.artifacts ?? {}).map(([key, path]) => [key, resolve(repoRoot, path)]),
    ),
    mockNodes: Object.entries(topology.nodes)
      .filter(([, node]) => topology.profile === "mock" && Number.isInteger(node.port))
      .map(([role, node]) => ({ role, port: node.port })),
    fmt(value) {
      const amount = BigInt(value);
      const whole = amount / scale;
      const fraction = (amount % scale).toString().padStart(raw.asset.decimals, "0").replace(/0+$/, "");
      return `${whole}${fraction ? `.${fraction}` : ""} ${raw.asset.symbol}`;
    },
    toBase(human) {
      const [whole, fraction = ""] = String(human).trim().split(".");
      if (fraction.length > raw.asset.decimals) {
        throw new Error(`${raw.asset.symbol} has ${raw.asset.decimals} decimals; "${human}" has too many`);
      }
      return (BigInt(whole || "0") * scale + BigInt((fraction + "0".repeat(raw.asset.decimals)).slice(0, raw.asset.decimals))).toString(10);
    },
    peerAddress(role, pubkey) {
      const base = topology.nodes[role]?.p2p;
      if (!base || !pubkey) return undefined;
      return base.includes("/p2p/") ? base : `${base}/p2p/${nodePeerId(pubkey)}`;
    },
    artifactPath(path) {
      return resolve(repoRoot, path);
    },
  };
}
