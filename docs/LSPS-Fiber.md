# LSPS-Fiber — Liquidity Service Provider protocol for Fiber Network

**Status:** Draft v0.1 · **Chain:** CKB (Fiber) · **Transport:** HTTPS/JSON

An LSP (Liquidity Service Provider) sells **inbound liquidity**: it opens and funds a payment channel
*toward* a client so the client can immediately **receive** payments. This is the missing primitive that
lets a fresh Fiber wallet accept money without first acquiring channels.

LSPS-Fiber adapts Lightning's [LSPS1](https://github.com/BitcoinAndLightningLayerSpecs/lsp) ("buy a
channel") to Fiber, and adds the thing Lightning structurally cannot do: **per-asset inbound liquidity**
— buy inbound capacity denominated in a specific UDT (e.g. RUSD), because FNN's `open_channel` funds
channels with a `funding_udt_type_script`.

This document specifies the wire protocol. The shared contracts live in `@fiberlsp/protocol`; the FNN JSON-RPC
adapter lives in `@fiberlsp/fiber`; static registry and graph discovery live in `@fiberlsp/registry`.
The reference implementation is `@fiberlsp/server` (LSP side) and `@fiberlsp/client` (wallet/merchant side).
For package boundaries and runtime surfaces, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## 1. Grounding in FNN

The protocol is constrained by what FNN (the reference Fiber node, v0.9) actually supports. Verified from
source (`crates/fiber-json-types/src/channel.rs`, `crates/fiber-lib/src/fiber/network.rs`):

- **`open_channel { pubkey, funding_amount, funding_udt_type_script?, public?, … }`** — the opener funds
  the channel; that funded balance becomes the peer's **inbound** capacity. There is **no `push_amount`**
  and no initial-balance transfer at open.
- **Auto-accept is asymmetric for UDT:** when a node auto-accepts an incoming channel, it contributes
  `auto_accept_channel_ckb_funding_amount` for a CKB channel, but **`0` for a UDT channel**. So an LSP
  opening a **UDT channel** gives the client pure per-asset inbound with **zero client capital** — the
  flagship flow, and it is the node's default behaviour.
- Consequence for fees: since nothing crosses at open, an opening fee cannot be netted atomically. The
  fee is therefore either **prepaid** (before open) or paid **from the client's own outbound** right after
  the channel is ready (CKB channels only). See §4.

## 2. Assets

An asset is CKB or a UDT identified by its CKB `Script`. FNN represents a UDT two ways — as a `Script`
object (`funding_udt_type_script`) and as a molecule-hex string (invoice `udt_script`). The protocol
canonicalises both to the molecule hex (`@fiberlsp/protocol` `encodeScript` / `canonicalAssetId`) so the
same asset compares equal regardless of source.

```jsonc
// CKB
{ "kind": "CKB" }
// a UDT (RUSD on testnet)
{ "kind": "UDT", "symbol": "RUSD",
  "udt": { "code_hash": "0x1142…d21a", "hash_type": "type", "args": "0x878f…439b" } }
```

## 3. Endpoints

Base path: `/lsp/v1`. All bodies are JSON. Amounts are **decimal strings** in the asset's base unit
(shannons for CKB). Errors are `{ "error": { "code", "message" } }` with an HTTP 4xx/5xx status.

### `GET /lsp/v1/info` → `LspInfo`

The LSP's self-description: `lsp_pubkey`, `addresses` (multiaddrs to `connect_peer` to), `chain`,
`supported_assets` (each with `min_capacity`, `max_capacity`, `fee_schedule`, and optional `stream` terms
that make it a streaming lease — §5), `fee_modes`, `order_expiry_seconds`, and — when the LSP offers JIT
channels (§6) — `jit` terms (`fee_bps`, `fee_base`, `min_payment`, `max_expiry_seconds`).

JIT endpoints (§6): `POST /lsp/v1/jit/orders` (register an intent → hold invoice), `GET
/lsp/v1/jit/orders/:id`, `POST /lsp/v1/jit/orders/:id/reveal` (`{ preimage }` → settle), and
`POST /lsp/v1/jit/orders/:id/cancel`. The order `GET`, `reveal`, and `cancel` calls require the bearer
`order_token` returned by order creation.

### `POST /lsp/v1/orders` → `Order` (201)

Body = `CreateOrderRequest`:

```jsonc
{
  "target_pubkey": "0x…",           // the client node's pubkey (channel opened toward it)
  "target_address": "/ip4/…/tcp/8238", // optional multiaddr for connect_peer
  "asset": { "kind": "UDT", "symbol": "RUSD", "udt": { … } },
  "lsp_balance": "100000000",        // inbound capacity requested (LSP-funded)
  "client_balance": "0",             // optional client contribution (from_capacity/CKB only)
  "fee_mode": "prepaid",             // "prepaid" | "from_capacity"
  "public": true
}
```

The LSP validates (asset offered, capacity in range, fee-mode legal), quotes the fee, and returns an
`Order`. For `prepaid`, the order starts in `awaiting_payment` and carries a CKB `fee_invoice`. For
`from_capacity`, the LSP opens the channel immediately.

### `GET /lsp/v1/orders/:id` → `Order`

Current order state, including `channel_outpoint` once active.

### `POST /lsp/v1/orders/:id/settle` → `Order`

The client calls this after paying a **prepaid** fee invoice. Before provisioning, the LSP independently
verifies the fee actually settled by polling **`get_invoice { payment_hash }`** on its own node and
requiring `status === "Paid"` — a client cannot obtain inbound liquidity merely by calling `settle`. (The
reference server enables this by default; `LSP_TRUST_SETTLE=1` bypasses it for the zero-capital case
below, where the fee is confirmed out-of-band.)

## 4. Fee models

**The fee is always denominated in CKB**, never the channel asset. A client buying RUSD inbound has no
RUSD yet — only CKB — so a CKB fee is the only thing it can pay. This also keeps the LSP oracle-free.

`fee = base_fee + (channel is CKB ? ceil(proportional_bps · capacity / 10 000) : 0)` shannons. The
proportional term applies only to CKB channels (same unit); UDT channels are charged the flat `base_fee`.

| Mode | When usable | How the fee is paid |
|---|---|---|
| **`prepaid`** | any asset | Client settles a CKB `fee_invoice` **before** the channel opens. The only mode that supports pure-UDT inbound with zero client capital. |
| **`from_capacity`** | **CKB channels only** | Client dual-funds the channel with CKB (`client_balance ≥ fee`); after the channel is ready the client pays the fee to the LSP as an in-channel payment. Approximates LSPS1 "deducted from capacity". |

`from_capacity` is CKB-only because the post-open fee payment must come from the client's outbound *on the
new channel*, which is only CKB when the channel is CKB. A UDT channel cannot pay a CKB fee from itself.

> **The fee bootstrap.** An LSP-opened channel where the client contributes 0 leaves
> the client with **0 outbound**, so it cannot pay a fee *over Fiber* from that channel — not a `from_capacity`
> in-channel payment, and not even a `prepaid` Fiber `fee_invoice`. For the genuinely-zero-capital client the
> `prepaid` fee must therefore be an **out-of-band CKB payment**: on-chain to the LSP's address, or routed
> through a pre-existing CKB channel that already gives the client outbound. `from_capacity` only applies when
> the client *actively* dual-funds CKB (giving itself outbound); it does not apply to the auto-accept-0 open.
> An implementation MAY expose the `prepaid` `fee_invoice` as an on-chain address or a Fiber invoice depending
> on whether the client already has outbound. See [`AI-USAGE.md`](../AI-USAGE.md) for the live-testing findings.

## 5. Streaming lease (the default model)

Inbound liquidity is a **rental**, not a purchase: the LSP locks its own capital in a channel pointed at the
merchant, so its cost scales with *(amount × time)*. LSPS-Fiber therefore models the default offering as a
**two-phase lease**, and an offering advertises it by carrying `stream` terms (§2). A purchase-only offering
(no `stream`) is the degenerate case — activation with no ongoing rent.

**Phase 1 — activation (once, CKB).** The `fee_schedule` fee of §4, now understood as the *first payment*:
it opens the channel, covers the LSP's on-chain funding cost, and is the **minimum stake** to start the
lease. It is paid in CKB because pre-revenue the merchant holds no channel asset — the same bootstrap as §4
(out-of-band CKB for the zero-capital merchant). It is a non-refundable activation, not a refundable bond; a
true escrowed bond needs an on-chain primitive Fiber doesn't expose (§8).

**Phase 2 — streaming (recurring, channel asset).** Once revenue lands, the merchant streams rent to keep
the channel alive. **Rent per period** = `ceil(rate_bps_per_period · capacity / 10 000)`, in the **channel's
own asset** — not CKB. Charging it post-revenue in the leased asset is both possible and oracle-free.
`LeaseTerms = { asset, capacity } & StreamTerms`. The combined price is `quoteLease(offering, capacity) →
{ activation (CKB), stream: { rentPerPeriod (channel asset) } }`.

How rent is paid — and why it needs no new plumbing:

- **By keysend** — the merchant pays the LSP's pubkey with a spontaneous payment; the LSP issues **no
  per-period invoice**.
- **Over the same channel, in the same asset, out of revenue** — once a customer has paid the merchant, the
  merchant holds local balance on the leased channel and streams rent back over it. No second channel, no CKB
  rail. Pre-revenue there is nothing to pay from, so rent naturally **defers to the first sale** (a `dry_run`
  send is the affordability pre-check — FNN builds/prices the route without moving funds).
- **Rebalancing side effect** — paying rent back shifts balance toward the LSP, which **restores the
  merchant's inbound headroom**. Receiving depletes inbound; rent replenishes it. (FNN treats keysend-to-self
  as the native rebalance; this is the same motion aimed at the LSP.)

**Trust properties.** Each period is a normal atomic Fiber payment, so trust is bounded to a single period:
the merchant never pre-pays for uptime it might not get, and an LSP that closes early **forfeits all future
rent** — the incentive to keep the channel open is the rent stream itself. If the merchant misses more than
`grace_periods` consecutive periods, the LSP is entitled to close (the lease has *lapsed*). This aligns
incentives **without** an on-chain enforcement primitive; a cryptographically-enforced minimum lifetime
(à la Lightning Pool) is the stronger version and is tracked as an upstream dependency (§8).

Reference implementation: `LeaseTerms` + `rentPerPeriod` in `@fiberlsp/protocol`; the `StreamingLease`
scheduler (dry-run pre-check → keysend → confirm, with `payDue()` / `start()` / lapse detection) in
`@fiberlsp/client`.

## 6. JIT channels — single-node linked-hash hold provisioning

A merchant with **zero channels** cannot receive its first payment. Lightning's LSPS2 solves this by
intercepting the HTLC mid-flight, opening a channel, and forwarding, but FNN exposes no HTLC-interception
hooks. LSPS-Fiber instead moves the interception point **up one layer, to the invoice**, using FNN hold
invoices and a linked-hash construction that works with one LSP node.

The same-hash design is not safe on one node: a node that holds `invoice(H)` and later sends `payment(H)`
can mark its own invoice paid and reject the held TLC. The canonical JIT flow therefore derives two
different SHA-256 hashes from one merchant secret. An FNN invoice preimage is a fixed 32-byte `Hash256`
(a longer preimage is rejected), so both invoice **preimages are kept to 32 bytes** — the domain-tagged
value is hashed down rather than fed in raw:

```text
S            = merchant-generated 32-byte secret
leg_hash B   = sha256(S)                              (leg invoice; preimage = S, 32 bytes)
P_hold       = sha256("LSPS-FIBER/JIT/HOLD\0" || S) (32-byte hold preimage)
hold_hash A  = sha256(P_hold)
```

Paying the leg reveals `S`; the LSP derives `P_hold = sha256(TAG || S)` and settles the hold. The tag is
essential — without it `P_hold` would be `sha256(S) = B`, which is public, letting anyone settle the hold.
The merchant proves, before the LSP commits capital, that `A` and `B` are linked by one secret without
revealing `S` (statement: `∃S : sha256(S)=B ∧ sha256(sha256(TAG||S))=A`). The reference protocol uses
`LinkageVerifier`; production uses a zero-knowledge proof (`groth16-dual-sha256`). The `exposed-secret`
proof is sound but reveals `S`, so it is test-only and must be explicitly enabled.

**The flow** (`POST /lsp/v1/jit/orders`, reference: `JitService` server-side, `JitCheckout` in the SDK;
see [`JIT-CHECKOUT.md`](./JIT-CHECKOUT.md) for API parameters and setup modes):

```text
1. merchant SDK generates S and derives hold_hash A + leg_hash B
2. merchant SDK issues its own LEG invoice(B, amount - jit_fee, preimage = S)
3. merchant -> LSP: JIT intent { A, B, leg invoice, linkage proof, gross amount }
4. LSP verifies proof, leg hash, leg amount, asset policy and capacity policy
5. LSP returns an order id, bearer order token, and customer-facing HOLD invoice(A, gross amount)
6. customer pays the hold invoice -> funds are held at the LSP node
7. LSP opens a channel to the merchant
8. LSP pays the merchant's leg invoice(B) over the fresh channel
9. LSP learns S, derives P_hold = sha256(TAG || S), and calls settle_invoice(A, P_hold)
10. customer payment flips Success; merchant keeps amount - jit_fee
```

If `get_payment` exposes the settled leg preimage, the LSP settles without a merchant callback. If the node
does not expose it, the merchant SDK calls `POST /lsp/v1/jit/orders/:id/reveal` with the leg preimage `S`
only after its leg invoice is `Paid`. Wrong reveals are rejected and do not change terminal state.

**Deliver-or-refund.** The LSP can only collect the customer's held funds after the merchant leg has paid and
the LSP has a leg preimage that maps to the customer hold hash. If the customer never pays, the order
expires. If opening or forwarding fails, the LSP cancels the hold and the customer is refunded.

**The fee bootstrap dissolves.** The JIT fee is deducted from the forwarded amount, in the channel's own
asset. Combined with the streaming lease (§5), the merchant's first sale can fund channel activation and
future rent without an out-of-band CKB fee. The acceptor of a UDT channel still needs enough on-chain CKB
for its side's cell reserve, and its `auto_accept_amount` floor bounds the minimum channel size.

Latency is honest: this is JIT at **checkout latency** (an on-chain open, minutes on testnet), arranged at
invoice time. Sub-second JIT on a cold, unarranged payment still needs upstream HTLC interception and
zero-conf channels (§8).

## 7. Liquidity order lifecycle

```
created ──prepaid──▶ awaiting_payment ──settle──▶ opening ──▶ channel_active
        └─from_capacity──────────────▶ opening ──▶ channel_active
                                                └─▶ failed  (open/ready timeout)
        (unpaid past expires_at) ─────────────────▶ expired
```

`opening` → `channel_active` is driven by the LSP polling `list_channels` for a channel to
`target_pubkey`, in the requested asset, in state `ChannelReady`, whose LSP-side `local_balance` covers
the requested inbound.

JIT orders use their own lifecycle:

```
created ──customer pays hold──▶ payment_held ──channel opening──▶ opening ──leg payment──▶ forwarding ──reveal/settle──▶ settled
       └─not paid by expiry────────────────────────────────────────────────────────────────────────────────────────────▶ expired
                         └─open/forward failure or merchant cancel──────────────────────────────────────────────────▶ refunded
```

## 8. Out of scope (roadmap)

- **Sub-second JIT on a cold payment** — §6 delivers JIT *semantics* (no prior channel, atomic, fee from
  the forward) at checkout latency, arranged at invoice time. True mid-flight interception of an
  unarranged payment needs HTLC-interception hooks for intermediaries plus zero-conf channels in FNN.
  Three concrete upstream asks fell out of the live work: expose the preimage in `get_payment` (the
  forwarder's node already knows it), stop reusing `HoldTlcTimeout` for the invoice-already-`Paid`
  rejection, and document that a hold invoice's hold window is its expiry (not `DEFAULT_HOLD_TLC_TIMEOUT`,
  which is MPP-only). See [`upstream-fiber-findings.md`](./upstream-fiber-findings.md).
- **Proportional pricing of UDT channels** — needs a price oracle.
- **Cryptographically-enforced lease terms** — the streaming lease (§5) aligns incentives so early close is
  self-defeating, but an *enforced* minimum channel lifetime (à la Lightning Pool) needs upstream Fiber
  support. Refunds and dispute flows sit here too.
- **On-chain fee payment** — the MVP settles the opening fee over Fiber (or out-of-band CKB); a first-class
  on-chain verification path is a natural addition.

## 9. Reuse

`@fiberlsp/protocol` ships the shared contracts: assets, order/JIT/lease/receipt types, fee/rent math,
the molecule `Script` encoder, and linkage proof contracts. Node-facing FNN JSON-RPC helpers live in
`@fiberlsp/fiber`. Any wallet or competing LSP can adopt the contracts to interoperate — the protocol is
the product, the reference server is just one conforming implementation.
