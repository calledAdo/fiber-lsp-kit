# LSPS-Fiber — Liquidity Service Provider protocol for Fiber Network

**Status:** Draft v0.1 · **Chain:** CKB (Fiber) · **Transport:** HTTPS/JSON

An LSP (Liquidity Service Provider) sells **inbound liquidity**: it opens and funds a payment channel
*toward* a client so the client can immediately **receive** payments. This is the missing primitive that
lets a fresh Fiber wallet accept money without first acquiring channels.

LSPS-Fiber adapts Lightning's [LSPS1](https://github.com/BitcoinAndLightningLayerSpecs/lsp) ("buy a
channel") to Fiber, and adds the thing Lightning structurally cannot do: **per-asset inbound liquidity**
— buy inbound capacity denominated in a specific UDT (e.g. RUSD), because FNN's `open_channel` funds
channels with a `funding_udt_type_script`.

This document specifies the wire protocol. The reference implementation is `@fiberlsp/server` (LSP side)
and `@fiberlsp/client` (wallet side); the shared types live in `@fiberlsp/protocol`.

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
`supported_assets` (each with `min_capacity`, `max_capacity`, `fee_schedule`), `fee_modes`, and
`order_expiry_seconds`.

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

The client calls this after paying a **prepaid** fee invoice. The LSP (which SHOULD independently verify
the invoice settled against its node) then opens and provisions the channel.

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

> **The fee bootstrap (confirmed on testnet).** An LSP-opened channel where the client contributes 0 leaves
> the client with **0 outbound**, so it cannot pay a fee *over Fiber* from that channel — not a `from_capacity`
> in-channel payment, and not even a `prepaid` Fiber `fee_invoice`. For the genuinely-zero-capital client the
> `prepaid` fee must therefore be an **out-of-band CKB payment**: on-chain to the LSP's address, or routed
> through a pre-existing CKB channel that already gives the client outbound. `from_capacity` only applies when
> the client *actively* dual-funds CKB (giving itself outbound); it does not apply to the auto-accept-0 open.
> An implementation MAY expose the `prepaid` `fee_invoice` as an on-chain address or a Fiber invoice depending
> on whether the client already has outbound. See `LIVE_RESULTS.md`.

## 5. Order lifecycle

```
created ──prepaid──▶ awaiting_payment ──settle──▶ opening ──▶ channel_active
        └─from_capacity──────────────▶ opening ──▶ channel_active
                                                └─▶ failed  (open/ready timeout)
        (unpaid past expires_at) ─────────────────▶ expired
```

`opening` → `channel_active` is driven by the LSP polling `list_channels` for a channel to
`target_pubkey`, in the requested asset, in state `ChannelReady`, whose LSP-side `local_balance` covers
the requested inbound.

## 6. Out of scope (roadmap)

- **JIT channels** (open-on-first-payment via HTLC interception) — not in FNN's RPC surface today.
- **Proportional pricing of UDT channels** — needs a price oracle.
- **Channel lease / duration guarantees, refunds, and dispute flows.**
- **On-chain fee payment** — the MVP settles fees over Fiber; on-chain is a natural addition.

## 7. Reuse

`@fiberlsp/protocol` ships the types, `computeFee`/`validateOrder`, the molecule `Script` encoder, and a
typed FNN RPC client. Any wallet or competing LSP can adopt them to interoperate — the protocol is the
product, the reference server is just one conforming implementation.
