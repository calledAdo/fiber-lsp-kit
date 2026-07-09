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

Judges do not need to build this circuit to run the normal demo (`npm run demo`) or inspect the JIT protocol.
Production deployments should publish audited release artifacts separately: the merchant needs the proving
runtime plus `.wasm` and final `.zkey`, while the LSP needs the matching `verification_key.json`. Who needs
which file, what trust each carries, and why to ship them as Release assets (not in git) are in
[`../../../../docs/zk-artifacts.md`](../../../../docs/zk-artifacts.md).

## Prerequisites

Use a Circom 2 compiler binary. Do not use the deprecated `circom` npm package; it is Circom 0.5 and cannot
parse this circuit.

```bash
circom --version
npm install
```

## Build

These commands are for a development setup only. A production verifier should come from a real ceremony.
This circuit compiles to 88,949 constraints (three SHA-256 blocks), so `pot17` is the smallest usable
power-of-tau size.

```bash
cd packages/protocol/circuits/dual-sha256-linkage
mkdir -p build
circom dual_sha256_linkage.circom --r1cs --wasm --sym -l ../../../../node_modules -o build
../../../../node_modules/.bin/snarkjs r1cs info build/dual_sha256_linkage.r1cs
../../../../node_modules/.bin/snarkjs powersoftau new bn128 17 build/pot17_0000.ptau -v
../../../../node_modules/.bin/snarkjs powersoftau contribute build/pot17_0000.ptau build/pot17_0001.ptau --name="dev" -v -e="replace-this-randomness"
../../../../node_modules/.bin/snarkjs powersoftau prepare phase2 build/pot17_0001.ptau build/pot17_final.ptau -v
../../../../node_modules/.bin/snarkjs groth16 setup build/dual_sha256_linkage.r1cs build/pot17_final.ptau build/dual_sha256_linkage_0000.zkey
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
  "scheme": "groth16-dual-sha256",
  "data": "{\"proof\":...,\"publicSignals\":[...]}"
}
```

Set `LINKED_JIT_VK_PATH=build/verification_key.json` on the reference server to enable verification.

## Public signals

`public.json` is 512 bit signals: the 256 big-endian bits of `hold_hash`, followed by the 256 big-endian bits of `leg_hash`. This is the same encoding as `hashToBitSignals()` in the protocol package.
