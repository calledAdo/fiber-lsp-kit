/**
 * FNN's JSON-RPC encodes u64/u128 as 0x-prefixed hex strings (the CKB convention). These helpers keep
 * every amount as a decimal string at the protocol boundary and convert only when talking to the node.
 */

/** Parse a value that may be a hex string ("0x..."), decimal string, number, or bigint. */
export function asBig(v: string | number | bigint | null | undefined): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  const s = v.trim();
  if (s === "") return 0n;
  return s.startsWith("0x") || s.startsWith("0X") ? BigInt(s) : BigInt(s);
}

/** Encode a bigint/decimal-string amount as the 0x hex string FNN expects. */
export function toHex(v: string | number | bigint): string {
  return "0x" + asBig(v).toString(16);
}

/** Normalize any amount to a decimal string (the protocol's canonical form). */
export function toDecimal(v: string | number | bigint): string {
  return asBig(v).toString(10);
}
