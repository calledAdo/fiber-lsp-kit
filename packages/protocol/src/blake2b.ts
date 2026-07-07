/**
 * Minimal CKB-flavoured BLAKE2b-256 (personalization "ckb-default-hash"), vendored to keep the package
 * dependency-free. This is FNN's default `HashAlgorithm::CkbHash` — the hash a normal Fiber invoice uses.
 *
 * Adapted from the public-domain reference JS BLAKE2b (blakejs, CC0). Pinned byte-exact by golden vectors
 * (see blake2b.test.ts) generated from Python `hashlib.blake2b(..., person=b"ckb-default-hash")`, which is
 * the same construction ckb-hash uses. 64-bit words are handled as hi/lo 32-bit pairs.
 */

// prettier-ignore
const SIGMA = [
  [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],
  [14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3],
  [11,8,12,0,5,2,15,13,10,14,3,6,7,1,9,4],
  [7,9,3,1,13,12,11,14,2,6,5,10,4,0,15,8],
  [9,0,5,7,2,4,10,15,14,1,11,12,6,8,3,13],
  [2,12,6,10,0,11,8,3,4,13,7,5,15,14,1,9],
  [12,5,1,15,14,13,4,10,0,7,6,3,9,2,8,11],
  [13,11,7,14,12,1,3,9,5,0,15,4,8,6,2,10],
  [6,15,14,9,11,3,0,8,12,2,13,7,1,4,10,5],
  [10,2,8,4,7,6,1,5,15,11,9,14,3,12,13,0],
  [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],
  [14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3],
];

const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

// Working vectors (v: 16 words = 32 uint32) and the 128-byte message block as 32 uint32.
const v = new Uint32Array(32);
const m = new Uint32Array(32);

function ADD64AA(out: Uint32Array, a: number, b: number): void {
  const o0 = out[a]! + out[b]!;
  let o1 = out[a + 1]! + out[b + 1]!;
  if (o0 >= 0x100000000) o1++;
  out[a] = o0;
  out[a + 1] = o1;
}
function ADD64AC(out: Uint32Array, a: number, b0: number, b1: number): void {
  let o0 = out[a]! + b0;
  if (b0 < 0) o0 += 0x100000000;
  let o1 = out[a + 1]! + b1;
  if (o0 >= 0x100000000) o1++;
  out[a] = o0;
  out[a + 1] = o1;
}
function GET32(arr: Uint8Array, i: number): number {
  return arr[i]! ^ (arr[i + 1]! << 8) ^ (arr[i + 2]! << 16) ^ (arr[i + 3]! << 24);
}

function G(a: number, b: number, c: number, d: number, ix: number, iy: number): void {
  const x0 = m[ix]!;
  const x1 = m[ix + 1]!;
  const y0 = m[iy]!;
  const y1 = m[iy + 1]!;

  ADD64AA(v, a, b);
  ADD64AC(v, a, x0, x1);

  let xor0 = v[d]! ^ v[a]!;
  let xor1 = v[d + 1]! ^ v[a + 1]!;
  v[d] = xor1;
  v[d + 1] = xor0;

  ADD64AA(v, c, d);

  xor0 = v[b]! ^ v[c]!;
  xor1 = v[b + 1]! ^ v[c + 1]!;
  v[b] = (xor0 >>> 24) ^ (xor1 << 8);
  v[b + 1] = (xor1 >>> 24) ^ (xor0 << 8);

  ADD64AA(v, a, b);
  ADD64AC(v, a, y0, y1);

  xor0 = v[d]! ^ v[a]!;
  xor1 = v[d + 1]! ^ v[a + 1]!;
  v[d] = (xor0 >>> 16) ^ (xor1 << 16);
  v[d + 1] = (xor1 >>> 16) ^ (xor0 << 16);

  ADD64AA(v, c, d);

  xor0 = v[b]! ^ v[c]!;
  xor1 = v[b + 1]! ^ v[c + 1]!;
  v[b] = (xor1 >>> 31) ^ (xor0 << 1);
  v[b + 1] = (xor0 >>> 31) ^ (xor1 << 1);
}

interface Ctx {
  b: Uint8Array;
  h: Uint32Array;
  t: number;
  c: number;
  outlen: number;
}

function compress(ctx: Ctx, last: boolean): void {
  for (let i = 0; i < 16; i++) {
    v[i] = ctx.h[i]!;
    v[i + 16] = IV[i]!;
  }
  v[24] = v[24]! ^ ctx.t;
  v[25] = v[25]! ^ (ctx.t / 0x100000000);
  // t high word stays 0 for our short inputs
  if (last) {
    v[28] = ~v[28]!;
    v[29] = ~v[29]!;
  }
  for (let i = 0; i < 32; i++) m[i] = GET32(ctx.b, 4 * i);

  for (let i = 0; i < 12; i++) {
    const s = SIGMA[i]!;
    G(0, 8, 16, 24, s[0]! * 2, s[1]! * 2);
    G(2, 10, 18, 26, s[2]! * 2, s[3]! * 2);
    G(4, 12, 20, 28, s[4]! * 2, s[5]! * 2);
    G(6, 14, 22, 30, s[6]! * 2, s[7]! * 2);
    G(0, 10, 20, 30, s[8]! * 2, s[9]! * 2);
    G(2, 12, 22, 24, s[10]! * 2, s[11]! * 2);
    G(4, 14, 16, 26, s[12]! * 2, s[13]! * 2);
    G(6, 8, 18, 28, s[14]! * 2, s[15]! * 2);
  }
  for (let i = 0; i < 16; i++) ctx.h[i] = ctx.h[i]! ^ v[i]! ^ v[i + 16]!;
}

const PERSONAL = new TextEncoder().encode("ckb-default-hash"); // 16 bytes

/** BLAKE2b-256 with CKB's "ckb-default-hash" personalization. Input/output are raw bytes. */
export function ckbBlake2b(input: Uint8Array): Uint8Array {
  const outlen = 32;
  const ctx: Ctx = { b: new Uint8Array(128), h: new Uint32Array(16), t: 0, c: 0, outlen };
  for (let i = 0; i < 16; i++) ctx.h[i] = IV[i]!;
  // Parameter block: digest_len ^ (fanout<<16=1) ^ (depth<<24=1); personalization at bytes 48..63.
  ctx.h[0] = ctx.h[0]! ^ 0x01010000 ^ outlen;
  // personalization occupies param words 12..15 (offset 48). Fold 16 bytes as 4 little-endian u32.
  for (let i = 0; i < 4; i++) {
    ctx.h[12 + i] = ctx.h[12 + i]! ^ GET32(PERSONAL, i * 4);
  }
  for (let i = 0; i < input.length; i++) {
    if (ctx.c === 128) {
      ctx.t += ctx.c;
      compress(ctx, false);
      ctx.c = 0;
    }
    ctx.b[ctx.c++] = input[i]!;
  }
  ctx.t += ctx.c;
  while (ctx.c < 128) ctx.b[ctx.c++] = 0;
  compress(ctx, true);
  const out = new Uint8Array(outlen);
  for (let i = 0; i < outlen; i++) out[i] = (ctx.h[i >> 2]! >> (8 * (i & 3))) & 0xff;
  return out;
}
