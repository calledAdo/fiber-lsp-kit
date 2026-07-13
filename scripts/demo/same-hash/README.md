# Same-hash JIT demo

This scenario gives one LSP operator two distinct FNN nodes:

```text
customer == funded asset channel ==> hold node

payment node -- opens and funds --> merchant
```

The hold and merchant invoices use the same payment hash. The hold node captures the customer payment; the
payment node opens the merchant channel and pays the merchant invoice; application state coordinates the two
nodes and releases the hold. The hold and payment nodes need neither a channel nor a peer session between
them, and this demo does not create one.

## One-process run

```bash
npm run demo:same-hash:e2e
```

It verifies the four distinct nodes, hold-before-open ordering, merchant payment before hold release, absence
of a hold-to-payment channel, and rent priced from the exact payment-to-merchant channel's live remaining
inbound capacity.

## Multi-terminal run

```bash
npm run demo:same-hash:lsp       # terminal 1
npm run demo:same-hash:merchant  # terminal 2
npm run demo:same-hash:customer  # terminal 3

npm run demo:same-hash:invoice   # terminal 4
npm run demo:same-hash:pay
npm run demo:same-hash:rent
```

## Live profile

Fill every required field in [`demo.config.json`](./demo.config.json): `hold.rpc`, `payment.rpc`,
`merchant.rpc`, `merchant.p2p`, and `customer.rpc`. If any one is blank, the entire scenario uses mock nodes.

Before startup, the operator must ensure:

- all four FNN nodes are distinct and on the same chain;
- the customer is connected to the hold node and has a ready RUSD channel with enough local balance to pay;
- the payment node has the CKB and RUSD capital needed to open the requested merchant channel;
- the merchant's configured P2P listener is reachable by the payment node.

The launcher checks the first two groups without moving funds. `JitService` establishes the payment-node to
merchant peer session when needed before it opens the channel.
