# Fiber LSP Kit

<!-- After pushing, replace OWNER with your GitHub account/org for a live badge. -->
[![build-and-test](https://github.com/OWNER/fiber-lsp-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/fiber-lsp-kit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **Buy inbound liquidity for a Fiber wallet — in any asset, including stablecoins — then invoice, get paid, and reconcile.**

A fresh wallet on Fiber can't *receive* a payment: it has no inbound channel capacity — and on Fiber that's
**per-asset**, so to accept **RUSD** you need RUSD inbound specifically. **Fiber LSP Kit** is the missing
**Liquidity Service Provider (LSP)** + **merchant back-office** layer that fixes this: a protocol, a reference
server, and a wallet SDK to **buy per-asset inbound**, then **invoice → get paid → reconcile** on top of it.

It is **infrastructure, not an app** — the **LSPS-Fiber** protocol is the product; the server is one
conforming implementation.

|  |  |
|---|---|
| **Category** | 3 — Merchant, Liquidity, LSP & Multi-Asset Infrastructure |
| **Event** | *"Gone in 60ms: Fiber Network Infrastructure Hackathon"* (1–15 July 2026) |
| **Team** | _<!-- add names / GitHub handles -->_ |
| **Video** | _<!-- add link -->_ |
| **Hosted demo** | _<!-- add link (deploy `apps/demo-console`) -->_ |

| Where to look | For |
|---|---|
| [`docs/LSPS-Fiber.md`](./docs/LSPS-Fiber.md) | **the protocol spec** — wire format, REST API, fee model (the technical breakdown) |
| [`scripts/demo/`](./scripts/demo) | six runnable scripts reproducing the whole flow on live testnet nodes |
| [`docs/node-setup.md`](./docs/node-setup.md) | prerequisite for the above — standing up funded testnet `fnn` nodes |
| [`docs/upstream-fiber-findings.md`](./docs/upstream-fiber-findings.md) | issue drafts + an RFC we're contributing back to the Fiber team |
| [`ROADMAP.md`](./ROADMAP.md) · [`AI-USAGE.md`](./AI-USAGE.md) | future roadmap · AI allowance claim + testing regime |

---

## The gap we fill

You can only receive what someone has funded *toward* you. A new wallet has **zero inbound** → it can't be
paid. On live testnet we measured how scarce per-asset inbound is: of **807 public channels**, only **6** carry
RUSD. So a merchant that wants a stablecoin is unreachable until an LSP opens a public RUSD channel to it —
**that provisioning, plus the merchant tooling to run on it, is this kit.**

## What's in the box

| Package | What it is |
|---|---|
| `@fiberlsp/protocol` | The LSPS-Fiber contract layer: assets, order/JIT/lease/receipt types, fee/rent math, and linkage proof contracts. |
| `@fiberlsp/fiber` | Typed FNN JSON-RPC adapter: invoices, payments, channels, graph reads, peer connection, and channel opening helpers. |
| `@fiberlsp/registry` | Static provider registry + gossip graph discovery: load `providers.json`, merge by LSP pubkey, and resolve live provider offers. |
| `@fiberlsp/server` | Reference LSP engine + REST API, single-node linked-hash `JitService`, and server-side merchant invoice-webhook service. |
| `@fiberlsp/client` | Wallet/merchant SDK: provider discovery re-exports, quote comparison, inbound purchase, invoice checkout, JIT checkout, streaming rent, monitoring, and ledger helpers. |
| `apps/demo-console` | Zero-dependency static console that plays the flow (replay or live). |

Boundary note for consumers: import `FiberChannelRpcClient`, `FetchLike`, channel/graph RPC types, and
`isChannelReady` from `@fiberlsp/fiber`. Registry discovery is available from `@fiberlsp/registry` and is
re-exported by `@fiberlsp/client` for compatibility.

## Try it

**Fastest — no node, no faucet, ~2 seconds:**

```bash
npm install
npm run demo
```

This drives the **real kit** (LSP engine, invoice-webhook service, settlement ledger) over mock FNN nodes and a
real local HTTP webhook sink, printing the whole flow: detect no inbound → buy it from the LSP → issue an
invoice → get paid → `invoice.paid` webhook → reconcile + export CSV.

**Reproduce it live** against real Fiber nodes (discover → buy inbound → invoice → routed pay → stream rent): set up the
testnet nodes ([`docs/node-setup.md`](./docs/node-setup.md)), then run the scripts in
[`scripts/demo/`](./scripts/demo).

Other scripts: `npm run build` · `npm test` (offline tests over the real RPC code path) · `npm run server` (the LSP
+ merchant REST API, needs an FNN node).

## How it works

- **Provisioning.** The LSP funds a channel *toward* the wallet, so the wallet gets **inbound** while
  contributing **zero** (it auto-accepts): `createOrder → settleFee → open_channel → channel_active`.
- **Leasing (default).** Inbound is *rented*, not bought. A lease has two phases: **activation** — a one-time
  **CKB** first payment that opens the channel and is the minimum stake — then **streaming** rent in the
  **channel's own asset**, paid by keysend out of revenue over the same channel (no second channel, no oracle).
  Rent aligns incentives: an LSP that closes early forfeits future rent, and paying rent back **restores the
  merchant's inbound**. Verified live (keysend RUSD settled on testnet). See [`docs/LSPS-Fiber.md`](./docs/LSPS-Fiber.md) §5.
- **JIT channels (atomic).** A merchant with **zero channels** shows a customer a **hold invoice**; the
  customer's payment is *captured and held* while the LSP opens a fresh channel on-chain, then forwarded
  (minus the JIT fee). The current JIT path is **single-node linked-hash JIT**: the customer hold hash and
  merchant leg hash are different but proven linked, so the LSP can settle the customer hold only after the
  merchant leg reveals the linked preimage. **The first sale buys the channel** — no out-of-band activation fee,
  though a live merchant Fiber node still needs enough CKB for its own cell reserve.
  See [`docs/LSPS-Fiber.md`](./docs/LSPS-Fiber.md) §6.
- **Discovery.** Two sources, the wallet's choice: a **registry** of LSP REST endpoints (the practical default —
  fast, orderable immediately) and the **gossip graph** (the more authentic, on-chain-verifiable capability
  signal, registry-free). See [`docs/LSPS-Fiber.md`](./docs/LSPS-Fiber.md).
- **Getting paid.** The merchant issues a node-native invoice; the payer routes to it over the gossip graph via
  HTLC/TLC hops unlocked by one shared preimage. We proved a real **3-node routed** RUSD payment where the LSP
  earned a forwarding fee, and the merchant's backend received an `invoice.paid` webhook + a reconciled ledger.

The full **protocol, REST API, and fee model** are in **[`docs/LSPS-Fiber.md`](./docs/LSPS-Fiber.md)**; the live
integration facts we pinned from FNN source are in **[`AI-USAGE.md`](./AI-USAGE.md)**.

```ts
// A fresh wallet with only CKB buys 10 RUSD of INBOUND capacity:
const order = await lsp.buyInboundLiquidity({ asset: RUSD, amount: "1000000000", feeMode: "prepaid", targetPubkey, targetAddress, payFee });
order.state; // "channel_active" — it can now RECEIVE RUSD, having never held any
```

## What's real, simulated, and production-bound

| | |
|---|---|
| **Fully working, live on CKB testnet** | LSP discovery (registry + gossip graph) · RUSD channel **provisioning** · invoice issuance · **routed multi-hop payment** · server-side `invoice.paid` **webhook** · settlement **ledger** reconcile + CSV · **multi-period streaming rent** (keysend RUSD). Reproduce with [`scripts/demo/`](./scripts/demo). |
| **Simulated / reference-grade (on purpose)** | discovery uses the **registry as the default** (a local `providers.json`) with the gossip graph as the authentic layer; in the *non-JIT* purchase flow the zero-capital merchant pays the CKB activation fee **out-of-band** (logged, `LSP_TRUST_SETTLE=1`) — the JIT flow needs no fee bootstrap at all; offline tests drive a **scripted RPC transport**; on-chain opens are subject to **testnet confirmation latency** (a JIT payment stays safely held meanwhile — the hold window is the invoice expiry). |
| **Needed for production** | auth + rate-limiting on the LSP REST · a hosted registry (or the native LSP-endpoint advertisement, [`docs/upstream-fiber-findings.md`](./docs/upstream-fiber-findings.md)) · on-chain fee verification for the zero-capital *purchase* case · production linkage-proof setup for single-node JIT · sub-second JIT on unarranged payments (needs upstream HTLC interception + zero-conf, RFC sketched in the findings doc). Tracked in [`ROADMAP.md`](./ROADMAP.md). |

## License

[MIT](./LICENSE) — fully open source. See [`ROADMAP.md`](./ROADMAP.md) for what's next and [`AI-USAGE.md`](./AI-USAGE.md) for the AI allowance claim.

---

<sub>**Submission deliverables:** project summary + gap + category → here · team/video/hosted-demo → header ·
runnable demo → `npm run demo` · technical breakdown → [spec](./docs/LSPS-Fiber.md) · repo/open-source →
[LICENSE](./LICENSE) · roadmap → [ROADMAP](./ROADMAP.md) · AI claim → [AI-USAGE](./AI-USAGE.md).</sub>
