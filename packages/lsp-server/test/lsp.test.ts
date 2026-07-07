import { test } from "node:test";
import assert from "node:assert/strict";
import {
  udtAsset,
  CKB,
  type AssetOffering,
  type CreateOrderRequest,
} from "@fiberlsp/protocol";
import { FiberChannelRpcClient } from "@fiberlsp/fiber";
import { Lsp, OrderError, makeInvoiceFeeVerifier } from "@fiberlsp/server";
import { makeMockRpc } from "./mockRpc.js";

const RUSD = udtAsset(
  {
    code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
    hash_type: "type",
    args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
  },
  "RUSD",
);

const offerings: AssetOffering[] = [
  {
    asset: CKB,
    min_capacity: "100",
    max_capacity: "1000000",
    fee_schedule: { base_fee: "1000", proportional_bps: 100 },
  },
  {
    asset: RUSD,
    min_capacity: "10",
    max_capacity: "1000000",
    fee_schedule: { base_fee: "1000", proportional_bps: 0 },
  },
];

function makeLsp(makeReady = true) {
  const mock = makeMockRpc({ lspPubkey: "0xLSP", makeReady });
  const lsp = new Lsp({
    rpc: new FiberChannelRpcClient({ rpcUrl: "http://mock", fetchImpl: mock.fetchImpl }),
    lspPubkey: "0xLSP",
    addresses: ["/ip4/127.0.0.1/tcp/8228"],
    supportedAssets: offerings,
    feeModes: ["prepaid", "from_capacity"],
    readyPollAttempts: 3,
    readyPollIntervalMs: 0,
    sleep: async () => {},
    idgen: (() => {
      let n = 0;
      return () => `order_${++n}`;
    })(),
    now: () => 1_000,
  });
  return { lsp, mock };
}

test("HERO: prepaid RUSD order provisions per-asset inbound (client funds 0)", async () => {
  const { lsp, mock } = makeLsp();
  const req: CreateOrderRequest = {
    target_pubkey: "0xCLIENT",
    target_address: "/ip4/127.0.0.1/tcp/8238",
    asset: RUSD,
    lsp_balance: "100000",
    fee_mode: "prepaid",
  };
  let order = await lsp.createOrder(req);
  assert.equal(order.state, "awaiting_payment");
  assert.equal(order.fee.asset.kind, "CKB"); // fee paid in CKB
  assert.equal(order.payment.mode, "prepaid");

  order = await lsp.settleFee(order.order_id);
  assert.equal(order.state, "channel_active");
  assert.equal(order.channel_outpoint, "0xoutpoint:0");
  // the channel was opened with the RUSD funding script and no client contribution
  assert.ok(mock.calls.includes("connect_peer"));
  assert.ok(mock.calls.includes("open_channel"));
});

test("from_capacity CKB order opens immediately and reaches active", async () => {
  const { lsp } = makeLsp();
  const order = await lsp.createOrder({
    target_pubkey: "0xCLIENT",
    asset: CKB,
    lsp_balance: "50000",
    client_balance: "2000",
    fee_mode: "from_capacity",
  });
  assert.equal(order.state, "channel_active");
  assert.equal(order.payment.mode, "from_capacity");
});

test("settleFee rejects an unknown order and a wrong-state order", async () => {
  const { lsp } = makeLsp();
  await assert.rejects(() => lsp.settleFee("nope"), (e) => e instanceof OrderError && e.code === "not_found");
});

test("createOrder rejects an unsupported asset and bad capacity", async () => {
  const { lsp } = makeLsp();
  await assert.rejects(
    () =>
      lsp.createOrder({
        target_pubkey: "0xC",
        asset: udtAsset({ code_hash: "0x" + "22".repeat(32), hash_type: "type", args: "0x" }),
        lsp_balance: "100",
        fee_mode: "prepaid",
      }),
    (e) => e instanceof OrderError && e.code === "unsupported_asset",
  );
  await assert.rejects(
    () => lsp.createOrder({ target_pubkey: "0xC", asset: CKB, lsp_balance: "1", fee_mode: "prepaid" }),
    (e) => e instanceof OrderError && e.code === "below_min_capacity",
  );
});

test("provisioning times out to failed when the channel never becomes ready", async () => {
  const { lsp } = makeLsp(false); // channel stays AwaitingChannelReady
  const order = await lsp.createOrder({
    target_pubkey: "0xCLIENT",
    asset: CKB,
    lsp_balance: "50000",
    client_balance: "2000",
    fee_mode: "from_capacity",
  });
  assert.equal(order.state, "failed");
  assert.match(order.failure_reason ?? "", /ChannelReady/);
});

test("liquidity() reports per-asset capacity read from channels", async () => {
  const { lsp } = makeLsp();
  await lsp.createOrder({
    target_pubkey: "0xCLIENT",
    asset: CKB,
    lsp_balance: "50000",
    client_balance: "2000",
    fee_mode: "from_capacity",
  });
  const snap = await lsp.liquidity();
  assert.equal(snap.lsp_pubkey, "0xLSP");
  const ckb = snap.assets.find((a) => a.asset.kind === "CKB");
  assert.ok(ckb, "CKB asset present in snapshot");
  assert.equal(ckb.channel_count, 1);
  assert.equal(ckb.ready_channel_count, 1);
  assert.equal(ckb.outbound, "50000"); // LSP-funded local balance
  assert.equal(ckb.inbound, "0");
});

function makeLspWithVerifier(invoiceStatus: string) {
  const mock = makeMockRpc({ lspPubkey: "0xLSP", makeReady: true, invoiceStatus });
  const rpc = new FiberChannelRpcClient({ rpcUrl: "http://mock", fetchImpl: mock.fetchImpl });
  const lsp = new Lsp({
    rpc,
    lspPubkey: "0xLSP",
    addresses: [],
    supportedAssets: offerings,
    feeModes: ["prepaid", "from_capacity"],
    readyPollAttempts: 3,
    readyPollIntervalMs: 0,
    sleep: async () => {},
    idgen: () => "order_fee",
    now: () => 1_000,
    verifyFeePaid: makeInvoiceFeeVerifier(rpc),
  });
  return { lsp, mock };
}

test("fee verifier blocks provisioning until the invoice is Paid", async () => {
  const { lsp } = makeLspWithVerifier("Open"); // fee not settled yet
  const order = await lsp.createOrder({
    target_pubkey: "0xCLIENT",
    target_address: "/ip4/127.0.0.1/tcp/8238",
    asset: RUSD,
    lsp_balance: "100000",
    fee_mode: "prepaid",
  });
  assert.equal(order.state, "awaiting_payment");
  await assert.rejects(
    () => lsp.settleFee(order.order_id),
    (e) => e instanceof OrderError && e.code === "fee_unpaid",
  );
  assert.equal(lsp.getOrder(order.order_id)?.state, "awaiting_payment"); // still not provisioned
});

test("fee verifier provisions once the invoice reports Paid", async () => {
  const { lsp, mock } = makeLspWithVerifier("Paid");
  const order = await lsp.createOrder({
    target_pubkey: "0xCLIENT",
    target_address: "/ip4/127.0.0.1/tcp/8238",
    asset: RUSD,
    lsp_balance: "100000",
    fee_mode: "prepaid",
  });
  const settled = await lsp.settleFee(order.order_id);
  assert.equal(settled.state, "channel_active");
  assert.ok(mock.calls.includes("get_invoice"), "verifier queried get_invoice");
  assert.ok(mock.calls.includes("open_channel"));
});

test("webhook_url receives a POST on each order state transition", async () => {
  const mock = makeMockRpc({ lspPubkey: "0xLSP", makeReady: true });
  const events: { url: string; state: string }[] = [];
  const lsp = new Lsp({
    rpc: new FiberChannelRpcClient({ rpcUrl: "http://mock", fetchImpl: mock.fetchImpl }),
    lspPubkey: "0xLSP",
    addresses: [],
    supportedAssets: offerings,
    feeModes: ["prepaid", "from_capacity"],
    readyPollAttempts: 3,
    readyPollIntervalMs: 0,
    sleep: async () => {},
    idgen: () => "order_wh",
    now: () => 1_000,
    deliverWebhook: async (url, order) => {
      events.push({ url, state: order.state });
    },
  });
  await lsp.createOrder({
    target_pubkey: "0xCLIENT",
    asset: CKB,
    lsp_balance: "50000",
    client_balance: "2000",
    fee_mode: "from_capacity",
    webhook_url: "http://hook.test/orders",
  });
  await new Promise((r) => setTimeout(r, 0)); // flush best-effort deliveries
  const states = events.map((e) => e.state);
  assert.deepEqual([...new Set(events.map((e) => e.url))], ["http://hook.test/orders"]);
  assert.ok(states.includes("opening"), "opening transition delivered");
  assert.ok(states.includes("channel_active"), "channel_active transition delivered");
});
