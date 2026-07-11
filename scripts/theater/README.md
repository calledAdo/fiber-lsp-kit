# The 3-terminal demo — one story, three roles

This is the demo to **record** and the demo a judge **runs after forking**. Three terminals play the three
actors in a JIT sale — **LSP**, **merchant**, **customer** — and the payment is real code end to end. The only
thing that changes between "on my laptop" and "on live testnet" is one config field; the commands are identical.

> **The zero-explanation version** is still `npm run demo` (one terminal, ~2 s). This folder is the *staged*
> version, for a video or a hands-on judge who wants to see the roles interact.

## What you need installed

**Node 20+ and npm. Nothing else.** Locally, a bundled **mock-fnn** daemon stands in for real Fiber nodes, so
there is no `fnn`, no faucet, no chain. The ZK is *not* mocked: on a machine where the proving artifacts exist,
the merchant builds a **real Groth16 proof** and the LSP **verifies it in real code**.

## The chain of action

Open three terminals in the repo root. Run these, in order:

| # | Terminal | Command | What it does |
|---|----------|---------|--------------|
| 1 | **LSP** | `npm run demo:lsp` | (local) starts the mock-fnn daemon, then the **real** LSP server. Advertises its JIT modes and then **narrates every order** — including `linkage proof VERIFIED ✓`. Leave it running. |
| 2 | **Merchant** | `npm run demo:merchant` | A wallet with **zero channels**. Builds a real Groth16 linkage proof (when artifacts are present), gets it accepted, and prints the customer's **hold invoice**. Then waits. |
| 3 | **Customer** | `npm run demo:customer` | Reads the hold invoice and pays it. Shows the payment go **Inflight → Success** as the LSP settles. |

Then watch Terminal 1 and Terminal 2 complete the story: the LSP opens a channel, forwards the merchant leg,
and settles the hold; the merchant flips to `SETTLED`. **The first sale bought the channel**, and the customer's
money was refundable until the merchant was actually paid.

What each terminal shows in the `linked` (ZK) run:

```
TERMINAL 1 (LSP)                                  TERMINAL 2 (MERCHANT)
[jit] …  linkage proof VERIFIED ✓ (linked)        [zk] Groth16 proof built in ~2s — sending to the LSP
[jit] …  opening a channel to the merchant…       HOLD INVOICE → show to the customer: fibt_…
[jit] …  forwarding the merchant leg…                       (waiting…)
[jit] …  SETTLED ✓ — merchant paid, hold released ✅ order → SETTLED, channel opened
```

## Local → live is one field

The three commands are **identical** on testnet. All that changes is the profile
([`../live/networks/`](../live/networks)):

| | `local.json` | `testnet.json` |
|---|---|---|
| `fnn` | `"mock"` (daemon stands in) | `"live"` (real nodes) |
| `nodes.*.rpc` | mock ports (`9227`…) | your real node RPCs (`8227`…) |
| `asset.script` | dev RUSD | testnet RUSD |

Run live with `NETWORK=testnet` on each command. The two extra human steps — both **outside** the scripts — are:
**start and fund your `fnn` nodes** (see [`../live/node-setup.md`](../live/node-setup.md)) and select the profile.
On live, `demo:lsp` skips the mock daemon; everything else is the same.

## Which JIT mode you'll see

The merchant negotiates mode exactly like a real wallet, from what the LSP offers and what it can build:

- **`linked` (the ZK path)** — chosen when the LSP advertises it (a verification key is present) **and** the
  merchant has the proving artifacts. This machine has them under the circuit's `build/`, so the flagship runs
  `linked`: a Groth16 proof that the hold and leg invoice hashes share a secret, without revealing it.
- **`same_hash`** — the zero-artifact fallback. A bare fork gets this automatically: a complete JIT sale with
  no proof, no key, no ceremony. Still deliver-or-refund, still one-sale-buys-the-channel.

To get the `linked` ZK path on a fresh clone, build the circuit once (see
[`../../packages/protocol/circuits/dual-sha256-linkage/README.md`](../../packages/protocol/circuits/dual-sha256-linkage/README.md))
so `build/verification_key.json`, the proving key, and the circuit wasm exist; then re-run. Otherwise the demo
runs `same_hash` and needs nothing.

## Pieces

- [`mock-fnn.mjs`](./mock-fnn.mjs) — the local stand-in for Fiber nodes: one JSON-RPC listener per node over a
  shared in-memory network. `fnn: "mock"` only; it refuses to run against a live profile.
- [`lsp.mjs`](./lsp.mjs) · [`merchant.mjs`](./merchant.mjs) · [`customer.mjs`](./customer.mjs) — the three
  terminals, all profile-driven, all identical local vs live.
