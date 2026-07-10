# Dual-SHA256 linkage circuit (Groth16)

Trustless single-node JIT linkage proof without blake2b circuits, with both invoice preimages kept to the
32 bytes a live FNN node accepts (a `Hash256`): the domain-tagged value is hashed down to 32 bytes rather
than fed into the invoice raw.

## Statement

Given public hold hash `A` and leg hash `B`, prove knowledge of a 32-byte secret `S`:

```
B = sha256(S)                                    (leg invoice; preimage = S)
A = sha256(sha256("LSPS-FIBER/JIT/HOLD\0" || S)) (hold invoice; preimage = sha256(TAG||S))
```

The tag is essential: without it the hold preimage would be `sha256(S) = B`, which is public, letting anyone
settle the customer hold. Paying the leg reveals `S`, from which the LSP derives the 32-byte hold preimage.

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

You do not need to build this circuit to run the normal demo (`npm run demo`) or inspect the JIT protocol.
Who needs which artifact, what trust each carries, and why to ship them as Release assets (not in git) are in
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
limbs (`hold_hi, hold_lo, leg_hi, leg_lo`), matching `hashToLimbSignals()` in the protocol package. Exposing
256 bit-signals per hash instead would put `nPublic` at 512, inflating the verification key (its `IC` carries
`nPublic + 1` group elements) and making verification a 513-point multi-scalar multiplication.

## Build

The circuit compiles to 88,457 constraints (three SHA-256 blocks), so `2^17` is the smallest usable
power-of-tau size.

**Do not generate your own phase 1.** Download the public [Perpetual Powers of
Tau](https://github.com/privacy-scaling-explorations/perpetualpowersoftau) — many independent contributors and
a public transcript — so no phase-1 secret is yours to hold:

```bash
cd packages/protocol/circuits/dual-sha256-linkage
mkdir -p build && cd build
curl -O https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_17.ptau
# sha256: 6b662a324867139fb1a20a324d90b6ff61856dfb23f59326909f14b0e2483ae0
cd ..

SNARK=../../../../node_modules/.bin/snarkjs
circom dual_sha256_linkage.circom --r1cs --wasm --sym -l ../../../../node_modules -o build
$SNARK r1cs info build/dual_sha256_linkage.r1cs
$SNARK groth16 setup build/dual_sha256_linkage.r1cs build/powersOfTau28_hez_final_17.ptau build/dual_sha256_linkage_0000.zkey
$SNARK zkey contribute build/dual_sha256_linkage_0000.zkey build/dual_sha256_linkage_final.zkey --name="dev" -e="replace-this-randomness"
$SNARK zkey export verificationkey build/dual_sha256_linkage_final.zkey build/verification_key.json

# anyone can check the key derives from this circuit + this ptau, and that the contribution chain is intact:
$SNARK zkey verify build/dual_sha256_linkage.r1cs build/powersOfTau28_hez_final_17.ptau build/dual_sha256_linkage_final.zkey
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
../../../../node_modules/.bin/snarkjs wtns calculate build/dual_sha256_linkage_js/dual_sha256_linkage.wasm input.json witness.wtns
../../../../node_modules/.bin/snarkjs groth16 prove build/dual_sha256_linkage_final.zkey witness.wtns proof.json public.json
../../../../node_modules/.bin/snarkjs groth16 verify build/verification_key.json public.json proof.json
```

Post the proof to the LSP as:

```json
{
  "scheme": "groth16-dual-sha256",
  "data": "{\"proof\":...,\"publicSignals\":[...]}"
}
```

Set `LINKED_JIT_VK_PATH=build/verification_key.json` on the reference server to enable verification.

## Public signals

`public.json` is 512 bit signals: the 256 big-endian bits of `hold_hash`, followed by the 256 big-endian bits of `leg_hash`. This is the same encoding as `hashToBitSignals()` in the protocol package.
