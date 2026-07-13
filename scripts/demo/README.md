# JIT demos

The demos are two explicit checkout topologies. Choose one command or folder up front; there is no interactive
mode selection and no shared config that changes node roles at runtime.

| Scenario | Nodes | Hash relationship | Proof artifacts | Rent channel |
|---|---:|---|---|---|
| [`same-hash/`](./same-hash) | hold, payment, merchant, customer | one hash on both invoices | none | merchant -> payment node |
| [`linked/`](./linked) | LSP, merchant, customer | two hashes linked by one secret | Groth16 | merchant -> LSP |

## Quick checks

```bash
npm install
npm run demo:same-hash:e2e
npm run demo:linked:e2e
```

The one-process checks use the same `FiberChannelRpcClient`, `JitCheckout`, `JitService`, `StreamingLease`,
prover, and verifier used by a deployed composition. The mock implements the FNN JSON-RPC boundary; it does
not replace the protocol or proof logic.

## Node source selection

Each scenario has its own `demo.config.json`. Node resolution is atomic:

- When every required node field is populated, every role uses those live FNN endpoints.
- When any required field is missing, every role uses the scenario's mock nodes.
- Live and mock nodes are never mixed in one run.

The LSP launcher starts mock nodes only for a mock profile. For either profile it then performs a read-only
preflight: node identity, one chain hash, distinct required nodes, customer-to-hold peer connectivity, channel
state, asset, and customer outbound capacity. It does not fund, connect, or open prerequisite live channels.

## Multi-terminal runs

The command names are scenario-qualified. Start LSP, merchant, and customer in that order, then use the
scenario's invoice/pay actions:

```bash
# same-hash example
npm run demo:same-hash:lsp
npm run demo:same-hash:merchant
npm run demo:same-hash:customer
npm run demo:same-hash:invoice
npm run demo:same-hash:pay
npm run demo:same-hash:rent
```

Use the corresponding `demo:linked:*` commands for linked JIT. Both scenarios intentionally demonstrate the
kit's checkout and channel-bound rent primitives; ordinary Fiber invoice routing is outside the demo scope.

See each scenario README for live prerequisites and the exact channel topology.
