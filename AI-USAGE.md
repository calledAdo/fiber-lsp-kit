# AI usage

AI tooling was used to build Fiber LSP Kit, under a human-driven feedback and testing loop. This note is
an honest account of where AI helped and where human judgement + real testnet runs did the deciding work.

## Where AI helped

- Drafting boilerplate: TypeScript types, the REST dispatcher, test scaffolding, and prose in the README
  and spec.
- Research: navigating FNN source to understand the channel-funding model before writing any code.

## Where the human loop did the real work

The design of an LSP for Fiber turns entirely on how FNN's `open_channel` actually behaves — and that was
established by **reading the official FNN `v0.9.0-rc5` prerelease source and running up to four live nodes on CKB testnet** (LSP hold node,
LSP paying node, merchant, and a routing node), not by trusting a generated guess. That regime found and fixed
six concrete integration issues that no amount of armchair reasoning would have surfaced:

1. **`node_info` returns `pubkey`** (not `node_id`/`public_key`); `new_invoice`'s `payment_hash` is nested
   under `invoice.data`.
2. **Dialing needs a base58 `/p2p/<peer-id>`** = `base58(0x1220 ‖ sha256(compressed pubkey))`, not the hex
   pubkey — a bare multiaddr never completes the Fiber `Init` handshake.
3. **A redundant `connect_peer` panics the acceptor's gossip actor** (`ActorAlreadyRegistered`).
4. **`auto_accept_amount` is a minimum floor, not a ceiling** — a UDT open below it stalls silently in
   `NegotiatingFunding`. (This one was initially misdiagnosed as endpoint flakiness; the source told the
   truth.)
5. **A CKB channel's `local_balance` is below the funded amount** (occupied cell reserve), so provisioned
   channels must be matched by id+peer+asset+ready, not by an exact balance.
6. **A freshly-created FNN node needs on-chain CKB to be stable** — an unfunded node can't initialize its
   `ckb` actor, sheds every peer, and never completes the Init handshake, so it can neither accept a channel
   nor route. (Surfaced while building the 3-node routed test; funding the fresh merchant node fixed it.)

Several of these are written up as upstream reports in
[`docs/upstream-fiber-findings.md`](./docs/upstream-fiber-findings.md).

## Testing regime

- The offline suite runs through the **real** RPC code path (a scripted transport, not stubbed logic).
- `npm run demo:same-hash:e2e` exercises four-node JIT and channel-bound live-capacity rent;
  `npm run demo:linked:e2e` exercises the real Groth16 linkage path and the same rent primitive on a three-node topology.
- `npm run test:live` re-checks the real RPC surface against a running node.
- The JIT sale flow (LSP/merchant/customer) is reproducible via `scripts/demo/`, over mock nodes or live.
- JIT behaviour (hold, settle, refund, hold-window semantics) was spiked live against a node before the kit
  code was written. Live testing also surfaced that a **single** FNN node holding and paying one hash silently
  loses funds ([finding #5](./docs/upstream-fiber-findings.md)), which is why the kit ships **two** JIT modes:
  `same_hash` (two LSP nodes, no proof — the default when offered) and `linked` (one node, Groth16 linkage
  proof). Both are described in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) (JIT checkout).
