# Roadmap

Fiber LSP Kit ships a working protocol, reference server, and client SDK — including the **streaming lease**
(rent in the channel asset out of revenue) and **atomic JIT channels** (hold-invoice provisioning, one merchant
secret linking the customer hold and merchant leg invoice hashes). What's here is honest about being a reference implementation; below
is the path toward something node operators could run in production.

## Near term

- **A linkage setup the LSP can trust — or no setup at all.** `linked` JIT's shipped artifacts are a
  **single-party development setup** that must not be trusted with real funds. A reproducible build proves the
  artifacts match the circuit but says nothing about whether the setup's secret was destroyed. Phase 1 already
  uses the public Perpetual Powers of Tau, so nothing there is ours; the gap is Groth16's circuit-specific
  **phase 2**. The fix is a genuine multi-party phase 2 with published attestations and a final public beacon —
  coordination cost, no runtime cost. See [`docs/CEREMONY.md`](./docs/CEREMONY.md).
  An LSP that runs a second FNN node can serve **`same_hash`** instead and skip all of it: there is no proof, so
  there is no setup. **PTLCs** would delete the SNARK from `linked` too.
- **A `same_hash` LSP that does not depend on the merchant revealing.** The paying node learns the leg preimage
  from the TLC fulfilment, but FNN's `get_payment` does not expose it
  ([finding #4](./docs/upstream-fiber-findings.md)), so the LSP settles from the merchant's `reveal`. A merchant
  that takes the forward and never reveals costs the LSP the forwarded amount. This is true of both JIT modes
  and is fixed upstream, not here.
- **Escrowed activation bond (prepaid path).** The optional pay-before-open purchase flow is trusted by
  construction — nothing binds the client's fee to a channel actually being opened, and verifying the fee
  on-chain does not change that. A CKB lock script escrowing the activation, claimable by the LSP only against a
  live funding cell, is the real fix. (JIT needs none of this: the fee is netted from the first forwarded
  payment.)
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
