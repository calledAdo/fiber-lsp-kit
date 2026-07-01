#!/usr/bin/env bash
# Part C — raw feasibility check: LSP (node #1) opens a RUSD channel to the fresh
# client (node #2) that funds ZERO. Proves per-asset inbound at zero client capital.
#
# Prereqs:
#   - node #1 (LSP) running on 127.0.0.1:8227, holding RUSD  (you start it: needs FIBER_SECRET_KEY_PASSWORD)
#   - node #2 (client) running on 127.0.0.1:8237/8238 + funded from the Pudge faucet
#
# Node #2 identity (already live, captured 2026-07-01):
CLIENT_PUBKEY="0344f85475b59dd4427fd7e37e581c9d1d99d74d7d69aa95bd8a538d4ec4e87283"
CLIENT_ADDR="/ip4/127.0.0.1/tcp/8238/p2p/${CLIENT_PUBKEY}"

LSP="http://127.0.0.1:8227"
CLIENT="http://127.0.0.1:8237"

# RUSD funding: 1e8 base units (< node #2's auto_accept_amount 1e9, so it auto-accepts).
FUNDING="0x5f5e100"
RUSD_CODE_HASH="0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a"
RUSD_ARGS="0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b"

rpc() { curl -s -m 15 -X POST "$1" -H 'content-type: application/json' -d "$2"; }

echo "== 1. LSP -> connect_peer(client) =="
rpc "$LSP" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"connect_peer\",\"params\":[{\"address\":\"${CLIENT_ADDR}\",\"save\":true}]}"; echo

echo "== 2. LSP -> open_channel (RUSD, LSP-funded, client funds 0) =="
rpc "$LSP" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"open_channel\",\"params\":[{\"pubkey\":\"${CLIENT_PUBKEY}\",\"funding_amount\":\"${FUNDING}\",\"public\":true,\"funding_udt_type_script\":{\"code_hash\":\"${RUSD_CODE_HASH}\",\"hash_type\":\"type\",\"args\":\"${RUSD_ARGS}\"}}]}"; echo

echo "== 3. poll node #2 list_channels until the RUSD channel reaches ChannelReady =="
for i in $(seq 1 60); do
  out=$(rpc "$CLIENT" '{"jsonrpc":"2.0","id":3,"method":"list_channels","params":[{}]}')
  echo "[$i] $out" | python3 -c "import sys,json; d=json.loads(sys.stdin.read().split('] ',1)[1]); chs=d.get('result',{}).get('channels',[]); print('  channels:',[(c.get('state',{}).get('state_name'), c.get('local_balance'), c.get('remote_balance'), 'UDT' if c.get('funding_udt_type_script') else 'CKB') for c in chs])" 2>/dev/null || echo "  (parse pending)"
  if echo "$out" | grep -q ChannelReady; then echo "  -> ChannelReady reached"; break; fi
  sleep 5
done

echo
echo "PASS CRITERIA: node #2 shows a UDT channel, state ChannelReady, local_balance 0x0,"
echo "remote_balance == ${FUNDING}. That is per-asset inbound with zero client capital."
