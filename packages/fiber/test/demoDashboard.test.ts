import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { FiberChannelRpcClient, type FetchLike } from "@fiberlsp/fiber";
import { udtAsset } from "@fiberlsp/protocol";
import { collectDashboardSnapshot } from "../../../scripts/demo/shared/dashboard-data.mjs";
import {
  createDashboardActionController,
  routeDashboardRequest,
} from "../../../scripts/demo/shared/dashboard-server.mjs";
import { loadState, updateState } from "../../../scripts/demo/shared/state.mjs";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

const assetScript = {
  code_hash: "0x" + "44".repeat(32),
  hash_type: "type" as const,
  args: "0x1234",
};

function rpcFor(role: string, calls: string[]) {
  const pubkey = `0x${role}`;
  const peer = role === "customer" ? "0xlsp" : "0xpeer";
  const channels = role === "merchant"
    ? [{
        channel_id: "0xmerchant-channel",
        channel_outpoint: "0xmerchant-outpoint",
        pubkey: "0xlsp",
        funding_udt_type_script: assetScript,
        state: { state_name: "ChannelReady" },
        local_balance: "0x5f5e100",
        remote_balance: "0x2faf0800",
        enabled: true,
      }]
    : role === "customer"
      ? [{
          channel_id: "0xcustomer-channel",
          channel_outpoint: "0xcustomer-outpoint",
          pubkey: "0xlsp",
          funding_udt_type_script: assetScript,
          state: { state_name: "ChannelReady" },
          local_balance: "0xbebc200",
          remote_balance: "0x2faf0800",
          enabled: true,
        }]
      : [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const request = JSON.parse(String(init.body)) as { method: string };
    calls.push(`${role}:${request.method}`);
    const result = request.method === "node_info"
      ? { pubkey, chain_hash: "0xtestnet" }
      : request.method === "list_peers"
        ? { peers: [{ pubkey: peer }] }
        : request.method === "list_channels"
          ? { channels }
          : (() => { throw new Error(`unexpected RPC ${request.method}`); })();
    return { json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
  return new FiberChannelRpcClient({ rpcUrl: `http://${role}.test`, fetchImpl });
}

function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "fiber-dashboard-"));
  temporary.push(stateDir);
  writeFileSync(join(stateDir, "jit-hold.json"), JSON.stringify({
    invoice: "fibt1-secret-invoice",
    paymentHash: "0xpayment-hash",
    capacity: "1000000000",
    channelId: "0xmerchant-outpoint",
  }));
  writeFileSync(join(stateDir, "rent.json"), JSON.stringify({
    channelId: "0xmerchant-outpoint",
    periodsPaid: 2,
    totalPaid: "400000",
    initialRent: { remainingInbound: "800000000", amount: "200000" },
    payments: [{ period: 1, status: "paid", amount: "200000", remainingInbound: "800000000" }],
  }));
  writeFileSync(join(stateDir, "regular-payment.json"), JSON.stringify({
    invoice: "fibt1-regular-invoice",
    paymentHash: "0xregular-payment",
    amount: "10000000",
    customerPaymentStatus: "Success",
    merchantInvoiceStatus: "Paid",
    fee: "0x2710",
    elapsedMs: 1018,
  }));
  return {
    mode: "linked",
    holdRole: "lsp",
    stateDir,
    asset: udtAsset(assetScript, "RUSD"),
    assetConfig: { symbol: "RUSD", decimals: 8 },
    topology: {
      profile: "live",
      nodes: {
        customer: { rpc: "http://customer.test" },
        merchant: { rpc: "http://merchant.test" },
        lsp: { rpc: "http://lsp.test" },
      },
    },
  };
}

test("dashboard snapshot exposes the payable invoice but no order capability", async () => {
  const cfg = fixture();
  const calls: string[] = [];
  const snapshot = await collectDashboardSnapshot(cfg, {
    now: () => 1_720_000_000_000,
    rpcFactory: (_url: string, role: string) => rpcFor(role, calls),
    balanceProvider: async ({ role }: { role: string }) => ({
      amount: role === "lsp" ? "1500000000" : "0",
      checkedAt: "2024-07-03T09:46:39.000Z",
    }),
  });

  assert.equal(snapshot.generatedAt, "2024-07-03T09:46:40.000Z");
  assert.deepEqual(snapshot.scenario, {
    mode: "linked",
    profile: "live",
    asset: { symbol: "RUSD", decimals: 8 },
  });
  assert.equal(snapshot.nodes.customer.focusPeer.maxSingleChannelOutbound, "200000000");
  assert.equal(snapshot.nodes.merchant.channels[0].channelId, "0xmerchant-outpoint");
  assert.deepEqual(snapshot.nodes.lsp.onchainAsset, {
    amount: "1500000000",
    checkedAt: "2024-07-03T09:46:39.000Z",
  });
  assert.equal(snapshot.checkout.channelId, "0xmerchant-outpoint");
  assert.equal(snapshot.checkout.customerPaymentStatus, "Success");
  assert.equal(snapshot.checkout.invoice, "fibt1-secret-invoice");
  assert.equal(snapshot.rent.periodsPaid, 2);
  assert.deepEqual(snapshot.regularPayment, {
    invoice: "fibt1-regular-invoice",
    paymentHash: "0xregular-payment",
    amount: "10000000",
    customerPaymentStatus: "Success",
    merchantInvoiceStatus: "Paid",
    fee: "0x2710",
    elapsedMs: 1018,
    settled: true,
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /order[_-]?token|authorization/i);
  assert.deepEqual(new Set(calls.map((call) => call.split(":")[1])), new Set([
    "node_info",
    "list_peers",
    "list_channels",
  ]));
});

test("dashboard router serves snapshots and only guarded named actions", async () => {
  const assets = {
    "/": { type: "text/html; charset=utf-8", body: "<main>dashboard</main>" },
    "/dashboard.css": { type: "text/css; charset=utf-8", body: "main{}" },
    "/dashboard.js": { type: "text/javascript; charset=utf-8", body: "void 0" },
  };
  const snapshot = { generatedAt: "now" };
  const calls: Array<{ action: string; body: unknown }> = [];
  const actions = {
    requestInvoice: async (body: unknown) => {
      calls.push({ action: "invoice", body });
      return { invoice: "fibt1created" };
    },
    payInvoice: async (body: unknown) => {
      calls.push({ action: "pay", body });
      return { status: "Success" };
    },
    requestRegularInvoice: async (body: unknown) => {
      calls.push({ action: "regular-invoice", body });
      return { invoice: "fibt1regular" };
    },
    payRegularInvoice: async (body: unknown) => {
      calls.push({ action: "regular-pay", body });
      return { status: "Success", invoiceStatus: "Paid" };
    },
    streamRent: async (body: unknown) => {
      calls.push({ action: "rent", body });
      return { periodsPaid: 2 };
    },
  };

  const api = await routeDashboardRequest({ method: "GET", path: "/api/snapshot", assets, snapshot: async () => snapshot });
  assert.equal(api.status, 200);
  assert.equal(api.headers["content-type"], "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(api.body), snapshot);

  const page = await routeDashboardRequest({ method: "GET", path: "/", assets, snapshot: async () => snapshot });
  assert.equal(page.status, 200);
  assert.equal(page.body, "<main>dashboard</main>");

  const invoice = await routeDashboardRequest({
    method: "POST",
    path: "/api/actions/invoice",
    headers: { "content-type": "application/json", "x-demo-action": "1" },
    body: { amount: "1", capacity: "10" },
    assets,
    snapshot: async () => snapshot,
    actions,
  });
  assert.equal(invoice.status, 200);
  assert.equal(JSON.parse(invoice.body).result.invoice, "fibt1created");
  assert.deepEqual(calls, [{ action: "invoice", body: { amount: "1", capacity: "10" } }]);

  const regular = await routeDashboardRequest({
    method: "POST",
    path: "/api/actions/regular-invoice",
    headers: { "content-type": "application/json", "x-demo-action": "1" },
    body: { amount: "0.1" },
    assets,
    snapshot: async () => snapshot,
    actions,
  });
  assert.equal(regular.status, 200);
  assert.equal(JSON.parse(regular.body).result.invoice, "fibt1regular");

  const unguarded = await routeDashboardRequest({
    method: "POST",
    path: "/api/actions/pay",
    headers: { "content-type": "application/json" },
    body: { invoice: "fibt1created" },
    assets,
    snapshot: async () => snapshot,
    actions,
  });
  assert.equal(unguarded.status, 403);

  const wrongType = await routeDashboardRequest({
    method: "POST",
    path: "/api/actions/pay",
    headers: { "content-type": "text/plain", "x-demo-action": "1" },
    body: { invoice: "fibt1created" },
    assets,
    snapshot: async () => snapshot,
    actions,
  });
  assert.equal(wrongType.status, 415);

  const mutation = await routeDashboardRequest({
    method: "POST",
    path: "/api/snapshot",
    headers: { "content-type": "application/json", "x-demo-action": "1" },
    body: {},
    assets,
    snapshot: async () => snapshot,
    actions,
  });
  assert.equal(mutation.status, 405);

  const missing = await routeDashboardRequest({ method: "GET", path: "/unknown", assets, snapshot: async () => snapshot });
  assert.equal(missing.status, 404);
});

test("dashboard action controller rejects a second action while one is in flight", async () => {
  let clock = 1_720_000_000_000;
  let finish!: (value: { status: string }) => void;
  const pending = new Promise<{ status: string }>((resolve) => { finish = resolve; });
  const controller = createDashboardActionController({
    requestInvoice: async () => ({ invoice: "fibt1" }),
    payInvoice: async () => pending,
    requestRegularInvoice: async () => ({ invoice: "fibt1regular" }),
    payRegularInvoice: async () => ({ status: "Success", invoiceStatus: "Paid" }),
    streamRent: async () => ({ periodsPaid: 1 }),
  }, { now: () => clock });

  const payment = controller.payInvoice({ invoice: "fibt1" });
  assert.equal(controller.activity().status, "running");
  assert.equal(controller.activity().kind, "pay");
  clock += 1_500;
  assert.equal(controller.activity().elapsedMs, 1_500);
  await assert.rejects(() => controller.requestInvoice({ amount: "1", capacity: "10" }), /already in progress/i);

  finish({ status: "Success" });
  clock += 500;
  await payment;
  assert.equal(controller.activity().status, "success");
  assert.equal(controller.activity().elapsedMs, 2_000);
});

test("demo milestone updates preserve state written by another process", () => {
  const cfg = fixture();

  updateState(cfg, "jit-hold", { customerPaymentStatus: "Success" });
  updateState(cfg, "jit-hold", { channelId: "0xsettled-channel" });

  const state = loadState(cfg, "jit-hold");
  assert.equal(state.customerPaymentStatus, "Success");
  assert.equal(state.channelId, "0xsettled-channel");
  assert.equal(state.invoice, "fibt1-secret-invoice");
});

test("dashboard HTML declares all approved navigation views and repeat-payment actions", () => {
  const html = readFileSync(new URL("../../../scripts/demo/dashboard/index.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../../../scripts/demo/dashboard/dashboard.js", import.meta.url), "utf8");
  for (const view of ["overview", "customer", "merchant", "lsp", "checkout", "payments", "rent"]) {
    assert.match(html, new RegExp(`data-view=["']${view}["']`));
  }
  assert.match(html, /name=["']amount["']/i);
  assert.match(html, /name=["']capacity["']/i);
  assert.match(html, /name=["']invoice["']/i);
  assert.match(html, /name=["']periods["']/i);
  assert.match(js, /\/api\/actions\/invoice/);
  assert.match(js, /\/api\/actions\/pay/);
  assert.match(js, /\/api\/actions\/rent/);
  assert.match(js, /\/api\/actions\/regular-invoice/);
  assert.match(js, /\/api\/actions\/regular-pay/);
  assert.match(html, /data-action=["']regular-invoice["']/);
  assert.match(js, /paymentFeedback\.dataset\.actionFeedback\s*=\s*paymentAction/);
  assert.match(js, /data-action-timer/);
  assert.match(js, /updateActionTimers/);
  assert.match(js, /Failed/);
  assert.match(js, /onchainAsset/);
});
