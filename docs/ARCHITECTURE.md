# Architecture

Fiber LSP Kit is a **protocol plus a reference implementation** for renting per-asset inbound liquidity on
Fiber. The reusable contract is **LSPS-Fiber**; the server and client SDK are one conforming implementation of
it. This document is the design: the constraint that forces the shape, the decisions taken because of it, the
protocol those decisions produce, and how the pieces compose.

## The constraint that shapes everything

You can only *receive* a Fiber payment over inbound capacity someone has funded toward you, and on Fiber that
capacity is **per-asset** — RUSD inbound is a different thing from CKB inbound. Everything else follows from how
FNN's `open_channel` actually behaves (verified against FNN v0.9 source, `crates/fiber-json-types` and
`crates/fiber-lib/src/fiber/network.rs`):

- **The opener funds the channel; the funded balance becomes the *peer's* inbound.** There is no `push_amount`
  and no balance transfer at open. So to give a wallet inbound, someone must open a channel *toward* it.
- **UDT auto-accept contributes `0`.** When a node auto-accepts an incoming channel it adds
  `auto_accept_channel_ckb_funding_amount` for a CKB channel but **nothing** for a UDT channel. So an LSP that
  opens a **UDT channel** hands the client pure per-asset inbound for **zero client capital** — this is the
  flagship capability, and it is FNN's default behaviour.
- **Nothing crosses at open, so a fee cannot be netted from the channel.** It is therefore **prepaid** (before
  open) or paid from the client's own outbound right after (CKB channels only).

That last point is the whole reason an LSP is a distinct service rather than a wallet feature, and it drives the
fee model, the lease model, and the JIT design below.

## Design decisions

**Protocol first.** The product is the LSPS-Fiber contract in `@fiberlsp/protocol` — assets, order/JIT/lease
types, fee and rent math, linkage-proof interfaces. The server and SDK exist to prove the contract runs against
real nodes; any wallet or competing LSP can adopt the contract to interoperate. LSPS-Fiber adapts Lightning's
LSPS1 ("buy a channel") and adds the thing Lightning cannot: **per-asset** inbound denominated in a specific
UDT.

**The fee is CKB, and its bootstrap is explicit.** A client buying RUSD inbound holds no RUSD yet — only CKB —
so a CKB fee is the only thing it can pay, and it keeps the LSP oracle-free. Because a zero-capital,
auto-accept-0 client also has *no outbound* on the new channel, it cannot pay that fee over Fiber at all; the
`prepaid` fee is then an **out-of-band CKB payment** (on-chain, or over a pre-existing CKB channel). The
alternative, `from_capacity`, only applies when the client actively dual-funds CKB and thereby gives itself
outbound — CKB channels only.

**Inbound is leased, not sold.** The LSP's cost is *(amount × time)* of locked capital, so the default offering
is a **two-phase lease**: a one-time CKB **activation** (the first payment, and the minimum stake), then
**streaming rent** paid in the *channel's own asset* out of revenue. Charging rent post-revenue in the leased
asset is oracle-free, and it aligns incentives — an LSP that closes early forfeits future rent, and paying rent
back rebalances the channel, restoring the merchant's inbound. A purchase-only offering is the degenerate case
(activation, no rent).

**JIT is single-node and linked-hash.** For a merchant with *no* channel, the first payment is provisioned
just-in-time. Lightning's LSPS2 intercepts the in-flight HTLC; FNN exposes no such hook, so interception moves
up one layer to the **invoice**: the customer pays a hold invoice at the LSP, the LSP opens the channel and
forwards, and settles the hold only after the forward succeeds. One node cannot safely hold `invoice(H)` and
pay `invoice(H)`, so the hold and leg use two different hashes linked by one secret, verified by a zero-knowledge
proof so the LSP need not trust the merchant. The mechanism is in [`JIT-CHECKOUT.md`](./JIT-CHECKOUT.md).

**Mechanism is rigid; policy is pluggable.** The safety-critical *ordering* is fixed — verify the proof before
minting a hold, hold the customer payment before opening, forward before settling, deliver-or-refund. Everything
that is *policy* is injected: stores, pricing, the linkage-proof backend, the receive strategy, the timers. This
"lego brick" separation is what makes the kit reusable rather than a monolith (see Composition, below).

**Capital discipline is structural.** The LSP can only lose money by paying the merchant leg and then failing to
settle the customer hold, so the engine never opens before the hold is funded, never forwards when too little
hold lifetime remains, reads the on-chain TLC expiry rather than guessing it, and re-drives in-flight orders on
restart. Because FNN exposes no push/subscription for invoice, channel, or payment state, every such transition
is discovered by polling.

**Discovery is registry-first.** A static registry of LSP REST endpoints is the dependable, immediately-orderable
path; the gossip graph is a complementary capability signal that is authentic but slow to converge for a
newly-announced node. See Discovery, below.

## Packages

The layering is the protocol-first decision made concrete: contracts at the bottom, the node adapter above them,
then discovery, then the two consumers.

| Package | Role | Depends on |
|---|---|---|
| `@fiberlsp/protocol` | The LSPS-Fiber contracts: assets, order/JIT/lease/receipt types, fee/rent math, the molecule `Script` encoder, linkage-proof interfaces. | — |
| `@fiberlsp/fiber` | Typed FNN JSON-RPC adapter: invoices, payments, channels, graph reads, peer connection, channel-opening helpers. | `protocol` |
| `@fiberlsp/registry` | Static provider registry + gossip-graph discovery, merged by pubkey. | `protocol`, `fiber` |
| `@fiberlsp/server` | Reference LSP engine + REST API, single-node JIT service, invoice-webhook service, injectable stores. | `protocol`, `fiber` |
| `@fiberlsp/client` | Merchant/wallet SDK: discovery, quote comparison, inbound purchase, invoice checkout, JIT checkout, payment watching, streaming rent, ledger. | `protocol`, `fiber`, `registry` |

A wallet or competing LSP can depend on `protocol` (and `fiber`) alone and ignore the reference server entirely.

## The LSPS-Fiber protocol

Base path `/lsp/v1`; JSON bodies; amounts are decimal strings in the asset's base unit (shannons for CKB);
errors are `{ "error": { "code", "message" } }` with a 4xx/5xx status.

**Assets.** An asset is CKB or a UDT identified by its CKB `Script`. FNN represents a UDT two ways — a `Script`
object (`funding_udt_type_script`) and a molecule-hex string (invoice `udt_script`); the protocol canonicalises
both to the hex so the same asset compares equal regardless of source.

**Endpoints.**

| Endpoint | Purpose |
|---|---|
| `GET /lsp/v1/info` | Provider identity, supported assets, fee modes, lease terms, JIT terms. |
| `POST /lsp/v1/orders` · `GET /lsp/v1/orders/:id` | Create / read a normal inbound-liquidity order. |
| `POST /lsp/v1/orders/:id/settle` | Confirm a prepaid fee (LSP re-checks `get_invoice` = `Paid`) → provision. |
| `POST /lsp/v1/jit/orders` · `GET :id` | Create a linked-hash JIT order (returns a customer hold invoice) / read it. |
| `POST /lsp/v1/jit/orders/:id/reveal` · `/cancel` | Fallback preimage reveal / cancel before capital is committed. |
| `/merchant/v1/*` | Optional reference invoice + webhook API, mounted when `MERCHANT_FIBER_RPC_URL` is set. |

JIT order reads and controls require the per-order bearer `order_token` returned at creation.

**Fee model.** The fee is always CKB: `fee = base_fee + (channel is CKB ? ceil(proportional_bps · capacity /
10_000) : 0)`. The proportional term needs a common unit, so it applies only to CKB channels; UDT channels pay
the flat `base_fee`. Two modes: **`prepaid`** (any asset; settle a CKB `fee_invoice` before open — the only mode
supporting pure-UDT inbound at zero client capital) and **`from_capacity`** (CKB channels only; client
dual-funds CKB and pays the fee in-channel after ready).

**Lifecycles.**

```text
normal:  created ─prepaid─▶ awaiting_payment ─settle─▶ opening ─▶ channel_active
                 └─from_capacity──────────────────────▶ opening ─▶ channel_active ─▶ failed (open/ready timeout)
                 └─unpaid past expires_at ─────────────────────────────────────────▶ expired

JIT:     created ─customer pays hold─▶ payment_held ─▶ opening ─leg paid─▶ forwarding ─settle─▶ settled
                 └─not paid by expiry ────────────────────────────────────────────────────────▶ expired
                 └─open/forward failure or cancel ──────────────────────────────────────────────▶ refunded
```

`opening → channel_active` is driven by polling `list_channels` for a `ChannelReady` channel to the target, in
the requested asset, whose LSP-side balance covers the requested inbound.

## Flows

**Pre-provisioned lease** (default, lowest-complexity): discover an LSP → `buyInboundLiquidity` → LSP validates
and quotes → client pays the CKB activation → LSP opens the asset channel → on `ChannelReady` the merchant
invoices and receives → rent streams back by keysend. Rent is charged on **live remaining** inbound, not
original capacity:

```text
rent_due = ceil(live_remaining_inbound_capacity · rate_bps_per_period / 10_000)   (in the channel asset)
```

**Single-node JIT** (first payment, no inbound yet): merchant derives the linked `hold_hash`/`leg_hash` and a
leg invoice → registers the order with a linkage proof → LSP returns a customer hold invoice → customer pays,
funds held at the LSP → LSP opens the channel, forwards the net leg, derives the hold preimage, settles. It is
atomic (deliver-or-refund) at **checkout latency** — an on-chain open, not sub-second interception. The timing
discipline that keeps it loss-free (hold-vs-open budget, the on-chain TLC ceiling read from
`pending_tlcs[].expiry`, leg-outlives-hold validation, retrying settle + resume-on-restart) is detailed in
[`JIT-CHECKOUT.md`](./JIT-CHECKOUT.md).

## Composition model

The two flows are *compositions*, not the only supported paths — the SDK is independent bricks an integrator
wires as needed. Nothing forces a "check inbound → purchase → issue" sequence, and JIT is a swappable strategy,
not a silo.

Receiver bricks, each usable on its own: `InvoiceService` (decomposed into `checkReceiveReadiness` / `issue` /
`receive` / `waitForPayment`), `buyInboundFromLsp` (provisioning as an injectable `ensureInbound` hook),
`PaymentWatcher`, `SettlementLedger`, `LiquidityMonitor`, `StreamingLease`, and the optional `MerchantCheckout`
composer. How a merchant becomes able to receive is itself pluggable behind one `ReceiveStrategy` interface:

| Strategy | How inbound is obtained | Customer pays |
|---|---|---|
| `DirectReceive` (have) | already have inbound | a normal invoice on the merchant node |
| `DirectReceive` + `ensureInbound` (buy) | bought from an LSP first | a normal invoice on the merchant node |
| `JitReceive` | channel opens on the paying tx | the LSP hold invoice |
| `autoStrategy({ direct, jit, decide })` | picked per request from readiness | depends on the pick |

`ReceiveStrategy.originate(req)` returns a uniform `ReceiveHandle` (payable invoice + `awaitSettlement()` →
`Receipt`), so callers never branch on the mechanism. The server engine is equally unopinionated: stores are
dependency-injected (`Memory*` / `File*`), and the JIT linkage backend is selected through
`selectLinkageVerifiers()` (Groth16, or the test-only exposed-secret path, never both).

## Discovery

Two layers, the wallet's choice:

1. **Static registry** — `registry/providers.json`, a public phonebook carrying only static identity; live
   terms come from each provider's `/lsp/v1/info`. This is the primary, immediately-orderable path. See
   [`../registry/README.md`](../registry/README.md).
2. **Gossip graph** — Fiber graph reads expose node pubkeys, addresses, and UDT auto-accept config; the SDK
   merges these with the registry by pubkey. Authentic and registry-free, but a newly-announced node is slow to
   become graph-visible (its `node_announcement` lags its `channel_announcement`), so the registry stays the
   dependable default. The gap and the upstream ask are in
   [`upstream-fiber-findings.md`](./upstream-fiber-findings.md).

## Methodology

The design turns entirely on how FNN behaves, so every load-bearing claim was established by **reading the FNN
v0.9 source and running live testnet nodes**, not by assumption — the funding model, the auto-accept floor, the
peer-dial format, the hold-invoice window, the 32-byte preimage limit. Rough edges and missing surfaces found
that way are written up as issue drafts and RFCs for the Fiber team in
[`upstream-fiber-findings.md`](./upstream-fiber-findings.md). The mechanism/policy discipline above is applied
per-component: a sequence is made rigid only where ordering is the safety property, and everything else is left
injectable.

What is fully working, reference-grade, and production-bound is in the root [`README.md`](../README.md); the
roadmap for the gaps is in [`ROADMAP.md`](../ROADMAP.md).
