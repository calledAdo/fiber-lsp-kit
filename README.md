# Fiber LSP Kit

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **Buy inbound liquidity for a Fiber wallet — in any asset, including stablecoins — then invoice, get paid, and reconcile.**

A fresh wallet on Fiber can't *receive* a payment: it has no inbound channel capacity — and on Fiber that's
**per-asset**, so to accept **RUSD** you need RUSD inbound specifically. **Fiber LSP Kit** is the missing
**Liquidity Service Provider (LSP)** + **merchant back-office** layer that fixes this: a protocol, a reference
server, and a wallet SDK to **buy per-asset inbound**, then **invoice → get paid → reconcile** on top of it.

It is **infrastructure, not an app** — the **LSPS-Fiber** protocol is the product; the server is one
conforming implementation.

| Where to look | For |
|---|---|
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | the design: the FNN constraint, the decisions, the LSPS-Fiber protocol, JIT checkout, discovery, and how it composes |
| [`scripts/demo/`](./scripts/demo) | the runnable demo: three roles (LSP/merchant/customer), a JIT sale, mock nodes or live |
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
| `@fiberlsp/fiber` | Typed FNN JSON-RPC adapter: invoices, payments, channels, graph reads, peer connection, and channel opening helpers. |
| `@fiberlsp/registry` | Static provider registry + gossip graph discovery: load `providers.json`, merge by LSP pubkey, and resolve live provider offers. |
| `@fiberlsp/server` | Reference LSP engine + REST API, `JitService` in both `linked` and `same_hash` modes, and server-side merchant invoice-webhook service. |
| `@fiberlsp/prover-linked` | Merchant-side Groth16 linkage prover for `linked` JIT: in-process witness generation + a bundled WebAssembly prover (pure `npm i`, no binary), with an optional native-subprocess backend for speed. Not needed for `same_hash`. |
| `@fiberlsp/client` | Wallet/merchant SDK: provider discovery re-exports, quote comparison, inbound purchase, invoice checkout, JIT checkout, streaming rent, monitoring, and ledger helpers. |
| `registry/providers.json` | Git-hosted provider registry file; providers can be added by PR, and merchants can download or bundle it. |

Boundary note for consumers: import `FiberChannelRpcClient`, `FetchLike`, channel/graph RPC types, and
`isChannelReady` from `@fiberlsp/fiber`. Registry discovery is available from `@fiberlsp/registry` and is
re-exported by `@fiberlsp/client` for compatibility.

## Try it

**The demo — three roles, one JIT sale, no `fnn`, no faucet.** LSP, merchant, and customer are each a
long-running process that logs what it sees. A merchant with **zero channels** takes a sale; where the proving
key is present the merchant builds a **real Groth16 proof** the LSP verifies live. By default every role uses a
bundled mock-fnn node. See [`scripts/demo/`](./scripts/demo):

```bash
npm install
npm run demo:lsp        # terminal 1 — the LSP (starts the mock nodes + server, narrates each order)
npm run demo:merchant   # terminal 2 — the merchant (zero channels)
npm run demo:customer   # terminal 3 — the customer
npm run demo:invoice    # terminal 4 — merchant proves linkage + prints the hold invoice
npm run demo:pay        #            — customer pays it → LSP opens a channel, forwards, settles
```

On a fresh clone the merchant fetches the `linked` proving artifacts from the release with
`npm run demo:merchant -- --download` (and the LSP its key with `npm run demo:lsp -- --download`); without them
the demo runs the no-proof `same_hash` mode. Details in [`scripts/demo/README.md`](./scripts/demo/README.md).

**Run it live** by putting a real Fiber node's RPC URL in a role's `fnn` field in
[`scripts/demo/demo.config.json`](./scripts/demo/demo.config.json) — the commands don't change, and you own
that node's funding and peering.

Other scripts: `npm run build` · `npm test` (offline tests over the real RPC code path) · `npm run server` (the LSP
+ merchant REST API, needs an FNN node).

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
  **`same_hash`** gives the LSP a second node — one holds, one pays — and both legs carry one hash. There is
  nothing to prove: **no proving key, no circuit, no trusted setup**, and the merchant ships a single `sha256`.
  **`linked`** is for a single-node LSP: the two hashes must differ, so the merchant proves in zero knowledge
  that they share a secret (Groth16), which costs it a ~19 MB one-time artifact download (proving key + circuit,
  fetched from a versioned release and sha256-verified) and a bundled wasm prover that installs with `npm i` —
  no binary, no native toolchain.
  Merchants prefer `same_hash` automatically when it is offered. See
  [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) (JIT checkout).
- **Leasing.** After activation, **streaming** rent is paid in the **channel's own asset** by keysend out of
  revenue over the same channel (no second channel, no oracle). Rent aligns incentives: an LSP that closes early
  forfeits future rent, and paying rent back **restores the merchant's inbound**.
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
// A merchant with ZERO channels takes its first sale — the sale itself buys the channel:
const sale = await new JitCheckout({ rpc, lsp, merchantPubkey }).checkout({
  asset: RUSD, amount: "2000000000", channelCapacity: "10000000000", // pay 20 RUSD; open a 100 RUSD channel
});
showCustomer(sale.invoice); // a HOLD invoice — the payment is captured and held
await sale.settle();        // the LSP opens the channel, pays the merchant, then releases the hold

// Or provision inbound ahead of demand, without a customer (prepaid, CKB activation fee):
const order = await lsp.buyInboundLiquidity({ asset: RUSD, amount: "1000000000", feeMode: "prepaid", targetPubkey, targetAddress, payFee });
order.state; // "channel_active" — it can now RECEIVE RUSD, having never held any
```

## What's real, simulated, and production-bound

| | |
|---|---|
| **Fully working, live on CKB testnet** | LSP discovery (registry + gossip graph) · RUSD channel **provisioning** · invoice issuance · **routed multi-hop payment** · server-side `invoice.paid` **webhook** · settlement **ledger** reconcile + CSV · **multi-period streaming rent** (keysend RUSD). Reproduce on live nodes via [`scripts/demo/`](./scripts/demo) with real endpoints in `demo.config.json`. |
| **Simulated / reference-grade (on purpose)** | discovery uses the **registry as the default** with the gossip graph as the authentic layer; in the *non-JIT* purchase flow the zero-capital merchant pays the CKB activation fee **out-of-band** (logged, `LSP_TRUST_SETTLE=1`) — the JIT flow needs no fee bootstrap at all; offline tests drive a **scripted RPC transport**; on-chain opens are subject to **testnet confirmation latency** (a JIT payment stays safely held meanwhile — the hold window is the invoice expiry). |
| **Needed for production** | **for `linked` JIT only, a linkage setup the LSP can trust** — phase 1 is the public Perpetual Powers of Tau, but the circuit-specific phase 2 is a single dev contribution, so `linked` is not yet trustless in practice (running `same_hash` instead removes the setup entirely; a multi-party phase 2, or PTLCs, also removes the dependency) · **`get_payment` must expose the settled preimage** ([finding #4](./docs/upstream-fiber-findings.md)) or the LSP depends on the merchant's `reveal` to recoup the forward · auth + rate-limiting on the LSP REST · native LSP endpoint/capability advertisement in the Fiber graph · an escrowed activation bond to close the *prepaid* path's pay-before-open trust gap · sub-second JIT on unarranged payments (needs upstream HTLC interception + zero-conf). Tracked in [`ROADMAP.md`](./ROADMAP.md). |

## License

[MIT](./LICENSE) — fully open source. See [`ROADMAP.md`](./ROADMAP.md) for what's next and
[`AI-USAGE.md`](./AI-USAGE.md) for how AI was used.
