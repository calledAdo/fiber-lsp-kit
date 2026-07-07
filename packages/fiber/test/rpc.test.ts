import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHANNEL_READY,
  FiberChannelRpcClient,
  isChannelReady,
  type FetchLike,
  type GraphNodesPage,
  type RawChannel,
} from "@fiberlsp/fiber";
import type { UdtTypeScript } from "@fiberlsp/protocol";

function scriptedRpc(results: unknown[]): {
  rpc: FiberChannelRpcClient;
  calls: Array<{ url: string; body: Record<string, unknown> }>;
} {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const next = results.shift();
    return { json: async () => next };
  };
  return {
    rpc: new FiberChannelRpcClient({ rpcUrl: "http://fnn.test", fetchImpl }),
    calls,
  };
}

function channel(overrides: Partial<RawChannel> = {}): RawChannel {
  return {
    channel_id: "0xchannel",
    pubkey: "0xpeer",
    state: { state_name: CHANNEL_READY },
    local_balance: "0x0",
    remote_balance: "0x1",
    enabled: true,
    ...overrides,
  };
}

const udtTypeScript: UdtTypeScript = {
  code_hash: "0x" + "11".repeat(32),
  hash_type: "type",
  args: "0x1234",
};

test("openChannel serializes decimal funding as FNN hex", async () => {
  let captured: unknown;
  const rpc = new FiberChannelRpcClient({
    rpcUrl: "http://fnn.test",
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(String(init.body));
      return {
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: { temporary_channel_id: "0xtemp" },
        }),
      };
    },
  });

  await rpc.openChannel({
    pubkey: "0x02aa",
    fundingAmount: "100000000",
    public: true,
  });

  assert.deepEqual(captured, {
    jsonrpc: "2.0",
    id: 1,
    method: "open_channel",
    params: [
      {
        pubkey: "0x02aa",
        funding_amount: "0x5f5e100",
        public: true,
      },
    ],
  });
});

test("call sends JSON-RPC requests with incrementing ids and throws RPC errors", async () => {
  const { rpc, calls } = scriptedRpc([
    { jsonrpc: "2.0", id: 1, result: { pubkey: "0xnode" } },
    { jsonrpc: "2.0", id: 2, error: { message: "peer unavailable" } },
  ]);

  assert.deepEqual(await rpc.nodeInfo(), { pubkey: "0xnode" });
  await assert.rejects(() => rpc.connectPeer("/ip4/127.0.0.1/tcp/8238"), {
    message: 'FNN rpc "connect_peer" errored: peer unavailable',
  });

  assert.deepEqual(calls.map((c) => c.body), [
    { jsonrpc: "2.0", id: 1, method: "node_info", params: [] },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "connect_peer",
      params: [{ address: "/ip4/127.0.0.1/tcp/8238", save: true }],
    },
  ]);
});

test("newInvoice serializes hold-invoice fields and optional UDT metadata", async () => {
  const { rpc, calls } = scriptedRpc([
    {
      jsonrpc: "2.0",
      id: 1,
      result: {
        invoice_address: "fib:hold",
        invoice: { data: { payment_hash: "0xhold" } },
      },
    },
  ]);

  const invoice = await rpc.newInvoice({
    amount: 1500n,
    currency: "RUSD",
    description: "jit hold",
    udtTypeScript,
    expirySeconds: 90,
    paymentHash: "0xhold",
    hashAlgorithm: "sha256",
  });

  assert.equal(invoice.invoice_address, "fib:hold");
  assert.deepEqual(calls[0].body, {
    jsonrpc: "2.0",
    id: 1,
    method: "new_invoice",
    params: [
      {
        amount: "0x5dc",
        currency: "RUSD",
        description: "jit hold",
        udt_type_script: udtTypeScript,
        expiry: "0x5a",
        payment_hash: "0xhold",
        hash_algorithm: "sha256",
      },
    ],
  });
});

test("listChannels returns an empty list when FNN omits channels and scopes by pubkey when provided", async () => {
  const { rpc, calls } = scriptedRpc([
    { jsonrpc: "2.0", id: 1, result: {} },
    { jsonrpc: "2.0", id: 2, result: { channels: [channel({ channel_id: "0xready" })] } },
  ]);

  assert.deepEqual(await rpc.listChannels(), []);
  assert.deepEqual(await rpc.listChannels("0xpeer"), [channel({ channel_id: "0xready" })]);

  assert.deepEqual(calls.map((c) => c.body), [
    { jsonrpc: "2.0", id: 1, method: "list_channels", params: [{}] },
    { jsonrpc: "2.0", id: 2, method: "list_channels", params: [{ pubkey: "0xpeer" }] },
  ]);
});

test("graphNodesAll follows cursors and caps returned nodes", async () => {
  const page = (ids: string[], cursor: string): GraphNodesPage => ({
    nodes: ids.map((id) => ({
      node_name: id,
      version: "0.9.0",
      addresses: [],
      features: [],
      pubkey: `0x${id}`,
      timestamp: "0x1",
      chain_hash: "0xchain",
      auto_accept_min_ckb_funding_amount: "0x0",
      udt_cfg_infos: [],
    })),
    last_cursor: cursor,
  });
  const { rpc, calls } = scriptedRpc([
    { jsonrpc: "2.0", id: 1, result: page(["a", "b"], "0x2") },
    { jsonrpc: "2.0", id: 2, result: page(["c", "d"], "0x4") },
  ]);

  const nodes = await rpc.graphNodesAll({ pageSize: 2, maxNodes: 3 });

  assert.deepEqual(nodes.map((n) => n.node_name), ["a", "b", "c"]);
  assert.deepEqual(calls.map((c) => c.body), [
    { jsonrpc: "2.0", id: 1, method: "graph_nodes", params: [{ limit: "0x2" }] },
    { jsonrpc: "2.0", id: 2, method: "graph_nodes", params: [{ limit: "0x2", after: "0x2" }] },
  ]);
});

test("sendPayment serializes keysend dry-run payments and fee caps", async () => {
  const { rpc, calls } = scriptedRpc([
    {
      jsonrpc: "2.0",
      id: 1,
      result: { payment_hash: "0xpay", status: "Created", fee: "0x0" },
    },
  ]);

  await rpc.sendPayment({
    targetPubkey: "0xpeer",
    amount: "2500",
    keysend: true,
    udtTypeScript,
    dryRun: true,
    maxFeeAmount: 12n,
  });

  assert.deepEqual(calls[0].body, {
    jsonrpc: "2.0",
    id: 1,
    method: "send_payment",
    params: [
      {
        target_pubkey: "0xpeer",
        amount: "0x9c4",
        keysend: true,
        udt_type_script: udtTypeScript,
        dry_run: true,
        max_fee_amount: "0xc",
      },
    ],
  });
});

test("peer, parse, and abandon wrappers call their FNN methods with typed parameters", async () => {
  const { rpc, calls } = scriptedRpc([
    { jsonrpc: "2.0", id: 1, result: { peers: [{ pubkey: "0xpeer", address: "/ip4/127.0.0.1/tcp/8238" }] } },
    {
      jsonrpc: "2.0",
      id: 2,
      result: { invoice: { amount: "0x64", data: { payment_hash: "0xhash" } } },
    },
    { jsonrpc: "2.0", id: 3, result: null },
  ]);

  assert.deepEqual(await rpc.listPeers(), [{ pubkey: "0xpeer", address: "/ip4/127.0.0.1/tcp/8238" }]);
  assert.deepEqual(await rpc.parseInvoice("fib:invoice"), {
    invoice: { amount: "0x64", data: { payment_hash: "0xhash" } },
  });
  assert.equal(await rpc.abandonChannel("0xtemp"), null);

  assert.deepEqual(calls.map((c) => c.body), [
    { jsonrpc: "2.0", id: 1, method: "list_peers", params: [] },
    { jsonrpc: "2.0", id: 2, method: "parse_invoice", params: [{ invoice: "fib:invoice" }] },
    { jsonrpc: "2.0", id: 3, method: "abandon_channel", params: [{ channel_id: "0xtemp" }] },
  ]);
});

test("hold invoice lifecycle wrappers call the FNN methods with payment hash parameters", async () => {
  const { rpc, calls } = scriptedRpc([
    { jsonrpc: "2.0", id: 1, result: null },
    { jsonrpc: "2.0", id: 2, result: { invoice_address: "fib:cancelled" } },
    { jsonrpc: "2.0", id: 3, result: { status: "Paid" } },
    { jsonrpc: "2.0", id: 4, result: { payment_hash: "0xpay", status: "Success" } },
  ]);

  await rpc.settleInvoice("0xhash", "0xpreimage");
  assert.deepEqual(await rpc.cancelInvoice("0xhash"), { invoice_address: "fib:cancelled" });
  assert.deepEqual(await rpc.getInvoice("0xhash"), { status: "Paid" });
  assert.deepEqual(await rpc.getPayment("0xpay"), { payment_hash: "0xpay", status: "Success" });

  assert.deepEqual(calls.map((c) => c.body), [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "settle_invoice",
      params: [{ payment_hash: "0xhash", payment_preimage: "0xpreimage" }],
    },
    { jsonrpc: "2.0", id: 2, method: "cancel_invoice", params: [{ payment_hash: "0xhash" }] },
    { jsonrpc: "2.0", id: 3, method: "get_invoice", params: [{ payment_hash: "0xhash" }] },
    { jsonrpc: "2.0", id: 4, method: "get_payment", params: [{ payment_hash: "0xpay" }] },
  ]);
});

test("isChannelReady only accepts ChannelReady state", () => {
  assert.equal(isChannelReady(channel()), true);
  assert.equal(isChannelReady(channel({ state: { state_name: "ChannelReadying" } })), false);
});
