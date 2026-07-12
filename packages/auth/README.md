# @fiberlsp/auth

Optional merchant authentication building blocks for a hosted Fiber LSP. Nothing is enabled by importing this package: an operator must explicitly compose its middleware into `createApi`.

The package keeps proof, policy, quota, and token handling behind interfaces. `MerchantCapabilityService` is the token-backend seam. `SignedCapabilityService` is the included implementation and signs compact capability tokens with Ed25519 through `node:crypto`.

## Exports

- `MerchantProofVerifier`, `MerchantCapabilityService`, `MerchantPolicyStore`, `MerchantQuotaProvider`, and `ChallengeStore`
- `SignedFiberInvoiceVerifier`
- `SignedCapabilityService`
- `MemoryChallengeStore`
- `MemoryMerchantPolicyStore` and `FileMerchantPolicyStore`
- `createMerchantAuthMiddleware`
- `createAdminPolicyMiddleware`
- `merchantScopePermission`

## Reference composition

Load the Ed25519 keys from operator-controlled configuration, a secret manager, or a protected file. Never embed a private key in application source.

```ts
import { FiberChannelRpcClient } from "@fiberlsp/fiber";
import { createApi } from "@fiberlsp/server";
import {
  FileMerchantPolicyStore,
  MemoryChallengeStore,
  SignedCapabilityService,
  SignedFiberInvoiceVerifier,
  createMerchantAuthMiddleware,
} from "@fiberlsp/auth";

const rpc = new FiberChannelRpcClient({ rpcUrl: process.env.FIBER_RPC_URL! });
const challenges = new MemoryChallengeStore({ ttlMs: 5 * 60_000 });
const policies = new FileMerchantPolicyStore("./state/merchant-policies.json");

const quota = {
  async usage(pubkey: string) {
    const channels = await rpc.listChannels(pubkey);
    return {
      openChannels: channels.filter((channel) =>
        channel.state.state_name !== "Closed"
      ).length,
    };
  },
};

const capabilities = new SignedCapabilityService({
  privateKey: operatorPrivateKey,
  publicKey: operatorPublicKey,
  quota,
});

const proofVerifier = new SignedFiberInvoiceVerifier({
  rpc,
  challenges,
  expectedCurrency: "Fibt",
});

const merchantAuth = createMerchantAuthMiddleware({
  challenges,
  proofVerifier,
  policies,
  capabilities,
});

const handle = createApi(lsp, {
  prepaid,
  jit,
  middleware: [merchantAuth],
});
```

The snippet is composition only. Existing `createApi` calls without `middleware` remain unauthenticated.

## Merchant flow

1. Request `POST /lsp/v1/auth/challenge` with `{ "pubkey": "<merchant-node-pubkey>" }`.
2. Ask the merchant's Fiber node to create a zero-amount, short-lived invoice whose description is the exact challenge.
3. Submit `POST /lsp/v1/auth/token` with `{ "invoice": "<signed-invoice>", "pubkey": "<merchant-node-pubkey>" }`.
4. Send the returned token as `Authorization: Bearer <token>` when creating prepaid or JIT orders.

The middleware guards only `POST /lsp/v1/orders` and `POST /lsp/v1/jit/orders`. JIT GET, reveal, and cancel continue to use their existing per-order token.

## Security model

FNN v0.9.0-rc5 `parse_invoice` cryptographically validates a present recoverable secp256k1 signature against the invoice's `payee_public_key`. `SignedFiberInvoiceVerifier` still requires a non-empty signature, an exact payee match, a live single-use challenge, a non-expired timestamp/expiry pair, and the configured `expectedCurrency`. The currency check is the cross-network replay guard because invoices expose a network currency marker rather than `chain_hash`.

`MemoryChallengeStore.consume` checks the merchant and expiry before atomically deleting a valid challenge. Reuse fails. `SignedCapabilityService` binds the merchant pubkey, permissions, and optional `maxChannels` into the Ed25519-signed payload, then consults live quota usage on authorization. Signed tokens remain valid until the operator rotates the signing key, so deployments should define an operational key-rotation policy.

`createAdminPolicyMiddleware` is reference-only and requires a deployment-supplied admin authorization callback. The package does not prescribe an admin credential format or database.

## Live verification

The proof path was checked without moving funds on two FNN v0.9.0-rc5 testnet nodes:

1. `node_info` returned each node's pubkey and testnet chain hash.
2. Each node created a zero-amount `Fibt` invoice with a byte-exact challenge description.
3. `parse_invoice` returned a non-empty signature, the issuing node's pubkey, the exact description, timestamp, expiry, and `currency: "Fibt"`.
4. A signature word was modified and a new valid Bech32m checksum was calculated. `parse_invoice` rejected the resulting invoice as `Invalid signature`.

These calls created local, short-lived invoices only. They did not open channels or move funds.
