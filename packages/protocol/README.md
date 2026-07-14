# @fiberlsp/protocol

Framework-free LSPS-Fiber contracts and pure domain helpers. This package has no FNN transport, HTTP server,
storage, or environment configuration.

LSPS-Fiber is this project's application-level interoperability contract. It is not an upstream Fiber standard.

## Major exports

- Assets: `CKB`, `udtAsset`, `udtAssetFromHex`, `canonicalAssetId`, `assetEquals`
- Prepaid contracts: `LspInfo`, `AssetOffering`, `CreateOrderRequest`, `Order`, `LiquiditySnapshot`
- JIT contracts: `JitMode`, `JitTerms`, `CreateJitOrderRequest`, `JitOrder`, `jitFee`, `jitForwardAmount`
- Leasing: `LeaseTerms`, `rentPerPeriod`, `leaseTermsFor`, `quoteLease`
- Receipts: `Receipt`, `buildReceipt`, `WebhookEvent`, invoice-status helpers
- Linkage: `LinkageProof`, `LinkageVerifier`, `dualSha256`, `sameHashLink`
- Groth16 verification: `createGroth16DualSha256Verifier`, `verifyGroth16Bn254`
- FNN encodings: decimal/hex amount helpers, Molecule `Script` encoding, CKB Blake2b

## Example

```ts
import {
  jitForwardAmount,
  rentPerPeriod,
  udtAsset,
  type JitTerms,
  type LeaseTerms,
} from "@fiberlsp/protocol";

const rusd = udtAsset(
  { code_hash: "0x...", hash_type: "type", args: "0x..." },
  "RUSD",
);

const jit: JitTerms = {
  modes: ["same_hash"],
  fee_bps: 100,
  fee_base: "50000000",
  min_payment: "500000000",
  min_expiry_seconds: 600,
  max_expiry_seconds: 3600,
};

const lease: LeaseTerms = {
  asset: rusd,
  capacity: "1000000000",
  rate_bps_per_period: 5,
  period_seconds: 86400,
  grace_periods: 2,
};

console.log(jitForwardAmount(jit, "2000000000").toString());
console.log(rentPerPeriod(lease).toString());
```

Amounts are decimal strings in the asset's base unit at the protocol boundary. FNN-specific hexadecimal
encoding belongs in [`@fiberlsp/fiber`](../fiber/README.md).

The linked circuit source and build instructions are in
[`circuits/dual-sha256-linkage`](./circuits/dual-sha256-linkage/README.md).
