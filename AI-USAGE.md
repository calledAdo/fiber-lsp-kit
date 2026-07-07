# AI usage

AI tooling was used to build Fiber LSP Kit, under a human-driven feedback and testing loop. This note is
an honest account of where AI helped and where human judgement + real testnet runs did the deciding work.

## Where AI helped

- Drafting boilerplate: TypeScript types, the REST dispatcher, test scaffolding, and prose in the README
  and spec.
- Research: navigating FNN source to understand the channel-funding model before writing any code.

## Where the human loop did the real work

The design of an LSP for Fiber turns entirely on how FNN's `open_channel` actually behaves — and that was
established by **reading the FNN v0.9 source and running two live nodes on CKB testnet**, not by trusting a
generated guess. That regime found and fixed six concrete integration issues that no amount of
armchair reasoning would have surfaced:

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

Each fix was verified end-to-end: an LSP provisioning **10 RUSD** of inbound to a fresh client that funded
**0**, the client **receiving 5 RUSD** over that channel, and finally a **3-node routed** payment where a
customer pays a fresh merchant *through the LSP hub* over kit-provisioned inbound (reproduce with `scripts/demo/`). The
molecule `Script` encoder was checked byte-for-byte against a real node's `udt_script`.

Two of the issues above are written up as upstream reports in
[`docs/upstream-fiber-findings.md`](./docs/upstream-fiber-findings.md).

## Testing regime

- The offline test suite runs through the **real** RPC code path (a scripted transport, not stubbed logic).
- `npm run demo` exercises the whole merchant flow node-lessly (real kit code + a real webhook sink).
- `npm run test:live` re-checks the real RPC surface against a running node on demand.
- The live provision/invoice/pay/rent flow is reproducible via the scripts in `scripts/demo/` (discover →
  buy → invoice → routed pay → stream rent).
- The JIT design was **spiked live before any kit code was written**: hold invoices, `settle_invoice`
  release, `cancel_invoice` refund, the same-node hold/forward collision, the real hold window (invoice
  expiry, not the 120 s constant), and an early multi-node atomic rehearsal. The current shipped JIT path is
  the single-node linked-hash design covered by the offline tests and spec §6; the failed hypotheses became
  upstream issue drafts.
