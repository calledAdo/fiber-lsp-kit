# Upstream FNN findings (issue drafts)

While building Fiber LSP Kit we drove four live FNN nodes (v0.9.0-rc5) on CKB testnet through the full
channel-opening, streaming-rent, and hold-invoice JIT paths, and hit several rough edges and missing surfaces worth reporting
upstream. These are **drafts** to file at [nervosnetwork/fiber](https://github.com/nervosnetwork/fiber);
each has a minimal repro.

---

## 1. Redundant `connect_peer` can crash the acceptor's gossip actor (`ActorAlreadyRegistered`)

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

**Workaround we adopted.** `provision()` calls `list_peers` first and skips `connect_peer` when already
peered.

---

## 2. A UDT `open_channel` funded *below* the acceptor's `auto_accept_amount` stalls silently

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

## 3. (enhancement) Advertise LSP-provider capability natively in the gossip graph

**Type:** feature proposal / RFC (not a bug)

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

**Security / spam.** Node announcements are signed by the node key, so the Sybil cost is running a real
node; bounding the descriptor size and treating advertised fees as non-binding (confirmed live) keeps the
surface small. This mirrors how the graph already trusts `udt_cfg_infos`.

**Why it's implement-ready on the client side.** Fiber LSP Kit's discovery already reads `graph_nodes` for
capability (`discoverFromGraph`) and is written to honour exactly such a flag the moment it lands — a
`requireLspFeature` filter and a configurable feature name. Merged discovery (`discoverProviders`) unions
graph capability with registry endpoints today and would collapse onto the graph alone under Proposal B.

---

### Also worth documenting (DX, not bugs)

- **Dialing an unannounced peer needs `/p2p/<peer-id>`**, where `peer-id = base58btc(0x1220 ‖
  sha256(33-byte compressed pubkey))` — not the hex node pubkey. A bare transport multiaddr connects but
  never completes `Init`. A short note in the `connect_peer` docs would save integrators a lot of time.
- A first-boot node **migrates a plaintext-hex `ckb/key` to an encrypted keystore** and does not
  auto-generate one; documenting the expected key material would smooth onboarding.

---

## 4. `get_payment` does not expose the settled payment's preimage

**Severity:** low (missing surface; forces protocol workarounds)

**What happens.** When an outgoing payment settles, the paying node cryptographically *learns the
preimage* (the TLC fulfillment carries it), but `get_payment` returns only
`{ payment_hash, status, created_at, last_updated_at, failed_error, fee, custom_records }` — the preimage
is in the node's store yet unreachable over RPC.

**Why it matters.** Hold-invoice choreography (LSPS2-style JIT, submarine-swap-like flows) needs the
forwarder to *relay* the preimage: node B pays `invoice(H)`, learns `P`, and a coordinating process calls
`settle_invoice(H, P)` on node A. Today `P` must be re-supplied out-of-band by the payee even though B
already holds it — an extra round-trip and a needless trust discussion.

**Ask.** Add `payment_preimage` (present when `status == "Success"`) to `GetPaymentCommandResult`.

---

## 5. One node holding and paying the same hash silently loses funds; the error names it `HoldTlcTimeout`

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
first pays, the same hash rides both legs safely (verified live — the hold stayed `Received` and settled from
the leg preimage). That is the `same_hash` JIT mode, and it is why it needs no linkage proof at all.

---

## 6. (docs) A hold invoice's hold window is its *expiry* — `DEFAULT_HOLD_TLC_TIMEOUT` is MPP-only

**Severity:** docs

**What we measured.** A held TLC on a hash-only invoice survives far beyond the 120 s
`DEFAULT_HOLD_TLC_TIMEOUT` (we held >7 minutes and settled cleanly at 155 s with `settle_invoice`).
Reading `channel.rs` confirms it: for a hold invoice the hold expiry is `min(invoice expiry, TLC expiry)`
("ensure the expiry is large enough for manual settlement via RPC"); the 120 s constant only bounds MPP
partial sets on preimage-known invoices.

**Why it matters.** This is a *feature* — a generous, caller-controlled hold window is exactly what makes
hold-invoice provisioning (a JIT channel's on-chain open takes minutes) viable — but nothing documents it,
and the constant's name invites the wrong conclusion.

**Ask.** Document hold-invoice semantics (window = invoice expiry; `settle_invoice`/`cancel_invoice`
lifecycle; `Received` state) in the RPC README.

---

## 7. (RFC sketch) HTLC interception + zero-conf channels ⇒ sub-second JIT

Our kit ships JIT channels at *checkout latency* by holding the payer's funds in a hold invoice while the
channel opens on-chain (see `ARCHITECTURE.md`). Matching Lightning LSPS2's *sub-second* JIT for a
payment with **no prior arrangement** needs two upstream pieces: (a) an interception hook for
*intermediaries* — let a registered process pause an incoming forward whose next hop doesn't exist and
resume/fail it later (today's hold applies only to the final payee's invoice, and a single node cannot
hold and forward one hash — finding 5); (b) zero-conf channels, so the forward can complete before the
funding tx confirms. With both, the invoice-layer arrangement disappears and JIT becomes transparent to
the payer's wallet.

---

## 8. (enhancement) No push notifications for invoice / channel / payment state ⇒ everything must poll

**Severity:** low (works, but forces polling loops in every integrator)

**What happens.** FNN's RPC is strictly request/response. There is no way to *subscribe* to state changes —
no "notify me when this invoice becomes `Received`/`Paid`", "when this channel reaches `ChannelReady`", or
"when this payment settles/fails". So any process that reacts to those transitions (our `JitService`: hold
detection, channel-ready detection, forward-settlement detection) must **poll** the relevant `get_invoice`
/ `list_channels` / `get_payment` on an interval.

**Why it matters.** Polling is workable (parked `await`s, batchable into one shared watcher across orders),
but it's needless RPC load and latency, and every integrator re-implements the same loops. An event stream
would let JIT/streaming flows be event-driven and delete the loops entirely.

**Ask.** Add a subscription/notification surface — e.g. a WebSocket or long-poll `subscribe` for invoice,
channel, and payment state transitions (Lightning's `invoicestream` / channel-event feeds are the model).

---

## 9. (RFC sketch) PTLCs would make single-node atomic JIT trivially trustless

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

**Ask.** Track PTLC / adaptor-signature TLCs on the Fiber roadmap. Bitcoin Lightning is making the same
HTLC→PTLC move; CKB's Schnorr-friendly stack makes it natural here too.

---

## 10. `node_announcement` propagation lags `channel_announcement`, so a new node is undiscoverable by capability

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
the default discovery path and the gossip graph as a slower, authenticating layer — see finding #3.)

**Ask.** Re-broadcast `node_announcement` more eagerly — at least when a node's first `channel_announcement`
becomes relayable and on new peer connections — and/or relay a buffered `node_announcement` to peers once the
supporting channel is known, so capability discovery converges on roughly the same timescale as channel
discovery. Relates to #3 (native LSP capability advertisement) and #8 (no push/subscription surface).
