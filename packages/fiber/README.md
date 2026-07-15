# @fiberlsp/fiber

Typed FNN JSON-RPC transport and node utilities. The adapter converts LSPS-Fiber decimal amounts to FNN hex,
normalizes the RPC fields used by the kit, and keeps business policy out of the transport layer.

## Major exports

- `FiberChannelRpcClient` and its channel, invoice, payment, peer, graph, and routing types
- `invoiceAttr` for typed access to parsed invoice attributes
- `openChannelAndAwait`, `channelAsset`, and `isChannelReady`
- invoice/TLC expiry helpers from `timing.ts`
- `PaymentPreimageSource` and `FnnStoreChangePreimageSource`

## Basic use

```ts
import { FiberChannelRpcClient } from "@fiberlsp/fiber";

const rpc = new FiberChannelRpcClient({
  rpcUrl: "http://127.0.0.1:8227",
  // authToken: process.env.FNN_RPC_TOKEN, // optional transport policy
});

const info = await rpc.nodeInfo();
const channels = await rpc.listChannels();
const invoice = await rpc.newInvoice({
  amount: "100000000",
  description: "order-42",
  expirySeconds: 900,
});

console.log(info.pubkey, channels.length, invoice.invoice_address);
```

`authToken` only adds an FNN bearer header. The package does not prescribe whether an operator exposes or
authenticates its node RPC.

## Optional trampoline routing

The payer may delegate the unknown remainder of a route to one or more explicitly selected trampoline nodes.
`trampolineHops` is optional and maps directly to FNN's `trampoline_hops`; FNN also requires the payer to set a
`maxFeeAmount` budget.

```ts
await rpc.sendPayment({
  invoice: merchantInvoice,
  trampolineHops: [lspPubkey],
  maxFeeAmount: "1000000",
});
```

The package does not select a trampoline or require an LSP to provide that service. Applications should verify
the selected node advertises `TRAMPOLINE_ROUTING_REQUIRED` or `TRAMPOLINE_ROUTING_OPTIONAL`. They may instead use
normal graph routing or an explicitly built route.

## Preimage observation

`FnnStoreChangePreimageSource` subscribes to FNN's optional `subscribe_store_changes` WebSocket method and
matches `PutPreimage` by payment hash. It arms before `send_payment`, has no replay, and should connect to a
private/trusted RPC boundary because the stream carries payment preimages.

Applications inject the `PaymentPreimageSource` interface into `JitService`; they may replace the FNN observer
with another transport or durable source.

## Compatibility

The typed shapes are pinned to live `v0.9.0-rc5` observations. Later FNN releases must be probed before support
is claimed. Current-source gaps and version-scoped findings are recorded in
[`docs/upstream-fiber-findings.md`](../../docs/upstream-fiber-findings.md).
