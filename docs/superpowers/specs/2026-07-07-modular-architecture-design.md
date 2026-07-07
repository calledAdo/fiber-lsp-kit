# Modular Architecture Refactor Design

## Objective

Refactor Fiber LSP Kit into a modular monorepo whose boundaries match the product model:

- merchants discover LSPs,
- merchants either pre-provision inbound liquidity or use JIT checkout,
- both paths create a leased inbound position,
- rent is charged from live remaining inbound capacity,
- JIT proof complexity is isolated behind a small optional package,
- the deployable server becomes composition/wiring, not the place where domain logic accumulates.

The target architecture should be easier to reason about, easier to test, and easier for hackathon judges or
third-party merchants to reproduce.

## Product Facts

Fiber LSP Kit has two main merchant-to-LSP mechanisms.

**Pre-provisioned inbound lease.** The merchant buys or rents inbound liquidity before a customer payment
arrives. At checkout, the merchant checks whether it has enough inbound for the requested asset and amount.
If it does, it issues a normal node-native invoice. If it does not, it rents more inbound from an LSP and then
issues the invoice once the channel is active.

**JIT checkout.** The merchant can start with insufficient or zero inbound. The merchant chooses an LSP and
creates a linked-hash JIT order. The customer receives an LSP-issued hold invoice. When the customer payment is
held, the LSP opens a channel to the merchant, forwards the net amount to the merchant leg invoice, derives the
hold preimage, and settles the customer hold.

Both mechanisms should produce the same long-lived result: a leased inbound channel tracked as a
`LeasePosition`.

## Rent Rule

Rent is charged on live remaining inbound capacity at the rent due timestamp, not on the original opened
capacity.

```text
rent_base = live_remaining_inbound_capacity
rent_due  = ceil(rent_base * rate_bps_per_period / 10_000)
```

Example:

```text
LSP opens inbound capacity:     1000
Customer pays merchant:          500
Remaining inbound before rent:   500
Rent rate:                         1%
Rent due:                           5
```

After the merchant pays rent of `5` back to the LSP, remaining inbound becomes `505`. This makes rent both a
fee for currently usable inbound and a light rebalance that restores some receive capacity.

If live remaining inbound is `0`, rent due is `0`, because the LSP is not currently providing usable inbound
capacity on that lease.

The LSP should compute rent from its own channel view. For an LSP-funded channel, the rent base is the LSP's
local balance on the leased channel. From the merchant's view, the same value is the merchant's remote balance.
The lease must be bound to a concrete `channel_outpoint`, asset, merchant pubkey, and provider identity so rent
cannot be accidentally attributed to the wrong LSP or business.

## Package Boundaries

The monorepo should move toward this package layout:

```text
packages/
  protocol/
  fiber/
  registry/
  merchant/
  lsp/
  jit-proof/

apps/
  lsp-server/
  demo-console/
```

### `@fiberlsp/protocol`

Stable shared contract layer. It should contain:

- wire schemas and TypeScript types,
- asset identifiers and canonical asset helpers,
- fee and rent math,
- order, JIT, lease, receipt, event, and error-code types,
- protocol version constants,
- JIT capability and proof-scheme identifiers.

It should not contain FNN RPC calls, server runtime code, merchant checkout orchestration, or large generated
circuit build artifacts.

### `@fiberlsp/fiber`

Thin adapter over FNN JSON-RPC. It should contain:

- `FiberChannelRpcClient`,
- invoice creation, parsing, polling, settlement, cancellation,
- payment sending and payment polling,
- channel listing and channel asset interpretation,
- peer connection and channel opening helpers,
- graph discovery primitives,
- readiness and channel-balance utilities.

This package keeps FNN-specific details in one place so the merchant and LSP packages consume a clear port
instead of each duplicating channel parsing or RPC assumptions.

### `@fiberlsp/registry`

Provider discovery and provider identity package. It should contain:

- `providers.json` schema and validation,
- registry file loading from a local path or URL,
- provider identity normalization,
- graph/registry merge logic,
- provider capability filtering,
- optional provider info signature verification.

The registry is a static file, not an HTTP service. Providers are added by pull request to the GitHub-hosted
`providers.json`. Merchants can periodically download that file, bundle it, or combine it with gossip graph
discovery.

### `@fiberlsp/merchant`

Merchant SDK. It should contain:

- unified checkout engine,
- invoice issuing and settlement watching,
- inbound readiness checks,
- provider selection and quote comparison,
- pre-provisioned inbound purchase/rent flow,
- JIT checkout strategy,
- local lease tracker,
- rent payment scheduler,
- settlement ledger.

The main checkout API should hide the difference between direct, pre-provisioned, and JIT checkout while still
allowing callers to force a specific mode.

```ts
checkout.create({
  asset,
  amount,
  mode: "auto" | "direct" | "pre_provision" | "jit",
});
```

### `@fiberlsp/lsp`

LSP domain package. It should contain:

- offer catalog,
- normal liquidity order service,
- JIT order service,
- channel provisioner,
- lease position service,
- rent accounting service,
- persisted job runner,
- event bus,
- webhook dispatcher,
- stores.

It should not own the deployable HTTP server as its main abstraction. HTTP should be an adapter over this
domain package.

### `@fiberlsp/jit-proof`

Optional JIT proof package. It should contain:

- artifact manifest loader,
- artifact checksum verification,
- linked-hash proof builder,
- linked-hash verifier helpers,
- small bundled proving runtime wrapper.

Production merchants should not need Circom, Powers of Tau files, ceremony tooling, or generated build
directories. They should use a small runtime wrapper plus the published proving artifacts required for the
active JIT version.

## Core Domain Objects

The refactor should center the codebase around these objects:

```text
Provider
Offer
CheckoutIntent
LiquidityOrder
JitOrder
LeasePosition
RentPeriod
PaymentReceipt
ProtocolEvent
ProofArtifactManifest
```

### Provider

A provider represents a commercial LSP identity.

```ts
interface Provider {
  provider_id: string;
  name: string;
  chain: string;
  lsp_pubkey: string;
  base_url?: string;
  addresses: string[];
  features: ProviderFeature[];
  source: Array<"registry" | "graph">;
}
```

Registry discovery gives the REST endpoint. Graph discovery confirms node identity, p2p addresses, and asset
capability. The two are merged by `lsp_pubkey`.

### Offer

An offer is the LSP's live commercial terms, returned by `/lsp/v1/info`.

```ts
interface Offer {
  provider_id: string;
  lsp_pubkey: string;
  asset: Asset;
  min_capacity: string;
  max_capacity: string;
  activation_fee: FeeSchedule;
  lease?: LeaseTerms;
  jit?: JitCapability[];
}
```

JIT capability should be advertised per asset/offer, not as one global server flag.

### CheckoutIntent

A checkout intent is the merchant-facing payment request state machine.

```ts
type CheckoutMode = "auto" | "direct" | "pre_provision" | "jit";

interface CheckoutIntent {
  intent_id: string;
  mode: CheckoutMode;
  asset: Asset;
  amount: string;
  state:
    | "created"
    | "checking_inbound"
    | "provisioning"
    | "invoice_ready"
    | "payment_pending"
    | "settled"
    | "failed"
    | "expired";
  invoice?: string;
  payment_hash?: string;
  provider_id?: string;
  order_id?: string;
  jit_order_id?: string;
  lease_id?: string;
}
```

The merchant checkout engine chooses a strategy:

- `direct`: issue a normal merchant invoice only if inbound is already sufficient,
- `pre_provision`: create a liquidity order, wait for channel active, then issue the merchant invoice,
- `jit`: create a JIT order and show the LSP hold invoice,
- `auto`: choose direct when possible, otherwise choose based on policy and provider capabilities.

### LiquidityOrder

Normal inbound provisioning order. It keeps the existing `createOrder -> settleFee -> open_channel ->
channel_active` lifecycle but should create a `LeasePosition` once the channel becomes active.

### JitOrder

JIT order remains a separate state machine only for the atomic first-payment process:

```text
created -> payment_held -> opening -> forwarding -> settled
                              \             \-> refunded
                               \-> refunded
```

When a JIT order settles and the channel remains open, the LSP creates a `LeasePosition` with
`source = "jit_order"`.

### LeasePosition

The shared result of normal provisioning and JIT.

```ts
type LeaseSource = "prepaid_order" | "from_capacity_order" | "jit_order";

interface LeasePosition {
  lease_id: string;
  source: LeaseSource;
  source_order_id: string;
  provider_id: string;
  lsp_pubkey: string;
  merchant_pubkey: string;
  asset: Asset;
  channel_outpoint: string;
  original_capacity: string;
  rent_base: "live_remaining_inbound";
  rate_bps_per_period: number;
  period_seconds: number;
  grace_periods: number;
  opened_at: number;
  state: "active" | "lapsed" | "closed";
}
```

The `LeasePosition` is the object rent accounting, merchant dashboards, and LSP closure policy should use.

### RentPeriod

Each rent cycle records the measured live inbound and the payment outcome.

```ts
interface RentPeriod {
  rent_period_id: string;
  lease_id: string;
  due_at: number;
  measured_at?: number;
  live_remaining_inbound?: string;
  rent_due?: string;
  payment_hash?: string;
  state: "scheduled" | "due" | "paid" | "skipped_zero" | "missed" | "failed";
}
```

`skipped_zero` is important. It records that rent was intentionally zero because there was no remaining
inbound to rent.

### ProofArtifactManifest

JIT proof artifacts should be versioned and hash-pinned.

```ts
interface ProofArtifactManifest {
  scheme: "groth16-dual-sha256-v1";
  version: string;
  wasm_url: string;
  zkey_url: string;
  verification_key_url: string;
  sha256: {
    wasm: string;
    zkey: string;
    verification_key: string;
  };
}
```

## Discovery Architecture

`providers.json` should remain a static registry file. It is the practical endpoint phonebook.

Example shape:

```json
{
  "version": 1,
  "providers": [
    {
      "provider_id": "fiber-lsp-kit-reference-testnet",
      "name": "Fiber LSP Kit Reference Server",
      "chain": "testnet",
      "lsp_pubkey": "0x...",
      "base_url": "https://lsp.example.com",
      "addresses": ["/ip4/127.0.0.1/tcp/8238"],
      "features": ["lsps-fiber", "lease", "jit"],
      "note": "Add providers by GitHub pull request."
    }
  ]
}
```

Discovery flow:

```text
1. merchant loads providers.json from GitHub, disk, or app bundle
2. merchant optionally scans the Fiber gossip graph
3. registry providers and graph providers are merged by lsp_pubkey
4. merchant fetches each provider's /lsp/v1/info for live terms
5. merchant filters by asset, amount, lease terms, JIT capability, and proof support
6. merchant chooses a provider by policy
```

Graph discovery is authentic but may not carry the REST endpoint. Registry discovery is orderable but requires
trust in the file. Merging both gives a good default: registry says where to call, graph confirms which Fiber
node is behind it.

## LSP Info and Capability Versioning

`GET /lsp/v1/info` should move toward a versioned capability structure.

```ts
interface LspInfo {
  protocol: {
    name: "lsps-fiber";
    version: "1.0";
  };
  provider_id: string;
  lsp_pubkey: string;
  addresses: string[];
  chain: string;
  offers: Offer[];
}
```

JIT should be advertised per offer:

```ts
interface JitCapability {
  version: "linked-sha256-groth16-v1";
  proof_schemes: ["groth16-dual-sha256-v1"];
  artifact_manifest_url: string;
  verifier_key_hash: string;
  min_payment: string;
  max_expiry_seconds: number;
  fee_bps: number;
  fee_base: string;
}
```

This lets future JIT versions coexist with the current linked-hash mechanism.

## Merchant Checkout Flows

### Direct Checkout

```text
1. merchant checks inbound for asset and amount
2. if sufficient, merchant node issues invoice
3. customer pays invoice through normal Fiber routing
4. merchant watches invoice settlement
5. merchant records receipt
```

### Pre-Provisioned Lease Checkout

```text
1. merchant checks inbound
2. if short, merchant chooses LSP and creates liquidity order
3. merchant pays activation fee by the selected supported method
4. LSP opens channel to merchant
5. LSP records LeasePosition when channel is active
6. merchant issues normal invoice
7. customer pays merchant directly
8. recurring rent service charges live remaining inbound each period
```

### JIT Checkout

```text
1. merchant selects an LSP that supports JIT for the requested asset/version
2. merchant loads proof artifacts for the selected JIT capability
3. merchant generates secret S and derives linked hold/leg hashes
4. merchant creates its own leg invoice for net amount
5. merchant sends JIT order and proof to LSP
6. LSP verifies proof and returns customer-facing hold invoice
7. customer pays the hold invoice
8. LSP opens a channel to merchant
9. LSP pays merchant leg invoice
10. LSP derives hold preimage and settles hold
11. LSP creates LeasePosition with source = "jit_order"
12. recurring rent service charges live remaining inbound each period
```

## LSP Internal Services

The LSP package should be structured around domain services:

```text
OfferCatalog
LiquidityOrderService
JitOrderService
LeaseService
RentService
ChannelProvisioner
JobRunner
EventBus
WebhookDispatcher
Stores
```

`ChannelProvisioner` owns peer connection, `open_channel`, and ready-channel detection.

`JobRunner` owns long-running work. JIT should not be a fire-and-forget promise because channel opens can take
minutes and the process may restart.

`LeaseService` creates and updates lease positions.

`RentService` measures live remaining inbound, computes rent, records the rent period, and watches payment
outcome.

`WebhookDispatcher` delivers signed webhooks from protocol events.

## HTTP Adapter

The deployable server should move to `apps/lsp-server` and become composition:

```text
load env
construct Fiber adapters
construct stores
construct LSP services
mount HTTP routes
start job runner
```

The HTTP API routes should call domain services. They should not contain orchestration logic directly.

## Security Requirements

The refactor should include these requirements:

- add idempotency keys for liquidity order creation and JIT order creation,
- store only hashed bearer order tokens,
- sign webhooks,
- verify provider info signatures when configured,
- verify proof artifact checksums before use,
- reject exposed-secret JIT outside explicit local/dev mode,
- bind each lease to provider id, LSP pubkey, asset, merchant pubkey, and channel outpoint,
- compute rent from LSP channel state, not merchant-submitted values,
- enforce duplicate active JIT hash/invoice rejection,
- keep JIT proof verification before hold invoice creation and before capital commitment,
- persist long-running JIT and provisioning jobs.

## Migration Plan

The refactor should be staged so existing functionality keeps working during the transition.

1. Create new package shells: `fiber`, `registry`, `merchant`, `lsp`, `jit-proof`.
2. Move `FiberChannelRpcClient` and channel/invoice helpers from `protocol` into `fiber`.
3. Move discovery and quote logic into `registry` and `merchant`.
4. Move `Lsp`, `JitService`, stores, locks, and webhook services into `lsp`.
5. Introduce `LeasePosition` and make normal order activation create one.
6. Make JIT settlement create a `LeasePosition`.
7. Replace capacity-based rent math with live-remaining-inbound rent measurement.
8. Move circuit artifacts and proof helpers into `jit-proof`.
9. Move deployable server wiring into `apps/lsp-server`.
10. Keep compatibility exports temporarily from existing package names if needed for demos.
11. Update docs and demos to explain registry file discovery, unified checkout, and JIT artifact setup.

## Testing Requirements

Tests should cover:

- registry file parsing and graph/registry merge by `lsp_pubkey`,
- quote selection across providers,
- direct checkout when inbound is sufficient,
- pre-provisioned checkout when inbound is short,
- JIT checkout path producing a `LeasePosition`,
- rent computed on live remaining inbound after customer payments,
- zero rent when remaining inbound is zero,
- rent payment increasing remaining inbound,
- duplicate JIT order rejection,
- idempotent order creation,
- bearer token hashing and authorization,
- proof artifact checksum rejection,
- LSP restart/resume of pending JIT/provisioning jobs,
- webhook signing and verification.

## Out Of Scope

This design does not require a hosted registry service. The registry remains a GitHub-hosted static file.

This design does not require a new proof system. The first target remains the current Groth16 linked
dual-SHA-256 proof, packaged more cleanly.

This design does not require upstream Fiber HTLC interception or zero-conf channels. The current JIT model
remains invoice-time JIT with honest on-chain-open latency.

This design does not implement code yet. It defines the architecture and migration target for the next
implementation plan.
