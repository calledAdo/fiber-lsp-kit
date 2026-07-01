# Live confirmation runbook (2-node testnet)

Goal: prove on a real CKB testnet that an LSP can open a **RUSD** channel to a fresh client that funds
**zero**, giving the client pure per-asset inbound — the flagship claim, and then run the full
`buyInboundLiquidity` flow through `@fiberlsp/server` + `@fiberlsp/client`.

We use two FNN nodes on one machine:

| Node | Role | RPC | P2P | Base dir |
|---|---|---|---|---|
| **#1** | LSP (already funded from RouteKit testing) | `127.0.0.1:8227` | `8228` | `~/my-fnn` |
| **#2** | client wallet (fresh) | `127.0.0.1:8237` | `8238` | `~/my-fnn-client` |

Node #2's directory + config (new ports, `announced_node_name: lsp-client-node`) are **already prepared**
by the scaffold. Node #2's config inherits the RUSD `udt_whitelist` with `auto_accept_amount`, so it
**auto-accepts** RUSD channels — which is exactly what demonstrates acceptor-funds-0.

The steps below need things only you have (the node key password, faucet funds), so they're yours to run;
`!`-prefix them in this session so the output lands here and I can reconcile.

---

## Part A — start node #1 (LSP)

FNN encrypts its CKB key with a password you set earlier. Start it with that password in the env:

```bash
cd ~/my-fnn
FIBER_SECRET_KEY_PASSWORD='<your-password>' ./fnn -c config.yml -d ~/my-fnn
```

> If you see `Cannot resolve cell dep for type id …` on boot, that's a transient CKB-RPC hiccup — just
> re-run; it clears within a couple of tries.

Confirm it's up and grab its identity (you'll need `LSP_PUBKEY` and its P2P multiaddr):

```bash
curl -s -X POST http://127.0.0.1:8227 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"node_info","params":[]}' | python3 -m json.tool
```

Note `node_id` (→ `LSP_PUBKEY`). The LSP's dialable address is `/ip4/127.0.0.1/tcp/8228/p2p/<node_id>`.

## Part B — bring up node #2 (client) and fund it

1. Start node #2 (first boot generates its own fiber identity + CKB key, encrypted with the password you
   pass). Use a **new terminal** and keep it running:

   ```bash
   cd ~/my-fnn-client
   FIBER_SECRET_KEY_PASSWORD='<pick-a-password>' ./fnn -c config.yml -d ~/my-fnn-client
   ```

   If FNN reports it needs a CKB key file (`encrypt_decrypt_file NotFound`), create one the same way you
   did for node #1 (`ckb-cli account new` → `account export --lock-arg <arg> --extended-privkey-path
   ~/my-fnn-client/ckb/key`), then restart with the password.

2. Get node #2's CKB funding address and fund it from the **[Pudge faucet](https://faucet.nervos.org/)**
   (a small amount of CKB is enough — the client only pays the CKB fee):

   ```bash
   cd ~/my-fnn-client && ./ckb-cli account list   # shows the address to fund
   ```

3. Node #2's `node_id`: `curl 127.0.0.1:8237 … node_info` → this is your `CLIENT_PUBKEY`.

> The LSP (node #1) needs **RUSD** to fund the RUSD channel. It should still hold the RUSD from RouteKit
> testing; if not, acquire testnet RUSD to node #1's address first.

## Part C — the raw feasibility check (RPC, no server yet)

From node #1 (LSP), connect to node #2 and open a **RUSD** channel funded entirely by the LSP:

```bash
# 1. LSP connects to the client
curl -s -X POST http://127.0.0.1:8227 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,
  "method":"connect_peer","params":[{"address":"/ip4/127.0.0.1/tcp/8238/p2p/<CLIENT_PUBKEY>"}]}'

# 2. LSP opens a RUSD channel toward the client (funding_amount is RUSD; hex-encoded).
#    RUSD script = the udt_whitelist entry in config.yml.
curl -s -X POST http://127.0.0.1:8227 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,
  "method":"open_channel","params":[{
    "pubkey":"<CLIENT_PUBKEY>",
    "funding_amount":"0x5f5e100",
    "funding_udt_type_script":{
      "code_hash":"0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
      "hash_type":"type",
      "args":"0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b"}}]}'
```

Then, **on node #2**, watch the channel appear and confirm the asymmetry — client `local_balance` = 0,
`remote_balance` = the full RUSD funding (that's the client's inbound):

```bash
curl -s -X POST http://127.0.0.1:8237 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"list_channels","params":[{}]}' | python3 -m json.tool
```

✅ **Pass = node #2 shows a `funding_udt_type_script` (RUSD) channel with `local_balance: 0x0` and
`remote_balance` = funding, reaching `ChannelReady`.** That is per-asset inbound with zero client capital.

## Part D — the full stack (LSP server + client SDK)

1. Run the reference LSP server against node #1:

   ```bash
   cd ~/fiber-lsp-kit
   npm run build
   FIBER_RPC_URL=http://127.0.0.1:8227 LSP_PUBKEY='<LSP_PUBKEY>' PORT=8080 npm run server
   ```

2. Drive `buyInboundLiquidity` from the client side (a small script; node #2 pays the CKB fee invoice):
   quote → order (`prepaid`, asset RUSD) → pay the CKB `fee_invoice` from node #2 → `settle` → the server
   opens the RUSD channel → order goes `channel_active`.

Once this passes, we fold any RPC-shape fixes back into `@fiberlsp/protocol` and add an env-gated
`test:live`, exactly as RouteKit did.

---

### What to paste back to me

- node #1 `node_info` (for `LSP_PUBKEY` + address)
- node #2 `node_info` + funded address
- the Part C `list_channels` output from node #2

I'll reconcile field shapes against the code and fix anything the live node does differently.
