# Running Fiber nodes (for the live demo)

**You do not need this to evaluate the kit** — `npm run demo` (repo root) reproduces the entire flow with zero
setup. This guide is for reproducing the **live, on-chain** scripts in [`scripts/demo/`](../scripts/demo), which
need three real Fiber (`fnn`) nodes on CKB testnet.

Standing up funded testnet nodes is genuinely involved (keys, faucets, RUSD, p2p handshakes) — that's the honest
reason the node-less demo exists. Here's the whole thing.

## The three nodes

| Role | RPC | P2P | On-chain funding it needs |
|---|---|---|---|
| **LSP** | `127.0.0.1:8227` | `8228` | CKB **+ RUSD** (it sells RUSD inbound) |
| **customer** | `127.0.0.1:8237` | `8238` | RUSD **outbound** (to pay) — `00-setup.mjs` tops this up |
| **merchant** | `127.0.0.1:8247` | `8248` | **CKB** only (a fresh node needs CKB to stay stable; funds **0** RUSD) |

## 1. Get `fnn`

The Fiber node binary, from <https://github.com/nervosnetwork/fiber>: build from source (`make build`, needs
Rust) or use a portable release. You'll get `fnn` and `fnn-cli` (v0.9.x). Put a copy in each node's home dir.

## 2. Create a node home + config

For each node, a base directory (e.g. `~/lsp`, `~/customer`, `~/merchant`) containing a `config.yml`. Minimal
testnet config — change `listening_addr` (P2P) and `rpc.listening_addr` per the table above:

```yaml
fiber:
  listening_addr: "/ip4/0.0.0.0/tcp/8228"     # 8228 / 8238 / 8248
  announced_node_name: "lsp-node"
  bootnode_addrs:
    - "/ip4/54.179.226.154/tcp/8228/p2p/Qmes1EBD4yNo9Ywkfe6eRw9tG1nVNGLDmMud1xJMsoYFKy"
    - "/ip4/16.163.7.105/tcp/8228/p2p/QmdyQWjPtbK4NWWsvy8s69NGJaQULwgeQDT5ZpNDrTNaeV"
  announce_listening_addr: true
  chain: testnet
  scripts:                                     # testnet FundingLock + CommitmentLock (see fiber-scripts repo)
    - name: FundingLock
      script: { code_hash: 0x6c67887fe201ee0c7853f1682c0b77c0e6214044c156c7558269390a8afa6d7c, hash_type: type, args: 0x }
      cell_deps:
        - type_id: { code_hash: 0x00000000000000000000000000000000000000000000000000545950455f4944, hash_type: type, args: 0x3cb7c0304fe53f75bb5727e2484d0beae4bd99d979813c6fc97c3cca569f10f6 }
        - cell_dep: { out_point: { tx_hash: 0x12c569a258dd9c5bd99f632bb8314b1263b90921ba31496467580d6b79dd14a7, index: 0x0 }, dep_type: code }
    - name: CommitmentLock
      script: { code_hash: 0x740dee83f87c6f309824d8fd3fbdd3c8380ee6fc9acc90b1a748438afcdf81d8, hash_type: type, args: 0x }
      cell_deps:
        - type_id: { code_hash: 0x00000000000000000000000000000000000000000000000000545950455f4944, hash_type: type, args: 0xf7e458887495cf70dd30d1543cad47dc1dfe9d874177bf19291e4db478d5751b }
        - cell_dep: { out_point: { tx_hash: 0x12c569a258dd9c5bd99f632bb8314b1263b90921ba31496467580d6b79dd14a7, index: 0x0 }, dep_type: code }
rpc:
  listening_addr: "127.0.0.1:8227"             # 8227 / 8237 / 8247
ckb:
  rpc_url: "https://testnet.ckb.dev/"
  udt_whitelist:
    - name: RUSD
      script: { code_hash: 0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a, hash_type: type, args: 0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b }
      cell_deps:
        - type_id: { code_hash: 0x00000000000000000000000000000000000000000000000000545950455f4944, hash_type: type, args: 0x97d30b723c0b2c66e9cb8d4d0df4ab5d7222cbb00d4a9a2055ce2e5d7f0d8b0f }
      auto_accept_amount: 1000000000            # 10 RUSD auto-accept floor
services: [fiber, rpc, ckb]
```

Provide each node a CKB private key: write a 32-byte hex key to `<home>/ckb/key` (e.g. `openssl rand -hex 32`).
It becomes the node's identity **and** its on-chain wallet. **Never commit these.**

## 3. Boot

`fnn` encrypts the key with a password from the `FIBER_SECRET_KEY_PASSWORD` env var — required, no CLI flag:

```bash
cd ~/lsp && FIBER_SECRET_KEY_PASSWORD='choose-a-password' ./fnn -d ~/lsp
```

Each node reaches CKB via `testnet.ckb.dev`. Confirm it's up: `curl -s -X POST http://127.0.0.1:8227 -H
'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"node_info","params":[]}'`.

## 4. Fund

- **CKB** — every node needs on-chain CKB (a fresh node with 0 CKB can't stabilize its `ckb` actor and drops
  peers). Get it from the CKB testnet faucet (<https://faucet.nervos.org>), sending to the node's funding
  address (derivable from its `default_funding_lock_script` via `node_info`).
- **RUSD** — the LSP needs on-chain RUSD to sell inbound. Acquire testnet RUSD (e.g. JoyID wallet → the RUSD
  faucet) and send it to the LSP node's funding-lock address.

## 5. Peer the nodes

Connect **LSP ↔ customer** and **LSP ↔ merchant**. Dial the listener with a `/p2p/<peer-id>` suffix where
`peer-id = base58btc(0x1220 ‖ sha256(compressed pubkey))` — a bare multiaddr never completes the Fiber Init
handshake. Connect **once** per pair (a redundant `connect_peer` panics the gossip actor). `02-buy-inbound.mjs`
handles the LSP ↔ merchant connect for you.

## 6. Run the LSP server + the demo

See [`scripts/demo/README.md`](../scripts/demo/README.md) for the server command and the demo sequence.

## 7. (optional) Enable single-node JIT

JIT now runs on the same LSP node as the normal server. There is no fourth node and no `JIT_HUB_RPC_URL`.
To expose `/lsp/v1/jit/*`, start the server with a production linkage verifier:

```bash
LINKED_JIT_VK_PATH=/path/to/verification_key.json npm run server
```

For local tests only, the reference server can accept the unsafe exposed-secret proof mode:

```bash
JIT_ALLOW_UNSAFE_EXPOSED_SECRET=1 npm run server
```

That mode reveals the merchant's JIT secret to the LSP before forwarding, so it is not a production setting.
