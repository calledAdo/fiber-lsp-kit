# Upstream FNN findings

While building Fiber LSP Kit we drove four live FNN nodes (`v0.9.0-rc5`) on CKB testnet through channel
opening, streaming rent, hold-invoice JIT, graph discovery, and routed-payment probes. This document contains
only confirmed runtime bugs, concrete integration-DX observations, and proposals for unavailable capabilities.

The live reproductions remain scoped to **`v0.9.0-rc5`**. Current availability was re-audited on 2026-07-14
against official `develop` commit
[`04e091b`](https://github.com/nervosnetwork/fiber/commit/04e091b08953368aa5ee977f562ad628c3000ff4)
and the generated RPC documentation at that commit. Source inspection is used to establish API availability
and version context; it is never used by itself to claim that a runtime bug occurs or has been fixed.

- **Confirmed bug:** reproduced against live FNN nodes. The claim applies only to the named node version.
- **Confirmed DX observation:** measured through live RPCs or directly visible in the public API/documentation.
- **Proposal:** current source/docs show that the requested capability is unavailable; no runtime bug is implied.

---

## 1. Redundant `connect_peer` can crash the acceptor's gossip actor (`ActorAlreadyRegistered`)

**Type:** confirmed bug.

**Evidence:** reproduced on live `v0.9.0-rc5` nodes by dialing an already-connected peer twice, followed by the
`ActorAlreadyRegistered` panic and failed `open_channel` feature check described below.

**Version note:** current `develop` has substantially different peer-connect/reconnect handling. Retest before
filing against a newer release; this document does not claim the bug still occurs there.

**Severity:** medium (node-side panic; recoverable by restart, but a single client action triggers it)

**What happens.** Calling `connect_peer` toward a peer the node is *already* connected to can panic the
acceptor's gossip actor with `ActorAlreadyRegistered` (observed in `gossip.rs`). Once panicked, the node
stops completing the Fiber `Init` handshake for that peer, so a subsequent `open_channel` fails with
*"peer's feature not found, waiting for Init"* until the node is restarted.

**Repro.**
1. Nodes A and B, already connected (A dialed B once with a correct `/p2p/<peer-id>` multiaddr).
2. Call `connect_peer` on A toward B a second time (e.g. a client that reconnects before every order).
3. A's gossip actor panics (`ActorAlreadyRegistered`); `open_channel` A→B then fails on the Init check.

**Expected.** `connect_peer` to an already-connected peer should be a no-op (idempotent), not panic an
actor.

**Workaround we adopted.** Our channel-open helper (`openChannelAndAwait`, used by both the prepaid and JIT
paths) calls `list_peers` first and skips `connect_peer` when already peered.

---

## 2. A UDT `open_channel` funded *below* the acceptor's `auto_accept_amount` stalls silently

**Type:** confirmed DX observation.

**Evidence:** reproduced on live `v0.9.0-rc5` testnet nodes with 5 RUSD below a 10 RUSD auto-accept floor;
the opener remained in `NegotiatingFunding`, while 10 RUSD reached `ChannelReady`.

**Current availability:** current FNN documents the floor, logs that a below-floor request awaits manual
acceptance, and exposes pending channels to the acceptor. The opener still receives no machine-readable
"not auto-accepted" result, so automation must preflight the announced floor or time out.

**Severity:** medium (poor DX; the opener gets no error, only an indefinite `NegotiatingFunding`)

**What happens.** `is_udt_type_auto_accept` (in `ckb/contracts.rs`) accepts only when
`funding_amount >= auto_accept_amount`. If an opener funds a UDT channel *below* that floor, the acceptor
does **not** auto-accept and emits only a WARN — the opener's channel sits in `NegotiatingFunding`
indefinitely with no error surfaced back to it.

**Repro (testnet RUSD, `auto_accept_amount` = 10 RUSD / `1e9`).**
1. A opens a RUSD channel to B funding **5 RUSD** (`funding_amount` `0x1dcd6500`).
2. B logs a WARN and never accepts; A's channel stays in `NegotiatingFunding`.
3. Fund **10 RUSD** instead → accepted, `ChannelReady`.

**Expected.** The opener should receive an explicit error (e.g. "funding below peer's auto-accept
minimum for this asset"), rather than an open-ended pending state.

**Workaround we adopted.** The LSP never quotes a UDT capacity below the client's per-asset floor, and
`abandon_channel { channel_id }` clears a stuck `NegotiatingFunding` channel.

---

## 3. Advertise LSP-provider capability natively in the gossip graph

**Type:** proposal.

**Availability evidence:** the audited `NodeAnnouncement` carries node-signed addresses, features, and UDT
configuration, but no LSP-service flag or REST endpoint. This is an absent capability, not a runtime bug.

**Motivation.** Fiber already gossips most of what a client needs to *discover* a liquidity provider. Each
node announcement (`graph_nodes` → `NodeInfo`) carries `addresses`, `auto_accept_min_ckb_funding_amount`,
and per-UDT `udt_cfg_infos` (`{ name, script, auto_accept_amount }`). This is a real capability signal, not
incidental metadata — FNN's own channel-opener already reads it to predict auto-accept
(`log_sender_udt_funding_warning` / `log_sender_ckb_funding_warning` in `fiber/network.rs`). So a client can
*already* scan the graph and find every reachable node that speaks a given asset and the minimum it will
auto-accept, with **no central registry**.

Two pieces are still missing to make discovery fully graph-native, which today forces an out-of-band
registry:

1. an explicit **"I offer inbound liquidity as a service"** signal (auto-accepting a channel ≠ selling one),
2. the provider's **order endpoint** (the graph carries p2p multiaddrs, not the LSP REST/LSPS URL).

**Proposal A — a feature flag (smallest change).** Add an enabled-feature name (e.g. `LspProvider`) that
surfaces in `NodeInfo.features` (already produced by `enabled_features_names()` in `rpc/graph.rs`). Clients
filter `graph_nodes` by it to get the candidate set; the endpoint is then resolved by convention (e.g. an
advertised HTTP address + a well-known `/lsp/v1` path). Zero new schema — just a bit and a naming convention.

**Proposal B — an optional service descriptor (fully native).** Add one optional, size-bounded field to the
node announcement carrying an LSP descriptor: `{ endpoint, assets[], min/max, fee_summary }`. Discovery then
needs only `graph_nodes` — no registry, no convention. Price stays advisory: clients still confirm the live
quote against the endpoint before ordering.

**Security / spam.** A node-announcement signature binds the descriptor to a node key; it does not establish
reputation, uniqueness, or available capital. Bound the descriptor size, treat advertised fees as non-binding,
and let clients apply their own allowlists/reputation before requesting live terms. This matches how
`udt_cfg_infos` should be consumed today.

**Why it's implement-ready on the client side.** Fiber LSP Kit's discovery already reads `graph_nodes` for
capability (`discoverFromGraph`) and is written to honour exactly such a flag the moment it lands — a
`requireLspFeature` filter and a configurable feature name. Merged discovery (`discoverProviders`) unions
graph capability with registry endpoints today and would collapse onto the graph alone under Proposal B.

---

### Additional live-confirmed setup observations

- **Dialing an unannounced peer needs `/p2p/<peer-id>`**, where `peer-id = base58btc(0x1220 ‖
  sha256(33-byte compressed pubkey))` — not the hex node pubkey. A bare transport multiaddr connects but
  never completes `Init`. A short note in the `connect_peer` docs would save integrators a lot of time.
- A first-boot node **migrates a plaintext-hex `ckb/key` to an encrypted keystore** and does not
  auto-generate one; documenting the expected key material would smooth onboarding.

---

## 4. `get_payment` does not expose the settled payment's preimage

**Type:** confirmed DX observation.

**Evidence:** on live `v0.9.0-rc5`, a successful outgoing payment's `get_payment` result omitted the preimage;
an armed `subscribe_store_changes` listener received `PutPreimage`, while a later subscriber could not replay
the settled event.

**Current availability:** the audited `GetPaymentCommandResult` still omits the preimage. The opt-in
`subscribe_store_changes` module still emits live `PutPreimage` events without a cursor or replay API.

**Severity:** medium (durable value exists but has no replayable/readable RPC surface)

**What happens.** When an outgoing payment settles, the paying node cryptographically *learns the
preimage* (the TLC fulfillment carries it), but `get_payment` returns only
`{ payment_hash, status, created_at, last_updated_at, failed_error, fee, custom_records, routers }` — the
preimage is in the node's store but absent from every payment read RPC. FNN `v0.9.0-rc5` does have an opt-in
WebSocket `subscribe_store_changes` method: it emits `PutPreimage { payment_hash, payment_preimage }` live.
That module is disabled by default and has no cursor, history, or replay. A fresh subscriber receives no event
for an already-settled payment, even though the preimage remains durable in the node store.

**Why it matters.** Hold-invoice choreography (LSPS2-style JIT, submarine-swap-like flows) needs the
forwarder to *relay* the preimage: node B pays `invoice(H)`, learns `P`, and a coordinating process calls
`settle_invoice(H, P)` on node A. A process can capture `P` from the live store-change stream if it subscribes
before paying, but a disconnect between node persistence and application persistence cannot be repaired. An
out-of-band payee reveal is still needed for that failure window.

**Ask.** Add `payment_preimage` (present when `status == "Success"`) to `GetPaymentCommandResult`, or expose an
authenticated `get_preimage(payment_hash)` read. Either closes the restart/disconnect gap while retaining
`subscribe_store_changes` for low-latency delivery.

---

## 5. One node holding and paying the same hash silently loses funds; the error names it `HoldTlcTimeout`

**Type:** confirmed bug.

**Evidence:** reproduced end to end on live `v0.9.0-rc5` testnet nodes: the local outbound payment succeeded,
the local held invoice changed to `Paid`, and the original payer failed with `HoldTlcTimeout`, producing the
balance loss described below.

**Version note:** current source has new received-hold settlement logic. Retest on a newer release; source
inspection alone cannot establish whether the runtime ordering or loss still occurs.

**Severity:** medium (silent fund loss on the paying node; the misleading code hides why)

**What happens.** A node that holds `invoice(H)` and also *sends* `payment(H)` has its outbound settlement
mark its **own** invoice `Paid` without ever fulfilling the held inbound TLC. `send_payment` returns no
error. In `settle_tlc_set_command.rs` the held TLC is then rejected with `TlcErrorCode::HoldTlcTimeout` —
the same code as a real hold-window timeout, fired here ~40 s into a 120 s window.

**Repro (measured live on testnet, v0.9.0-rc5).**
1. Node L creates a hold invoice for hash `H` (hash-only `new_invoice`); a payer pays it → TLC held,
   `get_invoice` → `Received`, one `pending_tlcs` entry carrying `H`.
2. L pays a *different* node's invoice with the same hash `H`. `send_payment` is **accepted** and reaches
   `Success`.
3. L's own invoice flips to `Paid` with no `settle_invoice` call, `cancel_invoice` then refuses ("invoice can
   not be canceled, current status: Paid"), and the payer's payment ends `Failed / HoldTlcTimeout`.

**Effect.** The payee is paid, the payer is refunded, and **L is out the full amount** — with no error at any
call site. For a JIT LSP this is precisely the loss the whole construction exists to prevent.

**Ask.** Reject `send_payment` when the node holds an unsettled invoice for the same `payment_hash`, or
namespace the invoice and payment stores so the outbound fulfilment cannot mark an inbound invoice `Paid`.
Separately, give the TLC rejection a distinct code (e.g. `InvoiceAlreadyPaid`): the semantics ("this node
can't be both hold-payee and payer for one hash") are legitimate, but the current name hides them.

**Note.** The constraint is **per node**, and that is load-bearing for us: with a second node holding while a
first pays, the same hash secures both invoice payments safely (verified live — the hold stayed `Received` and settled from
the merchant preimage). That is the `same_hash` JIT mode, and it is why it needs no linkage proof at all.

---

## 6. A hold invoice's hold window is its *expiry* — `DEFAULT_HOLD_TLC_TIMEOUT` is MPP-only

**Type:** confirmed DX observation.

**Evidence:** on live `v0.9.0-rc5`, a held TLC survived beyond seven minutes and settled successfully after
155 seconds; cancellation after `Received` also worked when the same node was not holding and paying the hash.
The public hold-invoice and `cancel_invoice` pages disagree about the allowed cancellation states.

**Current availability:** current channel code derives the deadline from `min(invoice expiry, TLC expiry)`.
The generated `cancel_invoice` page still says only `Open` can be cancelled, while the implementation rejects
only `Paid` and `Cancelled` and therefore accepts `Received` and `Expired`.

**Severity:** docs

**What we measured.** A held TLC on a hash-only invoice survives far beyond the 120 s
`DEFAULT_HOLD_TLC_TIMEOUT` (we held >7 minutes and settled cleanly at 155 s with `settle_invoice`).
Reading `channel.rs` confirms it: for a hold invoice the hold expiry is `min(invoice expiry, TLC expiry)`
("ensure the expiry is large enough for manual settlement via RPC"); the 120 s constant only bounds MPP
partial sets on preimage-known invoices.

**Why it matters.** This is a *feature* — a generous, caller-controlled hold window is exactly what makes
hold-invoice provisioning (a JIT channel's on-chain open takes minutes) viable — but the window semantics are
undocumented and the constant's name invites the wrong conclusion.

**Upstream state (checked against `develop`, 2026-07-14).** The RPC README now *does* document the basic
hold-invoice lifecycle — a `payment_hash`-only invoice as a hold invoice ("the tlc must be accepted and held
until the preimage becomes known"), `settle_invoice` / `cancel_invoice`, and the `Received` status. So the
lifecycle half of this finding is largely addressed. What is still undocumented is the **window**.

**Ask (narrowed).** Document that a hold TLC lives until the **invoice expiry** (`min(invoice expiry, TLC
expiry)`), and that `DEFAULT_HOLD_TLC_TIMEOUT` (120 s) bounds only **MPP partial sets** on preimage-known
invoices — it is *not* the hold window. As written, the constant's name reads as the hold ceiling and misleads
integrators into under-sizing hold invoices.

**Also tracking — a `cancel_invoice` state inconsistency (docs vs docs).** The hold-invoice *concept* page
says a hold invoice may be cancelled in `Open`, `Received`, or `Expired`; the `cancel_invoice` *API* page
says cancellation only applies in `Open`. Our refund path assumes cancel-after-`Received` works (finding 5
observed it working live once the same hash isn't held+paid on one node). The two upstream pages disagree, so
until it's reconciled, treat cancel-after-`Received` as *observed-working-but-unspecified* and don't rely on
it across FNN versions without a live check.

---

## 7. HTLC interception and zero-confirmation channels for subsecond JIT

**Type:** proposal.

**Availability evidence:** no intermediary TLC-interception RPC or zero-confirmation channel option exists in
the audited source. This proposes new behavior rather than reporting a runtime failure.

Our kit ships JIT channels at *checkout latency* by holding the payer's funds in a hold invoice while the
channel opens on-chain (see `ARCHITECTURE.md`). Matching Lightning LSPS2's *sub-second* JIT for a
payment with **no prior arrangement** needs two upstream pieces: (a) an interception hook for
*intermediaries* — let a registered process pause an incoming forward whose next hop doesn't exist and
resume/fail it later (today's hold applies only to the final payee's invoice, and a single node cannot
hold and forward one hash — finding 5); (b) zero-conf channels, so the forward can complete before the
funding tx confirms. With both, the invoice-layer arrangement disappears and JIT becomes transparent to
the payer's wallet.

---

## 8. Add typed, replayable invoice, channel, and payment lifecycle subscriptions

**Type:** proposal.

**Availability evidence:** FNN has low-level `subscribe_store_changes`, including invoice-status,
payment-session, attempt, and preimage records, but no stable typed lifecycle contract, replay cursor, or
channel-ready event. The kit uses the preimage event where its shape is sufficient and polls public RPC state
for the other transitions.

**Severity:** low (works, but leaves lifecycle consumers on raw internal events plus polling)

**What happens.** `subscribe_store_changes` can report raw invoice-status, payment-session, payment-attempt, and
preimage writes. It is useful for low-latency observation (the kit consumes `PutPreimage`), but it is not in the
generated public RPC reference, has no cursor/replay, and emits no channel-ready store change. A consumer can
couple itself to the raw enum to reduce invoice/payment polling, but still needs `list_channels` polling and a
reconciliation read after disconnects.

**Why it matters.** Polling is workable (parked `await`s, batchable into one shared watcher across orders), but
the current split forces each integrator to decide which internal changes are safe to consume and how to repair
missed events. A public lifecycle stream would reduce RPC load without making correctness depend on an
unreplayable internal feed.

**Ask.** Promote stable invoice, channel, and payment lifecycle events to a documented subscription with a
cursor/replay or an explicit snapshot-then-subscribe contract.

---

## 9. `list_payments` / `get_payment` don't return `amount` or `udt_type_script`

**Type:** confirmed DX observation.

**Evidence:** live `v0.9.0-rc5` `list_payments` and `get_payment` responses for settled UDT payments omitted
both amount and asset while retaining status and fee.

**Current availability:** the audited `GetPaymentCommandResult` still has no amount or asset. Internal
`PaymentSession.request` retains both values, so the omission remains in the RPC projection.

**Severity:** low-medium (blocks node-level accounting; workaround exists via invoices)

**What happens.** Probed live against v0.9.0-rc5 (testnet, 2026-07-12): both `list_payments` and
`get_payment` return `{ payment_hash, status, created_at, last_updated_at, failed_error, fee,
custom_records }` for every payment observed — including settled UDT payments — with **no `amount` and no
`udt_type_script` field**. Current generated docs accurately list the reduced result, but the send request and
internal `PaymentSession.request` retain the omitted values. `fee` and `status` are present and reliable.

**Why it matters.** A node's own payment ledger is the natural place to reconcile what an LSP (or any
integrator) has actually paid out — total forwarded per asset, fees earned, a P&L — without maintaining a
separate in-memory or DB ledger that a restart can lose. Without `amount`/asset on the payment record, that
reconciliation isn't possible from `list_payments` alone; a caller has to keep its own record of what each
`payment_hash` was for (e.g. by remembering the invoice it paid), defeating the point of having a durable
node-side ledger. We hit this building `LspLedger` (`packages/lsp-server/src/ledger.ts`): fee/count/status
aggregation works; per-asset amount totals silently read zero against a live node.

**Ask.** Populate `amount` and `udt_type_script` (or an asset identifier) on `list_payments`/`get_payment`
records — from the invoice when one was paid, from the `send_payment` args for a keysend — so the payment
ledger is self-sufficient for accounting.

---

## 10. PTLCs would remove the single-node linkage proof

**Type:** proposal.

**Availability evidence:** the audited invoice/TLC types still use hash locks and `HashAlgorithm`; no
point-lock or adaptor-signature TLC is implemented. This is a protocol proposal, not a runtime bug.

**Severity:** low (enhancement; unlocks a cleaner construction)

**Context.** We showed single-node atomic JIT is possible today by deriving two hashes from one merchant
secret, kept to the 32-byte preimage a live node accepts (`B = sha256(S)`, `A = sha256(poseidon(S))`),
but it needs an extra proof that A and B are linked by the same hidden secret. Hashes are not homomorphic: there is no public `convert(A) → B` without
knowing the secret, and no way to *verify* the linkage without a ZK proof or a fraud bond.

**What PTLCs give.** With point (adaptor) locks instead of hash locks, a lock is `A = a·G`. A second lock
`B = A + t·G` for a public tweak `t` is both **derivable and verifiable** from `A` by anyone (`B − A = t·G`),
and fulfilling A (revealing `a`) automatically yields the opener of B (`a + t`). That is exactly the
"convert one lock to another without the secret" that hashes cannot do — the linkage becomes a one-line
elliptic-curve check, no SNARK, no bond. Single-node JIT (and cross-currency swaps, and multi-hop privacy)
all get simpler.

**Upstream state (checked 2026-07-14).** Fiber already lists the HTLC→PTLC migration in its cross-chain-hub
future plan ([discussion #1243](https://github.com/nervosnetwork/fiber/discussions/1243)) and is keeping the
CCH interface hash-algorithm-agnostic to ease it — but it is **not implemented**: the `develop` TLC types are
still hash locks (`payment_hash` + `HashAlgorithm ∈ { CkbHash, Sha256 }`), and there is no adaptor-signature
lock. So the direction is acknowledged; the work is not yet done.

**Ask.** Prioritize adaptor-signature TLCs. Proof-free single-node JIT (above) is one concrete construction
that a point-lock unlocks — the A↔B linkage collapses from a Groth16 proof to a one-line `B − A = t·G` check.
Bitcoin Lightning is making the same HTLC→PTLC move; CKB's Schnorr-friendly stack makes it natural here too.

---

## 11. `node_announcement` propagation lagged `channel_announcement` on rc5

**Type:** confirmed bug.

**Evidence:** reproduced on live `v0.9.0-rc5` testnet nodes: the channel announcement propagated within
minutes, while the same node remained absent from directly connected peers' `graph_nodes` for more than
15 minutes.

**Version note:** current `develop` broadcasts a node announcement on peer connection when announced addresses
are configured. Retest on a newer release; this document does not claim the rc5 propagation bug persists.

**Severity:** medium (breaks graph-based discovery of a newly-online provider)

**Context.** Capability discovery (which UDTs a node auto-accepts, its addresses) reads `graph_nodes` — i.e. it
depends on the node's `node_announcement`. On a freshly (re)started node we observed the two gossip messages
propagate very differently.

**Repro (measured live on testnet).**
1. Boot a funded node N that has one **public** `ChannelReady` channel and is directly peered with a
   well-connected node L.
2. From L's and a third node's RPC, poll `graph_channels` and `graph_nodes` for N.
3. Within a couple of minutes N's **`channel_announcement` is present** in peers' `graph_channels`, but its
   **`node_announcement` is absent** from `graph_nodes` — **even on L, which is directly connected to N** —
   and stays absent for 15+ minutes.

**Effect.** `graph_channels` shows an edge touching N, but there is no node record carrying N's
`udt_cfg_infos`/addresses, so `discoverFromGraph`-style capability discovery cannot surface N at all. A newly
announced LSP is therefore not graph-discoverable for a long time, even though it is fully operational and
orderable via its REST endpoint immediately. (This is the concrete reason our SDK treats the static registry as
the default discovery path and the gossip graph as a slower, node-signed corroborating layer — see finding #3.)

**Ask.** Re-broadcast `node_announcement` more eagerly — at least when a node's first `channel_announcement`
becomes relayable and on new peer connections — and/or relay a buffered `node_announcement` to peers once the
supporting channel is known, so capability discovery converges on roughly the same timescale as channel
discovery. Relates to #3 (native LSP capability advertisement) and #8 (no push/subscription surface).

## 12. Inbound no-channel-peer protection blocked an rc5 JIT open to a brand-new node

**Type:** confirmed bug.

**Evidence:** reproduced with byte-identical live `v0.9.0-rc5` nodes: both peers reported a connection, but
the funder's `open_channel` failed with `feature not found`; logs showed the fresh no-channel session being
evicted and reconnecting repeatedly. The shipped reconnect workaround then completed the JIT flow live.

**Version note:** current peer admission, pending-channel persistence, and reconnect code has materially
changed. Retest before filing against a newer release; the confirmed claim remains scoped to rc5.

**Symptom.** An LSP (funder) tries to `open_channel` to a freshly-started node that has **no channel yet** — the
exact case JIT/LSP provisioning targets. It fails with:

```
Invalid parameter: Peer Pubkey(...)'s feature not found, waiting for peer to send Init message
```

even though `list_peers` on both sides shows them connected. Verified live on testnet with two byte-identical
`fnn` builds (same sha256, commit `332141a`), same `chain_hash`, correct peer-ids — so it is not a version,
chain, or addressing problem.

**Mechanism (traced in source).** `open_channel` calls `check_feature_compatibility` (`network.rs:4742`),
which reads the peer's `features` from `peer_session_map`. That field is only set in `on_init_msg` when the
peer's `Init` is received **and the session survives**. Two protections from
[#1200 "Implement inbound and reconnect protections"](https://github.com/nervosnetwork/fiber/pull/1200) defeat
this for a no-channel peer:
- `enforce_inbound_peer_budget` / inbound-no-channel handling **disconnects the fresh peer ~30s after connect**
  (it is an inbound peer with no channel). Debug logs show the good `Outbound` session exchange `Init`
  (`"Peer ... connected"`) and then close at +30s.
- The funder's saved-peer reconnect then **flaps** dials to the fresh node (observed 125 open/close cycles),
  and each `on_peer_connected` re-inserts the peer into `peer_session_map` with `features: None`, clobbering
  the features from the good session.

**Effect.** A JIT/LSP funder cannot reliably keep a session with a brand-new acceptor long enough to run
`open_channel` — the very peer JIT exists to serve is treated as a low-priority inbound peer and evicted. The
customer's held payment then correctly refunds (deliver-or-refund works), but the channel never opens.

**Ask.** Exempt a peer with a **pending/just-requested channel open** from inbound-no-channel eviction (grace
window keyed on `to_be_accepted_channels` / an in-flight `OpenChannel`), and/or let a funder pin an outbound
session to the acceptor for the duration of the open. Also avoid overwriting a live session's `features` when a
concurrent reconnect attempt for the same pubkey opens and immediately closes. Relates to #2 (auto-accept) and
#7 (zero-conf JIT).

**Client-side workaround (shipped here).** Since the funder-initiated *outbound* session is not subject to this
protection, `openChannelAndAwait` (`packages/fiber/src/openChannel.ts`) accepts `reconnectOnFeatureMiss`: on the
"feature not found" rejection it re-dials the acceptor (`connect_peer`, unsaved) and retries `open_channel`
immediately, landing inside the eviction window. JIT (`packages/lsp-server/src/jit.ts`) opts in; the acceptor
also needs to advertise a dialable multiaddr (`target_address` on the JIT order) so the funder has somewhere to
dial. Verified live end-to-end on testnet: a merchant node with zero channels received a JIT-opened channel and
a settled payment. This works around the symptom but doesn't fix the underlying eviction — the upstream ask
above still stands.
