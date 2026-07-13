# Dual-SHA256 linkage circuit (Groth16)

Single-node JIT linkage proof without blake2b circuits, with both invoice preimages kept to the 32 bytes a
live FNN node accepts (a `Hash256`).

## Statement

Given public hold hash `A` and merchant payment hash `B`, prove knowledge of a 32-byte secret `S`:

```
B = sha256(S)              (merchant invoice; preimage = S)
A = sha256(poseidon(S))    (hold invoice; preimage = poseidon(S))
```

Paying the merchant invoice reveals `S`, from which the LSP derives the 32-byte hold preimage. Only the two *invoice* hashes
must be SHA-256 (FNN computes `payment_hash` that way); the derivation carries no security weight, since
reaching `hold_preimage` means inverting a SHA-256. Poseidon is used because it costs ~250 constraints instead
of ~30k, halving the FFT domain and the proving key. It only has to be deterministic and distinct from
`sha256(S)`, or the hold preimage would equal the public merchant payment hash.

Matches `@fiberlsp/protocol` `linkageDualSha256.ts` (`scheme: groth16-dual-sha256`).

## Repository policy

The repo commits the circuit source and instructions only. Generated proving artifacts are intentionally not
tracked:

- `build/`
- `.ptau`
- `.zkey`
- witness files
- proof/public signal JSON
- `verification_key.json`

You do not need to build this circuit to run the same-hash demo. The linked demo (`npm run demo:linked:e2e`)
uses a local build when present and otherwise downloads the versioned release artifacts with checksum
verification. Who needs which artifact, what trust each carries, and why to ship them as Release assets are in
[`ARCHITECTURE.md` § Artifact distribution](../../../../docs/ARCHITECTURE.md#artifact-distribution).

## Prerequisites

Use a Circom 2 compiler binary. Do not use the deprecated `circom` npm package; it is Circom 0.5 and cannot
parse this circuit.

```bash
circom --version
npm install
```

## Public inputs

The two hashes are exposed as **four** field elements — each 256-bit hash split into two 128-bit big-endian
limbs (`hold_hi, hold_lo, merchant_hash_hi, merchant_hash_lo`), matching `hashToLimbSignals()` in the protocol package. Exposing
256 bit-signals per hash instead would put `nPublic` at 512, inflating the verification key (its `IC` carries
`nPublic + 1` group elements) and making verification a 513-point multi-scalar multiplication.

## Build

The circuit compiles to 59,771 constraints (two SHA-256 blocks + a Poseidon), so `2^16` is the smallest
usable power-of-tau size.

**Do not generate your own phase 1.** Download the public [Perpetual Powers of
Tau](https://github.com/privacy-scaling-explorations/perpetualpowersoftau) — many independent contributors and
a public transcript — so no phase-1 secret is yours to hold:

```bash
cd packages/protocol/circuits/dual-sha256-linkage
mkdir -p build && cd build
curl -O https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_16.ptau
# sha256: 1c401abb57c9ce531370f3015c3e75c0892e0f32b8b1e94ace0f6682d9695922
cd ..

# The setup toolchain is a build-time dependency only — the kit itself ships no proof-system library.
SETUP="npx --yes snarkjs@0.7.6"
circom dual_sha256_linkage.circom --r1cs --wasm --sym -l ../../../../node_modules -o build
$SETUP r1cs info build/dual_sha256_linkage.r1cs
$SETUP groth16 setup build/dual_sha256_linkage.r1cs build/powersOfTau28_hez_final_16.ptau build/dual_sha256_linkage_0000.zkey
$SETUP zkey contribute build/dual_sha256_linkage_0000.zkey build/dual_sha256_linkage_final.zkey --name="dev"
$SETUP zkey export verificationkey build/dual_sha256_linkage_final.zkey build/verification_key.json

# anyone can check the key derives from this circuit + this ptau, and that the contribution chain is intact:
$SETUP zkey verify build/dual_sha256_linkage.r1cs build/powersOfTau28_hez_final_16.ptau build/dual_sha256_linkage_final.zkey
```

> **Phase 2 above is a single contribution and is development-only.** Groth16 needs a *circuit-specific* phase
> 2, and its soundness requires at least one contributor to have destroyed their entropy. `zkey verify` proves
> derivation and the contribution chain — it cannot prove anyone deleted anything, and neither can a
> reproducible build. For production, run a multi-party phase 2 (`zkey contribute` per independent contributor,
> each publishing an attestation) and finalise with `zkey beacon` against a public unpredictable value. See
> [`ARCHITECTURE.md` § Trust model](../../../../docs/ARCHITECTURE.md#trust-model).

## Witness input (`input.json`)

Use `scripts/linkage-witness-input.mjs` (repo root) to generate `input.json` from a secret hex string:

```bash
node ../../../../scripts/linkage-witness-input.mjs 0x<64-char-secret-hex> > input.json

# circom's generated witness calculator is CommonJS, but it lands inside a package whose package.json sets
# "type": "module". Mark the generated directory once, after building the circuit:
echo '{ "type": "commonjs" }' > build/dual_sha256_linkage_js/package.json

# Witness: circom emits a dependency-free calculator alongside the .wasm. No proof library needed.
node build/dual_sha256_linkage_js/generate_witness.js \
  build/dual_sha256_linkage_js/dual_sha256_linkage.wasm input.json witness.wtns
```

Then prove with whichever Groth16 prover you run. The proof is three group elements — the LSP cannot tell which
implementation produced it, and does not care.
[`ark-circom`](https://github.com/arkworks-rs/circom-compat) is the default (pure Rust, no native dependencies);
[`rapidsnark`](https://github.com/iden3/rapidsnark) is faster and leaner but needs `gmp` and `nasm` to build:

```bash
# rapidsnark, for example:
prover build/dual_sha256_linkage_final.zkey witness.wtns proof.json public.json
```

Verify locally with `verifyGroth16Bn254` from `@fiberlsp/protocol` — the same pairing check the LSP runs, over
`@noble/curves`, needing only `verification_key.json`.

Post the proof to the LSP as:

```json
{
  "scheme": "groth16-dual-sha256",
  "data": "{\"proof\":...,\"publicSignals\":[...]}"
}
```

The repository example accepts `LINKED_JIT_VK_PATH=build/verification_key.json`; package users inject the
resulting linkage verifier directly into `JitService`.

## Public signals

`public.json` is four field elements — `hold_hi, hold_lo, merchant_hash_hi, merchant_hash_lo` — the same encoding as
`hashToLimbSignals()` in the protocol package (see *Public inputs*, above).
