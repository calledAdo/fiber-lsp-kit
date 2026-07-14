# Roadmap

Fiber LSP Kit currently provides the LSPS-Fiber contract, typed FNN integration, two atomic JIT deployments,
channel-bound live-capacity rent, optional prepaid provisioning, and independent operational bricks. The work
below moves those interfaces from reference-grade infrastructure toward production operator deployments.

## Production safety

- **Trusted linked setup.** Replace the single-contributor development phase 2 with a public multi-party
  ceremony and beacon, or use `same_hash` and avoid the proof system entirely. See
  [`docs/CEREMONY.md`](./docs/CEREMONY.md).
- **Replayable preimage recovery.** Normal JIT settlement observes the paying node directly, but FNN's pubsub
  event has no replay and `get_payment` omits the preimage. Add a durable upstream read/replay path when one is
  available; keep merchant reveal as explicit recovery until then.
- **Durable stores.** Add production SQLite/Postgres implementations behind the existing store interfaces,
  transactional order transitions, expiry sweeping, and restart/failure testing.
- **Lease enforcement.** Add an LSP-side rent watcher that applies an operator-selected grace policy and closes
  a leased channel when required.
- **Independent review.** Audit the JIT state machine, linked circuit/setup, capability-token composition, and
  failure recovery before real-fund deployment.

## Operator readiness

- Structured logs, metrics, health checks, and alerts for held payments, channel opens, rent, and recovery.
- Deployment-owned key rotation, durable merchant policies, rate limiting, and audit logs around optional auth.
- A production webhook outbox with retries, idempotency, dead-letter handling, and delivery observability.
- Rebalancing policy that consumes the existing dry-run planner while keeping automatic submission opt-in.

## Protocol growth

- **Prepaid activation escrow.** Bind the prepaid fee to successful channel provisioning instead of relying on
  pay-before-open trust.
- **Provider quality signals.** Add uptime/reputation inputs without turning the static provider file into a
  source of dynamic pricing or liquidity truth.
- **External capital.** Compose FNN external-funding RPCs into a separately reviewed signing handoff so node
  operation and channel capital do not have to share one hot wallet.

## Upstream-dependent simplification

The following require FNN/Fiber capabilities rather than local application work:

- intermediary TLC interception and zero-confirmation channels for sub-second unarranged JIT;
- PTLC/adaptor-signature locks to remove the single-node linkage proof;
- replayable preimage reads and typed invoice/channel/payment lifecycle subscriptions;
- amount and asset fields on payment-history RPCs;
- native LSP capability and endpoint advertisement in node gossip.

Version-scoped reproductions and proposals are maintained in
[`docs/upstream-fiber-findings.md`](./docs/upstream-fiber-findings.md).
