# Demo harness — reproduce the whole flow

> **This folder is a demo / judge-testing harness — not part of the published SDK.** The product is the
> protocol, SDK, registry, Fiber adapter, and reference server under `packages/*`; these scripts just *drive*
> them against live nodes so the flow is reproducible.
> For a zero-setup version, `npm run demo` (repo root) runs the same flow **node-lessly** in ~2 seconds.

Six single-purpose, re-runnable scripts that walk the full merchant lifecycle over the **real kit**:

```bash
node scripts/demo/00-setup.mjs         # (convenience) top up the customer's RUSD outbound for headroom
node scripts/demo/01-discover-lsp.mjs  # merchant's wallet finds an LSP selling RUSD inbound (gossip graph)
node scripts/demo/02-buy-inbound.mjs   # take the offer → open a public RUSD channel (merchant funds 0)
node scripts/demo/03-invoice.mjs       # merchant issues an invoice → prints it + saves .invoice.json
node scripts/demo/04-pay.mjs           # customer pays it, ROUTED via the LSP; webhook + ledger fire
node scripts/demo/05-stream-rent.mjs   # merchant STREAMS RENT (keysend RUSD) to keep the leased channel alive
```

| Step | Kit surface | Proves |
|---|---|---|
| `01-discover` | `discoverFromGraph` + `discoverProviders` + `compareQuotes` | a wallet finds LSPs from the **gossip graph** (registry-free), resolves the endpoint, and prices the offer |
| `02-buy-inbound` | `LspClient.buyInboundLiquidity` (REST → server → node) | takes the offer, opens a **public RUSD channel**; merchant funds **0** |
| `03-invoice` | `InvoiceService.issue` | a node-native RUSD invoice (the QR payload) |
| `04-pay` | `send_payment` + `InvoiceWebhookService` + `SettlementLedger` | customer with no direct channel pays, **routed via the LSP**; webhook + reconciled ledger CSV |
| `05-stream-rent` | `StreamingLease` (keysend rent, `send_payment` `keysend`) | the lease's ongoing phase: rent streamed in **RUSD over the same channel** out of revenue; merchant balance ↓, LSP ↑ (proven live) |

## Prerequisites (do this before recording)

> **Getting `fnn`, writing the configs, funding, and peering the nodes is covered step-by-step in
> [`../../docs/node-setup.md`](../../docs/node-setup.md).** (No nodes to spare? `npm run demo` needs none.)

Three `fnn` nodes running on CKB testnet, funded, and peered:

| Role | RPC | needs |
|---|---|---|
| **LSP** (node#1) | `127.0.0.1:8227` | CKB **+ RUSD** on-chain (funds the inbound it sells) |
| **customer** (node#2) | `127.0.0.1:8237` | RUSD **outbound** toward the LSP — `00-setup` tops this up |
| **merchant** (node#3) | `127.0.0.1:8247` | on-chain **CKB** only (a fresh node needs CKB to stay stable; it funds **0** RUSD) |

Peered: **LSP ↔ customer** and **LSP ↔ merchant**. Then, from the repo root:

```bash
npm run build
# start the LSP's reference REST server (this is what a wallet orders from):
# READY_POLL_* widens the channel-confirmation window — testnet UDT funding can take several minutes.
FIBER_RPC_URL=http://127.0.0.1:8227 LSP_PUBKEY=<node#1 pubkey> LSP_TRUST_SETTLE=1 \
  READY_POLL_ATTEMPTS=150 READY_POLL_INTERVAL_MS=5000 npm run server
```

`LSP_TRUST_SETTLE=1` provisions without an in-Fiber fee payment — the zero-capital merchant pays the CKB fee
**out-of-band** (see the honesty note in the root `README.md`). Node identities/RPCs are set at the top of each
script and overridable via env (`LSP_PUBKEY`, `MERCHANT_RPC`, `LSP_REST`, `AMOUNT`, …).

Single-node JIT is exposed by the SDK/server as `/lsp/v1/jit/*`, but this live demo folder no longer carries
a JIT script because production JIT requires a linkage-proof verifier. See the protocol spec §6 and the
offline JIT tests for the canonical linked-hash flow.

## Notes

- `02-buy-inbound` opens an on-chain channel — allow a couple of minutes; **run it before the camera rolls**.
- `01`/`03`/`04` are fast and deterministic — ideal to run live.
- Amounts are env-overridable, e.g. `AMOUNT=300000000 node scripts/demo/03-invoice.mjs` (3 RUSD).

Each script prints its step and the resulting order/invoice/payment state as it runs.
