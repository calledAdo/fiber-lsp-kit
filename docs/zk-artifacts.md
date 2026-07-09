# Distributing the JIT linkage proof artifacts

Single-node JIT uses a Groth16 proof that the customer hold hash and the merchant leg hash are derived from
one hidden secret (see [`JIT-CHECKOUT.md`](./JIT-CHECKOUT.md) and
[`../packages/protocol/circuits/dual-sha256-linkage`](../packages/protocol/circuits/dual-sha256-linkage)).
Running the trusted setup is a one-time job; **integrators do not need to run it** — they download the
artifacts. This note says who needs which file and what trust each carries.

## Who needs what

| Role | Files | Trust | Distribute how |
|---|---|---|---|
| **Merchant (prover)** | `dual_sha256_linkage.wasm` + `dual_sha256_linkage_final.zkey` | none — pure computation | download freely (Release asset / CDN / IPFS) |
| **LSP (verifier)** | `verification_key.json` | **must come from a ceremony you trust** | obtain with the ceremony transcript; set `LINKED_JIT_VK_PATH` |

The merchant uses `.wasm` (build the witness) + final `.zkey` (turn it into a proof). The LSP uses only the
`verification_key.json`. **The `.zkey` and the `vk` must be a matched pair from the same phase-2 ceremony and
the same circuit** — mix them and every proof fails to verify.

## Why the merchant side is safe to publish, and the verifier side is not

The `.wasm` and `.zkey` are just computation: anyone can hold them, and they let you *produce* proofs. Publish
them openly.

The `verification_key.json` is the security-critical artifact. A Groth16 setup has "toxic waste" — secret
randomness from the ceremony. If whoever ran the ceremony **kept** that randomness, they can **forge** a proof
for hashes that are *not* actually linked. That is a real loss for the LSP: on a forged linkage it opens the
channel and pays the merchant leg (money out), then cannot settle the customer hold (the derived preimage
doesn't match `hold_hash`) — the LSP eats the forwarded amount. So an LSP must trust that the ceremony behind
its `vk` had **at least one honest participant who destroyed their toxic waste**.

## Dev artifacts vs. a production ceremony

- **This repo's artifacts are a single-party dev ceremony** (`build/` is gitignored; the
  [circuit README](../packages/protocol/circuits/dual-sha256-linkage/README.md) generates them locally). They
  are fine for local testing and the demo, and **must not be trusted with real funds** — one party could hold
  the toxic waste.
- **For production**, reuse a trusted phase 1 (e.g. the Perpetual Powers of Tau) and run a **multi-party
  phase-2 ceremony** (many independent contributors; security holds if any one is honest). Then publish, from
  that single ceremony:
  - `.wasm` + final `.zkey` for provers,
  - `verification_key.json` + the **ceremony transcript** for verifiers to check.

## Don't commit the binaries to git

The final `.zkey` is ~34 MB and the `.ptau`/`.wasm` are large; committing them bloats the repo (which is why
`build/` is gitignored). Publish them as **GitHub Release assets** (or a CDN/IPFS) and reference them by URL
**plus a content hash**, so consumers can verify what they downloaded.
