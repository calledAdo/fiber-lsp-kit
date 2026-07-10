/**
 * @fiberlsp/prover-linked — the merchant side of `linked` JIT, as one function.
 *
 * `JitCheckout` needs a `proveLinkage` hook. Building one by hand means generating a witness, shelling out to a
 * Groth16 prover, parsing its output, and binding the public signals to the order's hashes. This package does
 * all of that:
 *
 *     const jit = new JitCheckout({
 *       ...,
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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dualSha256,
  groth16DualSha256Proof,
  hashToLimbSignals,
  type LinkageProof,
} from "@fiberlsp/protocol";
import { calculateWtnsBin } from "./witnessCalculator.js";

export { calculateWtnsBin, type CircomInput } from "./witnessCalculator.js";

export interface LinkedProverConfig {
  /** The `.zkey` from the ceremony. Must be the matched pair of the LSP's `verification_key.json`. */
  zkeyPath: string;
  /** The circuit's compiled `.wasm`. Only the wasm is needed — not circom's emitted `witness_calculator.js`. */
  wasmPath: string;
  /**
   * The Groth16 prover binary. Defaults to `$FIBERLSP_LINKED_PROVER`, else `linkage-prover` on `PATH`.
   * Must accept `<zkey> <wtns> <proof.json> <public.json>`.
   */
  proverPath?: string;
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

/**
 * A `proveLinkage` hook for `JitCheckout`. Generates the witness in-process, runs the prover, and returns the
 * wrapped proof. The public signals the prover emits are checked against the order's hashes before the proof is
 * handed back — a mismatch here means the artifacts or the secret disagree, and the LSP would reject it anyway.
 */
export function makeLinkedProver(
  cfg: LinkedProverConfig,
): (holdHash: string, legHash: string, secretHex: string) => Promise<LinkageProof> {
  const prover = cfg.proverPath ?? process.env.FIBERLSP_LINKED_PROVER ?? "linkage-prover";
  const timeoutMs = (cfg.timeoutSeconds ?? 120) * 1000;

  return async (holdHash, legHash, secretHex) => {
    const wasm = await readFile(cfg.wasmPath);
    const wtns = await calculateWtnsBin(wasm, linkageWitnessInput(secretHex));

    const dir = await mkdtemp(join(cfg.tmpDir ?? tmpdir(), "fiberlsp-prove-"));
    try {
      const wtnsPath = join(dir, "witness.wtns");
      const proofPath = join(dir, "proof.json");
      const publicPath = join(dir, "public.json");
      await writeFile(wtnsPath, wtns);
      await run(prover, [cfg.zkeyPath, wtnsPath, proofPath, publicPath], timeoutMs);

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
