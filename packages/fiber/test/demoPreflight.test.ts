import assert from "node:assert/strict";
import { test } from "node:test";

import { FiberChannelRpcClient, type FetchLike, type RawChannel } from "@fiberlsp/fiber";
import { udtAsset, type UdtTypeScript } from "@fiberlsp/protocol";
import {
  assertCustomerHoldChannel,
  assertDistinctNodes,
  assertSameChain,
  assertTrampolineSupport,
  inspectNode,
} from "../../../scripts/demo/shared/preflight.mjs";

const assetScript: UdtTypeScript = {
  code_hash: "0x" + "11".repeat(32),
  hash_type: "type",
  args: "0x1234",
};
const asset = udtAsset(assetScript, "RUSD");

function rpcResults(results: unknown[]): FiberChannelRpcClient {
  const fetchImpl: FetchLike = async () => ({
    json: async () => ({ jsonrpc: "2.0", id: 1, result: results.shift() }),
  });
  return new FiberChannelRpcClient({ rpcUrl: "http://node.test", fetchImpl });
}

function readyChannel(overrides: Partial<RawChannel> = {}): RawChannel {
  return {
    channel_id: "0xcustomer-hold",
    channel_outpoint: "0xoutpoint",
    pubkey: "0xhold",
    funding_udt_type_script: assetScript,
    state: { state_name: "ChannelReady" },
    local_balance: "0x3e8",
    remote_balance: "0x0",
    enabled: true,
    ...overrides,
  };
}

test("preflight accepts a connected, funded customer-to-hold channel", async () => {
  const rpc = rpcResults([
    { channels: [readyChannel()] },
    { peers: [{ pubkey: "0xhold" }] },
  ]);

  const result = await assertCustomerHoldChannel({
    customerRpc: rpc,
    holdPubkey: "0xhold",
    asset,
  });

  assert.equal(result.channelId, "0xcustomer-hold");
  assert.equal(result.outbound, 1000n);
});

test("preflight rejects a missing customer-to-hold channel", async () => {
  const rpc = rpcResults([{ channels: [] }, { peers: [{ pubkey: "0xhold" }] }]);
  await assert.rejects(
    () => assertCustomerHoldChannel({ customerRpc: rpc, holdPubkey: "0xhold", asset }),
    /no channel to the hold node/i,
  );
});

test("preflight rejects unusable, wrong-asset, and zero-outbound channels", async () => {
  const variants: Array<[RawChannel, RegExp]> = [
    [readyChannel({ enabled: false }), /disabled/i],
    [readyChannel({ state: { state_name: "ChannelReadying" } }), /not ready/i],
    [readyChannel({ funding_udt_type_script: null }), /wrong asset/i],
    [readyChannel({ local_balance: "0x0" }), /no spendable outbound/i],
  ];

  for (const [channel, expected] of variants) {
    const rpc = rpcResults([{ channels: [channel] }, { peers: [{ pubkey: "0xhold" }] }]);
    await assert.rejects(
      () => assertCustomerHoldChannel({ customerRpc: rpc, holdPubkey: "0xhold", asset }),
      expected,
    );
  }
});

test("preflight rejects a disconnected customer and hold node", async () => {
  const rpc = rpcResults([{ channels: [readyChannel()] }, { peers: [] }]);
  await assert.rejects(
    () => assertCustomerHoldChannel({ customerRpc: rpc, holdPubkey: "0xhold", asset }),
    /not connected/i,
  );
});

test("node inspection and chain checks reject cross-network profiles", async () => {
  const hold = await inspectNode("hold", rpcResults([{ pubkey: "0xhold", chain_hash: "0xtestnet" }]));
  const customer = await inspectNode("customer", rpcResults([{ pubkey: "0xcustomer", chain_hash: "0xmainnet" }]));

  assert.deepEqual(hold, { role: "hold", pubkey: "0xhold", chainHash: "0xtestnet" });
  assert.throws(() => assertSameChain([hold, customer]), /different Fiber chains/i);
});

test("same-hash preflight requires distinct hold and payment nodes", () => {
  assert.throws(
    () => assertDistinctNodes([
      { role: "hold", pubkey: "0xsame", chainHash: "0xchain" },
      { role: "payment", pubkey: "0xsame", chainHash: "0xchain" },
    ]),
    /hold and payment resolve to the same node/i,
  );
});

test("trampoline preflight accepts advertised support and rejects its absence", () => {
  assert.doesNotThrow(() => assertTrampolineSupport({
    pubkey: "0xlsp",
    features: ["TRAMPOLINE_ROUTING_REQUIRED"],
  }));
  assert.doesNotThrow(() => assertTrampolineSupport({
    pubkey: "0xlsp",
    features: ["TRAMPOLINE_ROUTING_OPTIONAL"],
  }));
  assert.throws(
    () => assertTrampolineSupport({ pubkey: "0xlsp", features: ["BASIC_MPP_REQUIRED"] }),
    /does not advertise trampoline routing/i,
  );
});
