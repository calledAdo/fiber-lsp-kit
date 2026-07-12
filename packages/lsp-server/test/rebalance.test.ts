import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FiberChannelRpcClient,
  type FetchLike,
  type RawChannel,
  type RawRouter,
} from "@fiberlsp/fiber";
import { CKB, udtAsset, type UdtTypeScript } from "@fiberlsp/protocol";
import { needsRebalance, planCircularRebalance, Rebalancer } from "../src/index.js";

const RUSD: UdtTypeScript = { code_hash: "0x" + "11".repeat(32), hash_type: "type", args: "0x01" };
const rusd = udtAsset(RUSD, "RUSD");

function channel(overrides: Partial<RawChannel>): RawChannel {
  return {
    channel_id: "0xchannel",
    channel_outpoint: "0xoutpoint",
    pubkey: "0xpeer",
    funding_udt_type_script: RUSD,
    state: { state_name: "ChannelReady" },
    local_balance: "0x32",
    remote_balance: "0x32",
    enabled: true,
    ...overrides,
  };
}

function clientFrom(handler: (method: string, p0: any) => unknown): {
  rpc: FiberChannelRpcClient;
  calls: Array<{ method: string; p0: any }>;
} {
  const calls: Array<{ method: string; p0: any }> = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const { id, method, params } = JSON.parse(String(init.body));
    const p0 = params?.[0] ?? {};
    calls.push({ method, p0 });
    return { json: async () => ({ jsonrpc: "2.0", id, result: handler(method, p0) }) };
  };
  return { rpc: new FiberChannelRpcClient({ rpcUrl: "http://mock", fetchImpl }), calls };
}

test("needsRebalance selects only Ready channels in the requested asset below the local floor", () => {
  const starved = channel({ channel_id: "0xstarved", local_balance: "0x9", remote_balance: "0x5b" });
  const healthy = channel({ channel_id: "0xhealthy", local_balance: "0x50", remote_balance: "0x14" });
  const wrongAsset = channel({
    channel_id: "0xckb",
    funding_udt_type_script: null,
    local_balance: "0x1",
    remote_balance: "0x63",
  });
  const pending = channel({
    channel_id: "0xpending",
    state: { state_name: "NegotiatingFunding" },
    local_balance: "0x1",
    remote_balance: "0x63",
  });

  assert.deepEqual(needsRebalance([starved, healthy, wrongAsset, pending], {
    asset: rusd,
    minLocalBps: 2_000,
  }), [starved]);
});

test("needsRebalance returns empty when every channel is healthy", () => {
  const channels = [
    channel({ local_balance: "0x14", remote_balance: "0x50" }),
    channel({ channel_id: "0x2", local_balance: "0x64", remote_balance: "0x0" }),
  ];
  assert.deepEqual(needsRebalance(channels, { asset: rusd, minLocalBps: 2_000 }), []);
});

test("planCircularRebalance pins the donor and starved channel outpoints", () => {
  const donor = channel({ channel_id: "0xdonor", channel_outpoint: "0xdonor-out", pubkey: "0xdonor-peer" });
  const starved = channel({ channel_id: "0xstarved", channel_outpoint: "0xstarved-out", pubkey: "0xstarved-peer" });

  assert.deepEqual(planCircularRebalance({ starved, donor, lspPubkey: "0xlsp", amount: 10n }), {
    hops: [
      { pubkey: "0xdonor-peer", channelOutpoint: "0xdonor-out" },
      { pubkey: "0xstarved-peer" },
      { pubkey: "0xlsp", channelOutpoint: "0xstarved-out" },
    ],
  });
});

test("Rebalancer dry-runs by default and only submits when explicitly requested", async () => {
  const channels = [
    channel({ channel_id: "0xstarved", channel_outpoint: "0xstarved-out", local_balance: "0xa", remote_balance: "0x5a" }),
    channel({ channel_id: "0xdonor", channel_outpoint: "0xdonor-out", local_balance: "0x5a", remote_balance: "0xa" }),
  ];
  const router: RawRouter = [
    { target: "0xpeer", channel_outpoint: "0xdonor-out", amount_received: "0xb", incoming_tlc_expiry: "0x20" },
    { target: "0xlsp", channel_outpoint: "0xstarved-out", amount_received: "0xa", incoming_tlc_expiry: "0x10" },
  ];
  const { rpc, calls } = clientFrom((method) => {
    if (method === "list_channels") return { channels };
    if (method === "node_info") return { pubkey: "0xlsp" };
    if (method === "build_router") return { router_hops: router };
    if (method === "send_payment_with_router") return { payment_hash: "0xpay", status: "Created", fee: "0x1" };
    return null;
  });
  const rebalancer = new Rebalancer(rpc);

  const dry = await rebalancer.rebalance({ asset: rusd, minLocalBps: 2_000, amount: 10n });
  assert.equal(dry.status, "dry_run");
  assert.equal(calls.filter((c) => c.method === "send_payment_with_router")[0].p0.dry_run, true);

  const live = await rebalancer.rebalance({ asset: rusd, minLocalBps: 2_000, amount: 10n, dryRun: false });
  assert.equal(live.status, "submitted");
  const sends = calls.filter((c) => c.method === "send_payment_with_router");
  assert.equal(sends.length, 3);
  assert.equal(sends[1].p0.dry_run, true);
  assert.equal(sends[2].p0.dry_run, undefined);
  assert.equal(sends[2].p0.keysend, true);
  assert.deepEqual(sends[2].p0.udt_type_script, RUSD);
  assert.deepEqual(calls.filter((c) => c.method === "build_router")[0].p0, {
    hops_info: [
      { pubkey: "0xpeer", channel_outpoint: "0xdonor-out" },
      { pubkey: "0xlsp", channel_outpoint: "0xstarved-out" },
    ],
    amount: "0xa",
    udt_type_script: RUSD,
  });
});

test("Rebalancer returns no eligible donor without attempting to build a route", async () => {
  const channels = [
    channel({ channel_id: "0xstarved", local_balance: "0x5", remote_balance: "0x5f" }),
    channel({ channel_id: "0xweak", local_balance: "0x19", remote_balance: "0x4b" }),
  ];
  const { rpc, calls } = clientFrom((method) => {
    if (method === "list_channels") return { channels };
    return null;
  });

  const result = await new Rebalancer(rpc).rebalance({ asset: rusd, minLocalBps: 2_000, amount: 10n });
  assert.deepEqual(result, {
    status: "nothing_to_do",
    reason: "no_eligible_donor",
    starvedChannelId: "0xstarved",
  });
  assert.equal(calls.some((c) => c.method === "build_router"), false);
  assert.equal(calls.some((c) => c.method === "send_payment_with_router"), false);
});

test("Rebalancer does not submit when priced route fees would push the donor below the floor", async () => {
  const channels = [
    channel({ channel_id: "0xstarved", local_balance: "0x5", remote_balance: "0x5f" }),
    channel({ channel_id: "0xdonor", local_balance: "0x1e", remote_balance: "0x46" }),
  ];
  const router: RawRouter = [
    { target: "0xpeer", channel_outpoint: "0xoutpoint", amount_received: "0xb", incoming_tlc_expiry: "0x20" },
    { target: "0xlsp", channel_outpoint: "0xoutpoint", amount_received: "0xa", incoming_tlc_expiry: "0x10" },
  ];
  const { rpc, calls } = clientFrom((method) => {
    if (method === "list_channels") return { channels };
    if (method === "node_info") return { pubkey: "0xlsp" };
    if (method === "build_router") return { router_hops: router };
    return null;
  });

  const result = await new Rebalancer(rpc).rebalance({ asset: rusd, minLocalBps: 2_000, amount: 10n });
  assert.deepEqual(result, {
    status: "nothing_to_do",
    reason: "no_eligible_donor",
    starvedChannelId: "0xstarved",
  });
  assert.equal(calls.some((c) => c.method === "build_router"), true);
  assert.equal(calls.some((c) => c.method === "send_payment_with_router"), false);
});

test("Rebalancer omits the UDT script for CKB", async () => {
  const channels = [
    channel({ channel_id: "0xstarved", funding_udt_type_script: null, local_balance: "0x5", remote_balance: "0x5f" }),
    channel({ channel_id: "0xdonor", funding_udt_type_script: null, local_balance: "0x5f", remote_balance: "0x5" }),
  ];
  const { rpc, calls } = clientFrom((method) => {
    if (method === "list_channels") return { channels };
    if (method === "node_info") return { pubkey: "0xlsp" };
    if (method === "build_router") return {
      router_hops: [
        { target: "0xpeer", channel_outpoint: "0xoutpoint", amount_received: "0xa", incoming_tlc_expiry: "0x10" },
      ],
    };
    if (method === "send_payment_with_router") return { payment_hash: "0xpay", status: "Created" };
    return null;
  });

  await new Rebalancer(rpc).rebalance({ asset: CKB, minLocalBps: 2_000, amount: 10n });
  const build = calls.find((c) => c.method === "build_router");
  const send = calls.find((c) => c.method === "send_payment_with_router");
  assert.equal(build.p0.udt_type_script, undefined);
  assert.equal(send.p0.udt_type_script, undefined);
});
