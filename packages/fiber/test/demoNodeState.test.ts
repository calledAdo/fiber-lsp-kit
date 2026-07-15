import assert from "node:assert/strict";
import { test } from "node:test";

import { FiberChannelRpcClient, type FetchLike, type RawChannel } from "@fiberlsp/fiber";
import { udtAsset, type UdtTypeScript } from "@fiberlsp/protocol";
import {
  analyzePayableInvoice,
  analyzeRoutedInvoice,
  channelCapacity,
  inspectNodeState,
} from "../../../scripts/demo/shared/node-state.mjs";

const assetScript: UdtTypeScript = {
  code_hash: "0x" + "44".repeat(32),
  hash_type: "type",
  args: "0x1234",
};
const asset = udtAsset(assetScript, "RUSD");

function channel(overrides: Partial<RawChannel> = {}): RawChannel {
  return {
    channel_id: "0xchannel",
    channel_outpoint: "0xoutpoint",
    pubkey: "0xhold",
    funding_udt_type_script: assetScript,
    state: { state_name: "ChannelReady" },
    local_balance: "0x3e8",
    remote_balance: "0x64",
    enabled: true,
    ...overrides,
  };
}

function rpcByMethod(results: Record<string, unknown>): FiberChannelRpcClient {
  const fetchImpl: FetchLike = async (_url, init) => {
    const request = JSON.parse(String(init.body)) as { method: string };
    return { json: async () => ({ jsonrpc: "2.0", id: 1, result: results[request.method] }) };
  };
  return new FiberChannelRpcClient({ rpcUrl: "http://node.test", fetchImpl });
}

test("node state reports identity, channels, and the largest usable single channel to a peer", async () => {
  const rpc = rpcByMethod({
    node_info: { pubkey: "0xcustomer", chain_hash: "0xtestnet" },
    list_peers: { peers: [{ pubkey: "0xhold" }] },
    list_channels: {
      channels: [
        channel(),
        channel({ channel_id: "0xbigger", local_balance: "0x5dc" }),
        channel({ channel_id: "0xdisabled", local_balance: "0x270f", enabled: false }),
        channel({ channel_id: "0xother", pubkey: "0xother", local_balance: "0x1388" }),
      ],
    },
  });

  const state = await inspectNodeState({ role: "customer", rpc, asset, focusPeer: "0xhold" });

  assert.equal(state.pubkey, "0xcustomer");
  assert.equal(state.chainHash, "0xtestnet");
  assert.equal(state.channels.length, 4);
  assert.equal(state.focusPeer?.connected, true);
  assert.equal(state.focusPeer?.readyChannels, 2);
  assert.equal(state.focusPeer?.totalOutbound, "2500");
  assert.equal(state.focusPeer?.maxSingleChannelOutbound, "1500");
  assert.equal(state.focusPeer?.maxChannelId, "0xbigger");
});

test("payable invoice analysis parses the invoice and rejects an amount above direct capacity", async () => {
  const parsed = {
    invoice: {
      currency: "Fibt",
      amount: "1200",
      signature: "0xsig",
      data: {
        timestamp: "0x1",
        payment_hash: "0xhash",
        attrs: [
          { payee_public_key: "0xhold" },
          { description: "sale #1" },
          { expiry_time: "0xe10" },
        ],
      },
    },
  };
  const rpc = rpcByMethod({
    parse_invoice: parsed,
    list_channels: { channels: [channel({ local_balance: "0x3e8" })] },
  });

  await assert.rejects(
    () => analyzePayableInvoice({ rpc, invoice: "fibt1invoice", asset }),
    /exceeds.*single-channel.*1000/i,
  );
});

test("payable invoice analysis returns auditable invoice fields and payment capacity", async () => {
  const rpc = rpcByMethod({
    parse_invoice: {
      invoice: {
        currency: "Fibt",
        amount: "500",
        signature: "0xsig",
        data: {
          timestamp: "0x1",
          payment_hash: "0xhash",
          attrs: [{ payee_public_key: "0xhold" }, { description: "sale #1" }],
        },
      },
    },
    list_channels: { channels: [channel()] },
  });

  const result = await analyzePayableInvoice({ rpc, invoice: "fibt1invoice", asset });

  assert.deepEqual(result, {
    invoice: "fibt1invoice",
    currency: "Fibt",
    amount: "500",
    paymentHash: "0xhash",
    payeePubkey: "0xhold",
    description: "sale #1",
    expiryTime: undefined,
    timestamp: "0x1",
    maxSingleChannelOutbound: "1000",
    channelId: "0xchannel",
  });
});

test("routed invoice analysis asks FNN to price a route without requiring a direct merchant channel", async () => {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const request = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
    calls.push({ method: request.method, params: request.params });
    const result = request.method === "parse_invoice"
      ? {
          invoice: {
            currency: "Fibt",
            amount: "500",
            signature: "0xsig",
            data: {
              timestamp: "0x1",
              payment_hash: "0xhash",
              attrs: [{ payee_public_key: "0xmerchant" }, { description: "repeat sale" }],
            },
          },
        }
      : request.method === "send_payment"
        ? { payment_hash: "0xhash", status: "Created", fee: "0x2" }
        : (() => { throw new Error(`unexpected RPC ${request.method}`); })();
    return { json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
  const rpc = new FiberChannelRpcClient({ rpcUrl: "http://node.test", fetchImpl });

  const result = await analyzeRoutedInvoice({
    rpc,
    invoice: "fibt1invoice",
    expectedPayeePubkey: "0xmerchant",
    trampolinePubkey: "0xlsp",
  });

  assert.equal(result.payeePubkey, "0xmerchant");
  assert.equal(result.estimatedFee, "0x2");
  assert.deepEqual(result.trampolineHops, ["0xlsp"]);
  assert.equal(result.maxFeeAmount, "5");
  assert.deepEqual(calls.map((call) => call.method), ["parse_invoice", "send_payment"]);
  assert.deepEqual(calls[1]?.params, [{
    invoice: "fibt1invoice",
    trampoline_hops: ["0xlsp"],
    dry_run: true,
    max_fee_amount: "0x5",
  }]);
});

test("routed invoice analysis rejects the wrong merchant before asking FNN to build a route", async () => {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const request = JSON.parse(String(init.body)) as { method: string };
    calls.push(request.method);
    if (request.method !== "parse_invoice") throw new Error("route dry-run must not run for the wrong merchant");
    return {
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: {
          invoice: {
            currency: "Fibt",
            amount: "500",
            signature: "0xsig",
            data: {
              payment_hash: "0xhash",
              attrs: [{ payee_public_key: "0xother-merchant" }],
            },
          },
        },
      }),
    };
  };
  const rpc = new FiberChannelRpcClient({ rpcUrl: "http://node.test", fetchImpl });

  await assert.rejects(
    () => analyzeRoutedInvoice({ rpc, invoice: "fibt1invoice", expectedPayeePubkey: "0xmerchant" }),
    /does not belong to the configured merchant/i,
  );
  assert.deepEqual(calls, ["parse_invoice"]);
});

test("channel capacity is the sum of the exact channel's local and remote balances", () => {
  assert.equal(channelCapacity(channel()), 1100n);
});
