# Architecture

Fiber LSP Kit is a protocol contract plus composable implementation bricks for provisioning per-asset inbound
liquidity on Fiber. Operators select the services, adapters, stores, policies, and HTTP framework they need.

**LSPS-Fiber is this project's application-level contract, not an upstream Fiber standard.** Its purpose is to
make independently-built merchant clients and LSP services agree on assets, quotes, order lifecycles, JIT
checkout, rent, and receipts.

## System at a glance

```text
merchant application                    LSP application
--------------------                    ---------------
@fiberlsp/client   <--- LSPS-Fiber ---> @fiberlsp/server
       |                                      |
@fiberlsp/fiber                         @fiberlsp/fiber
       |                                      |
merchant FNN                         hold/pay FNN node(s)
```

Neither application package owns a process or deployment architecture. The reference HTTP server is an example
composition of these boundaries.

## The Fiber constraint

A wallet receives over capacity funded toward it. That inbound is asset-specific: RUSD inbound and CKB inbound
are different resources.

FNN `open_channel` creates that capacity as follows:

```text
LSP -- open_channel(asset, capacity = C) --> merchant

after the open:
  LSP local balance       ~= C     merchant can receive against it
  merchant local balance  = 0      merchant has no new outbound from the open
```

The exact CKB balance can be below the requested funding because the channel cell occupies capacity. For a UDT
channel, an auto-accepting merchant contributes no UDT. The opener therefore supplies the per-asset liquidity
that becomes the merchant's inbound.

This creates a cold-start problem: a merchant with no inbound cannot receive the asset it would use to pay for
that inbound. The kit supports two provisioning times, each with a different trust boundary.

## Provisioning paths

### Prepaid

The merchant pays a CKB activation invoice before the LSP opens the requested channel. This provisions capacity
ahead of customer demand, but payment and channel opening are independent actions. Verifying that the fee was
paid does not guarantee that the channel will be opened.

Prepaid is therefore a reference path with an explicit pay-before-open assumption. A production construction
needs escrow or another enforceable link between the activation payment and the funding cell.

### Just in time

JIT provisions the channel against an actual customer payment:

1. The merchant generates a secret and a merchant invoice.
2. The LSP validates the order before creating a customer hold invoice.
3. The customer pays the hold invoice; FNN locks the payment without releasing it to the LSP.
4. Only after the hold reaches `Received` does the LSP open and fund the merchant channel.
5. The LSP pays the merchant invoice over that new channel.
6. The paying FNN node learns the merchant preimage. The LSP persists it and settles the customer hold.
7. A failure before merchant payment cancels or expires the hold and refunds the customer.

```text
customer                    LSP                         merchant
   |                         |                              |
   |                         |<--- order + merchant invoice-|
   |<---- hold invoice ------|                              |
   |----- held payment ----->|                              |
   |                         |----- open channel ---------->|
   |                         |----- pay invoice ----------->|
   |                         |<---- preimage at pay node ----|
   |                         | settle hold                  |
```

The safety property is the order of effects: **hold before funding, merchant payment before hold settlement**.
JIT is atomic in the deliver-or-refund sense; it is not instant because channel funding confirms on-chain.

## Why there are two JIT modes

The obvious construction uses one hash on both invoices. On FNN `v0.9.0-rc5`, one node that held an incoming
invoice and sent a payment with that same hash marked its own invoice paid while the held customer TLC later
failed. The payee received funds, the customer refunded, and the node lost the amount. See
[`upstream-fiber-findings.md` finding 5](./upstream-fiber-findings.md#5-one-node-holding-and-paying-the-same-hash-silently-loses-funds-the-error-names-it-holdtlctimeout).

The current kit therefore supports two deployments that keep the hold and outgoing payment from colliding on
one FNN node.

### `same_hash`: two nodes, one hash

```text
S = merchant-generated 32-byte secret
H = sha256(S)

hold node:     customer hold invoice uses H
payment node:  merchant invoice uses H
```

The payment node opens the merchant channel and pays the merchant directly. Its `PutPreimage` event reveals `S`
to the LSP application, which persists the value and calls `settle_invoice(H, S)` on the hold node.

This mode has no proof system or setup. Its load-bearing conditions are operational:

- hold and payment RPCs must resolve to distinct FNN identities;
- the merchant payment must use the freshly-funded direct channel, not an arbitrary multi-hop route;
- application state must durably hand the preimage from payment flow to hold flow;
- the paying-node preimage observer must be armed before the outgoing payment.

The two LSP nodes need no channel or peer session with each other. They are coordinated by the operator's
application and persistent store.

### `linked`: one node, two hashes

A single-node LSP must avoid the same-hash collision. The merchant derives two different invoice hashes from
one hidden secret:

```text
private: S = merchant-generated 32-byte secret

B = sha256(S)             merchant payment hash; merchant preimage is S
A = sha256(poseidon(S))   customer hold hash; hold preimage is poseidon(S)
```

Before holding customer funds, the LSP verifies a Groth16 proof of:

```text
exists S: sha256(S) = B and sha256(poseidon(S)) = A
```

Paying the merchant reveals `S`; the LSP derives the hold preimage and settles `A`. The merchant must build the
proof because giving `S` to the LSP before payment would let the LSP settle the hold without paying.

The default merchant backend downloads a compressed `.ark` key plus circuit WASM (about 18.3 MiB transfer),
then proves in-process in about 2 seconds on the measured machine. The optional native backend is subsecond
(about 0.12 seconds plus key loading). The auditable `.zkey` plus circuit occupies about 36.7 MiB unpacked and
is a slower fallback in the WebAssembly backend. Hardware-specific measurements and artifact roles live in
[`@fiberlsp/prover-linked`](../packages/prover-linked/README.md).

The current phase-2 key has one development contribution and must not protect real funds. The setup trust and
replacement ceremony are documented in [`CEREMONY.md`](./CEREMONY.md).

### Mode comparison

| | `same_hash` | `linked` |
|---|---|---|
| LSP nodes | two | one |
| Invoice hashes | one shared hash | two proven-linked hashes |
| Merchant proof | none | Groth16 |
| Setup trust | none from a proof system | circuit-specific phase 2 |
| Main LSP exposure | durable cross-node handoff | proof/setup soundness |

An LSP advertises modes derived from its injected capabilities. A distinct `payRpc` enables `same_hash`; a
linkage verifier enables `linked`. The client prefers `same_hash` when both are available.

## Timing and recovery

The LSP loses capital if it pays the merchant and cannot settle the customer hold. The service bounds that
window with signed and node-observed values:

- `createOrder` rejects a hold lifetime below the advertised open/forward/settle budget.
- Before forwarding, the LSP reads the held TLC's absolute expiry from `list_channels` and uses the earlier of
  invoice expiry and TLC expiry.
- The merchant invoice must outlive the hold window; its signed absolute expiry is checked with `parse_invoice`.
- A valid observed preimage is persisted before hold settlement.
- `JitService.resume()` re-drives stored orders left in flight after restart.

FNN `v0.9.0-rc5` does not return a settled preimage from `get_payment`. Its optional WebSocket
`subscribe_store_changes` method emits live `PutPreimage` events but has no replay cursor. The package therefore
exposes `PaymentPreimageSource` as an injected boundary. `FnnStoreChangePreimageSource` is one implementation.

If the application misses the live event after the merchant has been paid, the merchant can explicitly call the
authenticated order recovery endpoint with the preimage. That fallback is cooperative and protects the LSP;
normal `settle()` does not reveal the secret. A replayable upstream read would remove this fallback.

## Pricing and channel rent

JIT pricing separates three costs:

| Component | Purpose | Timing |
|---|---|---|
| `fee_base` | channel open/close and one-sale abandonment risk | deducted from first sale |
| `fee_bps` | forwarding/service value | deducted from first sale |
| rent | continuing cost of locked LSP capital | paid each lease period |

Rent is bound to the exact provisioned channel and calculated from its current LSP-side balance:

```text
rent_due = ceil(live_remaining_inbound_capacity * rate_bps_per_period / 10_000)
```

If the LSP funded 1,000 units and customer payments consume 500 before the next period, rent is charged on the
remaining 500. Rent is paid in the channel asset through keysend. That reverse payment restores some merchant
inbound and needs no exchange-rate oracle.

The kit detects lease lapse and exposes cooperative close as separate bricks. It does not automatically close a
channel after missed rent; enforcement policy belongs to the operator composition.

## Protocol surface

Base path: `/lsp/v1`. Amounts are decimal strings in asset base units. Errors use
`{ "error": { "code", "message" } }` with an HTTP status.

| Endpoint | Purpose |
|---|---|
| `GET /info` | provider identity, assets, fee modes, lease terms, and derived JIT modes |
| `GET /liquidity` | current node capacity grouped by asset |
| `POST /jit/orders` | validate a JIT intent and return a customer hold invoice |
| `GET /jit/orders/:id` | read a JIT order with its per-order bearer token |
| `POST /jit/orders/:id/reveal` | explicit lost-observation recovery |
| `POST /jit/orders/:id/cancel` | cancel before capital is committed |
| `POST /orders` | create an optional prepaid order |
| `GET /orders/:id` | read a prepaid order |
| `POST /orders/:id/settle` | confirm prepaid fee handling and start provisioning |

```text
JIT: created -> payment_held -> opening -> forwarding -> settled
                    |              |             |
                    +--------------+-------------+-> refunded/expired on failure

prepaid: created -> awaiting_payment -> opening -> channel_active
                                      +---------> failed/expired
```

JIT follow-up routes require the random per-order bearer returned at creation. Deployment-wide merchant
authentication is separate, optional middleware from [`@fiberlsp/auth`](../packages/auth/README.md).

## Composition boundaries

| Package | Owns |
|---|---|
| [`@fiberlsp/protocol`](../packages/protocol/README.md) | pure contracts, math, asset identity, receipts, proof verification |
| [`@fiberlsp/fiber`](../packages/fiber/README.md) | FNN transport and node-level helpers |
| [`@fiberlsp/server`](../packages/lsp-server/README.md) | LSP state machines, stores, handlers, and operations |
| [`@fiberlsp/client`](../packages/client/README.md) | merchant/wallet workflows and receive strategies |
| [`@fiberlsp/registry`](../packages/registry/README.md) | provider-file and graph discovery |
| [`@fiberlsp/prover-linked`](../packages/prover-linked/README.md) | optional merchant proof generation |
| [`@fiberlsp/auth`](../packages/auth/README.md) | optional merchant identity/capability policy |

The server mechanism fixes only the ordering that protects funds. Pricing, stores, timers, webhook delivery,
preimage observation, linkage verification, authentication, rate limits, metrics, and HTTP transport are
injected policy.

On the merchant side, `DirectReceive`, `JitReceive`, and `autoStrategy` implement a common `ReceiveStrategy`.
Applications can receive directly when capacity is sufficient, arrange provisioning first, or originate JIT
without changing the checkout consumer's `ReceiveHandle` contract.

## Trust boundaries

| Party | Normal JIT property | Remaining assumption |
|---|---|---|
| Customer | held payment delivers or refunds under FNN hold/TLC semantics | correct invoice, route, and target FNN behavior |
| Merchant | merchant invoice is paid before the LSP can settle the hold | channel settlement semantics and its own node security |
| LSP, `same_hash` | no proof/setup assumption | distinct-node topology, direct route, persistence, preimage delivery |
| LSP, `linked` | one-node operation | verifier/circuit/setup soundness and preimage delivery |

This is a scoped, trust-minimized construction rather than a claim that the complete deployment is trustless.
Node keys, RPC security, persistent storage, availability, policy, and operational controls remain the
operator's responsibility. See [`SECURITY.md`](../SECURITY.md).

## Discovery

The client can combine two sources by normalized provider pubkey:

1. `registry/providers.json` supplies static identity and an immediately usable REST endpoint. Dynamic terms do
   not belong in this file.
2. `graph_nodes` supplies node-signed addresses, feature names, and auto-accept configuration from the local
   FNN graph view. `graph_channels` supplies public-channel topology validated by FNN against channel data, but
   graph propagation and directional liquidity can lag current conditions.

Clients fetch current terms from `/lsp/v1/info` and confirm capacity before ordering. FNN does not currently
advertise an LSP REST endpoint or native LSP-service feature, so graph-only rows are not automatically orderable.

## Latency and compatibility

Current JIT waits for a confirmed channel open and therefore takes minutes on testnet. The customer payment
remains held during that interval. Sub-second unarranged JIT requires upstream intermediary TLC interception and
zero-confirmation channels.

The runtime claims above were established on FNN `v0.9.0-rc5`. The latest stable release at the 2026-07-14
audit was `v0.8.1`; later `v0.9.0` candidates were not rerun. Current source availability was checked separately
against official `develop` commit `04e091b`. The evidence classes and upstream gaps are maintained in
[`upstream-fiber-findings.md`](./upstream-fiber-findings.md).
