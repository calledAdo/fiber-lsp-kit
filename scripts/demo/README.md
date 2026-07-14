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

The one-process checks use mock FNN roles by default and the same `FiberChannelRpcClient`, `JitCheckout`,
`JitService`, `StreamingLease`, prover, and verifier used by a deployed composition. The mock implements the
FNN JSON-RPC boundary; it does not replace protocol, state-machine, proof, or rent logic. The linked run needs
network access once if its checksum-verified release artifacts are not cached.

A successful run reports that the hold was funded before channel opening, the merchant was paid before hold
settlement, the expected channel became ready, and rent was calculated and paid against that channel's current
remaining inbound. The same-hash run additionally confirms four distinct roles and no hold-to-payment channel;
the linked run confirms the real proof and public signals.

## Node source selection

Each scenario has its own `demo.config.json`. Node resolution is atomic:

- When every required node field is populated, every role uses those live FNN endpoints.
- When any required field is missing, every role uses the scenario's mock nodes.
- Live and mock nodes are never mixed in one run.

The LSP launcher starts mock nodes only for a mock profile. For either profile it then performs a read-only
preflight: node identity, one chain hash, distinct required nodes, customer-to-hold peer connectivity, channel
state, asset, and customer outbound capacity. A live profile also arms and closes one paying-node
`subscribe_store_changes` subscription, proving preimage observation is available before any payment moves.
It does not fund, connect, or open prerequisite live channels.

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
