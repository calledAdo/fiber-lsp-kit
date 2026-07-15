# Phase-2 ceremony for the JIT linkage key

## Why this document exists

Under `linked` JIT the LSP verifies a Groth16 proof before it opens a channel and pays a merchant. That proof is
the only thing standing between the LSP and a merchant who supplies two *unlinked* hashes: if the proof can be
forged, the LSP pays the merchant invoice and then cannot settle the customer hold. It is a direct loss.

Groth16's keys are derived from secret randomness. **Whoever retains that secret can forge a proof for a false
statement, and the forgery verifies against the honest key.** So the key's provenance *is* the LSP's security,
and this document is how the key gets a provenance worth trusting.

Note who is protected. A backdoored key lets a **merchant steal from the LSP**. This ceremony is the LSP's
assumption, not the merchant's.

> **You may not need any of this.** The proof exists only because a single FNN node cannot hold and pay the same
> payment hash. An LSP that runs **two** nodes serves `same_hash` instead: one hash on both invoices, no proof, no
> proving key, no setup, and no proof-setup trust. See
> [`ARCHITECTURE.md` § Why there are two JIT modes](./ARCHITECTURE.md#why-there-are-two-jit-modes). Everything below
> applies to `linked` only.

## What is and is not already handled

**Phase 1 is done.** The build uses the **public Perpetual Powers of Tau**
(`powersOfTau28_hez_final_16.ptau`), which has many independent contributors and a published transcript. No
phase-1 secret is ours. Never generate your own.

**Phase 2 is not.** Groth16 needs a *circuit-specific* second phase, and the key shipped in this repo has a
single contribution — ours. **It must not be trusted with real funds.**

Two things that look like fixes and are not:

| | What it actually proves | What it cannot prove |
|---|---|---|
| A reproducible build | the `.zkey` and vk match the published circuit; the circuit is not backdoored | that the setup secret was destroyed — that secret is never a build input, and the same artifacts appear whether or not someone kept it |
| `snarkjs zkey verify` | the key derives from this circuit and this ptau, and the contribution chain is intact | that anyone deleted anything |

Both are necessary. Neither is sufficient. Only the ceremony below is.

## The security property

Each contributor mixes in entropy only they know, then destroys it. The key is sound if **at least one**
contributor was honest.

```text
   coordinator        Alice            Bob            Carol         public beacon
        │               │               │               │           (unpredictable,
        │  contrib_0000 │               │               │            did not exist
        ├──────────────▶│ +entropy_A    │               │            during any
        │               ├──────────────▶│ +entropy_B    │            contribution)
        │               │               ├──────────────▶│ +entropy_C      │
        │               │               │               ├─────────────────┤
        │               │               │               │                 ▼
        │               │               │               │           final .zkey
        │               │               │               │
        │        each destroys their own entropy and publishes an attestation
        │
        └─▶ sound unless ALL of {Alice, Bob, Carol} kept their entropy AND colluded
```

Soundness requires only one contributor to destroy their entropy. A contributor can trust their own action; an
outside observer relies on at least one of the publicly identified contributors having done the same. Three to
five independent contributors is already a categorical improvement over one.

The final **beacon** removes the last contributor's privileged position. Without it, the last participant sees
every prior contribution and could — in principle — steer the final key. A public, unpredictable value that did
not exist while anyone was contributing makes that impossible.

## Running it

### Coordinator, once, to start the chain

```bash
cd packages/protocol/circuits/dual-sha256-linkage
mkdir -p build && cd build
curl -O https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_16.ptau
# sha256: 1c401abb57c9ce531370f3015c3e75c0892e0f32b8b1e94ace0f6682d9695922
cd ..
circom dual_sha256_linkage.circom --r1cs --wasm --sym -l ../../../../node_modules -o build
npx --yes snarkjs@0.7.6 groth16 setup \
  build/dual_sha256_linkage.r1cs build/powersOfTau28_hez_final_16.ptau build/contrib_0000.zkey
```

Publish `contrib_0000.zkey`, the `.r1cs`, and their SHA-256 hashes. Announce the beacon *source* now — for
example "the CKB block hash at height N" — so that no contributor can have known its value.

`snarkjs` appears here and nowhere else. It is **setup-time tooling only**: the kit itself ships no
proof-system library, and the LSP verifies proofs with `@noble/curves`. It is invoked through a pinned
`npx --yes snarkjs@0.7.6` so a contribution is reproducible against a known implementation.

### Each contributor, independently, on a machine they control

```bash
./scripts/ceremony/contribute.sh build/contrib_0000.zkey build/contrib_0001.zkey "Alice <alice@example.com>"
```

Check the input hash against the one the coordinator published *before* you contribute. The script takes entropy
from the kernel CSPRNG mixed with characters you type — never echoed, never written to disk, never in the process
table — contributes, prints the output hash and your attestation, and tells you to destroy the entropy.

Publish the output zkey and your attestation, then hand the file to the next contributor. Contributions are
chained: `0000 → 0001 → 0002 → …`.

### Coordinator, once all contributions are in

Finalise against the beacon whose source you announced at the start:

```bash
./scripts/ceremony/finalize.sh build/contrib_000N.zkey <beacon-hash-hex> 10
```

This applies the beacon, exports `verification_key.json`, runs `zkey verify`, and prints every hash to publish.

### Then cut a release

```bash
npm run release    # -> verification_key.json, linkage.{zkey,ark}.gz, linkage.wasm, MANIFEST.md, SHA256SUMS
```

The `MANIFEST.md` records the circuit's `.r1cs` hash and the final `.zkey` hash, binding the released artifacts
to the ceremony you just ran. See the circuit guide's
[`Release artifacts`](../packages/protocol/circuits/dual-sha256-linkage/README.md#release-artifacts) section.

## What to publish

- the circuit source and its `.r1cs` (+ sha256)
- the ptau URL and sha256 — the public one, never one you generated
- every intermediate `.zkey` and each contributor's attestation
- the beacon value, its announced source, and the iteration count
- the final `.zkey` and `verification_key.json` (+ sha256)
- the deterministically converted `.ark` (+ sha256 and converter version), for the deployed WASM fast path

## What each party can then check

| Party | Check | Establishes |
|---|---|---|
| Anyone | `snarkjs zkey verify <r1cs> <ptau> <final.zkey>` | the key derives from *that* circuit and *that* public ptau, and the published chain is intact and ends in the announced beacon |
| Anyone | rebuild the circuit, compare the `.r1cs` hash | the circuit is the published source |
| LSP | sha256 of `verification_key.json` against the transcript | it is verifying against the ceremony's key |
| Merchant | `sha256sum -c SHA256SUMS` from the release | the selected `.ark`/`.zkey` and circuit `.wasm` are the released files |

```bash
npx --yes snarkjs@0.7.6 zkey verify \
  dual_sha256_linkage.r1cs powersOfTau28_hez_final_16.ptau dual_sha256_linkage_final.zkey
```

Combined with a reproducible build of the circuit, an LSP then knows exactly what it is verifying against — and
needs only to believe that **one** contributor was honest.

## Rotation

Proofs are bound to a circuit and a key. Rotating the key invalidates every proof generated against the old one,
so:

- **Merchants** must download the new `.ark` fast-path key (or `.zkey` fallback), plus `.wasm` if the circuit
  changed, and discard pre-generated proofs for the old key. A native deployment converting from `.zkey` keys
  its cache to that file's SHA-256, so rotation invalidates the converted cache automatically.
- **LSPs** must swap `verification_key.json` at `LINKED_JIT_VK_PATH`. The vk and the `.zkey` **must be a matched
  pair from the same setup**; mixing them fails every proof, silently.
- **Both** should expect a window where merchants hold the old key and the LSP the new one. Every proof in that
  window is rejected. Coordinate the swap, or accept the outage.

An LSP that also runs `same_hash` has an escape hatch: merchants can fall back to it and rotate at leisure.
