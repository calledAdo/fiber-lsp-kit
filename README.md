# Fiber LSP Kit

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **Buy inbound liquidity for a Fiber wallet — in any asset, including stablecoins — then invoice, get paid, and reconcile.**

A fresh wallet on Fiber can't *receive* a payment: it has no inbound channel capacity — and on Fiber that's
**per-asset**, so to accept **RUSD** you need RUSD inbound specifically. **Fiber LSP Kit** is the missing
**Liquidity Service Provider (LSP)** + **merchant back-office** layer that fixes this: a protocol, composable
server-side services, and a wallet SDK to **buy per-asset inbound**, then **invoice → get paid → reconcile** on top of it.

It is **infrastructure, not an app** — the **LSPS-Fiber** protocol and replaceable service bricks are the
product; [`examples/reference-lsp/`](./examples/reference-lsp) is only one conforming assembly.

| Where to look | For |
|---|---|
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | the design: the FNN constraint, the decisions, the LSPS-Fiber protocol, JIT checkout, discovery, and how it composes |
| [`scripts/demo/`](./scripts/demo) | two runnable JIT topologies: four-node same-hash and three-node linked, over mock or live FNN nodes |
| [`docs/upstream-fiber-findings.md`](./docs/upstream-fiber-findings.md) | issue drafts + RFCs for the Fiber team |
| [`ROADMAP.md`](./ROADMAP.md) · [`AI-USAGE.md`](./AI-USAGE.md) | roadmap · AI usage |

---

## The gap we fill

You can only receive what someone has funded *toward* you. A new wallet has **zero inbound** → it can't be
paid. Per-asset inbound is scarce on testnet — only a **handful** of the public channels carry RUSD. So a
merchant that wants a stablecoin is unreachable until an LSP opens a public RUSD channel to it — **that
provisioning, plus the merchant tooling to run on it, is this kit.**

## What's in the box

| Package | What it is |
|---|---|
| `@fiberlsp/protocol` | The LSPS-Fiber contract layer: assets, order/JIT/lease/receipt types, fee/rent math, and linkage proof contracts. |
| `@fiberlsp/fiber` | Typed FNN JSON-RPC adapter: invoices, payments, channels, graph reads, peer connection, channel opening, and optional paying-node preimage observation. |
| `@fiberlsp/auth` | Optional merchant-authentication bricks: signed Fiber-invoice identity proofs, scoped Ed25519 capability tokens, policy/challenge stores, and `createApi` middleware. Off by default. |
| `@fiberlsp/registry` | Static provider registry + gossip graph discovery: load `providers.json`, merge by LSP pubkey, and resolve live provider offers. |
| `@fiberlsp/server` | Composable server-side bricks: `JitService`, prepaid liquidity, lease/rebalancing helpers, injectable stores, and framework-neutral REST handlers. It starts no process and reads no environment variables. |
| `@fiberlsp/prover-linked` | Merchant-side Groth16 linkage prover for `linked` JIT: in-process witness generation + a bundled WebAssembly prover (pure `npm i`, no binary), with an optional native-subprocess backend for speed. Not needed for `same_hash`. |
| `@fiberlsp/client` | Wallet/merchant SDK: provider discovery re-exports, quote comparison, inbound purchase, invoice checkout, JIT checkout, streaming rent, monitoring, and ledger helpers. |
| `registry/providers.json` | Git-hosted provider registry file; providers can be added by PR, and merchants can download or bundle it. |

Boundary note for consumers: import `FiberChannelRpcClient`, `FetchLike`, channel/graph RPC types, and
`isChannelReady` from `@fiberlsp/fiber`. Registry discovery is available from `@fiberlsp/registry` and is
re-exported by `@fiberlsp/client` for compatibility.

## Try it

Run the complete flow in one process first:

```bash
npm install
npm run demo:same-hash:e2e   # four nodes, one payment hash, no proof artifacts
npm run demo:linked:e2e      # three nodes, different hashes, real Groth16 proof
```

Both commands use the real package APIs and typed FNN adapter against a bundled mock network by default. They
are separate entrypoints, not runtime modes: the same-hash scenario owns hold and payment nodes; the linked
scenario owns one LSP node and downloads any missing proof artifacts from the configured release.

For a multi-terminal run or live testnet nodes, choose a scenario in [`scripts/demo/`](./scripts/demo) and fill
its `demo.config.json`. A complete node profile runs live; if any required node field is absent, every role
uses that scenario's mock network. Startup performs only read-only topology checks and never opens the
customer's prerequisite channel for a live operator.

Other scripts: `npm run build` · `npm test` (offline tests over the real RPC code path) · `npm run example:lsp`
(one runnable Node HTTP composition from [`examples/reference-lsp/`](./examples/reference-lsp), requiring an FNN
node). Applications normally import the packages and inject their own clients, stores, observers, policy, and
HTTP framework; the example's environment variables are not part of the package APIs.

Live integration was verified against Fiber's official **`v0.9.0-rc5` prerelease**, not final `v0.9.0` and not
the latest stable release (`v0.8.1`). Re-check RPC behavior when changing FNN versions.

## How it works

- **Provisioning.** The LSP funds a channel *toward* the wallet, so the wallet gets **inbound** while
  contributing **zero** (it auto-accepts). Inbound is *rented*, not bought.
- **JIT channels — the default (atomic).** A merchant with **zero channels** shows the customer a **hold
  invoice**; the payment is *captured and held* while the LSP opens a fresh channel on-chain, then forwarded
  (minus the JIT fee). The merchant generates the secret, so the LSP can settle the customer hold only after
  paying the merchant. **Deliver-or-refund is structural** — and the merchant pays nothing up front, because
  **the first sale buys the channel**. This is why JIT is the default: the alternative asks the merchant to pay
  a fee *before* any channel exists and trust the LSP to open one.
- **Two JIT modes; the LSP advertises which it serves.** One FNN node cannot hold `invoice(H)` and also pay
  `invoice(H)` — it silently pays out and drops the hold (see
  [`docs/upstream-fiber-findings.md`](./docs/upstream-fiber-findings.md) #5). So:
  **`same_hash`** gives the LSP a second node — one holds, one pays — and both invoices carry one hash. There is
  nothing to prove: **no proving key, no circuit, no trusted setup**, and the merchant ships a single `sha256`.
  **`linked`** is for a single-node LSP: the two hashes must differ, so the merchant proves in zero knowledge
  that they share a secret (Groth16), which costs it a ~19 MB one-time artifact download (proving key + circuit,
  fetched from a versioned release and sha256-verified) and a bundled wasm prover that installs with `npm i` —
  no binary, no native toolchain.
  Merchants prefer `same_hash` automatically when it is offered. See
  [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) (JIT checkout).
- **Leasing.** After activation, **streaming** rent is priced from the bound channel's **live remaining
  inbound** and paid in that channel's own asset by keysend (no second channel, no oracle). Rent declines as
  customer payments consume the LSP's liquidity; paying rent back restores some merchant inbound.
- **Prepaid purchase (optional).** A merchant that wants inbound provisioned *ahead* of any customer can buy it
  with a CKB activation fee. Be aware it is pay-before-open: nothing atomically binds the fee to a channel
  actually being opened.
- **Discovery.** The primary path is a **registry** of LSP REST endpoints — fast and immediately orderable,
  shipped as [`registry/providers.json`](./registry/providers.json) (a public phonebook; add yours by PR). It
  carries only static identity; live terms come from each provider's `/lsp/v1/info`. Richer **gossip-graph**
  discovery (reading auto-accept capability straight from the on-chain graph) also works today for established
  nodes and is a forward-looking layer we're developing further — a newly-announced node propagates its
  capability slowly (see [`docs/upstream-fiber-findings.md`](./docs/upstream-fiber-findings.md) #10), so the
  registry stays the dependable default. See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) (Discovery).
- **Getting paid.** The merchant issues a node-native invoice; the payer routes to it over the gossip graph via
  HTLC/TLC hops unlocked by one shared preimage. A **routed** payment through the LSP hub earns it a forwarding
  fee, and the merchant's backend receives an `invoice.paid` webhook and a reconciled ledger.

The full **protocol, REST API, and fee model** are in **[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)**; the
FNN integration facts pinned from source are in **[`AI-USAGE.md`](./AI-USAGE.md)**.

```ts
import { JitCheckout, LspClient } from "@fiberlsp/client";

// A merchant with ZERO channels takes its first sale — the sale itself buys the channel:
const lsp = new LspClient({ baseUrl: "https://lsp.example" });
const sale = await new JitCheckout({
  rpc: merchantRpc,
  lsp,
  merchantPubkey,
  merchantAddress,
  proveLinkage, // required when the selected LSP offers only linked JIT
}).checkout({
  asset: RUSD, amount: "2000000000", channelCapacity: "10000000000", // pay 20 RUSD; open a 100 RUSD channel
});
showCustomer(sale.invoice); // a HOLD invoice — the payment is captured and held
await sale.settle();        // the LSP opens the channel, pays the merchant, then releases the hold

// Or provision inbound ahead of demand, without a customer (prepaid, CKB activation fee):
const order = await lsp.buyInboundLiquidity({ asset: RUSD, amount: "1000000000", feeMode: "prepaid", targetPubkey, targetAddress, payFee });
order.state; // "channel_active" — it can now RECEIVE RUSD, having never held any
```

## What's real, simulated, and production-bound

| Feature | Status | Evidence | Live / mock | Limitation |
|---|---|---|---|---|
| `linked` JIT checkout | Implemented | `npm run demo:linked:e2e`; [`jit.test.ts`](./packages/lsp-server/test/jit.test.ts) | Reproducible mock demo; same package/RPC path verified on testnet | On-chain confirmation latency; shipped Groth16 phase 2 is development-only; rc5 preimage observation is live-only, with explicit reveal recovery. |
| `same_hash` JIT checkout | Implemented | `npm run demo:same-hash:e2e`; [`jitSameHash.test.ts`](./packages/lsp-server/test/jitSameHash.test.ts); [finding #5](./docs/upstream-fiber-findings.md) | Reproducible mock demo; two-node hash behavior verified on testnet | Requires two LSP nodes; rc5 preimage observation has no replay, so durable upstream lookup is still needed. |
| Channel-bound streaming rent | Implemented | Both JIT demos; [`streamingLease.test.ts`](./packages/client/test/streamingLease.test.ts) | Mock demos plus live RUSD keysend verification | LSP-side lapse enforcement is not implemented. |
| Prepaid inbound provisioning | Reference implementation | [`client.test.ts`](./packages/client/test/client.test.ts); [`lsp.test.ts`](./packages/lsp-server/test/lsp.test.ts) | Scripted RPC tests; not part of the focused JIT demos | Pay-before-open trust gap; the demo-only `LSP_TRUST_SETTLE=1` bypass must not be used in production. |
| Registry + graph discovery | Implemented | [`registry.test.ts`](./packages/registry/test/registry.test.ts); [`discover.test.ts`](./packages/client/test/discover.test.ts) | Static registry and scripted graph tests; graph propagation behavior measured live | Newly announced node capabilities can propagate slowly; registry remains the dependable endpoint source. |
| Merchant authentication | Implemented, opt-in | [`@fiberlsp/auth`](./packages/auth/README.md); [`middleware.test.ts`](./packages/auth/test/middleware.test.ts); [`scripts/live-features.mjs`](./scripts/live-features.mjs) | Offline middleware suite plus live signed-invoice identity probe | Not mounted by default; operators supply keys, policy storage, composition, and rate limiting. |
| Invoice webhooks + merchant receipts/CSV | Implemented bricks | [`invoiceWebhooks.test.ts`](./packages/lsp-server/test/invoiceWebhooks.test.ts); [`ledger.test.ts`](./packages/client/test/ledger.test.ts) | Scripted RPC/unit coverage; not exercised by the focused JIT demos | Deployment owns durable storage, webhook retry policy, and accounting integration. |
| LSP ledger + circular rebalancing | Operational helpers | [`leaseAndLedger.test.ts`](./packages/lsp-server/test/leaseAndLedger.test.ts); [`rebalance.test.ts`](./packages/lsp-server/test/rebalance.test.ts); [`scripts/live-features.mjs`](./scripts/live-features.mjs) | Ledger read and routing RPCs probed live; rebalance submission is dry-run by default | FNN currently omits per-payment amount; a circular route must exist in the live graph. |
| Cooperative lease close | Operational helper | [`leaseAndLedger.test.ts`](./packages/lsp-server/test/leaseAndLedger.test.ts); gated live check in [`scripts/live-features.mjs`](./scripts/live-features.mjs) | Scripted tests; live close is opt-in because it is irreversible | No automatic LSP-side close after lease lapse. |

Production work remains: a trustworthy multi-party phase 2 for `linked` (or PTLCs), replayable upstream payment-preimage
lookup, production key/policy management and rate limiting around the optional auth middleware, native LSP
capability advertisement, an escrowed prepaid activation bond, and upstream interception + zero-conf support
for sub-second unarranged JIT. See [`ROADMAP.md`](./ROADMAP.md).

## License

[MIT](./LICENSE) — fully open source. See [`ROADMAP.md`](./ROADMAP.md) for what's next and
[`AI-USAGE.md`](./AI-USAGE.md) for how AI was used.
