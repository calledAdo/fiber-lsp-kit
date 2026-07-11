# The demo — three roles, one JIT sale, mock or live

One demo. Three roles — **LSP**, **merchant**, **customer** — each a long-running process that logs what it
sees. A merchant with **zero channels** takes a sale; the first sale buys the channel. Where the proving
artifacts are present, the merchant builds a **real Groth16 proof** and the LSP verifies it in real code.

There is no "mock version" and "live version": the *only* difference is whether a role points at a real Fiber
node or at the bundled **mock-fnn** daemon. That is one field in [`demo.config.json`](./demo.config.json).

## What you need

**Node 20+ and npm.** By default every role uses a mock node (an always-succeeds stand-in), so no `fnn`, no
faucet, no chain. For the `linked` (zero-knowledge) path you also need the proving artifacts — present already
if you built the circuit, otherwise fetched from a release (see *Artifacts* below). With none, the demo runs
`same_hash`, which needs nothing.

## Run it

Three terminals for the servers, a fourth for the actions:

```bash
# terminal 1 — the LSP (also starts the mock nodes; narrates every order)
npm run demo:lsp

# terminal 2 — the merchant (zero channels)
npm run demo:merchant

# terminal 3 — the customer
npm run demo:customer

# terminal 4 — drive the sale
npm run demo:invoice     # merchant builds the proof + prints the hold invoice
npm run demo:pay         # customer pays it → LSP opens a channel, forwards, settles
```

Watch the three server terminals narrate it:

```
LSP        [jit] … linkage proof VERIFIED ✓ → opening → forwarding → SETTLED ✓
MERCHANT   built Groth16 proof → hold invoice fibt… → ✅ SETTLED, channel opened
CUSTOMER   paying (held) → ✅ SUCCESS (the LSP paid the merchant first)
```

## Going live is one field

`demo.config.json` maps each role to its Fiber node endpoint(s):

```json
"roles": {
  "lsp":      { "fnn": [] },                 // [] ⇒ mock node
  "merchant": { "fnn": [] },
  "customer": { "fnn": [] }
}
```

- **Empty `fnn`** ⇒ a mock node stands in for that role.
- **A real RPC URL** ⇒ that role runs live. *You* own that node's funding and peering — the mock is an
  abstraction of "a funded, connected node that works", so on real nodes the accuracy is yours to ensure.
- **LSP with two endpoints** ⇒ it offers `same_hash`; **with one** ⇒ `linked` (needs the vk).

Mix freely: e.g. a live LSP with mock customer/merchant. The commands don't change.

## Artifacts (the `linked` ZK path)

Each server resolves what its role needs — **LSP: the verification key; merchant: the proving key + circuit
wasm** — from the paths in `demo.config.json`. If they are missing it will, with `--download` (or a `[y/N]`
prompt), fetch them from the release named in `demo.config.json`'s `release` field:

```bash
npm run demo:lsp -- --download
npm run demo:merchant -- --download
```

If the artifacts can't be obtained and the LSP has two endpoints, it falls back to `same_hash`. To get `linked`
on a fresh clone without a release, build the circuit once — see
[`../../packages/protocol/circuits/dual-sha256-linkage/README.md`](../../packages/protocol/circuits/dual-sha256-linkage/README.md).

## Pieces

- [`servers/`](./servers) — `lsp.mjs`, `merchant.mjs`, `customer.mjs`: the three long-running roles.
- [`actions/`](./actions) — `request-invoice.mjs`, `pay.mjs`: one-shot triggers that talk to the servers.
- [`mock-fnn.mjs`](./mock-fnn.mjs) — the always-succeeds Fiber stand-in; starts one node per mock role.
- [`lib/`](./lib) — `config.mjs` (the one knob) and `artifacts.mjs` (autodetect + download).
