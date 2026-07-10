/**
 * Witness generation for a circom circuit, as ESM.
 *
 * circom emits a `witness_calculator.js` alongside the `.wasm`. It is dependency-free but CommonJS, and it
 * lands inside a package whose `package.json` declares `"type": "module"` — so importing it fails no matter
 * which directory you run from. This is a port of that generator's logic (circom 2's wasm ABI), so a merchant
 * needs neither the emitted file nor a `{ "type": "commonjs" }` marker: only the `.wasm`.
 *
 * The output is a `.wtns` byte buffer, byte-identical to what circom's own generator produces — pinned by test.
 */

/** A circom input map: signal name → value, nested arrays allowed. */
export type CircomInput = Record<string, bigint | number | string | readonly unknown[]>;

interface CircomExports {
  getVersion(): number;
  getFieldNumLen32(): number;
  getRawPrime(): void;
  getWitnessSize(): number;
  getInputSize(): number;
  getInputSignalSize(hMSB: number, hLSB: number): number;
  readSharedRWMemory(i: number): number;
  writeSharedRWMemory(i: number, v: number): void;
  setInputSignal(hMSB: number, hLSB: number, i: number): void;
  getWitness(i: number): void;
  getMessageChar(): number;
  init(sanityCheck: number): void;
}

const EXCEPTIONS: Record<number, string> = {
  1: "Signal not found.",
  2: "Too many signals set.",
  3: "Signal already set.",
  4: "Assert Failed.",
  5: "Not enough memory.",
  6: "Input signal array access exceeds the size.",
};

/** Compute the `.wtns` bytes for `input` against a compiled circom `.wasm`. */
export async function calculateWtnsBin(wasm: Uint8Array | ArrayBuffer, input: CircomInput): Promise<Uint8Array> {
  let instance!: WebAssembly.Instance;
  const readMessage = (): string => {
    const e = instance.exports as unknown as CircomExports;
    let msg = "";
    for (let c = e.getMessageChar(); c !== 0; c = e.getMessageChar()) msg += String.fromCharCode(c);
    return msg;
  };
  let errStr = "";

  instance = await WebAssembly.instantiate(await WebAssembly.compile(wasm as BufferSource), {
    runtime: {
      exceptionHandler(code: number) {
        throw new Error(`${EXCEPTIONS[code] ?? "Unknown error."}\n${errStr}`);
      },
      printErrorMessage() {
        errStr += readMessage() + "\n";
      },
      // The circuit has no `log()` calls; keep the imports satisfied and stay silent.
      writeBufferMessage() {
        readMessage();
      },
      showSharedRWMemory() {},
    },
  });

  const e = instance.exports as unknown as CircomExports;
  const n32 = e.getFieldNumLen32();
  const prime = readShared(e, n32);
  const witnessSize = e.getWitnessSize();

  // --- feed the inputs ---
  e.init(0);
  let set = 0;
  for (const [name, value] of Object.entries(input)) {
    const h = fnvHash(name);
    const hMSB = parseInt(h.slice(0, 8), 16);
    const hLSB = parseInt(h.slice(8, 16), 16);
    const flat = flatten(value);
    const signalSize = e.getInputSignalSize(hMSB, hLSB);
    if (signalSize < 0) throw new Error(`Signal ${name} not found`);
    if (flat.length !== signalSize) {
      throw new Error(`Signal ${name} expects ${signalSize} values, got ${flat.length}`);
    }
    for (let i = 0; i < flat.length; i++) {
      const limbs = toArray32(normalize(flat[i]!, prime), n32);
      for (let j = 0; j < n32; j++) e.writeSharedRWMemory(j, limbs[n32 - 1 - j]!);
      e.setInputSignal(hMSB, hLSB, i);
      set++;
    }
  }
  if (set < e.getInputSize()) throw new Error(`Only ${set} of ${e.getInputSize()} input signals were set`);

  // --- serialise the .wtns (format version 2, two sections) ---
  const n8 = n32 * 4;
  const buf32 = new Uint32Array(witnessSize * n32 + n32 + 11);
  const buf = new Uint8Array(buf32.buffer);
  buf[0] = 0x77; // 'w'
  buf[1] = 0x74; // 't'
  buf[2] = 0x6e; // 'n'
  buf[3] = 0x73; // 's'
  buf32[1] = 2; // version
  buf32[2] = 2; // section count
  buf32[3] = 1; // section 1 id
  writeU64(buf32, 4, 8 + n8); // section 1 length
  buf32[6] = n8;

  e.getRawPrime();
  let pos = 7;
  for (let j = 0; j < n32; j++) buf32[pos + j] = e.readSharedRWMemory(j);
  pos += n32;
  buf32[pos++] = witnessSize;
  buf32[pos++] = 2; // section 2 id
  writeU64(buf32, pos, n8 * witnessSize); // section 2 length
  pos += 2;
  for (let i = 0; i < witnessSize; i++) {
    e.getWitness(i);
    for (let j = 0; j < n32; j++) buf32[pos + j] = e.readSharedRWMemory(j);
    pos += n32;
  }
  return buf;
}

function readShared(e: CircomExports, n32: number): bigint {
  e.getRawPrime();
  const arr = new Uint32Array(n32);
  for (let i = 0; i < n32; i++) arr[n32 - 1 - i] = e.readSharedRWMemory(i);
  return fromArray32(arr);
}

/**
 * The wtns header stores section lengths as a little-endian u64: low word first, then high.
 *
 * circom's own generator writes `parseInt(len.toString(16).slice(0, 8), 16)` into the low word, which happens
 * to be the whole value for any length below 2^32 and silently truncates above it. This does the arithmetic
 * instead, so the two agree byte-for-byte on real circuits and this one stays correct on larger ones.
 */
function writeU64(buf32: Uint32Array, at: number, value: number): void {
  const v = BigInt(value);
  buf32[at] = Number(v & 0xffffffffn);
  buf32[at + 1] = Number(v >> 32n);
}

function toArray32(rem: bigint, size: number): number[] {
  const out: number[] = [];
  const radix = 0x100000000n;
  let n = rem;
  while (n) {
    out.unshift(Number(n % radix));
    n /= radix;
  }
  while (out.length < size) out.unshift(0);
  return out;
}

function fromArray32(arr: Uint32Array): bigint {
  let res = 0n;
  for (const limb of arr) res = res * 0x100000000n + BigInt(limb);
  return res;
}

function flatten(value: unknown): bigint[] {
  const out: bigint[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else out.push(BigInt(v as bigint | number | string));
  };
  walk(value);
  return out;
}

function normalize(n: bigint, prime: bigint): bigint {
  const r = n % prime;
  return r < 0n ? r + prime : r;
}

/** FNV-1a over the signal name, as circom's wasm ABI expects. */
function fnvHash(str: string): string {
  const MASK = 2n ** 64n;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * 0x100000001b3n) % MASK;
  }
  return hash.toString(16).padStart(16, "0");
}
