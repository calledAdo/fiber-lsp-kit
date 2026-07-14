# Fiber LSP provider file

[`providers.json`](./providers.json) is a static phonebook of Fiber LSP identities and REST endpoints. It can be
hosted on Git, downloaded by a merchant, copied into an application, or replaced with a private list. Validate
changes against [`providers.schema.json`](./providers.schema.json).

## Data boundary

| Field | Requirement | Meaning |
|---|---|---|
| `name` | required | human-readable provider name |
| `base_url` | required | REST base URL; clients append `/lsp/v1/*` |
| `chain` | required | `testnet` or `mainnet` |
| `lsp_pubkey` | recommended | FNN identity used to cross-reference graph observations |
| `operator`, `note` | optional | provenance or short static context |

The file deliberately excludes fees, capacity, channel counts, and JIT terms. Those values change too quickly
for a static registry:

- current provider terms come from `GET /lsp/v1/info`;
- current LSP-local capacity comes from `GET /lsp/v1/liquidity`;
- the client's local FNN graph supplies node-signed announcements and public-channel observations.

Gossip data is not an LSP quote or a guarantee of immediately spendable liquidity. It can be delayed, and FNN
does not currently advertise the provider's REST endpoint. The registry answers "where can I request terms?";
the endpoint answers "what is offered now?"; the graph is independent network evidence.

## Add a provider

1. Expose an LSPS-Fiber-compatible `GET /lsp/v1/info` endpoint.
2. Add `name`, `base_url`, `chain`, and preferably `lsp_pubkey` to `providers.json`.
3. Do not add dynamic terms or capacity fields; the schema rejects them.
4. Validate the file against `providers.schema.json` and open a pull request.

## Operator and merchant control

The file is an artifact, not a mandatory service. A merchant can:

- fetch the repository copy with `fetchRegistry(url)`;
- copy it, remove untrusted providers, and add private providers;
- pass an inline list to its own application; or
- skip it and use graph discovery plus an application-defined endpoint resolver.

SDK usage and merge semantics are documented in
[`@fiberlsp/registry`](../packages/registry/README.md).
