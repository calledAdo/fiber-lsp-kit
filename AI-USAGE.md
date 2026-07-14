# AI-assisted development

AI tooling assisted with source navigation, TypeScript scaffolding, test generation, and documentation. Design
decisions and compatibility claims were accepted only after review against FNN source, protocol behavior, and
repeatable tests.

## Validation method

The load-bearing FNN assumptions were established by reading official `v0.9.0-rc5` source and operating up to
four testnet nodes. Those runs covered peer connection, UDT channel opening, hold invoices, JIT settlement,
live-capacity rent, graph reads, and routed-payment dry runs.

That process found integration details that generated code or prose alone could not establish, including:

- `node_info.pubkey` and the nested `new_invoice` response shape;
- peer dialing and redundant-connect behavior;
- UDT auto-accept minimum semantics;
- occupied CKB capacity affecting channel balances;
- the single-node same-hash collision;
- the absence of replayable preimage and complete payment-ledger RPC data.

Each runtime claim is version-scoped in [`docs/upstream-fiber-findings.md`](./docs/upstream-fiber-findings.md).
Current-source inspection is recorded separately from live reproduction so the two evidence classes are not
conflated.

## Repeatable checks

- `npm test` exercises the real adapter and package paths against scripted transports and mock FNN boundaries.
- `npm run demo:same-hash:e2e` runs the four-role, two-LSP-node JIT flow and channel-bound rent.
- `npm run demo:linked:e2e` runs the three-role, single-LSP-node flow with the real linkage proof.
- `npm run test:live` probes RPC compatibility against operator-supplied nodes without making every test move
  funds.

Mock demos are identified as mock runs. Live observations, source-confirmed behavior, and unimplemented
production work are identified separately throughout the documentation.
