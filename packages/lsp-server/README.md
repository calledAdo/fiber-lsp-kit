# @fiberlsp/server

Composable server-side LSP services and framework-neutral request handlers. Importing this package starts no
process, reads no environment variables, chooses no database, and enables no authentication.

## Major exports

- Provider surface: `Lsp`
- Provisioning: `JitService`, `LinkedMode`, `SameHashMode`, `PrepaidService`
- HTTP composition: `createApi`, `ApiMiddleware`, `createMerchantApi`
- Persistence interfaces and memory/file references: order, JIT, invoice-watch stores
- Merchant operations: `InvoiceWebhookService`, `LspLedger`, `closeLease`
- Liquidity operations: `Rebalancer`, `needsRebalance`, `planCircularRebalance`
- Linkage composition: `selectLinkageVerifiers`

## Composition

```ts
import { FiberChannelRpcClient, FnnStoreChangePreimageSource } from "@fiberlsp/fiber";
import { createApi, JitService, Lsp } from "@fiberlsp/server";

const holdRpc = new FiberChannelRpcClient({ rpcUrl: "http://127.0.0.1:8227" });
const payRpc = new FiberChannelRpcClient({ rpcUrl: "http://127.0.0.1:8327" });

const offerings = [/* application-defined AssetOffering values */];
const lsp = new Lsp({
  rpc: holdRpc,
  lspPubkey: "<hold-node-pubkey>",
  addresses: ["<hold-node-multiaddr>"],
  supportedAssets: offerings,
  feeModes: [],
});

const jit = new JitService({
  rpc: holdRpc,
  payRpc,
  preimageSource: new FnnStoreChangePreimageSource({ rpcUrl: "http://127.0.0.1:8327" }),
  supportedAssets: offerings,
  terms: {
    modes: ["same_hash"],
    fee_bps: 100,
    fee_base: "50000000",
    min_payment: "500000000",
    min_expiry_seconds: 600,
    max_expiry_seconds: 3600,
  },
});

const handle = createApi(lsp, { jit });
const response = await handle("GET", "/lsp/v1/info");
```

The `modes` returned by the service are derived from injected capabilities: a distinct `payRpc` enables
`same_hash`; a `linkageVerifier` enables `linked`. Custom applications should derive advertised terms from the
service rather than trusting an operator-supplied mode string.

`createApi` returns `{ status, body }`, so it can be mounted in `node:http`, Express, Fastify, serverless
handlers, or tests. Middleware is optional and can implement authentication, rate limits, logging, or metrics.
The opt-in reference authentication package is [`@fiberlsp/auth`](../auth/README.md).

See [`examples/reference-lsp`](../../examples/reference-lsp/README.md) for one runnable Node HTTP assembly.

## Operational boundaries

- Use persistent stores and call `JitService.resume()` after restart.
- The default webhook delivery is best-effort; production applications should inject a durable outbox.
- Rebalancing defaults to dry-run and is never an automatic JIT/lease side effect.
- Prepaid provisioning remains pay-before-open unless the deployment adds an escrow mechanism.
