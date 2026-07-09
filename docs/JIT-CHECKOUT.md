# Single-Node JIT Checkout

JIT checkout lets a merchant receive its first Fiber payment before it already has usable inbound capacity.
The implementation in this repo is **single-node linked-hash JIT**: one LSP Fiber node receives the customer
hold payment, opens a channel to the merchant, pays the merchant leg invoice, and settles the customer hold
only after the merchant leg has settled.

## Why It Exists

A fresh merchant cannot receive an asset if no channel points inbound toward it. A normal checkout would fail
before the merchant can show a payable invoice. JIT changes the order of operations:

1. the customer payment is held safely at the LSP,
2. the LSP opens the merchant's inbound channel,
3. the LSP forwards the net amount to the merchant,
4. the customer hold is settled only after that forward succeeds.

This is atomic from the payment perspective: deliver to the merchant or refund the payer.

## The linked-hash construction

One FNN node cannot safely hold `invoice(H)` and also send `payment(H)` — it can mark its own invoice paid and
reject the held TLC. So the customer hold and the merchant leg use two different hashes derived from one
merchant secret `S`. An FNN invoice preimage is a fixed 32-byte `Hash256`, so both preimages are kept to 32
bytes — the domain-tagged value is hashed down rather than fed in raw:

```text
S           = merchant-generated 32-byte secret
leg_hash  B = sha256(S)                              (leg invoice; preimage = S)
hold_hash A = sha256(sha256("LSPS-FIBER/JIT/HOLD\0" || S))
                                                     (hold invoice; preimage = sha256(TAG || S))
```

Paying the leg reveals `S`; the LSP derives the hold preimage `sha256(TAG || S)` and settles the hold. The tag
is essential — without it the hold preimage would be `sha256(S) = B`, which is public, letting anyone settle
the hold. The LSP verifies a proof that `A` and `B` come from one hidden `S` before committing capital: in
production `groth16-dual-sha256` (a Groth16 proof of `∃S : sha256(S)=B ∧ sha256(sha256(TAG||S))=A`), or the
test-only `exposed-secret`, which reveals `S` and is not a production mode.

## Merchant SDK API

The merchant uses `JitCheckout` from `@fiberlsp/client`.

```ts
const checkout = new JitCheckout({
  rpc: merchantRpc,
  lspBaseUrl: "http://127.0.0.1:8080",
  merchantPubkey,
  merchantAddress,
  proveLinkage,
});

const session = await checkout.checkout({
  asset: RUSD,
  amount: "300000000",
  description: "order #123",
  expirySeconds: 1800,
  webhookUrl: "https://merchant.example/webhooks/jit",
});

// Show this to the customer.
console.log(session.invoice);

// After customer payment and LSP forwarding, wait for final settlement.
const finalOrder = await session.settle({ attempts: 300, intervalMs: 2000 });
```

Constructor parameters:

| Parameter | Meaning |
|---|---|
| `rpc` | Merchant's own `FiberChannelRpcClient`. It issues the merchant leg invoice and checks settlement. |
| `lspBaseUrl` | Base URL for the LSP REST API. |
| `merchantPubkey` | Merchant Fiber node pubkey. The LSP opens the JIT channel toward this node. |
| `merchantAddress` | Optional Fiber multiaddr the LSP can dial. |
| `proveLinkage` | Function that returns a `LinkageProof` for `hold_hash`, `leg_hash`, and the merchant secret. |
| `fetchImpl`, `randomBytes`, `sleep` | Optional test hooks. |

Checkout request parameters:

| Parameter | Meaning |
|---|---|
| `asset` | Asset the customer pays and the channel carries. |
| `amount` | Gross customer payment in the asset base unit. |
| `description` | Optional merchant leg invoice text. |
| `expirySeconds` | Optional hold invoice expiry. The LSP caps this by its advertised JIT terms. |
| `webhookUrl` | Optional URL for JIT state updates. |

The returned session contains:

| Field | Meaning |
|---|---|
| `invoice` | Customer-facing LSP hold invoice. |
| `paymentHash` | The customer-facing `hold_hash`. |
| `order` | Initial `JitOrder` returned by the LSP. |
| `netAmount` | Merchant amount after JIT fee deduction. |
| `fee` | JIT fee deducted from the gross payment. |
| `settle()` | Waits for merchant leg payment and performs fallback reveal if needed. |
| `cancel()` | Cancels before the LSP commits capital. |

## LSP Service API

The server uses `JitService` from `@fiberlsp/server`.

```ts
const jit = new JitService({
  rpc: lspRpc,
  terms,
  supportedAssets,
  linkageVerifier,
  minCapacity: "1000000000",
  store,
});
```

Important parameters:

| Parameter | Meaning |
|---|---|
| `rpc` | LSP's own `FiberChannelRpcClient`. One node issues the hold invoice, opens the channel, pays the leg, and settles the hold. |
| `terms` | JIT fee and expiry terms advertised in `/lsp/v1/info`. |
| `supportedAssets` | Asset offerings and min/max capacity policy. |
| `linkageVerifier` | Verifies `hold_hash` and `leg_hash` linkage before capital is committed. |
| `minCapacity` | Optional floor above the offering minimum. Useful for Fiber UDT auto-accept floors. |
| `store` | Optional persistent `JitStore`. Defaults to memory. |
| `pollIntervalMs`, `readyPollAttempts` | Channel/payment polling controls. |
| `deliverWebhook` | Optional JIT update webhook dispatcher. |
| `onFraud` | Optional callback if a leg preimage proves the leg but fails the hold mapping. |

The REST order creation body is `CreateJitOrderRequest`:

```jsonc
{
  "target_pubkey": "0x...",
  "target_address": "/ip4/127.0.0.1/tcp/8248/p2p/...",
  "asset": { "kind": "UDT", "symbol": "RUSD", "udt": { "...": "..." } },
  "hold_hash": "0x...",
  "leg_hash": "0x...",
  "merchant_invoice": "fibt...",
  "linkage_proof": { "scheme": "groth16-dual-sha256", "data": "{...}" },
  "amount": "300000000",
  "channel_capacity": "1000000000",
  "expiry_seconds": 1800,
  "webhook_url": "https://merchant.example/webhooks/jit"
}
```

The LSP rejects unsupported assets, duplicate active hashes or invoices, invalid proofs, incorrect leg invoice
hashes, incorrect leg invoice amounts, too-small payments, over-capacity requests, and unauthorized follow-up
calls.

## State Machine

```text
created
  -> payment_held
  -> opening
  -> forwarding
  -> settled

created -> expired
created/payment_held -> refunded
opening/forwarding -> refunded on failed open or failed forward
```

Follow-up reads, reveals, and cancellation require the per-order bearer token returned at creation:

```text
Authorization: Bearer <order_token>
```

## Setup Modes

Production-style JIT is enabled by loading a Groth16 verification key:

```bash
LINKED_JIT_VK_PATH=/path/to/verification_key.json npm run server
```

Local test-only JIT can be enabled with:

```bash
JIT_ALLOW_UNSAFE_EXPOSED_SECRET=1 npm run server
```

That mode reveals the merchant secret to the LSP before forwarding. It is useful for tests and demos of API
control flow, but it is not the security model.

## Artifact distribution

The circuit source is in
[`packages/protocol/circuits/dual-sha256-linkage`](../packages/protocol/circuits/dual-sha256-linkage);
generated `.zkey`/`.ptau`/`.wasm`/vk files are git-ignored. Integrators do **not** run the ceremony — they
download the artifacts:

| Role | Files | Trust |
|---|---|---|
| Merchant (prover) | `dual_sha256_linkage.wasm` + final `.zkey` | none — pure computation, safe to publish |
| LSP (verifier) | `verification_key.json` | must come from a ceremony you trust |

The `.zkey` and vk must be a matched pair from the same ceremony. The vk is security-critical: a Groth16 setup
has toxic waste, and whoever ran the ceremony could forge a linkage proof — a forged proof makes the LSP open
the channel and pay the merchant leg, then fail to settle the customer hold (loss). So an LSP must trust the vk
came from a ceremony with at least one honest participant. **This repo's artifacts are a single-party dev
ceremony — test-only.** For production, reuse a trusted Powers-of-Tau phase 1 and run a multi-party phase-2
ceremony, then publish `.wasm`+`.zkey` for provers and the vk + transcript for verifiers as Release assets
(with content hashes), not in git.

## Latency

This JIT path is atomic, but it is not sub-second. It waits for a Fiber channel open, so checkout latency is
bounded by on-chain confirmation and Fiber channel readiness. On testnet this can take minutes. The customer
payment remains held during that window and expires or refunds if provisioning fails.

Sub-second JIT would need upstream Fiber changes: HTLC/TLC interception for intermediaries and zero-conf
channels. Those asks are sketched in [`upstream-fiber-findings.md`](./upstream-fiber-findings.md).
