import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHANNEL_READY,
  FiberChannelRpcClient,
  invoiceAttr,
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
      version: "0.9.0-rc5",
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

test("graphChannels serializes pagination and returns the live graph edge shape", async () => {
  const graphChannel = {
    channel_outpoint: "0xedge",
    node1: "0xnode1",
    node2: "0xnode2",
    created_timestamp: "0x1",
    update_info_of_node1: {
      timestamp: "0x2",
      enabled: true,
      outbound_liquidity: null,
      tlc_expiry_delta: "0x3",
      tlc_minimum_value: "0x0",
      fee_rate: "0x3e8",
    },
    update_info_of_node2: null,
    capacity: "0x64",
    chain_hash: "0xchain",
    udt_type_script: udtTypeScript,
  };
  const { rpc, calls } = scriptedRpc([
    { jsonrpc: "2.0", id: 1, result: { channels: [graphChannel], last_cursor: "0xcursor" } },
  ]);

  assert.deepEqual(await rpc.graphChannels({ limit: 5, after: "0xafter" }), {
    channels: [graphChannel],
    last_cursor: "0xcursor",
  });
  assert.deepEqual(calls[0].body, {
    jsonrpc: "2.0",
    id: 1,
    method: "graph_channels",
    params: [{ limit: "0x5", after: "0xafter" }],
  });
});

test("routed payment wrappers serialize explicit hops and routed keysend dry-runs", async () => {
  const router = [
    {
      target: "0xpeer",
      channel_outpoint: "0xdonor",
      amount_received: "0x65",
      incoming_tlc_expiry: "0x20",
    },
    {
      target: "0xself",
      channel_outpoint: "0xstarved",
      amount_received: "0x64",
      incoming_tlc_expiry: "0x10",
    },
  ];
  const { rpc, calls } = scriptedRpc([
    { jsonrpc: "2.0", id: 1, result: { router_hops: router } },
    { jsonrpc: "2.0", id: 2, result: { payment_hash: "0xpay", status: "Created", fee: "0x1" } },
  ]);

  const built = await rpc.buildRouter({
    hops: [
      { pubkey: "0xpeer", channelOutpoint: "0xdonor" },
      { pubkey: "0xself", channelOutpoint: "0xstarved" },
    ],
    amount: 100n,
    udtTypeScript,
  });
  assert.deepEqual(built, router);
  await rpc.sendPaymentWithRouter({
    router: built,
    keysend: true,
    udtTypeScript,
    dryRun: true,
  });

  assert.deepEqual(calls.map((c) => c.body), [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "build_router",
      params: [{
        hops_info: [
          { pubkey: "0xpeer", channel_outpoint: "0xdonor" },
          { pubkey: "0xself", channel_outpoint: "0xstarved" },
        ],
        amount: "0x64",
        udt_type_script: udtTypeScript,
      }],
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "send_payment_with_router",
      params: [{ router, keysend: true, udt_type_script: udtTypeScript, dry_run: true }],
    },
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

test("sendPayment serializes caller-selected trampoline hops", async () => {
  const { rpc, calls } = scriptedRpc([
    {
      jsonrpc: "2.0",
      id: 1,
      result: { payment_hash: "0xpay", status: "Created", fee: "0x5" },
    },
  ]);

  await rpc.sendPayment({
    invoice: "fibt1merchant",
    trampolineHops: ["0xlsp"],
    maxFeeAmount: 5n,
    dryRun: true,
  });

  assert.deepEqual(calls[0].body, {
    jsonrpc: "2.0",
    id: 1,
    method: "send_payment",
    params: [{
      invoice: "fibt1merchant",
      trampoline_hops: ["0xlsp"],
      dry_run: true,
      max_fee_amount: "0x5",
    }],
  });
});

test("peer, parse, and abandon wrappers call their FNN methods with typed parameters", async () => {
  const parsedInvoice = {
    invoice: {
      currency: "Fibt",
      amount: "0x64",
      signature: "010203",
      data: {
        timestamp: "0x123",
        payment_hash: "0xhash",
        attrs: [
          { description: "fiberlsp-auth:v1:testnet:nonce" },
          { payee_public_key: "02aa" },
          { expiry_time: "0x258" },
          { udt_script: { code_hash: "not-a-string" } },
        ],
      },
    },
  };
  const { rpc, calls } = scriptedRpc([
    { jsonrpc: "2.0", id: 1, result: { peers: [{ pubkey: "0xpeer", address: "/ip4/127.0.0.1/tcp/8238" }] } },
    {
      jsonrpc: "2.0",
      id: 2,
      result: parsedInvoice,
    },
    { jsonrpc: "2.0", id: 3, result: null },
  ]);

  assert.deepEqual(await rpc.listPeers(), [{ pubkey: "0xpeer", address: "/ip4/127.0.0.1/tcp/8238" }]);
  const parsed = await rpc.parseInvoice("fib:invoice");
  assert.deepEqual(parsed, parsedInvoice);
  assert.equal(invoiceAttr(parsed, "description"), "fiberlsp-auth:v1:testnet:nonce");
  assert.equal(invoiceAttr(parsed, "payee_public_key"), "02aa");
  assert.equal(invoiceAttr(parsed, "expiry_time"), "0x258");
  assert.equal(invoiceAttr(parsed, "udt_script"), undefined);
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
