# Reference LSP composition

[`server.mjs`](./server.mjs) is one runnable `node:http` assembly of the exported packages. It demonstrates
configuration and dependency injection; it is not package behavior or a required deployment architecture.

## Start

Run an FNN node with JSON-RPC reachable locally, then:

```bash
FIBER_RPC_URL=http://127.0.0.1:8227 npm run example:lsp
```

The server listens on `http://127.0.0.1:8080` by default and mounts `/health`, `/lsp/v1/info`, and
`/lsp/v1/liquidity`. Prepaid endpoints are enabled by the example. JIT is enabled only when one of the
deployments below is configured.

## Same-hash JIT

```bash
FIBER_RPC_URL=http://127.0.0.1:8227 \
JIT_PAY_FIBER_RPC_URL=http://127.0.0.1:8327 \
JIT_STORE_PATH=./state/jit-orders.json \
npm run example:lsp
```

The URLs must resolve to distinct FNN identities. The paying node must enable FNN's `pubsub` RPC module so the
composition can observe merchant preimages. Keep that RPC on a trusted network boundary.

## Linked JIT

```bash
FIBER_RPC_URL=http://127.0.0.1:8227 \
LINKED_JIT_VK_PATH=./linkage-artifacts/verification_key.json \
JIT_STORE_PATH=./state/jit-orders.json \
npm run example:lsp
```

The configured verification key determines which proofs the LSP accepts. The repository's current key is
development-only; see [`docs/CEREMONY.md`](../../docs/CEREMONY.md).

## Optional composition inputs

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port, default `8080` |
| `LSP_PUBKEY`, `LSP_ADDR` | Override identity discovered from `node_info` |
| `ORDER_STORE_PATH` | Persist prepaid orders |
| `JIT_STORE_PATH` | Persist JIT orders and captured preimages |
| `MERCHANT_FIBER_RPC_URL` | Mount the separate `/merchant/v1/*` invoice-webhook API |
| `WATCH_STORE_PATH` | Persist merchant invoice watches |
| `READY_POLL_ATTEMPTS`, `READY_POLL_INTERVAL_MS` | Tune channel-ready polling |
| `JIT_FEE_BPS`, `JIT_FEE_BASE`, `JIT_MIN_PAYMENT`, `JIT_MAX_EXPIRY` | Example JIT pricing/timing |

The file contains testnet RUSD example terms. Operators should replace assets, pricing, stores, HTTP transport,
authentication, observability, and secret management in their own composition. Authentication is not mounted
by this example; [`@fiberlsp/auth`](../../packages/auth/README.md) shows an opt-in middleware assembly.
