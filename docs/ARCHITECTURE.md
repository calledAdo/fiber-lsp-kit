# Architecture

Fiber LSP Kit is a **protocol plus a reference implementation** for renting per-asset inbound liquidity on
Fiber. The reusable contract is **LSPS-Fiber**; the server and client SDK are one conforming implementation of
it.

This document is an argument, not a catalogue. It runs in one line from a single fact about how Fiber channels
fund, through the provisioning path that fact forces, the pricing that path implies, the mechanism that
delivers it, the cryptography the mechanism needs, and the trust that is left over. Each section depends on the
one before it. Read it in order.

| | |
|---|---|
| [The constraint](#the-constraint) | how Fiber funds a channel, and what that makes impossible |
| [The problem](#the-problem-a-merchant-cannot-receive-its-first-payment) | the cold-start merchant |
| [Two ways to provision inbound](#two-ways-to-provision-inbound) | prepaid vs. just-in-time, and where the trust sits |
| [What that choice does to pricing](#what-that-choice-does-to-pricing) | the fee, and the lease |
| [Design principles](#design-principles) | what is rigid, what is pluggable |
| [The system](#the-system) | packages, protocol surface, lifecycles |
| [How a JIT checkout runs](#how-a-jit-checkout-runs) | the ordering that makes it safe |
| [The hash-lock collision](#the-hash-lock-collision) | why one hash is not enough, and the two modes that fix it |
| [Timing and expiries](#timing-and-expiries) | the clocks that bound the LSP's exposure |
| [Trust model](#trust-model) | what each party must believe |
| [The linkage circuit](#the-linkage-circuit) | the statement, its artifacts, and their cost |
| [Latency](#latency) | what JIT does not solve |
| [Composition model](#composition-model) · [Discovery](#discovery) · [Methodology](#methodology) | using it, and how it was established |

---

## The constraint

You can only *receive* a Fiber payment over **inbound capacity** — capacity someone else has funded toward you.
On Fiber that capacity is **per-asset**: RUSD inbound is a different thing from CKB inbound, and having one
grants you none of the other.

How that capacity comes into being is fixed by FNN's `open_channel`, established against FNN v0.9 source
(`crates/fiber-json-types`, `crates/fiber-lib/src/fiber/network.rs`):

```text
              open_channel(asset = RUSD, capacity = C)
   LSP  ──────────────────────────────────────────────────▶  merchant
        LSP funds C                     merchant funds 0
                                        (UDT auto-accept contributes nothing)

   once open:
        LSP's balance     = C   ──▶  this IS the merchant's inbound.  It can receive C.
        merchant's balance = 0  ──▶  the merchant has no outbound.    It can send nothing.

   nothing crossed the channel at open.
```

Three consequences, and everything downstream is a response to one of them:

- **The opener funds the channel; the funded balance becomes the *peer's* inbound.** There is no `push_amount`
  and no balance transfer at open. To give a wallet inbound, someone must open a channel *toward* it.
- **UDT auto-accept contributes `0`.** A node auto-accepting an incoming channel adds
  `auto_accept_channel_ckb_funding_amount` for a CKB channel but **nothing** for a UDT channel. An LSP that
  opens a **UDT channel** therefore hands the client pure per-asset inbound for **zero client capital** — which
  is exactly the product.
- **Nothing crosses at open, so a fee cannot be netted from the channel.** The LSP must be paid some other way.

That last point looks like a billing detail. It is not. It is what makes the choice of provisioning path an
architectural decision.

## The problem: a merchant cannot receive its first payment

A merchant that has just started has no inbound in the asset it wants to be paid in. It cannot receive. To
receive, someone must open a channel toward it. Whoever opens funds it, so the merchant must either fund its own
inbound — which it cannot, having no capital, and which is circular anyway — or an LSP must.

The LSP will want paying. But the merchant holds no RUSD (it has never been paid), and the fresh channel gives
it no outbound to pay over. So at the moment the LSP's fee is due, **the merchant cannot pay it through the
thing it just bought.**

The whole design turns on how that circle is broken.

## Two ways to provision inbound

There are exactly two, and they differ in *when* the channel is created relative to the payment that justifies
it.

### Prepaid purchase

The merchant pays a CKB activation fee out-of-band; the LSP *then* opens a channel. CKB is the only asset the
merchant can be assumed to hold, and pricing in it keeps the LSP oracle-free.

**Nothing atomically links the fee to the open.** The LSP can take the fee and never open, open something
smaller, or open and close immediately. Verifying the fee on-chain does not help — it proves the merchant paid,
and gives the merchant no recourse. Closing the gap needs an escrowed activation bond, which needs a CKB lock
script that does not exist yet (see [`../ROADMAP.md`](../ROADMAP.md)). **The prepaid path is trusted by
construction**, and an LSP advertising it should say so plainly.

### Just-in-Time (JIT)

**Just-in-time** provisioning creates the channel at the moment a real payment arrives for it, out of that
payment. Nothing is bought in advance.

The customer pays a **hold invoice** at the LSP — a payment the LSP has locked but cannot yet keep, because
settling it requires a preimage the LSP does not have. The LSP opens a channel to the merchant, forwards the
payment (net of fee) over it, and the merchant claims. Claiming reveals the preimage. Only now can the LSP
settle the customer's hold and keep the money.

The fee circle is dissolved rather than solved: the fee is deducted from a payment that already exists, and the
merchant never needs capital it does not have.

### Why JIT is the default

Because of where the trust ends up.

| | Prepaid purchase | JIT |
|---|---|---|
| Merchant | **trusts the LSP** with a fee, before any channel exists | trusts nothing — is paid before the LSP can settle |
| Customer | not involved | trusts nothing — the held payment either delivers or refunds |
| LSP | trusts nothing | trusts the linkage proof, in one of the two modes (see [Trust model](#trust-model)) |

Prepaid places the risk on the **least sophisticated, least capitalised party**: a cold-start merchant. JIT
moves all residual trust onto the **LSP** — the party with capital, expertise, and a repeated game, risking its
own money. Trust should flow toward whoever can bear it, and that is the argument.

The economics agree. The merchant never buys capacity it may not use; capacity is created on demand, sized to a
payment that is *already held*. The LSP never speculatively locks capital against a merchant who may never
receive anything.

Prepaid purchase remains available as an explicitly optional capability, for a merchant that wants inbound
provisioned ahead of any customer so its first checkout is instant.

## What that choice does to pricing

Under prepaid, the fee had to be an out-of-band CKB payment, because a zero-capital merchant has no outbound on
its new channel and cannot pay over Fiber at all. Under JIT the fee is simply **deducted from the forwarded
payment**, and the one-time activation cost migrates into `fee_base`. Three components, each paying for a
distinct thing:

| Component | Pays for | Charged |
|---|---|---|
| `fee_base` | the on-chain open + eventual close, and the risk a merchant makes one sale and leaves | once, netted from the **first** sale |
| streaming `rent` | the *ongoing* cost of the LSP's locked capital | per period, out of revenue |
| `fee_bps` | the forwarding value of each payment | per payment |

This has teeth. A JIT open locks at least the acceptor's `auto_accept_amount` of liquidity plus a CKB cell
reserve, and costs two on-chain transactions over its life. With `fee_base = 0` a merchant could make one dust
sale and walk, leaving the LSP with the bill — so `fee_base` must cover an open, and `min_payment` must
comfortably exceed `fee_base` or the merchant nets nothing. Prepaid's non-refundable activation fee was exactly
this protection; under JIT it is the same economics, **paid out of money that actually exists** and collected
atomically at the moment the LSP commits capital.

### Inbound is leased, not sold

The LSP's cost is *(amount × time)* of locked capital, so the offering is a **two-phase lease**: activation
(above), then **streaming rent** paid in the *channel's own asset* out of revenue. Charging rent post-revenue in
the leased asset is oracle-free and aligns incentives — an LSP that closes early forfeits future rent, and
paying rent back rebalances the channel, restoring the merchant's inbound. Rent is charged on **live remaining**
inbound, not original capacity:

```text
rent_due = ceil(live_remaining_inbound_capacity · rate_bps_per_period / 10_000)   (in the channel asset)
```

The lease is JIT's natural companion: the first sale opens the channel and pays activation; subsequent revenue
pays the rent. There is no moment where the merchant must find capital it does not have.

## Design principles

Three commitments shape the code, and they follow from the above.

**Protocol first.** The product is the LSPS-Fiber contract in `@fiberlsp/protocol` — assets, order/JIT/lease
types, fee and rent math, linkage-proof interfaces. The server and SDK exist to prove the contract runs against
real nodes; any wallet or competing LSP can adopt it to interoperate. LSPS-Fiber adapts Lightning's LSPS1 ("buy
a channel") and adds what Lightning cannot: **per-asset** inbound denominated in a specific UDT.

**Mechanism is rigid; policy is pluggable.** The safety-critical *ordering* is fixed — verify before minting a
hold, hold before opening, forward before settling, deliver-or-refund. Everything that is *policy* is injected:
stores, pricing, the linkage backend, the receive strategy, the timers. This is what makes the kit reusable
rather than a monolith.

**Capital discipline is structural.** Since JIT moves all residual trust onto the LSP, the LSP's own exposure
must be bounded by construction rather than by care. It can lose money in exactly one way — pay the merchant
leg, then fail to settle the customer hold — so the engine never opens before the hold is funded, never forwards
when too little hold lifetime remains, reads the on-chain TLC expiry rather than guessing it, and re-drives
in-flight orders on restart. Because FNN exposes no push or subscription for invoice, channel, or payment state,
every transition is discovered by polling.

## The system

| Package | Role | Depends on |
|---|---|---|
| `@fiberlsp/protocol` | The LSPS-Fiber contracts: assets, order/JIT/lease/receipt types, fee/rent math, the molecule `Script` encoder, linkage-proof interfaces, the Groth16 verifier. | — |
| `@fiberlsp/fiber` | Typed FNN JSON-RPC adapter: invoices, payments, channels, graph reads, peer connection, channel-opening helpers. | `protocol` |
| `@fiberlsp/registry` | Static provider registry + gossip-graph discovery, merged by pubkey. | `protocol`, `fiber` |
| `@fiberlsp/server` | Reference LSP engine + REST API, JIT service (`linked` and `same_hash`), invoice-webhook service, injectable stores. | `protocol`, `fiber` |
| `@fiberlsp/client` | Merchant/wallet SDK: discovery, quote comparison, inbound purchase, invoice checkout, JIT checkout, payment watching, streaming rent, ledger. | `protocol`, `fiber`, `registry` |
| `@fiberlsp/prover-linked` | Merchant-side proof generation for `linked` JIT. Not needed for `same_hash`. | `protocol` |

A wallet or competing LSP can depend on `protocol` (and `fiber`) alone and ignore the reference server.

### The LSPS-Fiber protocol

Base path `/lsp/v1`; JSON bodies; amounts are decimal strings in the asset's base unit (shannons for CKB);
errors are `{ "error": { "code", "message" } }` with a 4xx/5xx status.

**Assets.** An asset is CKB or a UDT identified by its CKB `Script`. FNN represents a UDT two ways — a `Script`
object (`funding_udt_type_script`) and a molecule-hex string (invoice `udt_script`); the protocol canonicalises
both to the hex so the same asset compares equal regardless of source.

| Endpoint | Purpose |
|---|---|
| `GET /lsp/v1/info` | Provider identity, supported assets, fee modes, lease terms, JIT terms (including `jit.modes`). |
| `GET /lsp/v1/liquidity` | Live capacity snapshot per asset — the data behind a liquidity dashboard. |
| `POST /lsp/v1/jit/orders` · `GET :id` | Create a JIT order (returns a customer hold invoice) / read it. |
| `POST /lsp/v1/jit/orders/:id/reveal` · `/cancel` | Fallback preimage reveal / cancel before capital is committed. |
| `POST /lsp/v1/orders` · `GET :id` · `POST :id/settle` | Optional prepaid purchase: create / read / confirm fee → provision. |
| `/merchant/v1/*` | Optional reference invoice + webhook API, mounted when `MERCHANT_FIBER_RPC_URL` is set. |

JIT order reads and controls require the per-order bearer `order_token` returned at creation.

**Prepaid fee model** (optional path). `fee = base_fee + (channel is CKB ? ceil(proportional_bps · capacity /
10_000) : 0)`, in CKB. The proportional term needs a common unit, so it applies only to CKB channels. Two modes:
`prepaid` (any asset; settle a CKB `fee_invoice` before open) and `from_capacity` (CKB channels only; the client
dual-funds CKB and pays in-channel once ready).

**Lifecycles.**

```text
JIT:      created ─customer pays hold─▶ payment_held ─▶ opening ─leg paid─▶ forwarding ─settle─▶ settled
                  └─not paid by expiry ───────────────────────────────────────────────────────▶ expired
                  └─open/forward failure or cancel ─────────────────────────────────────────────▶ refunded

prepaid:  created ─▶ awaiting_payment ─settle─▶ opening ─▶ channel_active ─▶ failed (open/ready timeout)
                  └─unpaid past expires_at ──────────────────────────────────────────────────────▶ expired
```

`opening → channel_active` is driven by polling `list_channels` for a `ChannelReady` channel to the target, in
the requested asset, whose LSP-side balance covers the requested inbound.

## How a JIT checkout runs

The merchant generates a 32-byte secret `S` and never shares it. Everything else follows from that one fact.

```text
   customer                    LSP                          merchant
      │                         │                              │
      │                         │◀───── 1. create order ───────│   hold_hash, leg invoice,
      │                         │        (+ linkage proof)     │   amount, target pubkey
      │                         │
      │                         │   verify EVERYTHING here — before any capital moves
      │                         │
      │◀──── 2. hold invoice ───│
      │                         │
      │───── 3. pay hold ──────▶│   funds locked at the LSP.
      │                         │   The LSP cannot keep them: settling needs a preimage
      │                         │   only the merchant can produce.
      │                         │
      │                         │────── 4. open_channel ──────▶│   on-chain. minutes.
      │                         │                              │
      │                         │──── 5. pay leg (net fee) ───▶│   merchant claims,
      │                         │◀──────── preimage S ─────────│   revealing S
      │                         │
      │                         │   6. settle the hold with S. The LSP keeps the gross.
      │                         │
      │   any failure before 5:  cancel the hold ─▶ customer refunded, merchant unpaid,
      │                          LSP out only its on-chain fee.
```

**The ordering is the security model.** The LSP acquires the ability to keep the customer's money strictly after
it has paid the merchant. Deliver-or-refund is therefore structural, not promised — it does not depend on the
LSP being honest, only on it being greedy.

This is what the rest of the document is defending.

## The hash-lock collision

Step 5 above hides a problem. The hold invoice and the leg invoice are both hash-locks. The obvious design gives
them the **same** hash `H = sha256(S)`: the merchant claims the leg with `S`, the LSP settles the hold with `S`.

**A single FNN node cannot do this.** Verified live against FNN v0.9.0-rc5: one node that holds `invoice(H)` and
then sends `payment(H)` has its `send_payment` *accepted*. The payment reaches `Success`. Its own hold invoice
silently flips to `Paid` with no `settle_invoice` call, `cancel_invoice` afterwards refuses, and the customer's
held payment ends `Failed / HoldTlcTimeout`. Net result: the merchant is paid, the customer is refunded, and
**the LSP loses the amount — with no error raised at any call site.** Written up as
[finding #5](./upstream-fiber-findings.md).

So the two legs must not collide on one node. There are exactly two ways out, and an LSP advertises which it
serves in `LspInfo.jit.modes`; the merchant chooses per order with `CreateJitOrderRequest.mode`.

```text
   linked — one node, two hashes            same_hash — two nodes, one hash

   customer          merchant               customer                       merchant
      │                 ▲                      │                              ▲
      │ hold: A         │ leg: B               │ hold: H                      │ leg: H
      ▼                 │                      ▼                              │
   ┌────────────────────┴───┐              ┌───────────┐               ┌──────┴──────┐
   │       LSP node         │              │ hold node │◀── S ─────────│  pay node   │
   │  holds A,  pays B      │              │  holds H  │   (internal)  │   pays H    │
   └────────────────────────┘              └───────────┘               └─────────────┘

   A = sha256(poseidon(S))                 H = sha256(S) on both legs
   B = sha256(S)                           no collision: different nodes
   A ≠ B, so no collision on one node.     nothing to prove — there is one hash.
   Merchant PROVES A and B share one S.
```

### `linked` — two hashes, one node

An FNN invoice preimage is a fixed 32-byte `Hash256`, so both preimages must be 32 bytes:

```text
S           = merchant-generated 32-byte secret
leg_hash  B = sha256(S)              (leg invoice;  preimage = S)
hold_hash A = sha256(poseidon(S))    (hold invoice; preimage = poseidon(S))
```

Paying the leg reveals `S`; the LSP derives the hold preimage `poseidon(S)` and settles. But `A` and `B` are two
unrelated-looking hashes, and the LSP is about to commit capital on the belief that learning `B`'s preimage will
yield `A`'s. If that belief is false, it pays the merchant and cannot settle the hold.

So before committing, the LSP verifies a proof of exactly that belief:

> `groth16-dual-sha256` — a Groth16 proof of `∃S : sha256(S) = B ∧ sha256(poseidon(S)) = A`.

**The proof cannot come from anyone but the merchant, and this is forced, not chosen.** The derivation runs leg →
hold, because the LSP learns the leg preimage and needs the hold preimage; so whoever knows `S` can compute
both. The LSP must not know the hold preimage before it pays. Therefore it must not know `S`. Therefore only the
merchant can prove anything about `S`.

Nor can the relation be checked from `A` and `B` alone, without a proof: that would require a *homomorphic*
lock, and SHA-256 annihilates any structure imposed on its preimages. A proof, from the merchant, is the only
remaining option. (A test-only `exposed-secret` scheme reveals `S` outright. It is not a security model — with
`S` in hand the LSP could settle the hold without paying the merchant at all.)

### `same_hash` — one hash, two nodes

The proof above exists only to work around a *single node's* inability to hold and pay one hash. Two nodes remove
the collision, and with it the entire construction:

```text
S    = merchant-generated 32-byte secret
hash = sha256(S)     (both the customer hold invoice and the merchant leg invoice; preimage = S)
```

The **hold node** mints the customer's hold invoice on `hash`. The **paying node** funds the JIT channel and pays
the merchant's leg invoice, which carries the same `hash`. The merchant claims, revealing `S` to the paying node;
the LSP settles the hold with `S`. There is nothing to prove because there is no relation between two hashes —
there is one hash. `JIT_PAY_FIBER_RPC_URL` names the paying node, and the server refuses to start if it resolves
to the same node as the hold one.

The merchant still generates `S`, so the ordering argument from [How a JIT checkout runs](#how-a-jit-checkout-runs)
is untouched. The paying node is cheap: it pays the merchant over the channel it has just funded, a single direct
hop, so it needs on-chain funds — which it already needed, being the funder — and no routing liquidity at all.

Two properties this mode must not lose:

- **Routing disjointness.** One hash is live on two payment routes at once. Any node sitting on *both* the
  customer's route to the hold node and the paying node's route to the merchant would learn `S` from the second
  and could claim on the first. Our topology makes that set empty: the merchant leg always traverses the
  freshly-funded channel with no intermediaries, and the customer's payment is held *before* that channel
  exists, so the merchant cannot yet appear on any route. An LSP that forwards the merchant leg over
  pre-existing hops rather than a fresh direct channel forfeits this argument and **must not use this mode**.
- **Durable handoff.** The paying node learns `S` and the hold node needs it. If the paying node claims and then
  dies before `S` is persisted, the hold expires, the customer is refunded, and the LSP has paid for nothing.
  This is the same exposure window `linked` has between forwarding and settling, but it now spans a process
  boundary, so `JIT_STORE_PATH` stops being an uptime nicety and becomes load-bearing.

### Choosing a mode

| | `linked` | `same_hash` |
|---|---|---|
| LSP nodes | one | two (hold + pay) |
| Invoice hashes | two, proven linked | one, on both legs |
| Merchant artifacts | `.wasm` + `.zkey` — 36.7 MB | none |
| Merchant work per order | ~0.12 s proving, 95 MB peak | one `sha256` |
| LSP verification | Groth16 pairing check, ~50 ms | compare two hashes |
| Trusted setup | circuit-specific phase 2 | **none** |
| LSP cost | one node | a second node + capital positioned at it |

`same_hash` is the better trade wherever an LSP can run two processes: it deletes the proof, the proving key, the
circuit, and the ceremony, and moves the residual cost onto the party that is capitalised and in a repeated game.
`linked` remains for an LSP that cannot, and is what a merchant must use against a single-node LSP. The client
prefers `same_hash` when the LSP advertises it.

## Timing and expiries

The only way the LSP loses money is to pay the merchant leg and then fail to settle the customer hold, so every
timer is checked against the money-flow rather than assumed. All of this is shared by both modes.

- **Hold vs. open budget.** `createOrder` refuses a hold shorter than one open + one forward + a settle margin —
  advertised as `JitTerms.min_expiry_seconds` so a merchant can inspect the floor before ordering — and `run()`
  refuses to pay the merchant when too little hold lifetime remains. It refunds instead.
- **On-chain TLC ceiling, read not assumed.** The invoice expiry is a soft timer; the held payment's TLC has a
  hard on-chain expiry past which the customer can force-close and reclaim. Before forwarding, the LSP reads the
  real TLC expiry from `list_channels` → `pending_tlcs[].expiry` and uses `min(invoice_expiry, tlc_expiry)`.
- **Leg outlives the hold.** The leg invoice must not expire before the LSP forwards. The client sets the leg
  expiry above the hold window, and `createOrder` validates the leg's absolute expiry from `parse_invoice`,
  rejecting `leg_expiry_too_short`. Expiry is read from the *signed invoice*, never from a claimed field.
- **Durable, retrying settle.** Settlement retries until the leg preimage lands or the hold nears expiry, and
  `JitService.resume()` re-drives any order left in flight by a crash — including one already `forwarding`. This
  requires a persistent `JIT_STORE_PATH`; with the in-memory store a crash leaves a held payment to refund at
  expiry.
- **Where the leg preimage comes from.** The paying node learns it from the TLC fulfillment, but FNN's
  `get_payment` does not expose it ([finding #4](./upstream-fiber-findings.md)). So today the LSP settles from
  the merchant's `reveal` call, and reads `get_payment` first only so it will settle without one once FNN
  surfaces the field. **This bounds what JIT guarantees:** a merchant that takes the forward and never reveals
  costs the LSP the forwarded amount. The customer is still refunded at expiry, and neither the proof nor the
  node topology changes this. Fixing #4 upstream closes it.

## Trust model

JIT is trustless for the customer and the merchant by construction, in both modes. What remains is the LSP's
exposure, and it differs sharply between them.

**Under `same_hash` there is nothing left.** No proof system, no proving key, no setup. This is the mode's whole
argument, and the reason it is preferred.

**Under `linked` the LSP is exposed to the soundness of the linkage proof.** A forged proof for two *unlinked*
hashes makes the LSP open a channel, pay the merchant leg, and then fail to settle the customer hold: a direct
loss. Note carefully who this protects. A backdoored key lets a *merchant* steal from the *LSP*. The ceremony
below is therefore the **LSP's** trust assumption, not the merchant's — the merchant's cost in `linked` is purely
mechanical, bytes and seconds.

Groth16's proving and verification keys are derived from secret randomness that must be destroyed after the
setup. Anyone retaining it can forge a proof for a false statement, and that forged proof **verifies against the
honest key**. Two consequences follow, and they are easy to conflate:

- **A reproducible build does not make the setup trustless.** Publishing the build so anyone can re-derive the
  artifacts proves the `.zkey` and vk match the published circuit — it rules out a backdoored circuit or a
  mismatched key, and it is worth doing. It says nothing about whether the setup's secret was destroyed, because
  that secret is never a build input. The ceremony's own `zkey verify` step likewise checks derivation and the
  contribution chain, not deletion.
- **Security rests on at least one honest contributor** in each of Groth16's two phases.

Phase 1 is handled: the build uses the **public Perpetual Powers of Tau**, which has many independent
contributors and a published transcript, so no phase-1 secret is ours. **Phase 2 — which Groth16 requires
per-circuit — is currently a single contribution and is development-only. It must not be trusted with real
funds.**

Three paths make the claim defensible, in increasing strength:

1. **Run `same_hash` instead.** A second LSP node removes the proof, so the setup stops existing. This needs no
   upstream change and no new cryptography, and it is why `same_hash` is preferred wherever it is available.
2. **A multi-party phase 2.** Independent contributors each extend the key with their own entropy and publish an
   attestation, and the chain is finalised against a public unpredictable beacon. Soundness then needs only
   *one* of them to have been honest. This costs coordination, not runtime: the proving key, proof size, and
   verification are unchanged. See [`CEREMONY.md`](./CEREMONY.md).
3. **No proof at all, on one node.** With PTLCs (adaptor signatures) the second lock is `B = A + t·G` for a
   public tweak `t`, so the linkage is *derivable and verifiable* by anyone with a one-line elliptic-curve check,
   and fulfilling one lock yields the opener of the other. Upstream HTLC interception would remove the hold
   invoice — and with it the second hash — outright. Both are tracked in
   [`upstream-fiber-findings.md`](./upstream-fiber-findings.md).

Everything from here down applies to `linked` only. A `same_hash` deployment can stop reading.

## The linkage circuit

### The statement, and why Poseidon

```text
public:  A (hold hash), B (leg hash)     — each as two 128-bit limbs, so nPublic = 4
private: S                               — 32 bytes
prove:   sha256(S) = B  ∧  sha256(poseidon(S)) = A
```

59,771 constraints, which is why `2^16` is the smallest usable power-of-tau size.

Only the two **invoice** hashes must be SHA-256, because that is how FNN computes `payment_hash`. The derivation
`S → poseidon(S)` is ours to choose and carries **no security weight**: reaching `hold_preimage` means inverting
a SHA-256 either way — `A` directly, or `B` to recover `S`.

Poseidon is chosen for cost. A SHA-256 block costs roughly 30k constraints; Poseidon costs roughly 250. Using
SHA-256 for the derivation would push the circuit past 2^16 into the next power of two, doubling the FFT domain
and, with it, the proving key the merchant must download. The derivation only has to be deterministic and
**distinct from `sha256(S)`** — were it equal, `hold_preimage` would equal the *public* leg hash and anyone could
settle the customer's hold. The JS derivation and `poseidon.circom` must agree exactly; a divergence makes the
circuit unsatisfiable, so it fails at proof generation rather than after the merchant leg is paid.

The two hashes are exposed as four field elements rather than 512 bit-signals: `nPublic = 512` would inflate the
verification key, whose `IC` carries `nPublic + 1` group elements, and make verification a 513-point
multi-scalar multiplication.

**The circuit cannot shrink further.** Both invoice hashes must be SHA-256 in-circuit, and the proof must bind
*both* public hashes to one secret, so two SHA-256 blocks is the floor for any hash-lock construction. Any
algebraic gadget between them costs a rounding error by comparison.

### Artifact distribution

The circuit source is in
[`../packages/protocol/circuits/dual-sha256-linkage`](../packages/protocol/circuits/dual-sha256-linkage);
generated `.zkey` / `.ptau` / `.wasm` / vk files are git-ignored. Integrators do not run the setup — they
download the artifacts. `npm run release` assembles exactly these into `dist/release/` with a `MANIFEST.md` and
`SHA256SUMS`:

| Role | Files | Size (gzipped) | Trust |
|---|---|---|---|
| Merchant (prover) | `linkage.ark` + `linkage.wasm` | 16.1 MB + 2.2 MB | none — pure computation, safe to publish |
| LSP (verifier) | `verification_key.json` | 3.4 KB | inherits the setup's trust (see [Trust model](#trust-model)) |

The proving key ships in two forms. The **`.zkey`** is the ceremony's artifact and the auditable one
(`snarkjs zkey verify` against the `.r1cs` + ptau). The **`.ark`** is that same key in arkworks' native
serialization — what the merchant's wasm prover actually loads, because it skips the snarkjs-format parse and so
proves ~7× faster (see below). The `.ark` is a **reproducibly-derived cache, not a second trust root**: it comes
from `linkage-prover convert <.zkey>`, which is deterministic, so anyone can regenerate it and byte-diff against
the published one. A merchant running the default wasm prover downloads only the `.ark` + `.wasm`; the `.zkey`
is there for auditing and for the native/rapidsnark path. All must be a matched pair from the same setup over
the same circuit — mixing them fails every proof, silently, at the LSP.

**No prover binary is downloaded, and no proof-system library is required on either side.** The merchant drives
[`@fiberlsp/prover-linked`](../packages/prover-linked), which generates the witness in-process and proves with a
**bundled WebAssembly prover** (≈0.6 MB, shipped inside the npm package) — so `linked` proving is a pure
`npm i`. The LSP verifies with `@noble/curves`.

Neither the `.r1cs` nor the ptau ships as a release asset. They are needed only to *audit* the ceremony, and the
ptau must be fetched from its public source rather than any mirror of ours. See [`CEREMONY.md`](./CEREMONY.md).

### Prover footprint

The asymmetry here is uncomfortable, and it is the reason `same_hash` exists: the party with no capital carries
the bulky computation, and the party risking money carries the 3.4 KB key that guards it.

**The prover is not part of the protocol.** A Groth16 proof is three group elements; proofs from different
implementations of the same circuit are indistinguishable, and the LSP neither knows nor cares which one ran.
`proveLinkage` is an injected hook, so the choice is purely local to the merchant — an LSP cannot advertise a
prover, and has no reason to.

The default is the **bundled WebAssembly prover** (arkworks, compiled from `tools/linkage-prover`): it runs
in-process, needs no binary and no native toolchain, and ships inside the npm package. A **native subprocess**
prover is the opt-in (`backend: "native"`) for anyone who wants raw speed. All emit **identical public signals**
and proofs that verify against the same key. Measured in Node over the same circuit and witness:

| Prover | Prove | Key it loads | Needs |
|---|---|---|---|
| **wasm (bundled) — default** | **~2 s** | `.ark` | nothing — pure `npm i` |
| wasm (bundled), from `.zkey` | ~15 s | `.zkey` | nothing — but see below |
| native subprocess — opt-in | **~0.12 s** + key load | `.ark`/`.zkey` | a prover binary (`linkage-prover` / `rapidsnark`) |

The **~2 s vs ~15 s** gap is the whole reason the `.ark` is published. The 13 s difference is almost entirely
`read_zkey` translating the snarkjs format and rebuilding the constraint matrices; the actual proving in wasm is
only ~2 s. Loading the pre-converted `.ark` skips that parse. So the wasm prover loads the `.ark` by default and
falls back to the `.zkey` (at ~15 s) if that is all the merchant has.

The wasm is single-threaded (no `rayon`; the native build keeps parallelism). That makes it slower per proof
than native — but read against the right denominator: a JIT order exists to bring a channel into being, the
on-chain open takes **minutes**, and the proof runs once during that window. On the payment hot path there is no
proving at all. So ~2 s of background compute per channel-open is, in practice, free — and worth trading for a
prover the merchant never has to install. Put differently: **the cost is paid per channel-open, not per
checkout** — once the channel exists, subsequent sales are ordinary routed payments over it.

Two more ways to cut it, neither needing a protocol change:

- **Use `same_hash`.** The cost goes to zero, not down.
- **Prove off the serving path.** The statement mentions only `S` — not the amount, the customer, or the expiry —
  so proofs can be generated ahead of time and consumed at checkout through the `randomBytes` and `proveLinkage`
  hooks. The serving process then loads no proving key at all.

The `.zkey` itself does not shrink. It is `f(nVars, domainSize)` — a property of the circuit, not the prover.

### Verification

The LSP's verifier is `verifyGroth16Bn254` in `@fiberlsp/protocol`: the Groth16 pairing equation over BN254, with
[`@noble/curves`](https://github.com/paulmillr/noble-curves) as its only dependency. It reads the standard circom
Groth16 JSON that every prover above emits, and verifies a proof in ~50 ms against the 3.4 KB key.

The kit therefore carries **no proof-system dependency on either side**. A JIT order is a channel-open, not a hot
path, so 50 ms is free; the memory a faster wasm verifier would resident (hundreds of MB) is not.

Two rejections matter more than the timing, and both are pinned by tests:

- **Public signals must be field-reduced.** `s` and `s + r` are the same field element, so accepting the
  unreduced form would verify one statement while a caller comparing decimal strings believes it verified
  another.
- **G2 points must lie in the r-order subgroup.** BN254's G2 has a large cofactor, so most on-curve points are
  *not* in it, and a pairing against one is meaningless. The test uses a real off-subgroup point rather than an
  off-curve one, because an off-curve point would be rejected for the wrong reason.

## Latency

JIT is atomic but not sub-second: it waits for an on-chain channel open, which takes minutes on testnet. The
customer's payment stays held throughout and refunds if provisioning fails.

Prepaid does not remove this wait — it relocates it to a moment when nobody is waiting. Sub-second JIT on an
*unarranged* payment needs upstream HTLC interception and zero-conf channels.

## Composition model

The flows above are *compositions*, not the only supported paths — the SDK is independent bricks an integrator
wires as needed. Nothing forces a "check inbound → purchase → issue" sequence, and JIT is a swappable strategy,
not a silo.

Receiver bricks, each usable on its own: `InvoiceService` (decomposed into `checkReceiveReadiness` / `issue` /
`receive` / `waitForPayment`), `buyInboundFromLsp` (provisioning as an injectable `ensureInbound` hook),
`PaymentWatcher`, `SettlementLedger`, `LiquidityMonitor`, `StreamingLease`, and the optional `MerchantCheckout`
composer. How a merchant becomes able to receive is itself pluggable behind one `ReceiveStrategy` interface:

| Strategy | How inbound is obtained | Customer pays |
|---|---|---|
| `JitReceive` | channel opens against the held payment | the LSP hold invoice |
| `DirectReceive` (have) | already have inbound | a normal invoice on the merchant node |
| `DirectReceive` + `ensureInbound` (buy) | bought from an LSP first | a normal invoice on the merchant node |
| `autoStrategy({ direct, jit, decide })` | receives directly when inbound already covers the amount, opens JIT when short | depends on the pick |

`ReceiveStrategy.originate(req)` returns a uniform `ReceiveHandle` (payable invoice + `awaitSettlement()` →
`Receipt`), so callers never branch on the mechanism. The server engine is equally unopinionated: stores are
dependency-injected (`Memory*` / `File*`), and the JIT linkage backend is selected through
`selectLinkageVerifiers()`.

### Integration

The merchant drives `JitCheckout` from `@fiberlsp/client`:

```ts
const checkout = new JitCheckout({ rpc: merchantRpc, lspBaseUrl, merchantPubkey, merchantAddress, proveLinkage });
const session = await checkout.checkout({ asset: RUSD, amount: "300000000", expirySeconds: 1800 });
console.log(session.invoice);            // show to the customer
const final = await session.settle();    // waits for leg payment, reveals if needed
```

`session` carries `mode`, `invoice` (the customer hold invoice), `paymentHash` (the hold hash), `netAmount`,
`fee`, `settle()`, and `cancel()`. `proveLinkage` is required only under `linked`; omit it and the client
negotiates `same_hash` when the LSP advertises it.

The LSP runs `JitService` from `@fiberlsp/server`, constructed with its `rpc`, an optional `payRpc` (the second
node — supplying it is what enables `same_hash`), advertised `terms`, `supportedAssets`, an optional
`linkageVerifier` (supplying it is what enables `linked`), an optional `minCapacity` floor to satisfy the
acceptor's UDT auto-accept minimum, an optional persistent `store`, polling controls, and optional
`deliverWebhook` / `onFraud` hooks. It rejects unsupported assets, duplicate active hashes or invoices, invalid
proofs, wrong leg hashes or amounts, payments below `min_payment`, over-capacity requests, and unauthorized
follow-up calls.

`jit.modes` is **derived from deployment, not operator-set**: a verification key at `LINKED_JIT_VK_PATH` enables
`linked`; a second node at `JIT_PAY_FIBER_RPC_URL` enables `same_hash`. The server refuses to start if the paying
node resolves to the same node id as the hold node. The test-only `JIT_ALLOW_UNSAFE_EXPOSED_SECRET=1` mode is
refused alongside a real key, so an operator cannot silently downgrade.

## Discovery

Two layers, the wallet's choice:

1. **Static registry** — `registry/providers.json`, a public phonebook carrying only static identity; live terms
   come from each provider's `/lsp/v1/info`. This is the primary, immediately-orderable path. See
   [`../registry/README.md`](../registry/README.md).
2. **Gossip graph** — Fiber graph reads expose node pubkeys, addresses, and UDT auto-accept config; the SDK
   merges these with the registry by pubkey. Authentic and registry-free, but a newly-announced node is slow to
   become graph-visible (its `node_announcement` lags its `channel_announcement`), so the registry stays the
   dependable default. The gap and the upstream ask are in
   [`upstream-fiber-findings.md`](./upstream-fiber-findings.md).

## Methodology

The design turns entirely on how FNN behaves, so every load-bearing claim above was established by **reading the
FNN v0.9 source and running live testnet nodes**, not by assumption — the funding model, the auto-accept floor,
the peer-dial format, the hold-invoice window, the 32-byte preimage limit, and the single-node hash collision
that produced `same_hash`. Rough edges and missing surfaces found that way are written up as issue drafts and
RFCs for the Fiber team in [`upstream-fiber-findings.md`](./upstream-fiber-findings.md).

The mechanism/policy discipline is applied per component: a sequence is made rigid only where ordering *is* the
safety property; everything else is left injectable.

What is fully working, reference-grade, and production-bound is in the root [`README.md`](../README.md); the
roadmap for the gaps is in [`ROADMAP.md`](../ROADMAP.md).
