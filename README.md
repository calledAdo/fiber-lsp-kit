# Fiber LSP Kit

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **Composable infrastructure for provisioning per-asset inbound liquidity to Fiber wallets.**

A Fiber wallet with no inbound capacity cannot receive its first payment. Capacity is asset-specific, so CKB
inbound does not make a wallet reachable for RUSD or another UDT. Fiber LSP Kit provides a protocol contract,
typed FNN adapter, LSP services, and merchant SDK for provisioning that inbound either during the first
checkout or ahead of demand.

This repository is infrastructure, not a hosted payment product. Its packages are independent building blocks;
[`examples/reference-lsp/`](./examples/reference-lsp) is one assembly, not a required server architecture.
**LSPS-Fiber is this project's application-level contract, not an upstream Fiber standard.**

## Run the core flows

```bash
npm install
npm run demo:same-hash:e2e
npm run demo:linked:e2e
```

Both commands use mock FNN roles by default behind the real `FiberChannelRpcClient` boundary. They exercise the
production protocol, service, client, proof, and rent code rather than replacing those layers with demo logic.
The linked run needs network access once when its checksum-verified proof artifacts are not already cached.

- `same_hash` uses four roles and two LSP nodes. One hash secures both invoices; no proof artifacts are needed.
- `linked` uses three roles and one LSP node. Two hashes are linked by a real Groth16 proof; missing release
  artifacts are downloaded and checksum-verified.
- Both demonstrate hold-before-open ordering, merchant payment before hold settlement, and rent calculated from
  the exact opened channel's live remaining inbound capacity. The linked run also sends a second regular invoice
  over the provisioned channel without opening another channel.

For multi-terminal or live-node runs, start with [`scripts/demo/README.md`](./scripts/demo/README.md). Live
profiles are opt-in and require operators to prepare the nodes, funds, peer connectivity, and prerequisite
customer channel; the scripts do not move live funds during preflight.

For a public, no-funds demonstration, [`render.yaml`](./render.yaml) deploys one resettable `linked` simulation.
It exposes the dashboard while keeping the mock FNN roles and application control services on the deployment's
loopback interface. The simulation still runs the real client, LSP state machine, Groth16 proof, settlement
ordering, repeat payment, and rent logic; only the FNN transport is mocked. Deployment and disclosure details are
in the [demo guide](./scripts/demo/README.md#hosted-simulation).

The multi-terminal demo also includes an interactive localhost dashboard. After starting the selected scenario's
LSP, merchant, and customer services, run `npm run demo:linked:dashboard` and open
`http://127.0.0.1:7104` (`same-hash` uses `npm run demo:same-hash:dashboard` and port `7004`). The browser drives
the same shared JIT, regular-payment, and rent operations as the CLI. It shows live action duration and failures,
channel liquidity, and the paying LSP node's read-only on-chain UDT balance when `ckbRpc` is configured. The
complete setup and click-by-click flow are in the central demo guide.

## Core mechanism

The merchant generates the secret that ultimately settles the customer's hold payment. The LSP cannot retain
the customer payment until it has opened the merchant channel and paid the merchant invoice. Failure before
that point cancels or expires the hold, returning the customer's funds.

| Mode | LSP deployment | Invoice hashes | Merchant requirement | Primary trade-off |
|---|---|---|---|---|
| `same_hash` | distinct hold and payment nodes | one shared hash | one SHA-256 | no proof system; LSP must durably coordinate two nodes |
| `linked` | one node | two hashes derived from one secret | linkage proof | one LSP node; proof setup and merchant artifacts required |

The client prefers `same_hash` when an LSP offers it. `linked` remains available for a single-node LSP. In both
modes the normal settlement path observes the merchant preimage directly from the paying FNN node. Because FNN
`v0.9.0-rc5` exposes that value only through a live, non-replayable store-change stream, an explicit cooperative
recovery endpoint remains available after a missed event.

After activation, channel rent is paid in the channel asset and calculated per channel:

```text
rent_due = ceil(live_remaining_inbound_capacity * rate_bps_per_period / 10_000)
```

Rent declines as customer payments consume the LSP-funded balance. A rent payment in the reverse direction
restores some inbound capacity.

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the complete sequence and trust boundaries.

## Packages

| Package | Responsibility |
|---|---|
| [`@fiberlsp/protocol`](./packages/protocol/README.md) | LSPS-Fiber types, assets, lifecycle contracts, fee/rent math, receipts, and linkage verification. |
| [`@fiberlsp/fiber`](./packages/fiber/README.md) | Typed FNN JSON-RPC transport, invoice/payment/channel helpers, graph reads, and optional preimage observation. |
| [`@fiberlsp/server`](./packages/lsp-server/README.md) | Composable JIT, prepaid, lease, webhook, ledger, rebalancing, store, and framework-neutral API bricks. |
| [`@fiberlsp/client`](./packages/client/README.md) | Merchant/wallet SDK for discovery, provisioning, checkout, payment watching, rent, and reconciliation. |
| [`@fiberlsp/registry`](./packages/registry/README.md) | Static provider loading and node-signed gossip-graph discovery. |
| [`@fiberlsp/prover-linked`](./packages/prover-linked/README.md) | Merchant linkage proving for `linked`; bundled WebAssembly default with optional native acceleration. |
| [`@fiberlsp/auth`](./packages/auth/README.md) | Optional invoice-based merchant identity and scoped Ed25519 capability middleware. Off by default. |

The public provider phonebook is [`registry/providers.json`](./registry/providers.json). It contains static
identity and endpoints only; clients retrieve current terms from each provider and treat local gossip data as
a separately node-signed network observation.

## Implementation status

### Core runnable flows

| Capability | Evidence | Boundary |
|---|---|---|
| `same_hash` JIT | `npm run demo:same-hash:e2e`; [`jitSameHash.test.ts`](./packages/lsp-server/test/jitSameHash.test.ts) | Two LSP nodes; preimage stream has no replay. |
| `linked` JIT | `npm run demo:linked:e2e`; [`jit.test.ts`](./packages/lsp-server/test/jit.test.ts) | Current phase-2 artifacts are development-only. |
| Post-JIT regular payment | `npm run demo:linked:e2e`; live FNN multi-terminal flow | Demo payer selects the linked LSP as an optional trampoline; other deployments may use graph or explicit routing. |
| Channel-bound rent | Both demos; [`streamingLease.test.ts`](./packages/client/test/streamingLease.test.ts) | Client detects lapse; automatic LSP-side enforcement is not implemented. |

### Additional composable bricks

| Capability | Status | Boundary |
|---|---|---|
| Prepaid inbound | Reference implementation | Fee is paid before channel open; no escrow currently binds the two actions. |
| Registry and graph discovery | Implemented | Graph data is node-signed and locally observed, not a current-liquidity guarantee. |
| Merchant authentication | Implemented, opt-in | Deployment supplies keys, policy persistence, rate limits, and composition. |
| Invoice webhooks and CSV receipts | Implemented bricks | Deployment owns durable storage, delivery retry, and accounting integration. |
| Ledger and circular rebalancing | Operational helpers | Payment amount/asset are absent from FNN payment reads; live rebalance submission remains operator-controlled. |
| Cooperative lease close | Operational helper | No automatic close after lease lapse. |

## Compatibility

| Component | Status |
|---|---|
| Node.js | `>=20.6` |
| FNN `v0.9.0-rc5` | Live integration target used by this repository |
| FNN `v0.8.1` | Latest stable release at the 2026-07-14 audit; not the version used for the live JIT verification |
| Later `v0.9.0` release candidates | Not claimed compatible until the live probes are rerun |

FNN is under active development. Re-run `npm run test:live` and the selected live demo when changing node
versions. The version-scoped evidence and current-source audit are recorded in
[`docs/upstream-fiber-findings.md`](./docs/upstream-fiber-findings.md).

## Integration

- Merchant/wallet composition: [`packages/client/README.md`](./packages/client/README.md)
- LSP service composition: [`packages/lsp-server/README.md`](./packages/lsp-server/README.md)
- Runnable HTTP example: [`examples/reference-lsp/README.md`](./examples/reference-lsp/README.md)
- Protocol and trust model: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- Linked-proof setup: [`packages/prover-linked/README.md`](./packages/prover-linked/README.md)

This code has not received an independent security audit. Do not use the development Groth16 phase-2 artifacts
with real funds. Read [`SECURITY.md`](./SECURITY.md) and [`ROADMAP.md`](./ROADMAP.md) before production work.

## License

[MIT](./LICENSE). AI-assisted development and validation are described in [`AI-USAGE.md`](./AI-USAGE.md).
