# Single-Node JIT Checkout Cleanup Design

## Objective

Replace the current dual JIT model with one production-oriented single-node JIT mechanism. The old two-node same-hash JIT path will be removed from the codebase. The remaining JIT path will use linked hashes so one LSP Fiber node can hold the customer payment, open the channel, pay the merchant leg, derive the hold preimage, and settle the customer payment.

## Target Mechanism

The merchant SDK generates a 32-byte secret `S` and derives two tagged SHA-256 preimages:

```text
holdPreimage = TAG_HOLD || S
legPreimage  = TAG_LEG  || S
holdHash     = sha256(holdPreimage)
legHash      = sha256(legPreimage)
```

The merchant creates a leg invoice for the net amount using `legPreimage`. The LSP creates a hold invoice for the gross amount using `holdHash`. The customer pays the hold invoice. Once the hold is received, the LSP opens a channel to the merchant and pays the merchant leg invoice. When the leg payment succeeds, the LSP obtains `legPreimage`, derives `holdPreimage`, and settles the held customer payment.

The API surface becomes:

```text
POST /lsp/v1/jit/orders
GET  /lsp/v1/jit/orders/:id
POST /lsp/v1/jit/orders/:id/reveal
POST /lsp/v1/jit/orders/:id/cancel
```

There will be no `/lsp/v1/jit/linked/*` route and no `JIT_HUB_RPC_URL`.

## Security Rules

Single-node JIT is only safe when the LSP verifies, before opening capital, that `holdHash` and `legHash` are linked without learning `S`. The unsafe exposed-secret proof must not be enabled by default.

Production startup must require a non-exposed-secret verifier. The current Groth16 verifier path is acceptable only after the circuit and TypeScript public-signal interface are fixed in this cleanup. A test-only unsafe path is allowed only when `JIT_ALLOW_UNSAFE_EXPOSED_SECRET=1` is set.

External reveal must be safe:

- wrong preimages are rejected without changing terminal state,
- a wrong preimage must never trigger refund after the merchant has already been paid,
- if the server cannot read the leg preimage from `get_payment`, the merchant SDK reveals `legPreimage` only after the merchant leg invoice is paid.

Control endpoints must be treated as capital-moving operations. This cleanup will add a per-order bearer token returned at order creation. `GET`, `cancel`, and `reveal` must require that token.

Order creation must reject duplicate active `holdHash`, duplicate active `legHash`, and duplicate active `merchant_invoice`.

## Policy Validation

JIT must enforce the LSP's asset and capacity policy, not only the fee terms:

- requested asset must be offered,
- gross amount must satisfy `min_payment`,
- merchant leg amount must equal `gross - fee`,
- merchant leg hash must equal `legHash`,
- channel capacity must cover `forward_amount`,
- channel capacity must not exceed the configured/offered maximum,
- expiry must be capped by `max_expiry_seconds`.

The JIT config will accept supported asset offerings and derive its asset/capacity policy from them.

## Code Changes

Delete the old two-node JIT implementation and tests:

```text
packages/lsp-server/src/jit.ts
packages/client/src/JitCheckout.ts
packages/lsp-server/test/jit.test.ts
packages/lsp-server/test/jitConcurrency.test.ts
packages/lsp-server/test/mockJitNodes.ts
packages/client/test/jitCheckout.test.ts
```

Rename and harden the linked implementation:

```text
packages/lsp-server/src/linkedJit.ts -> packages/lsp-server/src/jit.ts
packages/client/src/LinkedJitCheckout.ts -> packages/client/src/JitCheckout.ts
packages/lsp-server/test/linkedJit.test.ts -> packages/lsp-server/test/jit.test.ts
packages/client/test/linkedJitCheckout.test.ts -> packages/client/test/jitCheckout.test.ts
```

Update exports, server wiring, docs, and demo references so `JitService` and `JitCheckout` mean the single-node linked mechanism.

## Proof Circuit Fix

The current Groth16 circuit and TypeScript verifier must agree on public signals. A 256-bit hash must not be packed into one BN254 field. The proof interface will expose 512 public bit signals: 256 bits for `holdHash`, followed by 256 bits for `legHash`. The circuit must also constrain the tag bytes so the statement is exactly:

```text
exists S:
  sha256(TAG_HOLD || S) = holdHash
  sha256(TAG_LEG  || S) = legHash
```

Until this is fixed and verified, production JIT must not enable the Groth16 path.

## Testing

Tests must cover:

- single-node happy path: hold received, channel opens, leg pays, hold settles,
- fallback reveal path when `get_payment` omits `payment_preimage`,
- wrong reveal before forward does not poison the order,
- wrong reveal after forward does not refund a paid merchant path,
- invalid linkage proof rejects before hold invoice creation,
- unsupported asset and over-capacity requests reject,
- duplicate active hashes/invoices reject,
- endpoint auth rejects missing/wrong token,
- unsafe exposed-secret verifier is disabled unless explicitly opted in.

## Out Of Scope

This cleanup does not implement a production auth provider, a full webhook allowlist system, or a completed trusted Groth16 ceremony. It must leave explicit startup/runtime guards so unsafe modes cannot be mistaken for production.
