# @fiberlsp/prover-linked

Merchant-side proof generation for the single-LSP-node `linked` JIT mode. `same_hash` does not use this package
or any proof artifact.

The package generates the circuit witness in-process, proves with a bundled WebAssembly backend by default,
checks the returned public signals against the order hashes, and returns the `LinkageProof` accepted by
`JitCheckout`.

## Use

Download the merchant release artifacts and verify their checksums:

```bash
node scripts/fetch-artifacts.mjs \
  --release <release-asset-base-url> \
  --role merchant \
  --out ./linkage-artifacts
```

```ts
import { makeLinkedProver } from "@fiberlsp/prover-linked";

const proveLinkage = makeLinkedProver({
  zkeyPath: "./linkage-artifacts/linkage.ark",
  wasmPath: "./linkage-artifacts/linkage.wasm",
});
```

Pass `proveLinkage` as `JitCheckoutConfig.proveLinkage` in
[`@fiberlsp/client`](../client/README.md). It is called only when `linked` is selected.

The parameter remains named `zkeyPath` for API compatibility but accepts either the ceremony `.zkey` or the
converted `.ark` fast-load key.

## Backends and footprint

Measurements are from the repository's current artifacts and development machine; timings are indicative.

| Backend/key | Transfer | Unpacked files | Typical proof time | Extra runtime |
|---|---:|---:|---:|---|
| bundled WASM + `.ark` (default) | 16.14 MiB key + 2.16 MiB circuit | 34.26 MiB key + 2.16 MiB circuit | ~2 s | bundled 0.62 MiB prover WASM |
| bundled WASM + `.zkey` fallback | 16.49 MiB key + 2.16 MiB circuit | 34.48 MiB key + 2.16 MiB circuit | ~15 s | bundled prover WASM |
| native subprocess | same selected key + circuit | same selected key + circuit | ~0.12 s plus key load | `linkage-prover` or compatible binary |

The `.zkey` is the ceremony/audit artifact. The `.ark` is a deterministic converted cache of the same key and
is not a second trust root. The circuit WASM is still used to generate the witness for the native backend.

Set `backend: "native"` and `proverPath` to opt into the subprocess path. The default requires no native
toolchain or external prover binary.

## Security

The key must match the LSP's `verification_key.json`. Current release artifacts use a single-contributor
development phase 2 and must not protect real funds. See [`docs/CEREMONY.md`](../../docs/CEREMONY.md).
