# Fiber LSP Kit Architecture

Fiber LSP Kit is hackathon infrastructure for **Category 3: Merchant, Liquidity, LSP, and Multi-Asset
Infrastructure**. It gives Fiber wallets and merchant servers reusable primitives for discovering an LSP,
renting inbound capacity for a specific asset, accepting payments, tracking settlement, and using a
single-node JIT checkout path when the merchant has no usable inbound.

The project is a protocol plus reference implementation. The reusable contract is **LSPS-Fiber**; the server
and SDK prove that the contract can run against Fiber Network nodes.

## Package Boundaries

| Package | Public role | Depends on |
|---|---|---|
| `@fiberlsp/protocol` | Stable shared contracts: assets, orders, JIT orders, lease math, receipts, fee/rent math, linkage proof interfaces, and molecule script helpers. | none |
| `@fiberlsp/fiber` | Typed FNN JSON-RPC adapter: invoices, payments, channels, graph reads, peer connection, and channel-opening helpers. | `protocol` |
| `@fiberlsp/registry` | Static provider registry and gossip graph discovery. It loads `registry/providers.json`, filters providers, and merges registry entries with graph-derived capability. | `protocol`, `fiber` |
| `@fiberlsp/client` | Merchant/wallet SDK: provider discovery, quote comparison, inbound purchase, invoice issuing, JIT checkout, payment watching, streaming rent, and ledger helpers. | `protocol`, `fiber`, `registry` |
| `@fiberlsp/server` | Reference LSP server: LSPS-Fiber REST API, normal order provisioning, single-node JIT service, invoice webhook API, file-backed stores. | `protocol`, `fiber` |

The root package is private. The package boundaries are still monorepo-local, but they are arranged as if
they can be published independently after the hackathon.

## Runtime Surfaces

| Surface | Purpose |
|---|---|
| `/lsp/v1/info` | Advertises provider identity, supported assets, fee modes, lease terms, and JIT terms. |
| `/lsp/v1/orders` | Creates normal inbound-liquidity orders. |
| `/lsp/v1/orders/:id` | Reads a normal order state. |
| `/lsp/v1/orders/:id/settle` | Confirms the activation fee and triggers provisioning. |
| `/lsp/v1/jit/orders` | Creates a single-node linked-hash JIT order and returns a customer hold invoice. |
| `/lsp/v1/jit/orders/:id` | Reads JIT state. Requires the per-order bearer token. |
| `/lsp/v1/jit/orders/:id/reveal` | Fallback reveal path when FNN does not expose the settled leg preimage. Requires the token. |
| `/lsp/v1/jit/orders/:id/cancel` | Cancels an order before capital is committed. Requires the token. |
| `/merchant/v1/*` | Optional reference merchant invoice and webhook API mounted when `MERCHANT_FIBER_RPC_URL` is set. |

## Discovery Model

Discovery has two layers:

1. **Static provider registry.** `registry/providers.json` is a plain file intended to live in GitHub. LSPs can
   be added by pull request. A merchant can download the file, bundle it, or point the SDK at a URL.
2. **Gossip graph capability.** Fiber graph reads expose node pubkeys, addresses, and UDT auto-accept
   configuration. The SDK can use this as a live capability signal and merge it with the registry endpoint.

The registry is not an endpoint owned by this server. It is a reproducible discovery artifact. The LSP REST
endpoint is still the source of truth for live quotes and terms.

## Flow 1: Pre-Provisioned Inbound Lease

This is the default, lowest-complexity path.

1. The merchant SDK calls discovery and chooses an LSP that supports the target asset.
2. The merchant creates a liquidity order with `LspClient.buyInboundLiquidity`.
3. The LSP validates the asset, amount, fee mode, and capacity bounds.
4. The merchant pays the activation fee in CKB. In the zero-capital demo this is confirmed out of band with
   `LSP_TRUST_SETTLE=1`; production should replace that with on-chain verification.
5. The LSP opens a Fiber channel toward the merchant with the requested asset.
6. Once the channel reaches `ChannelReady`, the merchant can issue normal Fiber invoices and receive payments.
7. Rent is paid periodically in the channel asset by keysend over the same channel.

The key rule is that rent is charged on **live remaining inbound capacity**, not original capacity:

```text
rent_base = live_remaining_inbound_capacity
rent_due  = ceil(rent_base * rate_bps_per_period / 10_000)
```

Example:

```text
LSP opens 1000 units of inbound.
Customer pays merchant 500 units.
Remaining inbound at rent time is 500.
At 1 percent rent, rent due is 5.
```

When the merchant pays that rent back to the LSP, it also restores a small amount of merchant inbound.

## Flow 2: Single-Node JIT Checkout

JIT checkout is for the first payment when the merchant has no usable inbound. It uses one LSP node, a
customer-facing hold invoice, a merchant leg invoice, and a proof that both hashes are linked to one hidden
merchant secret. The LSP opens the channel only after the customer payment is held.

The detailed mechanism is in [`JIT-CHECKOUT.md`](./JIT-CHECKOUT.md). The short version:

1. Merchant creates `hold_hash` and `leg_hash` from one secret.
2. Merchant creates a leg invoice for the net amount.
3. Merchant registers a JIT order with the LSP and proves the two hashes are linked.
4. LSP returns a hold invoice for the customer.
5. Customer pays the hold invoice and funds are held at the LSP node.
6. LSP opens a channel to the merchant, pays the merchant leg invoice, learns the leg preimage, derives the
   hold preimage, and settles the customer hold.

This gives atomic JIT semantics at checkout latency. It is not sub-second LSPS2-style interception, because
FNN does not yet expose the required HTLC interception and zero-conf channel hooks.

## Composition Model (Lego Bricks)

The two flows above are *compositions*, not the only supported paths. The client SDK is built as independent
bricks that an integrator takes and wires as needed — nothing forces a fixed "check inbound, then purchase,
then issue" sequence, and JIT is a swappable strategy rather than a separate silo.

**Receiver bricks** (each exported and usable on its own):

- `InvoiceService` — decomposed on purpose: `checkReceiveReadiness()`, `issue()` (issues with **no** readiness
  gate), `receive()` (gate → optional provision → issue), `waitForPayment()`. Use whichever steps you want.
- `buyInboundFromLsp` — provisioning as an injectable hook (`ensureInbound`), never hardcoded.
- `PaymentWatcher`, `SettlementLedger`, `LiquidityMonitor`, `StreamingLease` — settlement, bookkeeping,
  monitoring, and rent as separate pieces.
- `MerchantCheckout` — an **optional** convenience composer (`createIntent` / `awaitSettlement` / `checkout`),
  not a required entrypoint.

**Choosing how you become able to receive.** The three mechanisms share one interface, `ReceiveStrategy`, so
they are interchangeable:

| Strategy | How inbound is obtained | Customer pays |
| --- | --- | --- |
| `DirectReceive` (have) | already have inbound | a normal invoice on the merchant node |
| `DirectReceive` + `ensureInbound` (buy) | bought from an LSP first | a normal invoice on the merchant node |
| `JitReceive` | channel opens on the paying tx | the LSP hold invoice |
| `autoStrategy({ direct, jit, decide })` | picked per request from readiness | depends on the pick |

`ReceiveStrategy.originate(req)` returns a uniform `ReceiveHandle` (payable invoice + `awaitSettlement()` →
`Receipt`), so callers never branch on the mechanism. `autoStrategy`'s default policy receives directly when
inbound already covers the amount and opens JIT only when short; override `decide` for any policy.
`MerchantCheckout` accepts an optional `strategy`, so the same composer drives have / buy / JIT / auto — and
falls back to the built-in issue-over-inbound path when no strategy is set.

**Server bricks.** The LSP engine is equally unopinionated: stores are dependency-injected (`MemoryOrderStore`
/ `FileOrderStore`, JIT and watch stores likewise), and the JIT linkage backend is selected through
`selectLinkageVerifiers()` (Groth16, or the test-only exposed-secret path, never both). A provider swaps any
brick — persistence, pricing, proof backend — without forking the flow.

## What Is Working

- Offline demo: `npm run demo` exercises the real SDK/server/ledger path over scripted FNN transports.
- Live demo harness: `scripts/demo/` reproduces discovery, inbound purchase, invoice, routed payment, webhook,
  ledger export, and streaming rent against real testnet nodes.
- Static console: `apps/demo-console` can be hosted without a backend for judges.
- JIT service and SDK: implemented and tested with the single-node linked-hash mechanism.
- Composable receive strategies: `DirectReceive` / `JitReceive` / `autoStrategy` behind one `ReceiveStrategy`
  interface, selectable in `MerchantCheckout` — the have / buy / JIT choice is composition, not a fixed flow.
- ZK verifier interface: implemented for Groth16 public-signal verification; generated proving artifacts are
  not committed.

## Production Gaps

- LSP REST auth, rate limits, metrics, and operator dashboard.
- On-chain verification for activation fees in the zero-capital non-JIT purchase path.
- Production trusted setup and artifact distribution for the JIT linkage proof.
- Durable production stores such as SQLite or Postgres instead of file-backed reference stores.
- Native Fiber graph advertisement for LSP endpoints and JIT capability versions.
- Sub-second JIT, which requires upstream HTLC interception and zero-conf channel support.
