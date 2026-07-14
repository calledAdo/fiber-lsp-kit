# @fiberlsp/registry

Provider discovery from two independent inputs:

- a static JSON phonebook containing provider identity and REST endpoints;
- the local FNN gossip graph containing node-signed addresses, feature names, and per-asset auto-accept floors.

The package does not treat either source as current price or liquidity truth. Fetch live terms from
`GET /lsp/v1/info` and confirm capacity before ordering.

## Exports

- `fetchRegistry(url)` loads a `Registry` document.
- `discover(url)` loads registry entries and probes each `/lsp/v1/info` endpoint.
- `discoverFromGraph(rpc, options)` maps graph node announcements to asset capabilities.
- `discoverProviders(options)` merges registry and graph rows by normalized LSP pubkey.

## Example

```ts
import { FiberChannelRpcClient } from "@fiberlsp/fiber";
import { udtAsset } from "@fiberlsp/protocol";
import { discoverProviders } from "@fiberlsp/registry";

const rpc = new FiberChannelRpcClient({ rpcUrl: "http://127.0.0.1:8227" });
const rusd = udtAsset(
  { code_hash: "0x...", hash_type: "type", args: "0x..." },
  "RUSD",
);

const providers = await discoverProviders({
  registryUrl: "https://example.invalid/providers.json",
  rpc,
  asset: rusd,
  minAmount: "1000000000",
});

console.log(providers.filter((provider) => provider.base_url && provider.reachable));
```

Graph-only rows may have no REST endpoint because FNN node announcements do not currently advertise an LSP
service URL. Applications may inject `resolveEndpoint` when they have an external convention.

The repository's provider file and contribution rules are documented in [`registry/README.md`](../../registry/README.md).
