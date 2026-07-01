# Fiber LSP Kit

> **Buy inbound liquidity for a Fiber wallet — in any asset, including stablecoins.**

Fiber LSP Kit is the missing **Liquidity Service Provider (LSP)** layer for
[Fiber Network](https://www.fiber.world): a protocol + reference server + client SDK that let a wallet
**buy inbound channel capacity** so it can receive payments — including capacity denominated in a specific
UDT like RUSD, something Lightning-derived tooling structurally cannot do.

It is **infrastructure, not an app** — the LSPS-Fiber protocol is the product; the server is one
conforming implementation.

Built for the **"Gone in 60ms: Fiber Network Infrastructure Hackathon"** (1–15 July 2026).
**Category 3 — Merchant, Liquidity, LSP & Multi-Asset Infrastructure.**

Sibling project to **[Fiber RouteKit](../fiber-routekit)** (Category 1): RouteKit diagnoses *"you can't
receive — no inbound RUSD liquidity"*; **this fixes it.**

📄 See **[`MASTER_PLAN.md`](./MASTER_PLAN.md)** for the full plan and **[`spec/LSPS-Fiber.md`](./spec/LSPS-Fiber.md)**
for the protocol.

---

## What's in the box

| Package | What it is |
|---|---|
| `@fiberlsp/protocol` | The LSPS-Fiber protocol as code — types, fee math, molecule `Script` encoder, typed FNN RPC client. |
| `@fiberlsp/server` | Reference LSP engine + REST API; runs beside an FNN node and provisions inbound channels. |
| `@fiberlsp/client` | Wallet-side SDK — discover providers and `buyInboundLiquidity()`. |

## The flagship flow

```ts
import { LspClient } from "@fiberlsp/client";
import { udtAsset } from "@fiberlsp/protocol";

const RUSD = udtAsset({ code_hash: "0x1142…d21a", hash_type: "type", args: "0x878f…439b" }, "RUSD");
const lsp = new LspClient({ baseUrl: "http://127.0.0.1:8080" });

// A fresh wallet with only CKB buys 100 RUSD of INBOUND capacity.
const order = await lsp.buyInboundLiquidity({
  asset: RUSD,
  amount: "100000000",
  feeMode: "prepaid",              // pay the fee in CKB (the client has no RUSD yet)
  targetPubkey: myNodePubkey,
  targetAddress: "/ip4/127.0.0.1/tcp/8238",
  payFee: async (p) => { if (p.mode === "prepaid") await myWallet.pay(p.fee_invoice); },
});

order.state; // "channel_active" — the wallet can now RECEIVE 100 RUSD
```

The client spent only CKB and never held RUSD. That is impossible on Lightning.

## Quickstart

```bash
npm install
npm run build        # builds all three packages (tsc -b project refs)
npm test             # 20 offline tests through the real RPC code path
npm run server       # start the reference LSP REST API (needs an FNN node; FIBER_RPC_URL, PORT)
```

## How the fee works (grounded in FNN)

FNN's `open_channel` has **no push-at-open**, so an opening fee can't be netted atomically. The fee is
therefore **always CKB** and paid either **prepaid** (before open — the only way to buy pure-UDT inbound
with zero client capital) or **from_capacity** (CKB channels only). See
[`spec/LSPS-Fiber.md`](./spec/LSPS-Fiber.md) §4.

## Status

- Implemented & tested offline (20 tests): protocol/fee/validation, molecule encoder (anchored to
  RouteKit's live-verified RUSD hex), the LSP order lifecycle, REST dispatcher, and the client SDK flow.
- Feasibility confirmed against **FNN v0.9 source**; live 2-node confirmation is the next build step.

## License

MIT (add `LICENSE` before submission).
