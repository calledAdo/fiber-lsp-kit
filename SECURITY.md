# Security

Fiber LSP Kit coordinates held payments, channel capital, and merchant settlement. The repository is a
reference implementation under active development and has not received an independent security audit.

## Deployment status

- The package versions are `0.0.0`; there is no stable production release.
- Live integration is pinned to FNN `v0.9.0-rc5`. Later node versions require the live probes to be rerun.
- The published `linked` Groth16 phase-2 artifacts use one development contribution and must not protect real
  funds. Use `same_hash` or complete the ceremony in [`docs/CEREMONY.md`](./docs/CEREMONY.md).

## Load-bearing assumptions

- A JIT order must be held before a channel opens and the merchant must be paid before the customer hold is
  settled. Do not reorder these transitions.
- `same_hash` requires distinct hold and payment nodes, a direct freshly-funded payment-node-to-merchant route,
  and durable application handoff between the nodes.
- `linked` additionally relies on circuit correctness, verifier correctness, and the soundness of its Groth16
  setup.
- FNN `v0.9.0-rc5` preimage observation is live-only. A missed event requires explicit cooperative recovery
  until FNN exposes a replayable read.
- Prepaid provisioning is pay-before-open and is not atomic without a separate escrow mechanism.
- Authentication is optional and off by default. Operators own key storage, rotation, rate limiting, policy
  persistence, transport security, and administrative authorization.

The complete trust and timing model is in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Operator checklist

- Keep FNN RPC, especially the store-change stream carrying payment preimages, on a trusted network boundary.
- Use persistent stores and test restart recovery before accepting held payments.
- Bound order amount, channel capacity, hold lifetime, and concurrent capital exposure.
- Verify linked artifacts against published checksums and a trusted ceremony transcript.
- Keep live-payment and irreversible-close checks opt-in during deployment testing.
- Monitor held orders, expiring TLCs, failed channel opens, missed preimage events, and webhook delivery.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for the repository when available. Otherwise, open a minimal issue
requesting a private contact channel and do not include exploit details or secrets in the public issue.
