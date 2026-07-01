# Fiber LSP Kit — Master Plan

> **Buy inbound liquidity for a Fiber wallet — in any asset, including stablecoins.**
> The missing liquidity-service layer for Fiber Network.

Built for the **"Gone in 60ms: Fiber Network Infrastructure Hackathon"** (1–15 July 2026).
**Category 3 — Merchant, Liquidity, LSP & Multi-Asset Infrastructure.**

This is the sibling project to **[Fiber RouteKit](../fiber-routekit)** (Category 1). RouteKit *diagnoses*
"you can't receive — you have no inbound RUSD liquidity." **Fiber LSP Kit is the thing that fixes it.**

---

## 1. Thesis

A Fiber wallet can only **receive** a payment if it already has **inbound** channel capacity. A brand-new
wallet has none — the classic Lightning onboarding wall. On Lightning this is solved by **LSPs**
(Liquidity Service Providers) that sell inbound liquidity via the LSPS1/LSPS2 specs. **Fiber has no such
layer** — the showcase inventory has zero liquidity-service projects. This is the biggest genuinely-empty
primitive named in the hackathon brief.

Fiber LSP Kit ships that layer, and does the one thing Lightning LSPs structurally **cannot**:
**per-asset inbound liquidity** — *"buy 100 RUSD of inbound capacity"* — because FNN funds channels with a
`funding_udt_type_script`.

## 2. Why this wins Category 3

- **Least-crowded category.** Prizes are allocated equally per category; Category 3 (Merchant/Liquidity/LSP)
  is historically the least contested. Fewer rivals → better odds.
- **Biggest missing primitive.** An LSP is foundational infrastructure other teams build on — a direct
  judging criterion (reusability, integration potential).
- **A uniquely-Fiber hero.** Per-asset / stablecoin inbound liquidity is impossible on Lightning-derived
  tooling. It is the node's *default* behaviour (UDT auto-accept funds the acceptor `0`).
- **Ecosystem story.** Two submissions, two categories, that reference each other: RouteKit finds the gap,
  LSP Kit fills it. This makes both look more finished and signals a real product direction (grant follow-on).

## 3. What ships

| Package | Name | What it is |
|---|---|---|
| `packages/protocol` | `@fiberlsp/protocol` | **The LSPS-Fiber spec as code** — message types, `computeFee`/`validateOrder`, a spec-exact molecule `Script` encoder + asset identity, and a typed FNN RPC client. The reusable artifact. |
| `packages/lsp-server` | `@fiberlsp/server` | Reference LSP engine + REST API. Runs beside an FNN node, takes orders, opens & provisions inbound channels, per asset. |
| `packages/client` | `@fiberlsp/client` | Wallet-side SDK — discover providers, quote, `buyInboundLiquidity()` end-to-end. |
| `spec/LSPS-Fiber.md` | — | The protocol specification. |
| `registry/providers.json` | — | Open provider-discovery registry (marketplace primitive). |

## 4. Architecture

```
 wallet (client node)                           LSP (server node)
 ┌───────────────────┐   POST /lsp/v1/orders    ┌─────────────────────────┐
 │  @fiberlsp/client │ ───────────────────────▶ │  @fiberlsp/server (Lsp)  │
 │  buyInboundLiq()  │ ◀─── Order (fee quote) ── │  quote → validate → open │
 └─────────┬─────────┘                           └────────────┬────────────┘
           │ pay CKB fee invoice (prepaid)                    │ open_channel(funding_udt_type_script)
           │                                                  │ poll list_channels → ChannelReady
           ▼                                                  ▼
     client's FNN node  ◀────────  new inbound RUSD channel  ────────  LSP's FNN node
```

Everything the server does to the node goes through `@fiberlsp/protocol`'s `FiberChannelRpcClient`, which
accepts an injectable transport — so the whole order→open→ready flow is driven in **offline replay tests**
through the *same code path* that runs live against FNN.

## 5. The fee model (grounded, not hand-waved)

FNN has **no push-at-open**, so an opening fee can't be netted atomically (verified from source). The fee
is therefore **always CKB** (a fresh client only has faucet CKB) and paid one of two ways:

- **`prepaid`** — client settles a CKB fee invoice before the channel opens. Supports the flagship
  pure-UDT-inbound flow with **zero client capital**.
- **`from_capacity`** (CKB channels only) — client dual-funds CKB, pays the fee in-channel after ready.

See [`spec/LSPS-Fiber.md`](./spec/LSPS-Fiber.md) §4. This honesty about FNN's constraints is a feature:
it's what separates real infrastructure from a mock.

## 6. Demo (the money shot)

1. Fresh client wallet: `RouteKit.checkAssetReadiness(RUSD)` → **not ready — no inbound RUSD** (red).
2. `client.buyInboundLiquidity({ asset: RUSD, amount: 100, feeMode: "prepaid" })` → pays a small **CKB**
   fee → LSP opens a **RUSD** channel → funding confirms → `channel_active`.
3. Same wallet: `RouteKit.checkAssetReadiness(RUSD)` → **ready** (green). It can now receive 100 RUSD.

Client spent only CKB. It never held RUSD. That is impossible on Lightning.

## 7. Status

- **Implemented & tested (offline, 20 unit tests):** the protocol types + fee math + order validation, the
  molecule encoder (regression-anchored to RouteKit's live-verified RUSD hex), the LSP order lifecycle
  (prepaid + from_capacity, provision, timeout→failed), the REST dispatcher, and the client SDK's full
  `buyInboundLiquidity` flow — all driven through the real RPC code path via a scripted transport.
- **Feasibility confirmed from FNN v0.9 source:** inbound provisioning, per-asset (UDT) inbound with zero
  client funding (auto-accept asymmetry), and the two fee models. JIT correctly deferred (not in RPC).
- **Next (live-confirm during build):** stand up a second FNN node (the client), fund it from the faucet,
  and prove the 2-node RUSD-inbound-at-zero open end-to-end — the same rigor RouteKit's `test:live` holds.

## 8. Roadmap

- Live 2-node integration test (`test:live`), mirroring RouteKit.
- A tiny marketplace UI over `registry/providers.json` comparing live quotes per asset.
- JIT channels once FNN exposes HTLC interception.
- Channel-lease durations, refunds, on-chain fee payment, and provider reputation.

## 9. Reuse from RouteKit

The molecule `Script` encoder, asset canonicalisation, the FNN hex/BigInt RPC conventions, and the
replay-transport testing discipline are carried over from RouteKit (where they were verified byte-exact
against a live testnet node). This project is self-contained — it vendors those pieces rather than
depending cross-repo — but they are the same battle-tested code.
