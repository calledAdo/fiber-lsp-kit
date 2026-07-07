# Single-Node JIT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace dual/two-node JIT with one canonical single-node linked-hash JIT implementation.

**Architecture:** The protocol exposes linked JIT fields directly on `CreateJitOrderRequest`. The server has one `JitService` driven by one Fiber RPC node. The client has one `JitCheckout` that creates the merchant leg invoice, registers a linked JIT order, and reveals the leg preimage only after the merchant leg is paid when fallback settlement is needed.

**Tech Stack:** TypeScript workspaces, Node `node:test`, FNN JSON-RPC wrapper, Circom Groth16 proof interface.

---

### Task 1: Protocol Types And Proof Signals

**Files:**
- Modify: `packages/protocol/src/jit.ts`
- Modify: `packages/protocol/src/linkageDualSha256.ts`
- Modify: `packages/protocol/test/linkageDualSha256.test.ts`
- Modify: `packages/protocol/circuits/dual-sha256-linkage/dual_sha256_linkage.circom`
- Modify: `scripts/linkage-witness-input.mjs`

- [ ] **Step 1: Write failing protocol tests**

Add assertions that `hashToBitSignals(hash)` returns 256 bit strings and that the Groth16 verifier compares 512 public signals as `hold bits || leg bits`.

- [ ] **Step 2: Run protocol linkage test**

Run: `node --import tsx --test packages/protocol/test/linkageDualSha256.test.ts`

Expected before implementation: fail because `hashToBitSignals` is missing.

- [ ] **Step 3: Implement protocol changes**

Make `CreateJitOrderRequest` use `hold_hash`, `leg_hash`, `merchant_invoice`, `linkage_proof`, and remove the two-node `payment_hash` request shape. Add `JitOrderRequest = Omit<CreateJitOrderRequest, "linkage_proof">`. Replace single-field hash public signals with 512 public bit signals in the verifier helpers.

- [ ] **Step 4: Update circuit/witness helper**

Make the circuit hash fixed domain-tag bytes plus a private 32-byte secret. Public signals are 256 hold hash bits followed by 256 leg hash bits. Update the witness helper to emit this shape.

### Task 2: Canonical Server JIT

**Files:**
- Replace: `packages/lsp-server/src/jit.ts`
- Delete: `packages/lsp-server/src/linkedJit.ts`
- Modify: `packages/lsp-server/src/jitStore.ts`
- Modify: `packages/lsp-server/src/index.ts`
- Test: `packages/lsp-server/test/jit.test.ts`

- [ ] **Step 1: Write failing service tests**

Cover happy path, fallback reveal, invalid proof, bad early reveal, unsupported asset, over-capacity, duplicate hash/invoice, and bearer-token enforcement.

- [ ] **Step 2: Run service test**

Run: `node --import tsx --test packages/lsp-server/test/jit.test.ts`

Expected before implementation: fail because the current `JitService` is the old two-node service.

- [ ] **Step 3: Implement single-node `JitService`**

Use one `rpc`, `terms`, `supportedAssets`, and `linkageVerifier`. Validate policy, create hold invoice with `hold_hash`, open the channel, pay `merchant_invoice`, derive the hold preimage from the leg preimage, and settle. Reject bad external reveals before storing them.

- [ ] **Step 4: Harden persistence**

Store `order_token` and temporary `preimage` only in the private record. Strip both from wire responses unless the response is the initial create response. Write file-store data with mode `0600`.

### Task 3: REST And Server Wiring

**Files:**
- Modify: `packages/lsp-server/src/api.ts`
- Modify: `packages/lsp-server/src/server.ts`

- [ ] **Step 1: Write failing API tests**

Use direct `createApi` calls to show `/lsp/v1/jit/orders` creates a single-node order, `/lsp/v1/jit/linked/orders` is gone, and `GET`/`reveal`/`cancel` reject missing bearer tokens.

- [ ] **Step 2: Implement API wiring**

Remove `linkedJit` API branches. Add optional request headers to the dispatcher. Extract bearer token from `Authorization: Bearer <token>`.

- [ ] **Step 3: Implement server startup guard**

Remove `JIT_HUB_RPC_URL`. Mount JIT only when a Groth16 verifier loads or `JIT_ALLOW_UNSAFE_EXPOSED_SECRET=1` is explicitly set.

### Task 4: Canonical Client Checkout

**Files:**
- Replace: `packages/client/src/JitCheckout.ts`
- Delete: `packages/client/src/LinkedJitCheckout.ts`
- Modify: `packages/client/src/index.ts`
- Test: `packages/client/test/jitCheckout.test.ts`

- [ ] **Step 1: Write failing checkout tests**

Cover order creation with linked hashes, required proof builder, fallback reveal when server remains `forwarding`, and bearer token usage on follow-up calls.

- [ ] **Step 2: Implement checkout**

Generate `S`, derive `dualSha256(S)`, create the merchant leg invoice with `legPreimage`, post `hold_hash` and `leg_hash` to `/lsp/v1/jit/orders`, then wait for leg `Paid` and reveal `legPreimage` when needed.

### Task 5: Delete Legacy Two-Node Surface And Update Docs

**Files:**
- Delete: `packages/lsp-server/test/jitConcurrency.test.ts`
- Delete: `packages/lsp-server/test/mockJitNodes.ts`
- Delete: `packages/client/test/linkedJitCheckout.test.ts`
- Delete: `packages/lsp-server/test/linkedJit.test.ts`
- Delete: `scripts/demo/06-jit-atomic.mjs`
- Modify: `README.md`
- Modify: `docs/LSPS-Fiber.md`
- Modify: `scripts/demo/README.md`

- [ ] **Step 1: Remove obsolete files**

Delete the old same-hash two-node tests, mocks, and demo script. Delete linked-name tests after their canonical replacements exist.

- [ ] **Step 2: Update docs**

Describe the single-node linked-hash JIT flow as the canonical JIT path. Remove `JIT_HUB_RPC_URL` instructions and `/jit/linked` references.

### Task 6: Verification

**Files:**
- All changed package files.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
node --import tsx --test packages/protocol/test/linkageDualSha256.test.ts packages/lsp-server/test/jit.test.ts packages/client/test/jitCheckout.test.ts
```

- [ ] **Step 2: Run broad test command if practical**

Run:

```bash
npm test
```

If this is skipped, report exactly why.
