# JIT demo guide

This is the single operator guide for both JIT checkout demonstrations. The demos use the same
`FiberChannelRpcClient`, checkout services, state machines, proof code, and streaming-rent primitive used by a
deployment. Mock FNN nodes replace only the JSON-RPC transport boundary; application logic does not branch on
whether a node is mock or live.

The demo covers JIT checkout, a post-JIT regular invoice payment, and channel-bound rent. The regular payment is
part of the linked scenario: the payer explicitly selects the LSP as a Fiber trampoline after the first checkout
leaves that LSP with channels to both customer and merchant.

## Choose a scenario

Choose one scenario before starting any process. Commands and configuration are scenario-qualified and the two
topologies never share node roles at runtime.

| Scenario | LSP topology | Hash relationship | Proof artifacts | Config |
|---|---|---|---|---|
| `linked` | One LSP node, merchant, customer | Two hashes derived from one secret | Groth16 required | [`linked/demo.config.json`](./linked/demo.config.json) |
| `same-hash` | Hold node, payment node, merchant, customer | One hash on both invoices | None | [`same-hash/demo.config.json`](./same-hash/demo.config.json) |

### Linked topology

```text
customer == existing funded asset channel ==> LSP -- opens and funds --> merchant
```

One LSP node cannot safely hold and forward the same hash. The hold and merchant invoices therefore have
different hashes, and the merchant proves that both derive from one private secret. The merchant builds the
proof; the LSP verifies it before issuing the customer-facing hold invoice.

### Same-hash topology

```text
customer == existing funded asset channel ==> hold node

payment node -- opens and funds --> merchant
```

One operator runs two distinct LSP nodes. The hold and merchant invoices share one payment hash. The hold and
payment nodes need neither a channel nor a peer connection between them; application state coordinates the
handoff.

## Requirements

- Node.js 20.6 or later and npm.
- Dependencies installed with `npm install`.
- For a live run, distinct prepared FNN nodes with the configured RUSD asset.
- For `linked`, the proving and verification artifacts described below.

All monetary CLI values use the configured asset's human denomination. With the supplied RUSD configuration,
`--amount 1.25` means `1.25 RUSD`, not `1.25` base units.

## Quick mock verification

Each one-process command starts mock FNN roles and runs checkout plus rent end to end:

```bash
npm run demo:linked:e2e
npm run demo:same-hash:e2e
```

These deterministic checks use the base-unit values under `e2eFixtures` in the selected `demo.config.json`.
That section is test-fixture data only: multi-terminal and live checkout commands never read it for payment or
channel capacity.

A successful run proves the following ordering:

1. The customer payment reaches the hold node and is held.
2. The LSP opens the requested merchant channel.
3. The LSP pays the merchant invoice through that channel.
4. Only after merchant payment succeeds does the LSP release the customer hold.
5. Rent is calculated from the exact channel's live remaining inbound capacity.

The `linked` run additionally builds and verifies the real proof. The `same-hash` run confirms that its hold
and payment roles are distinct and have no channel between them. After linked JIT settlement, the run issues a
regular merchant invoice and routes a second payment over the existing channels without another proof or channel
open. The supplied split-node topology does not guarantee that repeat route, so the same-hash E2E does not claim it.

## Mock or live nodes

Node selection is atomic for each scenario:

- If every required node field in `demo.config.json` is populated, all roles use those live FNN endpoints.
- If any required field is blank, all roles use mock nodes.
- A run never mixes mock and live nodes.

Required live fields:

| Scenario | Required fields |
|---|---|
| `linked` | `lsp.rpc`, `merchant.rpc`, `merchant.p2p`, `customer.rpc` |
| `same-hash` | `hold.rpc`, `payment.rpc`, `merchant.rpc`, `merchant.p2p`, `customer.rpc` |

The committed configurations are deliberately blank and therefore select mock nodes. No FNN process, testnet
funds, or CKB endpoint is needed for the quick E2E commands. To select live nodes, edit only the endpoint fields
for the chosen scenario and populate every required node field as one unit.

Linked example:

```json
{
  "ckbRpc": "https://testnet.ckb.dev/rpc",
  "nodes": {
    "lsp": { "rpc": "http://127.0.0.1:8327" },
    "merchant": {
      "rpc": "http://127.0.0.1:8347",
      "p2p": "/ip4/127.0.0.1/tcp/8348"
    },
    "customer": { "rpc": "http://127.0.0.1:8337" }
  }
}
```

Same-hash example:

```json
{
  "ckbRpc": "https://testnet.ckb.dev/rpc",
  "nodes": {
    "hold": { "rpc": "http://127.0.0.1:8327" },
    "payment": { "rpc": "http://127.0.0.1:8337" },
    "merchant": {
      "rpc": "http://127.0.0.1:8357",
      "p2p": "/ip4/127.0.0.1/tcp/8358"
    },
    "customer": { "rpc": "http://127.0.0.1:8347" }
  }
}
```

These snippets show only the fields that change between mock and live operation; retain the asset, JIT policy,
control ports, proof paths, and E2E fixtures already present in the file. The URLs are examples, not ports the
demo starts or configures. Each RPC must point to an already-running FNN node, and `merchant.p2p` must be a
dialable address for that same merchant node.

`ckbRpc` is optional and does not participate in mock-vs-live selection. When it is set, the dashboard uses the
CKB indexer `get_cells` method to show the paying LSP node's unspent on-chain balance for the configured UDT. This
is a read-only planning aid for choosing channel capacity; checkout and preflight do not depend on it.

The LSP launcher performs a read-only preflight before starting its REST service. It verifies node identities,
one chain hash, distinct roles, customer-to-hold connectivity, channel readiness, asset identity, positive
customer outbound capacity, and paying-node preimage subscription support. It does not assume the next checkout
amount, create prerequisite channels, or fund live nodes. The invoice action validates the requested amount.

### Live prerequisites: linked

- The customer is connected to the LSP and has a ready RUSD channel with positive local balance.
- The LSP has enough CKB and RUSD to open the requested merchant channel.
- The LSP FNN enables the `pubsub` RPC module so it can observe the merchant payment preimage.
- The merchant P2P listener configured as `merchant.p2p` is reachable by the LSP.
- To run the optional post-JIT regular-payment step, the LSP advertises `TRAMPOLINE_ROUTING_REQUIRED` or
  `TRAMPOLINE_ROUTING_OPTIONAL`. This is not required for JIT checkout itself.

### Live prerequisites: same-hash

- The customer is connected to the hold node and has a ready RUSD channel with positive local balance.
- The payment node has enough CKB and RUSD to open the requested merchant channel.
- The payment-node FNN enables the `pubsub` RPC module.
- The merchant P2P listener is reachable by the payment node.
- No connection or channel is required between the hold and payment nodes.

For either live topology, retain the normal FNN RPC modules when adding `pubsub`, and bind RPC according to the
operator's own security policy. The demo does not configure FNN authentication or public exposure.

Before a live JIT recording, run the scenario's `status` command and confirm:

| Check | Required initial state |
|---|---|
| Merchant | no ready channel in the configured asset |
| Customer | connected to the hold role with one ready asset channel and enough local outbound for the payment |
| Paying LSP role | enough on-chain CKB and configured UDT to fund the requested channel |
| Paying LSP RPC | `pubsub` enabled; merchant P2P address reachable |
| Repeat payment (`linked` only) | LSP advertises trampoline routing |

The demo reports the exact customer single-channel maximum. The optional on-chain dashboard figure is only an
upper bound; it does not account for CKB cell capacity, reserves, fees, or concurrent channel opens.

## Linked proof artifacts

`linked` resolves all three artifacts as one set:

- verification key;
- proving key;
- circuit WASM.

Resolution order is:

1. `scripts/demo/.artifacts` cache;
2. configured circuit build output;
3. checksum-verified download from the release in `linked/demo.config.json`, cached under
   `scripts/demo/.artifacts`.

Startup fails if a complete verified set cannot be obtained. It never changes to `same-hash` automatically.

## Multi-terminal walkthrough

The examples below use `linked`. Replace `linked` with `same-hash` to run the four-node topology.
Use either the browser actions or the CLI action commands for one checkout. The service startup commands are
required for both interfaces.

### 1. Start the services

Use three terminals and start them in order:

```bash
# terminal 1
npm run demo:linked:lsp

# terminal 2
npm run demo:linked:merchant

# terminal 3
npm run demo:linked:customer
```

Normal startup output is intentionally compact: colored milestones show the selected profile, node readiness,
available liquidity, customer payment limit, and local control URL. Full pubkeys, chain hashes, channels, and
balances are reserved for the explicit `status` command. Colors are disabled automatically when output is not a
TTY or `NO_COLOR` is set.

The customer maximum is calculated from one ready, enabled, matching-asset channel to the hold node. It is a
deterministic single-channel limit, not aggregate MPP or graph-wide routing capacity.

The LSP demo stores recoverable JIT order state under the ignored scenario `.state` directory. It does not enable
the prepaid service's trust-settlement bypass.

### 2. Start the optional live dashboard

In a fourth terminal:

```bash
npm run demo:linked:dashboard
```

Open `http://127.0.0.1:7104` for `linked`, or `http://127.0.0.1:7004` for `same-hash`. The dashboard is an optional
interactive adapter over the same shared operations used by the CLI. It can create a merchant checkout, pay the
resulting customer invoice, issue and settle a regular invoice over the provisioned linked path, and stream rent
from the settled channel. No Fiber business logic is reimplemented in the browser.

Each one-second state refresh uses only the read-only FNN calls `node_info`, `list_peers`, and `list_channels`, then
combines those results with milestones from the ignored demo state cache. In a live profile with `ckbRpc` set, the
dashboard also reads the configured UDT cells under each paying LSP node's funding lock and caches the result for
30 seconds. Actions are sent to the dashboard's localhost-only Node process, which calls the already-running
merchant and customer control services. The browser receives the payable invoice so it can display and pay it,
but it never receives node private keys or an LSP order capability.

Dashboard action requests require JSON and the `x-demo-action: 1` header, which prevents an ordinary cross-site HTML
form from dispatching a payment. The action controller also permits only one invoice, payment, or rent operation at
a time, preventing duplicate dispatch from a double-click. The dashboard binds to `127.0.0.1`; do not expose this
demo control surface publicly.

The views are:

- **Overview:** every configured role, connectivity, ready channels, and asset balances.
- **Customer:** paste or use the latest invoice, pay it, and watch confirmation while inspecting direct capacity.
- **Merchant:** enter payment and channel capacity, build the checkout, and see the resulting JIT channel.
- **LSP:** combined or split hold/payment node liquidity, depending on the selected scenario.
- **Checkout:** invoice acceptance, proof or same-hash coordination, channel opening, and settlement milestones.
- **Repeat payments:** route validation, customer settlement, merchant confirmation, fee, and elapsed time.
- **Rent:** select the exact merchant channel and periods, then watch live-priced rent settlement.

The LSP view reports both off-chain channel liquidity and the paying node's on-chain UDT balance. The latter is an
upper bound, not a guaranteed channel capacity: channel reserve, CKB cell capacity, fees, and concurrent orders can
reduce what the node can actually open.

Every submitted action displays `Running`, `Completed`, or `Failed` with a live elapsed timer. The timer starts
when the dashboard backend accepts the action, so the JIT payment measurement includes paying the hold invoice,
waiting for channel creation, paying the merchant, and final settlement. On completion or failure the timer
freezes, and failures retain the exact backend diagnostic in the action panel.

The dashboard is optional. The CLI commands remain an equivalent reproducible adapter and work unchanged when the
dashboard is not running.

#### Browser walkthrough

Start the dashboard only after the LSP, merchant, and customer terminals have each printed their `ready` line. The
dashboard does not start those services itself.

1. Open the dashboard. It starts on the **Merchant** view.
2. Enter **Customer payment** and **Channel capacity** in the configured asset's human denomination. Keep the
   payment at or below the customer maximum shown in the Customer view.
3. Select **Create invoice**. In `linked`, the progress indicator remains active while the merchant builds the
   linkage proof and the LSP verifies it. In `same-hash`, no proof is built.
4. When the customer invoice appears, select **Continue to customer**. The same invoice is already populated in the
   Customer form; it can also be pasted or replaced explicitly.
5. Select **Pay invoice**. The button is disabled while payment is in flight. The Customer, Checkout, Merchant, and
   LSP views update as the hold is accepted, the merchant channel appears, and atomic settlement completes.
6. Open **Checkout** to inspect the completed lifecycle, or **Merchant** to inspect the new channel and its balance
   direction.
7. For `linked`, return to **Merchant**. The regular-invoice action is now available because the merchant has
   inbound liquidity. Enter an amount and select **Create regular invoice**.
8. Continue to **Customer** and select **Pay regular invoice**. Fiber first dry-runs route construction, then sends
   the payment. Open **Repeat payments** to see the routing fee, elapsed time, customer success, and merchant `Paid`
   confirmation. No proof is generated and no channel is opened.
9. Open **Rent**, select the settled merchant channel and number of periods, then select **Pay rent**. Each completed
   period updates the live remaining inbound balance and total paid.

The browser sequence replaces the CLI action steps below; do not create or pay the same checkout through both
adapters. `status` remains useful at any point for the complete raw node snapshot.

### 3. CLI alternative: inspect the initial state

In another terminal:

```bash
npm run demo:linked:status
```

`status` is read-only. It prints each role's pubkey, chain, peers, channels, outbound balance, inbound balance,
and the customer's current single-channel checkout limit.

### 4. Request the hold invoice

```bash
npm run demo:linked:invoice -- --amount 1 --capacity 10
```

- `--amount` is required. It is the amount the customer pays.
- `--capacity` is required. It is the inbound channel capacity requested by the merchant.

If either value is omitted, the command exits with `--amount is required` or `--capacity is required`. No RPC
call is made, no proof is built, no JIT order is created, and no hold invoice is issued. A zero value or an
amount above the displayed customer limit is also rejected before a JIT order is created.

On success, the command prints:

- the complete customer-facing hold invoice;
- a compact amount, currency, and shortened payment-hash summary;
- merchant net amount and JIT fee;
- the shorter `pay -- --latest` command for the next local step.

The complete invoice is printed exactly once. The merchant and customer service terminals show milestones instead
of repeating the long encoded invoice.

### 5. Pay the printed invoice

The explicit invoice is the authoritative input:

```bash
npm run demo:linked:pay -- --invoice '<printed-hold-invoice>'
```

For local convenience, the last invoice can instead be loaded from the ignored scenario `.state` directory:

```bash
npm run demo:linked:pay -- --latest
```

Exactly one of `--invoice` or `--latest` is required. With neither, the command exits before parsing or paying
an invoice. With both, it rejects the ambiguous request. Before payment, the customer FNN parses the invoice and
checks its amount against the direct customer-to-payee channel. Default output shows the amount and shortened
payment hash; use `status` for node and channel details.

During a successful checkout, the LSP logs that the customer payment is held, the channel opens, the merchant
invoice is forwarded, and the hold is released. The pay command returns only after the customer payment reaches
`Success`.

### 6. Inspect settlement and copy the channel

```bash
npm run demo:linked:status
```

The merchant should now have one ready channel and outbound revenue. Copy that merchant channel's full
`channel_outpoint`; rent is deliberately bound to this exact channel.

### 7. Issue and pay a regular invoice (`linked`)

After JIT has provisioned the merchant channel, issue a regular Fiber invoice:

```bash
npm run demo:linked:regular-invoice -- --amount 0.1
```

`--amount` is required and uses the configured asset's human denomination. The merchant uses
`InvoiceService.receive()`, so invoice creation stops if its current ready inbound capacity cannot cover the
amount. The command prints the complete regular invoice and records it separately from JIT state.

Pay the explicit invoice:

```bash
npm run demo:linked:regular-pay -- --invoice '<printed-regular-invoice>'
```

Or deliberately use the latest locally recorded regular invoice:

```bash
npm run demo:linked:regular-pay -- --latest
```

Before moving funds, the customer calls `send_payment` with the configured LSP in `trampoline_hops`, a one-percent
maximum fee budget, and `dry_run: true`. The real send uses the same hop and budget. A failed route is rejected
before funds move, and the parsed invoice payee must match the configured merchant. On success, the command waits
for both customer payment `Success` and merchant invoice `Paid`, then
prints the routing fee and elapsed settlement time. Its milestones are stored in `regular-payment.json`; the JIT
record is never modified.

The linked topology creates the required liquidity shape after JIT:

```text
customer == existing channel ==> LSP == newly provisioned channel ==> merchant
```

That shape alone does not give the customer full graph knowledge. The supplied repeat-payment helper therefore
chooses the LSP as a trampoline. Trampoline routing is optional outside this helper: an application may use normal
graph discovery, another trampoline provider, or an explicitly constructed route.

The same-hash demo intentionally keeps hold and payment nodes separate and does not require a routed path between
them. It therefore has no `regular-invoice` or `regular-pay` command. An operator may compose such a path, but it is
not an invariant of that scenario.

### 8. Stream rent

```bash
npm run demo:linked:rent -- --channel '<settled-channel-outpoint>' --periods 3
```

- Exactly one of `--channel` or `--latest` is required.
- `--periods` is optional and defaults to `3`; it must be a positive integer.
- `--latest` loads only the last settled channel identifier from local state:

```bash
npm run demo:linked:rent -- --latest
```

The merchant server does not read `.state`. It receives the selected channel, verifies that the channel exists,
infers its capacity from the two live balances, and prices each period from current remaining inbound. Output
shows the bound channel, inferred capacity, initial rent, every settled period, and total paid.

If a dispatched rent payment does not confirm within the polling window, the batch stops. Its payment hash is
printed so the operator can check `get_payment` before retrying; this prevents an immediate blind duplicate.

## Command contract

| Command | Required input | Optional input | Missing-input behavior |
|---|---|---|---|
| `demo:<scenario>:status` | None | None | Read-only snapshot |
| `demo:<scenario>:dashboard` | None | None | Local browser adapter for checkout, payment, rent, and live state |
| `demo:<scenario>:invoice` | `--amount <asset amount>` and `--capacity <asset amount>` | None | Exits before any JIT order is created |
| `demo:<scenario>:pay` | Exactly one of `--invoice <invoice>` or `--latest` | None | Exits before payment |
| `demo:linked:regular-invoice` | `--amount <asset amount>` | None | Exits before a regular invoice is issued |
| `demo:linked:regular-pay` | Exactly one of `--invoice <invoice>` or `--latest` | None | Exits before route validation or payment |
| `demo:<scenario>:rent` | Exactly one of `--channel <id>` or `--latest` | `--periods <n>`; defaults to `3` | Exits before pricing or payment |

The `--` between `npm run <script>` and command options is required so npm forwards the options to the demo
script.

## Local state

The ignored `scripts/demo/<scenario>/.state` directory is a convenience cache, not an authority:

- requesting an invoice replaces the cached invoice;
- customer payment and merchant settlement merge their milestones into the same record;
- regular invoice and repeat-payment milestones use a separate `regular-payment.json` record;
- rent stores its latest channel-bound result separately;
- `--latest` and the optional dashboard read this cache;
- explicit `--invoice` and `--channel` always win by being the sole selected input;
- the LSP, merchant rent logic, and FNN nodes do not depend on this directory.

Prefer explicit inputs when recording, debugging, or demonstrating the flow.

## Stopping and rerunning

Stop the LSP, merchant, customer, and optional dashboard processes with `Ctrl+C`. For mock runs, stopping the LSP
also stops the mock FNN processes started by its launcher.

Live runs move testnet funds and leave opened channels on the configured FNN nodes. Stopping the demo processes
does not close those channels or reset node balances. Prepare a fresh merchant node when a recording must begin
from zero channels.

Before committing or publishing after a live run:

1. Stop the dashboard, customer, merchant, and LSP processes with `Ctrl+C`.
2. Cooperatively close or deliberately retain any test channels; stopping the scripts does not alter FNN state.
3. Restore `ckbRpc` and every field under `nodes` to `""` in the selected `demo.config.json`.
4. Leave `.state` and downloaded `.artifacts` uncommitted; both paths are ignored and regenerated locally.
5. Run both quick E2E commands from the blank configuration to confirm mock-first behavior.

## Troubleshooting

- `EADDRINUSE ... 7104` / `7004`: a dashboard is already listening on that scenario's port. Open the documented URL
  or stop the earlier dashboard terminal with `Ctrl+C`, then start it again.
- A dashboard action says it cannot reach the merchant or customer control URL: start all three service processes
  in order and wait for their `ready` output before using the browser controls.
- The LSP view says `Unavailable` for on-chain balance: set `ckbRpc` to a CKB RPC endpoint with the indexer
  `get_cells` method, then restart the dashboard. This does not block checkout.
- `--amount is required`: rerun invoice creation with `-- --amount <value>`.
- `--capacity is required`: include the desired inbound capacity in the same command.
- `requested ... exceeds ... maximum single-channel payment`: lower the amount or replenish the customer's
  ready channel to the hold node.
- `provide --invoice <invoice> or --latest`: pass the printed invoice or deliberately select cached state.
- `provide a regular invoice or select the latest saved invoice`: create one first or pass it explicitly.
- `does not advertise trampoline routing`: the selected linked LSP cannot serve the optional repeat-payment helper;
  use graph/explicit routing or a compatible trampoline node.
- `no payable route to merchant`: the customer's FNN trampoline dry-run could not reach the configured LSP or the
  LSP could not route onward to the invoice payee within the fee budget.
- `cannot receive ... only ... inbound`: lower the regular invoice amount or provision more merchant inbound.
- `provide --channel <channel-id> or --latest`: copy the settled merchant channel from `status` or select cache.
- `no saved hold invoice` / `latest JIT order has not recorded a settled channel`: use an explicit value or
  wait for settlement.
- `channel ... was not found on the merchant node`: the identifier belongs to another node or topology.
- Live profile unexpectedly uses mocks: at least one required node field is blank; partial live profiles are
  intentionally rejected as a unit.
