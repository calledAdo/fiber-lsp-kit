/**
 * @fiberlsp/prover-linked — the merchant side of `linked` JIT, as one function.
 *
 * `JitCheckout` needs a `proveLinkage` hook. Building one by hand means generating a witness, shelling out to a
 * Groth16 prover, parsing its output, and binding the public signals to the order's hashes. This package does
 * all of that:
 *
 *     const jit = new JitCheckout({
 *       rpc, lsp: new LspClient({ baseUrl }), merchantPubkey,
 *       proveLinkage: makeLinkedProver({ zkeyPath: "./linkage.zkey", wasmPath: "./linkage.wasm" }),
 *     });
 *
 * The proof is three group elements, so **the LSP cannot tell which prover produced it**. Point `proverPath` at
 * any circom-compatible Groth16 prover with the conventional CLI:
 *
 *     <prover> <circuit.zkey> <witness.wtns> <proof.json> <public.json>
 *
 * Both `ark-circom` (see `tools/linkage-prover`) and `rapidsnark` satisfy it.
 *
 * Nothing here is required for `same_hash` JIT, which needs no proof at all.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  dualSha256,
  groth16DualSha256Proof,
  hashToLimbSignals,
  type LinkageProof,
} from "@fiberlsp/protocol";
import { calculateWtnsBin } from "./witnessCalculator.js";

export { calculateWtnsBin, type CircomInput } from "./witnessCalculator.js";

export interface LinkedProverConfig {
  /**
   * The proving key: either the ceremony `.zkey` or a converted `.ark` (auto-detected). Both work; the `.ark`
   * proves ~7× faster in the wasm backend because it skips the snarkjs-format parse (15 s → 2 s). Must be the
   * matched pair of the LSP's `verification_key.json`.
   */
  zkeyPath: string;
  /** The circuit's compiled `.wasm`. Only the wasm is needed — not circom's emitted `witness_calculator.js`. */
  wasmPath: string;
  /**
   * Which prover to run. `wasm` (default) proves in-process with the bundled WebAssembly prover — no binary to
   * install, pure `npm i`. `native` shells out to a Groth16 binary (faster, ~0.12 s) for anyone who wants it.
   */
  backend?: "wasm" | "native";
  /**
   * The Groth16 prover binary, used only when `backend: "native"`. Defaults to `$FIBERLSP_LINKED_PROVER`, else
   * `linkage-prover` on `PATH`. Must accept `<zkey> <wtns> <proof.json> <public.json>`.
   */
  proverPath?: string;
  /**
   * Convert the `.zkey` to the prover's native form once, then reuse it. Loading a `.zkey` revalidates every
   * curve point, which costs ~4× a proof; the cache pays that once. The converted key is written beside the
   * `.zkey` (or in `cacheDir`) and keyed to its SHA-256, so replacing the `.zkey` invalidates it automatically.
   *
   * Only `linkage-prover` understands the converted format. Set `false` for `rapidsnark` or any other prover.
   * Default `true`.
   */
  cache?: boolean;
  /** Where the converted key lives. Default: alongside `zkeyPath`. */
  cacheDir?: string;
  /** Seconds before a hung prover is killed. Default 120. */
  timeoutSeconds?: number;
  /** Where scratch files go. Default the OS temp dir. */
  tmpDir?: string;
}

export class LinkedProverError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "LinkedProverError";
  }
}

/** Build the circuit's input map for a 32-byte secret. Exported so a caller can drive a prover directly. */
export function linkageWitnessInput(secretHex: string): {
  secret: number[];
  hold_hi: string;
  hold_lo: string;
  leg_hi: string;
  leg_lo: string;
} {
  const h = secretHex.startsWith("0x") ? secretHex.slice(2) : secretHex;
  if (h.length !== 64 || !/^[0-9a-fA-F]+$/.test(h)) throw new Error("secret must be a 32-byte hex string");
  const { hold, leg } = dualSha256("0x" + h);
  const [hold_hi, hold_lo] = hashToLimbSignals(hold);
  const [leg_hi, leg_lo] = hashToLimbSignals(leg);
  const secret = Array.from({ length: 32 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16));
  return { secret, hold_hi, hold_lo, leg_hi, leg_lo };
}

/** The bundled WebAssembly prover (arkworks, compiled from `tools/linkage-prover`). Loaded once, on first use. */
interface WasmProver {
  prove_wasm(zkey: Uint8Array, wtns: Uint8Array): string;
}
let wasmProverCache: WasmProver | undefined;
function wasmProver(): WasmProver {
  // wasm-bindgen emits CommonJS (`--target nodejs`); load it from this ESM module and let it read its own
  // sibling `.wasm`. The glue + wasm ship inside the package (see `files`), so this needs no external download.
  wasmProverCache ??= createRequire(import.meta.url)("../wasm/linkage_prover.cjs") as WasmProver;
  return wasmProverCache;
}

/** Check the prover's public signals against the order's hashes, then wrap. A mismatch means the artifacts or
 *  the secret disagree, and the LSP would reject the proof anyway. */
function bindAndWrap(proof: unknown, publicSignals: string[], holdHash: string, legHash: string): LinkageProof {
  const expected = [...hashToLimbSignals(holdHash), ...hashToLimbSignals(legHash)];
  if (publicSignals.length !== expected.length) {
    throw new LinkedProverError("public_signal_count", `prover emitted ${publicSignals.length} public signals`);
  }
  for (let i = 0; i < expected.length; i++) {
    if (BigInt(publicSignals[i]!).toString(10) !== expected[i]) {
      throw new LinkedProverError(
        "public_signal_mismatch",
        "the proof's public signals do not match this order's hashes — check the key matches the circuit",
      );
    }
  }
  return groth16DualSha256Proof({ proof, publicSignals });
}

/**
 * A `proveLinkage` hook for `JitCheckout`. Generates the witness in-process and proves it, returning the wrapped
 * proof. Defaults to the bundled wasm prover (no binary to install); pass `backend: "native"` to shell out.
 */
export function makeLinkedProver(
  cfg: LinkedProverConfig,
): (holdHash: string, legHash: string, secretHex: string) => Promise<LinkageProof> {
  if ((cfg.backend ?? "wasm") === "native") return makeNativeLinkedProver(cfg);

  return async (holdHash, legHash, secretHex) => {
    const [wasm, key] = await Promise.all([readFile(cfg.wasmPath), readFile(cfg.zkeyPath)]);
    const wtns = await calculateWtnsBin(wasm, linkageWitnessInput(secretHex));
    let out: { proof: unknown; publicSignals: string[] };
    try {
      out = JSON.parse(wasmProver().prove_wasm(key, wtns)) as typeof out;
    } catch (e) {
      throw new LinkedProverError("prover_failed", `wasm prover failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return bindAndWrap(out.proof, out.publicSignals, holdHash, legHash);
  };
}

/** The native-binary prover: converts the `.zkey` once, caches it, then shells out per proof. */
function makeNativeLinkedProver(
  cfg: LinkedProverConfig,
): (holdHash: string, legHash: string, secretHex: string) => Promise<LinkageProof> {
  const prover = cfg.proverPath ?? process.env.FIBERLSP_LINKED_PROVER ?? "linkage-prover";
  const timeoutMs = (cfg.timeoutSeconds ?? 120) * 1000;
  const wantCache = cfg.cache ?? true;
  let keyPromise: Promise<string> | undefined;

  /** The key to prove against: the converted cache when enabled, else the `.zkey` itself. Resolved once. */
  const provingKey = (): Promise<string> => {
    if (!wantCache) return Promise.resolve(cfg.zkeyPath);
    keyPromise ??= ensureConvertedKey(cfg, prover, timeoutMs).catch((e: unknown) => {
      // A cache is an optimisation, never a requirement: fall back to the .zkey and say why.
      keyPromise = undefined;
      console.warn(
        `[prover-linked] could not convert the proving key (${e instanceof Error ? e.message : String(e)}); ` +
          `proving from the .zkey, which revalidates every curve point and is roughly 4x slower`,
      );
      return cfg.zkeyPath;
    });
    return keyPromise;
  };

  return async (holdHash, legHash, secretHex) => {
    const wasm = await readFile(cfg.wasmPath);
    const wtns = await calculateWtnsBin(wasm, linkageWitnessInput(secretHex));
    const keyPath = await provingKey();

    const dir = await mkdtemp(join(cfg.tmpDir ?? tmpdir(), "fiberlsp-prove-"));
    try {
      const wtnsPath = join(dir, "witness.wtns");
      const proofPath = join(dir, "proof.json");
      const publicPath = join(dir, "public.json");
      await writeFile(wtnsPath, wtns);
      try {
        await run(prover, [keyPath, wtnsPath, proofPath, publicPath], timeoutMs);
      } catch (e) {
        // The cache is derived state. If it is corrupt or was written by an incompatible build, discard it and
        // rebuild from the .zkey rather than failing an order the merchant could otherwise have served.
        if (keyPath === cfg.zkeyPath) throw e;
        await rm(keyPath, { force: true });
        keyPromise = undefined;
        await run(prover, [await provingKey(), wtnsPath, proofPath, publicPath], timeoutMs);
      }

      const proof = JSON.parse(await readFile(proofPath, "utf8")) as unknown;
      const publicSignals = JSON.parse(await readFile(publicPath, "utf8")) as string[];

      const expected = [...hashToLimbSignals(holdHash), ...hashToLimbSignals(legHash)];
      if (publicSignals.length !== expected.length) {
        throw new LinkedProverError("public_signal_count", `prover emitted ${publicSignals.length} public signals`);
      }
      for (let i = 0; i < expected.length; i++) {
        if (BigInt(publicSignals[i]!).toString(10) !== expected[i]) {
          throw new LinkedProverError(
            "public_signal_mismatch",
            "the proof's public signals do not match this order's hashes — check the .zkey matches the circuit",
          );
        }
      }
      return groth16DualSha256Proof({ proof, publicSignals });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/**
 * Convert the `.zkey` into the prover's native form, once, and return the path.
 *
 * The cache filename embeds the `.zkey`'s SHA-256, so a rotated key never reuses a stale cache — and so two
 * keys can coexist. Conversion is atomic: write to a temp name, then rename, so a crash mid-convert cannot
 * leave a truncated file that a later run would trust.
 */
async function ensureConvertedKey(cfg: LinkedProverConfig, prover: string, timeoutMs: number): Promise<string> {
  const digest = await sha256File(cfg.zkeyPath);
  const dir = cfg.cacheDir ?? dirname(resolve(cfg.zkeyPath));
  const cached = join(dir, `${basename(cfg.zkeyPath, ".zkey")}.${digest.slice(0, 16)}.ark`);

  try {
    await stat(cached);
    return cached;
  } catch {
    /* not converted yet */
  }
  const partial = `${cached}.${process.pid}.partial`;
  await run(prover, ["convert", cfg.zkeyPath, partial], timeoutMs);
  await rename(partial, cached);
  return cached;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve_, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve_(hash.digest("hex")));
  });
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new LinkedProverError("prover_timeout", `${cmd} did not finish within ${timeoutMs} ms`));
    }, timeoutMs);

    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(
        new LinkedProverError(
          "prover_not_found",
          `could not run "${cmd}" (${e.message}). Set proverPath or FIBERLSP_LINKED_PROVER.`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new LinkedProverError("prover_failed", `${cmd} exited ${code}: ${stderr.trim()}`));
    });
  });
}
