# Live results — 2-node testnet confirmation

Confirmed on CKB **testnet** (Pudge) with two real FNN nodes (v0.9.0-rc5):

| Node | Role | RPC | P2P | pubkey |
|---|---|---|---|---|
| #1 | LSP (holds CKB) | `127.0.0.1:8227` | 8228 | `023dda5d…230109` |
| #2 | client (fresh, faucet CKB) | `127.0.0.1:8237` | 8238 | `0344f854…e87283` |

## What was proven

1. **Raw feasibility (RPC).** LSP `open_channel` → client at zero contribution → `ChannelReady`:
   - node #2 (client): `local_balance = 0`, `remote_balance = 201 CKB` (pure inbound, **client funded 0**)
   - node #1 (LSP): `local_balance = 201 CKB`, `remote_balance = 0`
   - outpoint `0x0e8f14f5d4744f363337ef019419dd4472d48681f628b52cdc165b181dd8dc7d:0`
   - (funded 300 CKB; the 99 CKB delta is the channel's occupied cell reserve.)

2. **Full stack (server + client SDK).** `LspClient.buyInboundLiquidity({ asset: CKB, 300 CKB, from_capacity })`
   → REST `POST /lsp/v1/orders` → `Lsp.provision` → live `open_channel` → poll → **`channel_active`**:
   - order `6def15dd-8f23-43d6-8d51-f9a7ddfd65d2`, fee `1300000000` shannons (13 CKB)
   - outpoint `0xfdea865331bf36cf69c1f7a4644df8e33b3a93274d5a0e3c5753a72e75bc7449:0`

Repro: `scripts/part-c-raw-open.sh` (raw) and `scripts/part-d-ckb.mjs` (full stack), against the server at
`FIBER_RPC_URL=http://127.0.0.1:8227 LSP_PUBKEY=023dda…230109 npm run server`.

## RPC-shape / behaviour facts pinned live (folded into the code)

- `node_info` returns the identity as **`pubkey`** (not `node_id`/`public_key`).
- `new_invoice` → `payment_hash` is nested under `invoice.data`, not top-level.
- **Dial address** must be `/ip4/…/tcp/…/p2p/<peer-id>` where `peer-id = base58(0x1220 ‖ sha256(compressed pubkey))`
  — NOT the hex pubkey. A bare multiaddr (no `/p2p/`) connects at the transport layer but never completes
  the fiber Init handshake, so `open_channel` fails with *"peer's feature not found, waiting for Init"*.
- A **redundant `connect_peer`** to an already-connected peer can crash the acceptor's gossip actor
  (`ActorAlreadyRegistered`, `gossip.rs`). `provision()` now checks `list_peers` and skips the reconnect.
- A **CKB channel's `local_balance` is less than the funded amount** (occupied cell reserve), so matching
  the provisioned channel by `local_balance >= lsp_balance` is wrong — `pollForReadyChannel` now matches
  the newly-appeared channel id + peer + asset + `ChannelReady`.

## Honest design note — the fee bootstrap

An LSP-opened channel where the client auto-accepts with **0** leaves the client with **0 outbound**. So a
client cannot pay a Fiber fee invoice (`prepaid`) or an in-channel fee (`from_capacity`) *from that channel*
— it has nothing to send. The truly-zero-capital client must pay the CKB fee out-of-band (on-chain, or via
a pre-existing CKB channel that gives it outbound). This is the real onboarding shape; the spec's fee
section should present the fee as an **out-of-band CKB payment** for the zero-capital case rather than an
in-Fiber invoice. Tracked as a spec follow-up. (It does not change the flagship value: the client receives
per-asset inbound it could not otherwise get.)

## The RUSD hero — DONE ✅

Node #1 was funded with 20 RUSD (via JoyID → stablepp faucet → transfer to its funding lock). Then, on the
same two live nodes:

3. **Raw feasibility (RPC), RUSD.** LSP `open_channel` funding **10 RUSD** → client at zero contribution →
   `ChannelReady`:
   - node #2 (client): RUSD, `local_balance = 0`, `remote_balance = 10 RUSD` (**per-asset inbound, client held 0 RUSD**)
   - node #1 (LSP): RUSD, `local_balance = 10 RUSD`, `remote_balance = 0`
   - outpoint `0x14247d2bd46f7b17e2429727df8c93bbf5190059c71f4caf5ffd46cf20d1f1af:0`

4. **Full stack (server + client SDK), RUSD.** `buyInboundLiquidity({ asset: RUSD, 10 RUSD, prepaid })`
   → REST → `Lsp.provision` → live UDT `open_channel` → poll → **`channel_active`**:
   - order `544e03e3-3fa3-429a-a668-578ac0d58270`, fee `1000000000` shannons (10 CKB)
   - outpoint `0x12f252a46f6504870efe284f9f1b540c1192ded02fb8085f5b322b55b3f0b8f7:0`

Repro: `scripts/part-e-rusd.mjs` against the running server.

### Critical UDT auto-accept fact (was a bug in our offering)

`is_udt_type_auto_accept` (FNN `contracts.rs`) returns `funding_amount >= auto_accept_amount` — the UDT
`auto_accept_amount` is a **minimum floor**, not a ceiling. A funding **below** it is silently refused
(WARN-level; the channel stalls in `NegotiatingFunding` and never reaches the acceptor). Testnet RUSD's
`auto_accept_amount` is **10 RUSD**, so a 5 RUSD open never accepted; 10 RUSD did. The server's RUSD
`min_capacity` was raised to 10 RUSD accordingly — an LSP must not quote a UDT capacity below the client's
auto-accept floor. (CKB uses the same floor semantics via `open_channel_auto_accept_min_ckb_funding_amount`.)

> Operational note: UDT funding makes a burst of CKB-RPC calls (fetch UDT cells + cell deps), so it is more
> sensitive to public-endpoint (`testnet.ckb.dev`) flakiness than a CKB channel; a stalled attempt is cleared
> with `abandon_channel` and retried. `abandon_channel { channel_id }` cleanly drops a pre-funding channel.
