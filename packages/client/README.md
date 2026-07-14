# @fiberlsp/client

Merchant and wallet SDK for composing LSPS-Fiber discovery, provisioning, checkout, rent, monitoring, and
reconciliation. Wallet-specific payment signing remains callback-driven.

## Major exports

- LSP transport: `LspClient`
- JIT: `JitCheckout`, `JitReceive`
- Direct receive: `InvoiceService`, `DirectReceive`, `autoStrategy`
- Ahead-of-demand provisioning: `buyInboundFromLsp`, `LspClient.buyInboundLiquidity`
- Discovery and pricing: `discoverProviders`, `compareQuotes`, `bestQuote`
- Operations: `PaymentWatcher`, `StreamingLease`, `LiquidityMonitor`, `SettlementLedger`
- Composition: `MerchantCheckout` and the `ReceiveStrategy` interface

## JIT checkout

```ts
import { JitCheckout, LspClient } from "@fiberlsp/client";
import { FiberChannelRpcClient } from "@fiberlsp/fiber";
import { udtAsset } from "@fiberlsp/protocol";

const merchantRpc = new FiberChannelRpcClient({ rpcUrl: "http://127.0.0.1:8427" });
const merchant = await merchantRpc.nodeInfo();
if (!merchant.pubkey) throw new Error("merchant node returned no pubkey");
const lsp = new LspClient({ baseUrl: "https://lsp.example" });
const rusd = udtAsset(
  { code_hash: "0x...", hash_type: "type", args: "0x..." },
  "RUSD",
);

const checkout = new JitCheckout({
  rpc: merchantRpc,
  lsp,
  merchantPubkey: merchant.pubkey,
  merchantAddress: "/ip4/203.0.113.10/tcp/8228/p2p/<peer-id>",
  // proveLinkage: makeLinkedProver(...), // required only when linked is selected
});

const session = await checkout.checkout({
  asset: rusd,
  amount: "2000000000",
  channelCapacity: "10000000000",
});

console.log(session.invoice); // customer-facing hold invoice
await session.settle();       // waits; it does not reveal the merchant secret
```

The SDK prefers `same_hash` when offered. Supply the `proveLinkage` hook from
[`@fiberlsp/prover-linked`](../prover-linked/README.md) when a single-node LSP offers only `linked`.
`revealFallback()` is explicit cooperative recovery after the merchant invoice is paid and the LSP missed its
live preimage event; normal `settle()` never calls it.

## Generic authorization

`LspClient({ authorization })` accepts a function returning a complete `Authorization` header. It is not tied
to a token format. Per-order JIT bearer tokens take precedence on follow-up order calls.

## Modular receive strategies

`DirectReceive`, `JitReceive`, and `autoStrategy` implement the same `ReceiveStrategy` contract. An application
can choose direct receive when inbound is sufficient, JIT when it is not, or inject another provisioning
strategy without changing checkout consumers.
