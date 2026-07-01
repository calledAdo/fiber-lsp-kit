/** Pure helpers for comparing and describing assets across their two UDT encodings. */
import type { Asset, UdtTypeScript } from "./types.js";
import { encodeScript } from "./molecule.js";

export const CKB: Asset = { kind: "CKB" };

/** Build a UDT asset from a Script object, precomputing its canonical molecule hex. */
export function udtAsset(udt: UdtTypeScript, symbol?: string): Asset {
  return { kind: "UDT", udt, scriptHex: encodeScript(udt).toLowerCase(), symbol };
}

/** Build a UDT asset from an invoice's `udt_script` hex string. */
export function udtAssetFromHex(scriptHex: string, symbol?: string): Asset {
  return { kind: "UDT", scriptHex: scriptHex.toLowerCase(), symbol };
}

/**
 * Canonical comparison key. CKB is "CKB"; a UDT is its molecule hex (from `scriptHex`, or computed
 * from the Script object). Returns null when identity is indeterminate (a UDT with neither encoding).
 */
export function canonicalAssetId(a: Asset): string | null {
  if (a.kind === "CKB") return "CKB";
  if (a.scriptHex) return a.scriptHex.toLowerCase();
  if (a.udt) return encodeScript(a.udt).toLowerCase();
  return null;
}

export function assetEquals(a: Asset, b: Asset): boolean {
  const ka = canonicalAssetId(a);
  const kb = canonicalAssetId(b);
  return ka !== null && ka === kb;
}

export function describeAsset(a: Asset): string {
  if (a.kind === "CKB") return "CKB";
  if (a.symbol) return a.symbol;
  if (a.udt) return `UDT(${a.udt.code_hash.slice(0, 12)}…)`;
  if (a.scriptHex) return `UDT(${a.scriptHex.slice(0, 14)}…)`;
  return "UDT(unknown)";
}

/** The Script object for a UDT asset, if we have one (needed to pass to open_channel). */
export function assetUdtScript(a: Asset): UdtTypeScript | undefined {
  return a.kind === "UDT" ? a.udt : undefined;
}
