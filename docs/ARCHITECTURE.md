# Architecture

Fiber LSP Kit is a **protocol plus a reference implementation** for renting per-asset inbound liquidity on
Fiber. The reusable contract is **LSPS-Fiber**; the server and client SDK are one conforming implementation of
it. This document is the design: the constraint that forces the shape, the decisions taken because of it, the
protocol those decisions produce, and how the pieces compose.

## The constraint that shapes everything

You can only *receive* a Fiber payment over inbound capacity someone has funded toward you, and on Fiber that
capacity is **per-asset** — RUSD inbound is a different thing from CKB inbound. Everything else follows from how
FNN's `open_channel` actually behaves (established against FNN v0.9 source, `crates/fiber-json-types` and
`crates/fiber-lib/src/fiber/network.rs`):

- **The opener funds the channel; the funded balance becomes the *peer's* inbound.** There is no `push_amount`
  and no balance transfer at open. To give a wallet inbound, someone must open a channel *toward* it.
- **UDT auto-accept contributes `0`.** A node auto-accepting an incoming channel adds
  `auto_accept_channel_ckb_funding_amount` for a CKB channel but **nothing** for a UDT channel. So an LSP that
  opens a **UDT channel** hands the client pure per-asset inbound for **zero client capital**.
- **Nothing crosses at open, so a fee cannot be netted from the channel.** It must be paid some other way — and
  that single fact is what makes the choice of provisioning path an architectural decision rather than a detail.

## Design decisions

### JIT is the default provisioning path

There are two ways to give a merchant inbound: sell it up front (**prepaid purchase**), or create it at the
moment a real payment arrives (**JIT**). JIT is the default, and the reason is where the trust has to sit.

In the prepaid path the merchant pays a CKB activation fee and the LSP *then* opens a channel. **Nothing
atomically links the two.** The LSP can take the fee and never open, open something worse, or open and close
immediately. Verifying the fee on-chain does not fix this — it only proves the merchant paid; it gives the
merchant no recourse. Closing that gap needs an escrowed activation bond, which needs a CKB lock script that
does not exist yet (see [`../ROADMAP.md`](../ROADMAP.md)). **The prepaid path is trusted by construction.**

JIT inverts it. The customer pays a hold invoice at the LSP; the LSP can only *keep* that money by settling the
hold, and it can only settle by learning a preimage it obtains by paying the merchant over a freshly opened
channel. Deliver-or-refund is therefore structural, not promised:

| | Prepaid purchase | JIT |
|---|---|---|
| Merchant | **trusts the LSP** with a fee, before any channel exists | trusts nothing — is paid before the LSP can settle |
| Customer | n/a | trusts nothing — held payment either delivers or refunds |
| LSP | trusts nothing | trusts the linkage proof (see *Trust model*, below) |

Prepaid places the risk on the **least sophisticated, least capitalised party** — a cold-start merchant. JIT
moves all residual trust onto the **LSP**: the party with capital, expertise, and a repeated game, risking its
own money. That is the right direction for trust to flow, and it is why JIT leads.

JIT is also better economics for both sides. The merchant never buys capacity it may not use — capacity is
created on demand, sized to a payment that is *already held*. The LSP never speculatively locks capital against
a merchant who may never receive anything. And it dissolves the fee bootstrap entirely (below).

Prepaid purchase remains available as an explicitly optional capability, for a merchant that wants inbound
provisioned ahead of any customer so its first checkout is instant. An LSP advertising it should be clear that
it asks the client to pay before the channel exists.

### The fee is CKB where it must be, and the activation cost migrates into JIT

A client buying inbound holds none of the target asset yet — only CKB — so a CKB fee is the only thing it can
pay, and it keeps the LSP oracle-free. But a zero-capital, auto-accept-0 client also has **no outbound** on the
new channel, so it cannot pay that fee over Fiber at all; the prepaid fee then has to be an out-of-band CKB
payment. That awkwardness exists *only* for prepaid.

Under JIT the fee is simply deducted from the forwarded payment, and the one-time activation cost migrates into
`fee_base`. The three fee components each pay for a distinct thing:

| Component | Pays for | Charged |
|---|---|---|
| `fee_base` | the on-chain open + eventual close, and the risk a merchant makes one sale and leaves | once, netted from the **first** sale |
| streaming `rent` | the *ongoing* cost of the LSP's locked capital | per period, out of revenue |
| `fee_bps` | the forwarding value of each payment | per payment |

This matters concretely. A JIT open locks at least the acceptor's `auto_accept_amount` of liquidity plus a CKB
cell reserve, and costs two on-chain transactions over its life. With `fee_base = 0` a merchant could make one
dust sale and walk, leaving the LSP with the bill — so `fee_base` must cover an open, and `min_payment` must
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

### Protocol first

The product is the LSPS-Fiber contract in `@fiberlsp/protocol` — assets, order/JIT/lease types, fee and rent
math, linkage-proof interfaces. The server and SDK exist to prove the contract runs against real nodes; any
wallet or competing LSP can adopt it to interoperate. LSPS-Fiber adapts Lightning's LSPS1 ("buy a channel") and
adds what Lightning cannot: **per-asset** inbound denominated in a specific UDT.

### Mechanism is rigid; policy is pluggable

The safety-critical *ordering* is fixed — verify the proof before minting a hold, hold the customer payment
before opening, forward before settling, deliver-or-refund. Everything that is *policy* is injected: stores,
pricing, the linkage-proof backend, the receive strategy, the timers. This separation is what makes the kit
reusable rather than a monolith.

### Capital discipline is structural

The LSP can only lose money by paying the merchant leg and then failing to settle the customer hold. So the
engine never opens before the hold is funded, never forwards when too little hold lifetime remains, reads the
on-chain TLC expiry rather than guessing it, and re-drives in-flight orders on restart. Because FNN exposes no
push/subscription for invoice, channel, or payment state, every transition is discovered by polling.

### Discovery is registry-first

A static registry of LSP REST endpoints is the dependable, immediately-orderable path; the gossip graph is a
complementary capability signal that is authentic but slow to converge for a newly-announced node.

## Packages

| Package | Role | Depends on |
|---|---|---|
| `@fiberlsp/protocol` | The LSPS-Fiber contracts: assets, order/JIT/lease/receipt types, fee/rent math, the molecule `Script` encoder, linkage-proof interfaces. | — |
| `@fiberlsp/fiber` | Typed FNN JSON-RPC adapter: invoices, payments, channels, graph reads, peer connection, channel-opening helpers. | `protocol` |
| `@fiberlsp/registry` | Static provider registry + gossip-graph discovery, merged by pubkey. | `protocol`, `fiber` |
| `@fiberlsp/server` | Reference LSP engine + REST API, JIT service (`linked` and `same_hash`), invoice-webhook service, injectable stores. | `protocol`, `fiber` |
| `@fiberlsp/client` | Merchant/wallet SDK: discovery, quote comparison, inbound purchase, invoice checkout, JIT checkout, payment watching, streaming rent, ledger. | `protocol`, `fiber`, `registry` |

A wallet or competing LSP can depend on `protocol` (and `fiber`) alone and ignore the reference server.

## The LSPS-Fiber protocol

Base path `/lsp/v1`; JSON bodies; amounts are decimal strings in the asset's base unit (shannons for CKB);
errors are `{ "error": { "code", "message" } }` with a 4xx/5xx status.

**Assets.** An asset is CKB or a UDT identified by its CKB `Script`. FNN represents a UDT two ways — a `Script`
object (`funding_udt_type_script`) and a molecule-hex string (invoice `udt_script`); the protocol canonicalises
both to the hex so the same asset compares equal regardless of source.

| Endpoint | Purpose |
|---|---|
| `GET /lsp/v1/info` | Provider identity, supported assets, fee modes, lease terms, JIT terms. |
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

## JIT checkout

The LSP receives the customer's hold payment, opens a channel to the merchant, pays the merchant leg invoice,
and settles the customer hold only after the leg has settled. The order of operations is the whole point: the
payment is held safely, the channel is opened, the net amount is forwarded, and only then is the hold settled —
deliver to the merchant, or refund the payer.

### One security property, two ways to get it

**The merchant generates the secret.** The LSP can settle the hold only with a value it does not possess until
the merchant has claimed its leg, so deliver-or-refund is structural. That single sentence is the security
model, and both modes below satisfy it identically.

What differs is how many nodes the LSP runs — and therefore whether a zero-knowledge proof is needed at all.
The LSP advertises what it serves in `LspInfo.jit.modes`; the merchant chooses per order with
`CreateJitOrderRequest.mode`.

| | `linked` | `same_hash` |
|---|---|---|
| LSP nodes | one | two (hold + pay) |
| Invoice hashes | two, proven linked | one, on both legs |
| Merchant artifacts | `.wasm` + `.zkey` (37 MB) | none |
| Merchant work per order | ~2.9 s, ~950 MB RSS | one `sha256` |
| LSP verification | Groth16, ~10 ms | compare two hashes |
| Trusted setup | circuit-specific phase 2 | **none** |
| LSP cost | one node | a second node + capital positioned at it |

`same_hash` is the better trade wherever an LSP can run two processes: it deletes the proof, the proving key,
the circuit, and the ceremony, and moves the residual cost onto the party that is capitalised and in a repeated
game. `linked` remains for an LSP that cannot, and is what a merchant must use against a single-node LSP.

### `linked` — two hashes, one node

One FNN node cannot safely hold `invoice(H)` and also send `payment(H)` — it can mark its own invoice paid and
reject the held TLC. So the hold and the leg use two different hashes derived from one merchant secret `S`. An
FNN invoice preimage is a fixed 32-byte `Hash256`, so both preimages are kept to 32 bytes:

```text
S           = merchant-generated 32-byte secret
leg_hash  B = sha256(S)              (leg invoice;  preimage = S)
hold_hash A = sha256(poseidon(S))    (hold invoice; preimage = poseidon(S))
```

Paying the leg reveals `S`; the LSP derives the hold preimage `poseidon(S)` and settles. Before committing
capital it verifies a proof that `A` and `B` come from one hidden `S`: `groth16-dual-sha256`, a Groth16 proof of
`∃S : sha256(S)=B ∧ sha256(poseidon(S))=A`. The test-only `exposed-secret` scheme reveals `S` and is not a
security model — with `S` in hand the LSP could settle the hold without paying the merchant.

The proof is unavoidable here, and it is worth being precise about why. The derivation runs leg → hold, since
the LSP learns the leg preimage and needs the hold preimage; so whoever knows `S` can compute both. The LSP must
not know the hold preimage before it pays, therefore it must not know `S`, therefore **only the merchant can
prove anything about `S`**. Nor can the relation be checked from `A` and `B` alone: that would require a
homomorphic lock, and SHA-256 annihilates any structure imposed on its preimages. A proof, from the merchant, is
the only remaining option.

Only the two **invoice** hashes must be SHA-256, because that is how FNN computes `payment_hash`. The
derivation is ours to choose and carries no security weight: reaching `hold_preimage` means inverting a
SHA-256 — either `A` directly, or `B` to recover `S`. Poseidon is used purely because it costs ~250
constraints against ~30k for a SHA-256 block, which halves the FFT domain and the proving key (**35 MB rather
than 51 MB** for the merchant). It only has to be deterministic and distinct from `sha256(S)`, or
`hold_preimage` would equal the *public* leg hash and anyone could settle the customer hold. The JS derivation
and `poseidon.circom` must agree exactly; a divergence makes the circuit unsatisfiable, so it fails at proof
generation rather than after the merchant leg is paid.

### `same_hash` — one hash, two nodes

The proof above exists only to work around a *single node's* inability to hold and pay one hash. Two nodes
remove the collision, and with it the entire construction:

```text
S    = merchant-generated 32-byte secret
hash = sha256(S)     (both the customer hold invoice and the merchant leg invoice; preimage = S)
```

The **hold node** mints the customer's hold invoice on `hash`. The **paying node** funds the JIT channel and
pays the merchant's leg invoice, which carries the same `hash`. The merchant claims, revealing `S` to the paying
node; the LSP settles the hold with `S`. There is nothing to prove because there is no relation between two
hashes — there is one hash. `JIT_PAY_FIBER_RPC_URL` names the paying node, and the server refuses to start if it
resolves to the same node as the hold one.

The paying node is cheap: it pays the merchant over the channel it has just funded, a single direct hop, so it
needs on-chain funds — which it already needed, being the funder — and no routing liquidity at all.

Two properties this mode must not lose:

- **Routing disjointness.** One hash is live on two payment routes at once. Any node sitting on *both* the
  customer's route to the hold node and the paying node's route to the merchant would learn `S` from the second
  and could claim on the first. Our topology makes that set empty: the merchant leg always traverses the
  freshly-funded channel with no intermediaries, and the customer's payment is held *before* that channel
  exists, so the merchant cannot yet appear on any route. An LSP that forwards the merchant leg over
  pre-existing hops rather than a fresh direct channel forfeits this argument and must not use this mode.
- **Durable handoff.** The paying node learns `S` and the hold node needs it. If the paying node claims and then
  dies before `S` is persisted, the hold expires, the customer is refunded, and the LSP has paid for nothing.
  This is the same exposure window `linked` has between forwarding and settling, but it now spans a process
  boundary, so `JIT_STORE_PATH` stops being an uptime nicety and becomes load-bearing.

### Timing and expiries

The only way the LSP loses money is to pay the merchant leg and then fail to settle the customer hold, so every
timer is checked against the money-flow rather than assumed:

- **Hold vs open budget.** `createOrder` refuses a hold shorter than one open + one forward + a settle margin,
  and `run()` refuses to pay the merchant when too little hold lifetime remains — it refunds instead.
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
  surfaces the field. Both modes share this. It bounds what JIT guarantees: a merchant that takes the forward
  and never reveals costs the LSP the forwarded amount — the customer is still refunded at expiry, and no proof
  or node topology changes that. Fixing #4 upstream closes it.

### Trust model

JIT is trustless for the customer and the merchant by construction, in both modes.

Under `same_hash` that is the end of it: there is no proof system, no proving key, and no setup, so there is
nothing left to trust. This is the mode's whole argument.

Under `linked` the LSP has one remaining exposure — the **soundness of the linkage proof**. A forged proof for
two *unlinked* hashes makes the LSP open a channel, pay the merchant leg, and then fail to settle the customer
hold: a direct loss. Note who this protects. A backdoored key lets a *merchant* steal from the LSP, so the
ceremony below is the **LSP's** trust assumption, not the merchant's; the merchant's cost in `linked` is purely
mechanical, bytes and seconds.

Groth16's proving and verification keys are derived from secret randomness that must be destroyed after the
setup. Anyone retaining it can forge a proof for a false statement, and that forged proof **verifies against the
honest key**. Two consequences follow, and they are easy to conflate:

- **A reproducible build does not make the setup trustless.** Publishing the build so anyone can re-derive the
  artifacts proves the `.zkey`/vk match the published circuit — it rules out a backdoored circuit or a
  mismatched key, and it is worth doing. It says nothing about whether the setup's secret was destroyed, because
  that secret is never a build input. `snarkjs zkey verify` likewise checks derivation and the contribution
  chain, not deletion.
- **Security rests on at least one honest contributor** in each of Groth16's two phases.

Phase 1 is handled: the build uses the **public Perpetual Powers of Tau**, which has many independent
contributors and a published transcript, so no phase-1 secret is ours. **Phase 2 — which Groth16 requires
per-circuit — is currently a single contribution and is development-only. It must not be trusted with real
funds.** Production needs a multi-party phase 2: independent contributors each running `zkey contribute` and
publishing an attestation, finalised with `zkey beacon` against a public unpredictable value.

Four paths make the claim defensible, in increasing strength:

1. **Run `same_hash` instead.** A second LSP node removes the proof, so the setup stops existing. This needs no
   upstream change and no new cryptography, and it is why `same_hash` is preferred wherever it is available.
2. **A multi-party phase 2.** Independent contributors each extend the key with their own entropy and publish
   an attestation, and the chain is finalised against a public unpredictable beacon. Soundness then needs only
   *one* of them to have been honest. This costs coordination, not runtime: the proving key, proof size, and
   verification are unchanged. See [`CEREMONY.md`](./CEREMONY.md).
3. **A transparent proof system.** Bulletproofs needs no setup at all — its generators are hashed from a public
   seed, so no secret ever existed to destroy — and it drops the merchant's proving key entirely. It is not free:
   the prover is slower in wall-clock, and verification becomes linear in circuit size, moving real CPU onto the
   LSP. That direction is at least coherent, since the setup was the LSP's trust assumption to begin with. The
   obstacle is practical: the circuit is circom over bn254, and adopting this means rebuilding the SHA-256 gadget
   against a different backend and curve.
4. **No proof at all, on one node.** With PTLCs (adaptor signatures) the second lock is `B = A + t·G` for a public
   tweak `t`, so the linkage is *derivable and verifiable* by anyone with a one-line elliptic-curve check, and
   fulfilling one lock yields the opener of the other. Upstream HTLC interception would remove the hold invoice —
   and with it the second hash — outright. Both are tracked in
   [`upstream-fiber-findings.md`](./upstream-fiber-findings.md).

### Artifact distribution

Applies to `linked` only; `same_hash` merchants download nothing.

The circuit source is in
[`../packages/protocol/circuits/dual-sha256-linkage`](../packages/protocol/circuits/dual-sha256-linkage);
generated `.zkey`/`.ptau`/`.wasm`/vk files are git-ignored. Integrators do not run the setup — they download the
artifacts, which should ship as release assets with content hashes (the `.zkey` is tens of megabytes) alongside
a reproducible build and the setup transcript.

| Role | Files | Size | Trust |
|---|---|---|---|
| Merchant (prover) | `dual_sha256_linkage.wasm` + final `.zkey` | 2.2 MB + 35 MB | none — pure computation, safe to publish |
| LSP (verifier) | `verification_key.json` | 4 KB | inherits the setup's trust (see above) |

The `.zkey` and vk must be a matched pair from the same setup and circuit.

### Prover footprint

Applies to `linked` only. The asymmetry is uncomfortable and is the reason `same_hash` exists: the party with no
capital carries the bulky computation, and the party risking money carries the 4 KB key that guards it. Measured
for the shipped circuit (59,771 constraints, 2^16 domain) with snarkjs on Node:

| Step | Time | Peak RSS |
|---|---|---|
| witness generation (the 2.2 MB wasm) | 0.5 s | 94 MB |
| Groth16 prove (the 35 MB zkey) | 2.9 s | **~950 MB** |

**Proving is the whole cost.** The wasm and snarkjs's install size are not the lever, and neither is
parallelism: capping the prover to one core holds RSS at ~930 MB while tripling wall time, because the memory
is field-arithmetic buffers on the main thread rather than per-worker copies. There is no tuning knob.

Read it against the right denominator: a JIT order exists to bring a channel into being, and once it exists
subsequent sales are ordinary routed payments over it. The cost is paid per channel-open, not per checkout.

Three ways to cut it, none needing a protocol change:

- **Use `same_hash`.** The cost goes to zero, not down.
- **Swap the prover.** `proveLinkage` is an injected hook, so a merchant may drive a native Groth16 prover over
  the same `.zkey` and witness instead of snarkjs.
- **Prove off the serving path.** The statement mentions only `S` — not the amount, the customer, or the expiry
  — so proofs can be generated ahead of time and consumed at checkout through the `randomBytes` and
  `proveLinkage` hooks. The serving process then loads no proving key at all.

The circuit itself cannot shrink. Both invoice hashes must be SHA-256 in-circuit, because FNN computes
`payment_hash` that way and the proof has to bind *both* public hashes to one secret — so two SHA-256 blocks
(~59k constraints) is the floor for any hash-lock construction, and any algebraic gadget between them costs a
rounding error by comparison. Poseidon already eliminated the one optional block: it inlines its round constants,
costing 1.6 MB of extra wasm to save 16 MB of proving key and a quarter of the proving time.

### Latency

JIT is atomic but not sub-second: it waits for an on-chain channel open, which takes minutes on testnet. The
customer's payment stays held throughout and refunds if provisioning fails. Note prepaid does not remove this
wait — it relocates it to a moment when nobody is waiting. Sub-second JIT on an *unarranged* payment needs
upstream HTLC interception and zero-conf channels.

### Integration

The merchant drives `JitCheckout` from `@fiberlsp/client`:

```ts
const checkout = new JitCheckout({ rpc: merchantRpc, lspBaseUrl, merchantPubkey, merchantAddress, proveLinkage });
const session = await checkout.checkout({ asset: RUSD, amount: "300000000", expirySeconds: 1800 });
console.log(session.invoice);            // show to the customer
const final = await session.settle();    // waits for leg payment, reveals if needed
```

`session` carries `invoice` (customer hold invoice), `paymentHash` (`hold_hash`), `netAmount`, `fee`,
`settle()`, and `cancel()`. `proveLinkage(holdHash, legHash, secret)` returns the `LinkageProof`.

The LSP runs `JitService` from `@fiberlsp/server`, constructed with its `rpc`, advertised `terms`,
`supportedAssets`, a `linkageVerifier`, an optional `minCapacity` floor (to satisfy the acceptor's UDT
auto-accept minimum), an optional persistent `store`, polling controls, and optional `deliverWebhook` /
`onFraud` hooks. It rejects unsupported assets, duplicate active hashes or invoices, invalid proofs, wrong leg
hashes or amounts, payments below `min_payment`, over-capacity requests, and unauthorized follow-up calls.

Enable JIT by loading a verification key — `LINKED_JIT_VK_PATH=/path/to/verification_key.json`. The test-only
`JIT_ALLOW_UNSAFE_EXPOSED_SECRET=1` mode is refused alongside a real key, so an operator cannot silently
downgrade.

## Composition model

The flows are *compositions*, not the only supported paths — the SDK is independent bricks an integrator wires
as needed. Nothing forces a "check inbound → purchase → issue" sequence, and JIT is a swappable strategy, not a
silo.

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

The design turns entirely on how FNN behaves, so every load-bearing claim was established by **reading the FNN
v0.9 source and running live testnet nodes**, not by assumption — the funding model, the auto-accept floor, the
peer-dial format, the hold-invoice window, the 32-byte preimage limit. Rough edges and missing surfaces found
that way are written up as issue drafts and RFCs for the Fiber team in
[`upstream-fiber-findings.md`](./upstream-fiber-findings.md). The mechanism/policy discipline above is applied
per component: a sequence is made rigid only where ordering is the safety property; everything else is left
injectable.

What is fully working, reference-grade, and production-bound is in the root [`README.md`](../README.md); the
roadmap for the gaps is in [`ROADMAP.md`](../ROADMAP.md).
