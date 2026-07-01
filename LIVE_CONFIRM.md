# Live confirmation runbook (2-node testnet)

Goal: prove on a real CKB testnet that an LSP can open a **RUSD** channel to a fresh client that funds
**zero**, giving the client pure per-asset inbound — the flagship claim, and then run the full
`buyInboundLiquidity` flow through `@fiberlsp/server` + `@fiberlsp/client`.

We use two FNN nodes on one machine:

| Node | Role | RPC | P2P | Base dir |
|---|---|---|---|---|
| **#1** | LSP (already funded from RouteKit testing) | `127.0.0.1:8227` | `8228` | `~/my-fnn` |
| **#2** | client wallet (fresh) | `127.0.0.1:8237` | `8238` | `~/my-fnn-client` |

Node #2's config inherits the RUSD `udt_whitelist` with `auto_accept_amount`, so it **auto-accepts** RUSD
channels — which is exactly what demonstrates acceptor-funds-0.

> **Status 2026-07-01 — node #2 is already up.** I generated its throwaway CKB key, booted it, and captured
> its identity live. RPC field shapes were reconciled against it (notably `node_info` returns **`pubkey`**,
> not `node_id`; `new_invoice`'s `payment_hash` is nested under `invoice.data`) and the code + 20 tests are
> green. **Node #2 identity:**
> - `CLIENT_PUBKEY` = `0344f85475b59dd4427fd7e37e581c9d1d99d74d7d69aa95bd8a538d4ec4e87283`
> - dial address = `/ip4/127.0.0.1/tcp/8238/p2p/0344f85475b59dd4427fd7e37e581c9d1d99d74d7d69aa95bd8a538d4ec4e87283`
> - **CKB funding address (fund this from the faucet):**
>   `ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqg8zpnvy5390xfxy95ptjuu938zlgrejjs0ccrkg`
>
> So the only things left that are genuinely yours: **(A) start node #1** with your
> `FIBER_SECRET_KEY_PASSWORD`, and **(B) fund node #2** at the address above. Then `bash scripts/part-c-raw-open.sh`.

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

Note the `pubkey` field (→ `LSP_PUBKEY`). The LSP's dialable address is `/ip4/127.0.0.1/tcp/8228/p2p/<pubkey>`.
(Live nodes return the identity as `pubkey`, confirmed against node #2.)

## Part B — fund node #2 (client)

Node #2 is **already running** (I booted it — see the Status box above). Its CKB key was generated as a
fresh throwaway; on first boot FNN migrated it to the encrypted format. All that remains:

Fund node #2 from the **[Pudge faucet](https://faucet.nervos.org/)** (a small amount of CKB is enough — the
client only pays the CKB fee) at:

```
ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqg8zpnvy5390xfxy95ptjuu938zlgrejjs0ccrkg
```

> The LSP (node #1) needs **RUSD** to fund the RUSD channel. It should still hold the RUSD from RouteKit
> testing; if not, acquire testnet RUSD to node #1's address first.

## Part C — the raw feasibility check (RPC, no server yet)

Once node #1 is up and node #2 is funded, just run the driver script — it connects the LSP to the client,
opens the LSP-funded RUSD channel, and polls node #2 until `ChannelReady`, printing the balances:

```bash
cd ~/fiber-lsp-kit && bash scripts/part-c-raw-open.sh
```

<details><summary>What it runs (raw RPC, node #2 identity already baked in)</summary>

```bash
# 1. LSP connects to the client
curl -s -X POST http://127.0.0.1:8227 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,
  "method":"connect_peer","params":[{"address":"/ip4/127.0.0.1/tcp/8238/p2p/0344f854...87283","save":true}]}'

# 2. LSP opens a RUSD channel toward the client (funding_amount is RUSD; hex-encoded).
curl -s -X POST http://127.0.0.1:8227 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,
  "method":"open_channel","params":[{
    "pubkey":"0344f85475b59dd4427fd7e37e581c9d1d99d74d7d69aa95bd8a538d4ec4e87283",
    "funding_amount":"0x5f5e100",
    "funding_udt_type_script":{
      "code_hash":"0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
      "hash_type":"type",
      "args":"0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b"}}]}'
```
</details>
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
