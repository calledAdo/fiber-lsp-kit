import { test } from "node:test";
import assert from "node:assert/strict";
import { udtAsset } from "@fiberlsp/protocol";
import { FiberChannelRpcClient, openChannelAndAwait, type FetchLike } from "@fiberlsp/fiber";

const RUSD_SCRIPT = {
  code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hash_type: "type" as const,
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const RUSD = udtAsset(RUSD_SCRIPT, "RUSD");

/** Mock node: an existing (pre-open) channel, then the freshly-opened one appears in `state` after open. */
function makeRpc(over: { peers?: string[]; openedState?: string; preexisting?: boolean } = {}) {
  const calls: string[] = [];
  let opened = false;
  const openedState = over.openedState ?? "ChannelReady";
  const fetchImpl: FetchLike = async (_u, init) => {
    const { method } = JSON.parse(String(init.body)) as { method: string };
    calls.push(method);
    let result: unknown = null;
    switch (method) {
      case "list_peers":
        result = { peers: (over.peers ?? []).map((pubkey) => ({ pubkey })) };
        break;
      case "connect_peer":
        result = null;
        break;
      case "open_channel":
        opened = true;
        result = { temporary_channel_id: "0xtmp" };
        break;
      case "list_channels": {
        const chans: unknown[] = [];
        if (over.preexisting) chans.push(chan("0xOLD", "ChannelReady"));
        if (opened) chans.push(chan("0xNEW", openedState));
        result = { channels: chans };
        break;
      }
      case "abandon_channel":
        result = null;
        break;
    }
    return { json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
  return { rpc: new FiberChannelRpcClient({ rpcUrl: "http://n", fetchImpl }), calls };
}

function chan(id: string, stateName: string) {
  return {
    channel_id: id,
    channel_outpoint: `${id}:0`,
    pubkey: "0xPEER",
    funding_udt_type_script: RUSD_SCRIPT,
    state: { state_name: stateName },
    local_balance: "0x1",
    remote_balance: "0x0",
    enabled: true,
  };
}

const base = {
  pubkey: "0xPEER",
  fundingAmount: "1000",
  asset: RUSD,
  readyPollAttempts: 3,
  pollIntervalMs: 0,
  sleep: async () => {},
};

test("returns the freshly-opened ready channel, identified by novelty + asset (not balance)", async () => {
  const { rpc, calls } = makeRpc({ preexisting: true });
  const ch = await openChannelAndAwait(rpc, { ...base, address: "/ip4/1.2.3.4/tcp/9" });
  assert.equal(ch?.channel_id, "0xNEW"); // the pre-existing 0xOLD is ignored
  assert.equal(ch?.channel_outpoint, "0xNEW:0");
  assert.ok(calls.includes("open_channel"));
});

test("skips connect_peer when already peered", async () => {
  const { rpc, calls } = makeRpc({ peers: ["0xPEER"] });
  await openChannelAndAwait(rpc, { ...base, address: "/ip4/1.2.3.4/tcp/9" });
  assert.ok(!calls.includes("connect_peer"), "no redundant connect when the peer is already connected");
});

test("returns null on timeout and abandons the orphan when asked", async () => {
  const { rpc, calls } = makeRpc({ openedState: "NEGOTIATING_FUNDING" });
  const ch = await openChannelAndAwait(rpc, { ...base, abandonOrphanOnTimeout: true });
  assert.equal(ch, null);
  assert.ok(calls.includes("abandon_channel"), "the never-ready orphan is abandoned");
});

test("leaves the orphan for retry when abandonOrphanOnTimeout is not set", async () => {
  const { rpc, calls } = makeRpc({ openedState: "NEGOTIATING_FUNDING" });
  const ch = await openChannelAndAwait(rpc, { ...base });
  assert.equal(ch, null);
  assert.ok(!calls.includes("abandon_channel"));
});
