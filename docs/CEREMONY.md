# Phase-2 ceremony for the JIT linkage key

The LSP verifies a Groth16 proof before it opens a channel and pays a merchant. If the proving key's setup
secret survives, someone can forge a proof for two *unlinked* hashes — the LSP then pays the merchant leg and
cannot settle the customer hold. That is a direct loss, so the key's provenance is the LSP's security.

This document is how the key gets a provenance worth trusting.

## What is and is not already handled

**Phase 1 is done.** The build uses the **public Perpetual Powers of Tau** (`powersOfTau28_hez_final_16.ptau`),
which has many independent contributors and a published transcript. No phase-1 secret is ours.

**Phase 2 is not.** Groth16 needs a *circuit-specific* second phase, and the key shipped in this repo has a
single contribution — ours. **It must not be trusted with real funds.**

Two things that do **not** fix this, and are easy to mistake for fixes:

- **A reproducible build.** Re-deriving the artifacts proves the `.zkey` and vk match the published circuit. It
  rules out a backdoored circuit. It says nothing about whether the setup's secret was destroyed, because that
  secret is never a build input — the same artifacts appear whether or not anyone kept it.
- **`snarkjs zkey verify`.** It proves the key derives from this circuit and this ptau, and that the
  contribution chain is intact. It cannot prove anyone deleted anything.

Both are necessary. Neither is sufficient. Only the ceremony below is.

## The security property

Each contributor mixes in entropy only they know, then destroys it. The key is sound if **at least one**
contributor was honest. Nobody has to trust anyone else — you only have to trust *yourself*, and any observer
only has to believe that *one* of N people behaved. This is the assumption Zcash, Semaphore, and Tornado rest
on. Three to five independent, publicly-named contributors is already a categorical improvement over one.

A final **beacon** removes the last contributor's privileged position: it applies a public, unpredictable value
that did not exist while anyone was contributing, so even the last participant could not have steered the
result.

## Running it

Coordinator, once:

```bash
cd packages/protocol/circuits/dual-sha256-linkage
mkdir -p build && cd build
curl -O https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_16.ptau
# sha256: 1c401abb57c9ce531370f3015c3e75c0892e0f32b8b1e94ace0f6682d9695922
cd ..
circom dual_sha256_linkage.circom --r1cs --wasm --sym -l ../../../../node_modules -o build
../../../../node_modules/.bin/snarkjs groth16 setup \
  build/dual_sha256_linkage.r1cs build/powersOfTau28_hez_final_16.ptau build/contrib_0000.zkey
```

Publish `contrib_0000.zkey`, the `.r1cs`, and their SHA-256 hashes.

Each contributor, independently, on a machine they control:

```bash
./scripts/ceremony/contribute.sh build/contrib_0000.zkey build/contrib_0001.zkey "Alice <alice@example.com>"
```

The script takes entropy from the kernel CSPRNG mixed with characters you type (never echoed, never written to
disk, never in the process table), contributes, prints the output hash and your attestation, and tells you to
destroy the entropy. Publish the output zkey and the attestation, then hand the file to the next contributor.
Contributions are chained: `0000 → 0001 → 0002 → …`.

Coordinator, once all contributions are in — finalise against a beacon nobody could predict. Announce the
source **before** the last contribution (e.g. "the CKB block hash at height N"), then use it:

```bash
./scripts/ceremony/finalize.sh build/contrib_000N.zkey <beacon-hash-hex> 10
```

This applies the beacon, exports `verification_key.json`, runs `zkey verify`, and prints every hash to publish.

## What to publish

- the circuit source and its `.r1cs` (+ sha256)
- the ptau URL and sha256 (the public one — never one you generated)
- every intermediate `.zkey` and each contributor's attestation
- the beacon value, its announced source, and the iteration count
- the final `.zkey` and `verification_key.json` (+ sha256)

## What anyone can then check

```bash
snarkjs zkey verify dual_sha256_linkage.r1cs powersOfTau28_hez_final_16.ptau dual_sha256_linkage_final.zkey
```

This confirms the key derives from *that* circuit and *that* public ptau, and that the published contribution
chain is intact and ends in the announced beacon. Combined with a reproducible build of the circuit, an LSP
then knows exactly what it is verifying against — and needs only to believe that one contributor was honest.

## Rotation

Proofs are bound to a circuit and key. When the key is rotated, previously generated proofs stop verifying, so
merchants must regenerate any they have cached. Distribute the new `.wasm` + `.zkey` (provers) and
`verification_key.json` (verifiers) as release assets with content hashes, as described in
[`ARCHITECTURE.md` § Artifact distribution](./ARCHITECTURE.md#artifact-distribution).
