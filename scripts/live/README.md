# Live harness — reproduce the whole flow on real fnn nodes

> **This folder is a harness — not part of the published SDK.** The product is the protocol, SDK, registry,
> Fiber adapter, and reference server under `packages/*`; these scripts just *drive* them against live nodes so
> the flow is reproducible. **No nodes to spare?** The 3-terminal staged demo in [`../theater/`](../theater)
> runs the JIT story with a bundled mock-fnn daemon — no real nodes.

Run the whole thing in order, with a preflight, from the repo root:

```bash
npm run demo:live                  # uses the testnet profile
NETWORK=mainnet npm run demo:live  # uses networks/mainnet.json (real funds — see below)
```

Or run any step on its own (they hand state to each other through `.state/`):

```bash
node scripts/live/00-setup.mjs        # (convenience) top up the customer's outbound for headroom
node scripts/live/01-discover-lsp.mjs # merchant's wallet finds an LSP selling inbound (registry + graph)
node scripts/live/02-buy-inbound.mjs  # take the offer → open a public channel (merchant funds 0)
node scripts/live/03-invoice.mjs      # merchant issues an invoice → prints it + saves .state/invoice.json
node scripts/live/04-pay.mjs          # customer pays it, ROUTED via the LSP; webhook + ledger fire
node scripts/live/05-stream-rent.mjs  # merchant STREAMS RENT (keysend) to keep the leased channel alive
node scripts/live/06-jit.mjs          # JIT checkout: hold invoice → LSP opens a channel → forwards → settles
```

| Step | Kit surface | Proves |
|---|---|---|
| `01-discover` | `discoverFromGraph` + `compareQuotes` | a wallet finds LSPs from the registry + **gossip graph**, resolves the endpoint, prices the offer |
| `02-buy-inbound` | `LspClient.buyInboundLiquidity` (REST → server → node) | takes the offer, opens a **public channel**; merchant funds **0** |
| `03-invoice` | `InvoiceService.issue` | a node-native invoice (the QR payload) |
| `04-pay` | `send_payment` + `InvoiceWebhookService` + `SettlementLedger` | customer with no direct channel pays, **routed via the LSP**; webhook + reconciled ledger CSV |
| `05-stream-rent` | `StreamingLease` (keysend rent) | rent streamed **over the same channel** out of revenue; merchant balance ↓, LSP ↑ |
| `06-jit` | `JitCheckout` (`same_hash` or `linked`) | a merchant with **zero channels** gets paid: the first sale buys the channel, deliver-or-refund |

## Configuration: network profiles

All node identities, RPC URLs, the UDT script, and amounts live in **one file per network** under
[`networks/`](./networks). Pick one with `NETWORK=<name>` (default `testnet`); [`lib/profile.mjs`](./lib/profile.mjs)
loads it. There are **no per-script env vars** to remember — edit the profile.

- **Testnet:** [`networks/testnet.json`](./networks/testnet.json) ships ready to go.
- **Mainnet / your own nodes:** copy `testnet.json`, set the mainnet UDT script, your node RPCs/pubkeys, and
  the amounts, then `NETWORK=<yourfile> npm run demo:live`. **This moves real funds** — no mainnet profile is
  shipped so nothing points at real value by accident.

## Prerequisites

> **Getting `fnn`, writing the configs, funding, and peering the nodes is covered step-by-step in
> [`node-setup.md`](./node-setup.md).**

The nodes named in the active profile, running, funded, and peered (**LSP ↔ customer**, **LSP ↔ merchant**).
`06-jit` in `same_hash` mode additionally needs the LSP's **paying node** (`nodes.lspPay`); in `linked` mode it
needs the LSP started with a linkage verification key. Then start the LSP's reference REST server — what a
wallet orders from — pointing it at the profile's LSP node:

```bash
# READY_POLL_* widens the channel-confirmation window — testnet UDT funding can take several minutes.
# Add JIT_PAY_FIBER_RPC_URL to serve same_hash JIT; LINKED_JIT_VK_PATH to serve linked.
FIBER_RPC_URL=http://127.0.0.1:8227 LSP_PUBKEY=<lsp pubkey> LSP_TRUST_SETTLE=1 \
  JIT_PAY_FIBER_RPC_URL=http://127.0.0.1:8257 \
  READY_POLL_ATTEMPTS=150 READY_POLL_INTERVAL_MS=5000 npm run server
```

`LSP_TRUST_SETTLE=1` provisions without an in-Fiber fee payment — the zero-capital merchant pays the CKB fee
**out-of-band** (see the honesty note in the root `README.md`).

`npm run demo:live` runs a **preflight** first: it fails fast if any profile node or the REST server is
unreachable, *before* anything touches chain.

## Notes

- `02-buy-inbound` opens an on-chain channel — allow a couple of minutes; **run it before the camera rolls**.
- `01`/`03`/`04`/`06` are fast — ideal to run live.
- Amounts come from the profile's `amounts` block; change them there, not via env.

Each script prints its step and the resulting order/invoice/payment state as it runs.
