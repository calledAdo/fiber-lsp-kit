/**
 * Asset identity helpers.
 *
 * A Fiber channel — and therefore an LSP order — is denominated in exactly one asset: native CKB, or a
 * single UDT. The awkward part is that a UDT reaches us in two encodings (a Script object, or the
 * molecule hex string on an invoice), so everything here funnels down to one comparable key through
 * `canonicalAssetId`.
 */
import type { Asset, UdtTypeScript } from "./types.js";
import { encodeScript } from "./molecule.js";

/** The native asset. */
export const CKB: Asset = { kind: "CKB" };

/** Wrap a Script object as a UDT asset, caching its molecule hex up front. */
export function udtAsset(udt: UdtTypeScript, symbol?: string): Asset {
  return { kind: "UDT", udt, scriptHex: encodeScript(udt).toLowerCase(), symbol };
}

/** Wrap a raw `udt_script` hex (as it appears on an invoice) as a UDT asset. */
export function udtAssetFromHex(scriptHex: string, symbol?: string): Asset {
  return { kind: "UDT", scriptHex: scriptHex.toLowerCase(), symbol };
}

/**
 * Collapse an asset to a single comparable key: `"CKB"` for the native asset, otherwise the lower-cased
 * molecule hex of its Script. Returns `null` when identity is indeterminate — a UDT carrying neither a
 * Script object nor a hex encoding.
 */
export function canonicalAssetId(a: Asset): string | null {
  if (a.kind === "CKB") return "CKB";
  const hex = a.scriptHex ?? (a.udt ? encodeScript(a.udt) : undefined);
  return hex ? hex.toLowerCase() : null;
}

/** True when both assets resolve to the same canonical key. */
export function assetEquals(a: Asset, b: Asset): boolean {
  const key = canonicalAssetId(a);
  return key !== null && key === canonicalAssetId(b);
}

/** Short human label for logs and API responses. */
export function describeAsset(a: Asset): string {
  if (a.kind === "CKB") return "CKB";
  if (a.symbol) return a.symbol;
  const id = a.udt?.code_hash ?? a.scriptHex;
  return id ? `UDT[${id.replace(/^0x/, "").slice(0, 8)}]` : "UDT[?]";
}

/** The Script object for a UDT asset, if we have one — needed to pass to `open_channel`. */
export function assetUdtScript(a: Asset): UdtTypeScript | undefined {
  return a.kind === "UDT" ? a.udt : undefined;
}
