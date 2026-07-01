/**
 * Minimal, spec-exact molecule encoder for a CKB `Script`.
 *
 * (Carried over from Fiber RouteKit, where it was verified byte-for-byte against a live FNN node's real
 * RUSD `udt_script`.) An invoice carries its UDT as `udt_script` = "0x-prefixed hex of molecule bytes of
 * the Script", while `list_channels` carries `funding_udt_type_script` as a Script object. To tell whether
 * an order's asset matches a channel's asset, we canonicalize both sides to the same molecule hex.
 *
 * Script is a molecule `table { code_hash: Byte32, hash_type: byte, args: Bytes }`.
 *   table layout: [u32le full_size][u32le off0][u32le off1][u32le off2][code_hash:32][hash_type:1][args]
 *   Bytes (args): [u32le length][bytes]
 *   hash_type byte: data=0x00, type=0x01, data1=0x02, data2=0x04
 */
import type { UdtTypeScript } from "./types.js";

export function encodeScript(s: UdtTypeScript): string {
  const codeHash = hexToBytes(s.code_hash);
  if (codeHash.length !== 32) {
    throw new Error(`Script.code_hash must be 32 bytes, got ${codeHash.length}`);
  }
  const hashType = hashTypeToByte(s.hash_type);
  const args = hexToBytes(s.args);
  const argsField = concat(u32le(args.length), args);

  const headerSize = 4 + 4 * 3; // full_size + 3 field offsets
  const off0 = headerSize;
  const off1 = off0 + 32; // after code_hash
  const off2 = off1 + 1; // after hash_type
  const fullSize = off2 + argsField.length;

  const buf = concat(
    u32le(fullSize),
    u32le(off0),
    u32le(off1),
    u32le(off2),
    codeHash,
    Uint8Array.of(hashType),
    argsField,
  );
  return "0x" + bytesToHex(buf);
}

function hashTypeToByte(t: UdtTypeScript["hash_type"]): number {
  switch (t) {
    case "data":
      return 0x00;
    case "type":
      return 0x01;
    case "data1":
      return 0x02;
    case "data2":
      return 0x04;
    default:
      throw new Error(`unknown hash_type: ${String(t)}`);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function u32le(n: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = n & 0xff;
  out[1] = (n >>> 8) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 24) & 0xff;
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
