# Roadmap

Fiber LSP Kit ships a working protocol, reference server, and client SDK — including the **streaming lease**
(rent in the channel asset out of revenue) and **atomic JIT channels** (hold-invoice provisioning, one merchant
secret linking the customer hold and merchant leg invoice hashes). What's here is honest about being a reference implementation; below
is the path toward something node operators could run in production.

## Near term

- **On-chain fee settlement for the zero-capital client (purchase flow).** The non-JIT purchase flow's
  client has no Fiber outbound and pays the CKB activation fee out-of-band today. Add a first-class
  on-chain-payment verification path (CKB indexer watch keyed by order id) so the whole order is self-serve
  without a pre-existing CKB channel. (The JIT flow already needs no fee bootstrap — the fee is deducted
  from the first forwarded payment.)
- **Persistence hardening.** The file-backed stores survive restarts (orders, invoice watches, JIT orders +
  revealed preimages); move to SQLite/Postgres behind the existing `OrderStore`/`JitStore` interfaces, with
  order expiry sweeping.
- **Operator surface.** Auth + rate-limiting on the REST API, structured logs, and a Prometheus metrics
  endpoint alongside `/lsp/v1/liquidity`. For JIT: a resume-on-boot pass over non-terminal orders (the
  crash-safety data is already persisted).
- **Lease lapse enforcement.** `StreamingLease` detects a lapsed lease client-side; add the LSP-side
  counterpart (rent watcher per leased channel → close after `grace_periods`).

## Medium term

- **Liquidity marketplace.** Grow the provider registry into a real discovery layer; the client SDK already
  compares quotes across LSPs (`compareQuotes`). Add reputation/uptime signals.
- **Gossip-graph discovery as a first-class path.** Registry is the primary discovery mechanism today; graph
  discovery (`discoverFromGraph`) works for established nodes but a newly-announced LSP is not graph-visible
  for a long time because its `node_announcement` (carrying the auto-accept capability) lags its
  `channel_announcement` (upstream finding #10). Make graph discovery dependable for newcomers — pushing the
  upstream re-broadcast fix and a native LSP-capability advertisement (finding #3) — so the gossip graph can
  stand on its own as a registry-free discovery layer.
- **More assets.** Any UDT works today; add curated offerings and per-asset floors sourced from each
  client node's `auto_accept_amount`.
- **On-chain-enforced lease terms.** A Fiber channel *is* a live CKB cell, and CKB requires cell-deps to be
  live at commit — so "this channel is still open" is provable on-chain with no oracle. A small lock script
  can escrow a lease bond claimable by the LSP only after N epochs *with the funding outpoint as a live
  cell-dep* (else refundable to the merchant): a cryptographically-enforced minimum channel lifetime,
  Lightning-Pool-style, using only L1. Design sketched; needs a deployed script + audit.
- **Sub-second JIT.** Today's JIT is atomic but runs at checkout latency (an on-chain open, held safely
  mid-payment). Sub-second JIT on *unarranged* payments needs upstream HTLC interception + zero-conf
  channels — RFC sketched in the findings doc.

## Upstream

The rough edges and missing surfaces we hit live are written up as issue drafts + an RFC in
[`docs/upstream-fiber-findings.md`](./docs/upstream-fiber-findings.md) for the Fiber team — including
`get_payment` preimage exposure, hold-invoice documentation, and the interception hooks above. Landing
those makes the provisioning path more robust for every LSP, not just this one.

## Continuation

The intent is to take the reference server to a production-grade, operator-runnable LSP — the piece the Fiber
ecosystem needs before wallets can offer one-tap "receive any asset."
