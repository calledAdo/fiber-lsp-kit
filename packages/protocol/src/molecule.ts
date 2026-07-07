/**
 * Molecule serializer for a CKB `Script` — the one place UDT identity is computed.
 *
 * FNN refers to a UDT in two shapes: an invoice's `udt_script` is molecule hex, while `list_channels`
 * hands back `funding_udt_type_script` as a structured object. Serializing both down to the same hex is
 * what lets the server decide whether an order's asset and a channel's asset are the same token.
 *
 * `table Script { code_hash: Byte32, hash_type: byte, args: Bytes }` serializes as a molecule table:
 *   a header of four little-endian u32 words [full_size, off0, off1, off2], then the fields laid out
 *   back to back, where `args` is a `Bytes` = [u32 length ++ raw payload].
 */
import type { UdtTypeScript } from "./types.js";

const HASH_TYPE_TAG: Record<UdtTypeScript["hash_type"], number> = {
  data: 0x00,
  type: 0x01,
  data1: 0x02,
  data2: 0x04,
};

/** Serialize a Script to its `0x`-prefixed molecule hex. */
export function encodeScript(script: UdtTypeScript): string {
  const codeHash = decodeHex(script.code_hash);
  if (codeHash.length !== 32) {
    throw new Error(`Script.code_hash must be 32 bytes, got ${codeHash.length}`);
  }
  const tag = HASH_TYPE_TAG[script.hash_type];
  if (tag === undefined) throw new Error(`unknown hash_type: ${String(script.hash_type)}`);
  const args = decodeHex(script.args);

  // Field offsets: 4 header words (16 bytes), then code_hash(32), hash_type(1), args-Bytes(4 + n).
  const HEADER = 16;
  const codeHashAt = HEADER;
  const hashTypeAt = codeHashAt + 32;
  const argsAt = hashTypeAt + 1;
  const total = argsAt + 4 + args.length;

  // One allocation; a DataView writes every u32 little-endian in place.
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total, true);
  view.setUint32(4, codeHashAt, true);
  view.setUint32(8, hashTypeAt, true);
  view.setUint32(12, argsAt, true);
  out.set(codeHash, codeHashAt);
  out[hashTypeAt] = tag;
  view.setUint32(argsAt, args.length, true); // Bytes length prefix
  out.set(args, argsAt + 4);

  return "0x" + encodeHex(out);
}

function decodeHex(hex: string): Uint8Array {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  const bytes = new Uint8Array(body.length >>> 1);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function encodeHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
