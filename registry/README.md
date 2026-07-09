# Fiber LSP provider registry

`providers.json` is a **public phonebook** of Fiber LSP endpoints — the practical, immediately-orderable
discovery path for a merchant/wallet. It is a plain file meant to live in GitHub; validate it against
[`providers.schema.json`](./providers.schema.json).

## What it is (and is not)

The registry carries **only static identity** — enough to *find and reach* a provider:

| Field | | |
|---|---|---|
| `name` | required | human-readable name |
| `base_url` | required | LSP REST base URL (client appends `/lsp/v1/*`) |
| `chain` | required | `testnet` \| `mainnet` |
| `lsp_pubkey` | recommended | Fiber node pubkey — lets a client cross-verify the endpoint and merge with the gossip graph by identity |
| `operator`, `note` | optional | provenance / free text |

It deliberately carries **no dynamic data**:

- **Terms (fees, capacity, min payment, JIT support)** are read **live** from each provider's
  `GET /lsp/v1/info` (`compareQuotes` does this). A file can't stay honest about prices; the endpoint is the
  source of truth for terms.
- **Liquidity and channel topology** are read from the **gossip graph** (`graph_channels` / `graph_nodes`),
  which is live and on-chain-verifiable. Channel counts open, close, and rebalance constantly, so they never
  belong in a static file.

So the registry answers "*who exists and where*"; the endpoint answers "*what will you charge me right now*";
the graph answers "*what capacity/topology is live*".

## Add your LSP (pull request)

1. Stand up an LSPS-Fiber server (`@fiberlsp/server`) in front of your FNN node so `GET /lsp/v1/info`
   responds.
2. Add one entry to `providers` with your `name`, `base_url`, `chain`, and (recommended) `lsp_pubkey`.
3. Keep it static — do **not** add fee/capacity/channel fields; the schema rejects them.
4. Open a PR. Validate first: any JSON-Schema validator against `providers.schema.json`.

## Fork it — merchants keep their own phonebook

The registry is a **reproducible artifact, not an owned endpoint**. A merchant can:

- point the SDK straight at this file's raw URL (`fetchRegistry(url)`), or
- **copy it, trim it to the LSPs they trust, add private ones**, and bundle that, or
- skip the file entirely and pass an inline provider list to `discoverProviders` / `compareQuotes`.

Discovery merges the registry with the gossip graph **by `lsp_pubkey`**, so an entry that is also seen on the
graph is marked `sources: ["registry", "graph"]` — registry for the reachable endpoint, graph for the
authenticated on-chain capability. See [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) (Discovery Model).
