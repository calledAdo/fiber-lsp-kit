# Dual-SHA256 linkage circuit (Groth16)

Trustless single-node JIT linkage proof without blake2b circuits.

## Statement

Given public hold hash `A` and leg hash `B`, prove knowledge of 32-byte secret `S`:

```
A = sha256("LSPS-FIBER/JIT/HOLD/v1\0" || S)
B = sha256("LSPS-FIBER/JIT/LEG/v1\0"  || S)
```

Matches `@fiberlsp/protocol` `linkageDualSha256.ts` (`scheme: groth16-dual-sha256-v1`).

## Prerequisites

Use a Circom 2 compiler binary. Do not use the deprecated `circom` npm package; it is Circom 0.5 and cannot
parse this circuit.

```bash
circom --version
npm install
```

## Build

These commands are for a development setup only. A production verifier should come from a real ceremony.
This circuit currently compiles to 59,600 constraints, so `pot16` is the smallest usable power-of-tau size.

```bash
cd packages/protocol/circuits/dual-sha256-linkage
mkdir -p build
circom dual_sha256_linkage.circom --r1cs --wasm --sym -l ../../../../node_modules -o build
../../../../node_modules/.bin/snarkjs r1cs info build/dual_sha256_linkage.r1cs
../../../../node_modules/.bin/snarkjs powersoftau new bn128 16 build/pot16_0000.ptau -v
../../../../node_modules/.bin/snarkjs powersoftau contribute build/pot16_0000.ptau build/pot16_0001.ptau --name="dev" -v -e="replace-this-randomness"
../../../../node_modules/.bin/snarkjs powersoftau prepare phase2 build/pot16_0001.ptau build/pot16_final.ptau -v
../../../../node_modules/.bin/snarkjs groth16 setup build/dual_sha256_linkage.r1cs build/pot16_final.ptau build/dual_sha256_linkage_0000.zkey
../../../../node_modules/.bin/snarkjs zkey contribute build/dual_sha256_linkage_0000.zkey build/dual_sha256_linkage_final.zkey --name="dev" -v -e="replace-this-randomness-too"
../../../../node_modules/.bin/snarkjs zkey export verificationkey build/dual_sha256_linkage_final.zkey build/verification_key.json
```

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
  "scheme": "groth16-dual-sha256-v1",
  "data": "{\"proof\":...,\"publicSignals\":[...]}"
}
```

Set `LINKED_JIT_VK_PATH=build/verification_key.json` on the reference server to enable verification.

## Public signals

`public.json` is 512 bit signals: the 256 big-endian bits of `hold_hash`, followed by the 256 big-endian bits of `leg_hash`. This is the same encoding as `hashToBitSignals()` in the protocol package.
