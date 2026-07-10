/**
 * The witness calculator is a port of circom's emitted `witness_calculator.js`. The only test that means
 * anything is that it produces the *same bytes* — a subtly different witness still proves, but proves a
 * different statement, and the LSP's public-signal check would reject it after the merchant paid for a proof.
 *
 * These tests need the built circuit, which is gitignored. They skip when it is absent rather than fail, so a
 * fresh clone still runs green; see `packages/protocol/circuits/dual-sha256-linkage/README.md` to build it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { calculateWtnsBin, linkageWitnessInput } from "@fiberlsp/prover-linked";
import { dualSha256 } from "@fiberlsp/protocol";

const here = dirname(fileURLToPath(import.meta.url));
const BUILD = resolve(here, "../../protocol/circuits/dual-sha256-linkage/build");
const WASM = join(BUILD, "dual_sha256_linkage_js/dual_sha256_linkage.wasm");
const GEN = join(BUILD, "dual_sha256_linkage_js/generate_witness.js");
const MARKER = join(BUILD, "dual_sha256_linkage_js/package.json");

const SECRET = "0x12d1a3c77b48d23f5f2472f83b065db19f5122ed8680abe947c1b70484164c09";
const haveCircuit = existsSync(WASM);

test("linkageWitnessInput derives the circuit's public signals from the secret", () => {
  const input = linkageWitnessInput(SECRET);
  const { hold, leg } = dualSha256(SECRET);
  assert.equal(input.secret.length, 32);
  assert.equal(BigInt(input.hold_hi), BigInt("0x" + hold.slice(2, 34)));
  assert.equal(BigInt(input.hold_lo), BigInt("0x" + hold.slice(34)));
  assert.equal(BigInt(input.leg_hi), BigInt("0x" + leg.slice(2, 34)));
  assert.equal(BigInt(input.leg_lo), BigInt("0x" + leg.slice(34)));
});

test("linkageWitnessInput rejects a secret that is not 32 bytes", () => {
  assert.throws(() => linkageWitnessInput("0x" + "11".repeat(31)), /32-byte/);
  assert.throws(() => linkageWitnessInput("not hex"), /32-byte/);
});

test(
  "the witness is byte-identical to the one circom's own generator produces",
  { skip: haveCircuit ? false : "circuit not built" },
  async () => {
    const ours = await calculateWtnsBin(readFileSync(WASM), linkageWitnessInput(SECRET));

    const dir = mkdtempSync(join(tmpdir(), "wtns-"));
    try {
      // circom's generator is CommonJS inside a "type": "module" package — the marker is exactly the friction
      // this port removes, but we need it here to produce the reference output.
      const hadMarker = existsSync(MARKER);
      if (!hadMarker) writeFileSync(MARKER, '{ "type": "commonjs" }');
      writeFileSync(join(dir, "input.json"), JSON.stringify(linkageWitnessInput(SECRET)));
      execFileSync(process.execPath, [GEN, WASM, join(dir, "input.json"), join(dir, "ref.wtns")]);
      if (!hadMarker) rmSync(MARKER);

      const reference = readFileSync(join(dir, "ref.wtns"));
      assert.equal(ours.length, reference.length, "witness length");
      assert.ok(Buffer.from(ours).equals(reference), "witness bytes differ from circom's generator");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a wrong input produces a different witness (the comparison above is not vacuous)",
  { skip: haveCircuit ? false : "circuit not built" },
  async () => {
    const a = await calculateWtnsBin(readFileSync(WASM), linkageWitnessInput(SECRET));
    const b = await calculateWtnsBin(readFileSync(WASM), linkageWitnessInput("0x" + "22".repeat(32)));
    assert.ok(!Buffer.from(a).equals(Buffer.from(b)));
  },
);

test(
  "an input the circuit cannot satisfy is rejected, not silently mis-proven",
  { skip: haveCircuit ? false : "circuit not built" },
  async () => {
    // hold_hi does not match sha256(poseidon(secret)): the circuit's constraint fails during witness generation.
    const bad = { ...linkageWitnessInput(SECRET), hold_hi: "1" };
    await assert.rejects(calculateWtnsBin(readFileSync(WASM), bad), /Assert Failed/);
  },
);

test(
  "a missing input signal is reported by name",
  { skip: haveCircuit ? false : "circuit not built" },
  async () => {
    const { hold_hi: _drop, ...missing } = linkageWitnessInput(SECRET);
    await assert.rejects(calculateWtnsBin(readFileSync(WASM), missing), /input signals were set/);
  },
);
