# Linked JIT demo

This scenario uses one LSP FNN node:

```text
customer == funded asset channel ==> LSP -- opens and funds --> merchant
```

One node cannot safely hold and pay the same hash, so the hold and merchant invoices use different hashes.
The merchant proves that both hashes derive from one private secret. The merchant builds the Groth16 proof;
the LSP verifies it before issuing the hold invoice.

## One-process run

```bash
npm run demo:linked:e2e
```

Missing proving/verification artifacts are fetched from the release configured in
[`demo.config.json`](./demo.config.json), checked against `SHA256SUMS`, and cached under `scripts/demo/.artifacts`.
Startup fails if they cannot be obtained; it never changes to a different JIT mechanism.

The default run uses three mock FNN roles behind the production RPC adapter. It verifies the real proof,
hold-before-open ordering, merchant payment before hold release, and rent priced and paid against the exact
channel opened for the checkout. Success output ends with the JIT order settled and the rent payment recorded.

## Multi-terminal run

```bash
npm run demo:linked:lsp       # terminal 1
npm run demo:linked:merchant  # terminal 2
npm run demo:linked:customer  # terminal 3

npm run demo:linked:invoice   # terminal 4
npm run demo:linked:pay
npm run demo:linked:rent
```

## Live profile

Fill every required field in [`demo.config.json`](./demo.config.json): `lsp.rpc`, `merchant.rpc`,
`merchant.p2p`, and `customer.rpc`. If any one is blank, the entire scenario uses mock nodes.

Before startup, the operator must ensure:

- all three FNN nodes are distinct and on the same chain;
- the customer is connected to the LSP and has a ready RUSD channel with enough local balance to pay;
- the LSP node has the CKB and RUSD capital needed to open the requested merchant channel;
- the LSP node enables FNN's `pubsub` RPC module (`RPC_ENABLED_MODULES` must retain the normal modules and add
  `pubsub`), with RPC bound privately; this is how the LSP captures the merchant preimage without a reveal call;
- the merchant's configured P2P listener is reachable by the LSP.

The launcher validates identity, network, the customer channel, and the preimage subscription without moving
funds. `JitService`
establishes the LSP-to-merchant peer session when needed before opening the channel.
