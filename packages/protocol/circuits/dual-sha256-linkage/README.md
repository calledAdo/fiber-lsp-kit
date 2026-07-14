# Dual-SHA256 linkage circuit

Groth16 circuit used only by single-LSP-node `linked` JIT. A two-node `same_hash` deployment needs no circuit,
proof artifact, or setup.

## Statement

Given public hold hash `A` and merchant payment hash `B`, prove knowledge of a private 32-byte `S`:

```text
B = sha256(S)             merchant invoice; preimage = S
A = sha256(poseidon(S))   hold invoice; preimage = poseidon(S)
```

Both invoice hashes are SHA-256 because that is the FNN invoice/TLC boundary. Poseidon is only an internal,
deterministic derivation that keeps the circuit below the `2^16` domain; it is not relied on as the invoice
hash or as an independently exposed security claim.

The two hashes are public as four BN254 field elements: 128-bit big-endian high/low limbs for each hash. This
keeps `nPublic = 4` instead of exposing 512 public bits and inflating the verification key.

The circuit currently compiles to 59,771 constraints. The JavaScript derivation in
`@fiberlsp/protocol` and `poseidon.circom` must remain byte-identical.

## Release artifacts

Generated artifacts are release assets, not Git-tracked source. Current measured sizes:

| File | Role | Compressed transfer | Unpacked | Notes |
|---|---|---:|---:|---|
| `verification_key.json` | LSP | 3.4 KiB | 3.4 KiB | Groth16 verification key |
| `linkage.ark.gz` | merchant default | 16.14 MiB | 34.26 MiB | deterministic fast-load cache |
| `linkage.zkey.gz` | ceremony/audit and fallback | 16.49 MiB | 34.48 MiB | canonical ceremony proving key |
| `linkage.wasm` | merchant witness generation | 2.16 MiB | 2.16 MiB | compiled circuit |

The default deployed merchant downloads `.ark.gz + linkage.wasm`: about **18.3 MiB transferred** and
**36.4 MiB unpacked**. The `.zkey + linkage.wasm` path is about **18.7 MiB transferred** and **36.7 MiB
unpacked**. A merchant does not need both proving-key forms at runtime.

The bundled proving engine is a separate approximately 0.62 MiB WebAssembly file shipped inside
`@fiberlsp/prover-linked`; it is not `linkage.wasm`. The latter calculates the circuit witness.

| Backend/key | Typical measured proof time | Installation |
|---|---:|---|
| bundled WebAssembly + `.ark` | ~2 s | package install only |
| bundled WebAssembly + `.zkey` | ~15 s | package install only; format parsing dominates |
| native subprocess | ~0.12 s plus key load | `linkage-prover` or compatible binary |

Timings are hardware-specific. The native path is subsecond; the deployed WebAssembly default is not. All
backends emit the same Groth16 proof/public-signal format.

The `.ark` is deterministically converted from the `.zkey`. It is a cache, not a separate trust root. The
`.zkey`, circuit R1CS, public Powers of Tau, contribution transcript, and verification key remain the auditable
chain.

## Repository policy

The repository commits source and instructions. It ignores:

- `build/` and witness files;
- `.ptau`, `.zkey`, `.ark`, `.r1cs`, and generated circuit WASM;
- proof/public-signal JSON and `verification_key.json`.

The linked demo uses a local matched build when present, otherwise it downloads release artifacts and verifies
`SHA256SUMS`. The same-hash demo performs no download.

## Build and development setup

Use a Circom 2 compiler binary. The deprecated `circom` npm package is Circom 0.5 and cannot parse this circuit.

```bash
cd packages/protocol/circuits/dual-sha256-linkage
mkdir -p build && cd build
curl -O https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_16.ptau
# sha256: 1c401abb57c9ce531370f3015c3e75c0892e0f32b8b1e94ace0f6682d9695922
cd ..

SETUP="npx --yes snarkjs@0.7.6"
circom dual_sha256_linkage.circom --r1cs --wasm --sym -l ../../../../node_modules -o build
$SETUP r1cs info build/dual_sha256_linkage.r1cs
$SETUP groth16 setup \
  build/dual_sha256_linkage.r1cs \
  build/powersOfTau28_hez_final_16.ptau \
  build/dual_sha256_linkage_0000.zkey
$SETUP zkey contribute \
  build/dual_sha256_linkage_0000.zkey \
  build/dual_sha256_linkage_final.zkey \
  --name="development"
$SETUP zkey export verificationkey \
  build/dual_sha256_linkage_final.zkey \
  build/verification_key.json
$SETUP zkey verify \
  build/dual_sha256_linkage.r1cs \
  build/powersOfTau28_hez_final_16.ptau \
  build/dual_sha256_linkage_final.zkey
```

This phase 2 has one development contribution. `zkey verify` proves derivation and contribution-chain
consistency; it cannot prove that toxic waste was destroyed. Do not protect real funds with this key. Production
replacement is described in [`docs/CEREMONY.md`](../../../../docs/CEREMONY.md).

Phase 1 uses the public Perpetual Powers of Tau. Do not generate a private phase 1.

## Manual witness and proof

`@fiberlsp/prover-linked` normally performs these steps in-process. For a manual audit:

```bash
node ../../../../scripts/linkage-witness-input.mjs 0x<64-hex-character-secret> > input.json

# Generated witness code is CommonJS inside a type:module package.
echo '{ "type": "commonjs" }' > build/dual_sha256_linkage_js/package.json
node build/dual_sha256_linkage_js/generate_witness.js \
  build/dual_sha256_linkage_js/dual_sha256_linkage.wasm \
  input.json \
  witness.wtns
```

Then run any compatible Groth16 prover. For example:

```bash
prover build/dual_sha256_linkage_final.zkey witness.wtns proof.json public.json
```

The public signal order is:

```text
hold_hi, hold_lo, merchant_hash_hi, merchant_hash_lo
```

The LSP verifies those values with `verifyGroth16Bn254` from `@fiberlsp/protocol` and
`verification_key.json`. Runtime verification uses `@noble/curves`; neither merchant nor LSP needs `snarkjs`
outside setup/audit work.
