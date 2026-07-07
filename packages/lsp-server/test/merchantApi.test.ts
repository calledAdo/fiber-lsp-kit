import { test } from "node:test";
import assert from "node:assert/strict";
import { FiberChannelRpcClient, udtAsset, type UdtTypeScript } from "@fiberlsp/protocol";
import { InvoiceWebhookService, createMerchantApi } from "@fiberlsp/server";

const RUSD_SCRIPT: UdtTypeScript = {
  code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hash_type: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const RUSD = udtAsset(RUSD_SCRIPT, "RUSD");

function standUp(statuses: string[]) {
  const rpc = new FiberChannelRpcClient({
    rpcUrl: "http://merchant",
    fetchImpl: async (_url, init) => {
      const { id, method } = JSON.parse((init.body as string) ?? "{}");
      let result: unknown = null;
      if (method === "new_invoice") result = { invoice_address: "fibt1qshop", invoice: { data: { payment_hash: "0xph" } } };
      else if (method === "get_invoice") result = { status: statuses[0] };
      return { json: async () => ({ jsonrpc: "2.0", id, result }) };
    },
  });
  const svc = new InvoiceWebhookService({
    rpc,
    deliver: async () => {},
    pollAttempts: 3,
    pollIntervalMs: 0,
    sleep: async () => {},
    now: () => 1_700_000_000,
    idgen: (() => {
      let n = 0;
      return () => `id_${n++}`;
    })(),
  });
  return { svc, api: createMerchantApi(svc) };
}

test("POST /merchant/v1/invoices issues an invoice and returns the watch", async () => {
  const { api } = standUp(["Paid"]);
  const res = await api("POST", "/merchant/v1/invoices", {
    asset: RUSD,
    amount: "500",
    webhook_url: "http://shop/hooks",
    description: "order #42",
  });
  assert.equal(res.status, 201);
  const watch = res.body as { watch_id: string; invoice: string; status: string };
  assert.equal(watch.invoice, "fibt1qshop");
  assert.equal(watch.status, "Open");
  assert.ok(watch.watch_id);
});

test("GET /merchant/v1/invoices/:id reflects settlement after the watch drains", async () => {
  const { svc, api } = standUp(["Paid"]);
  const created = await api("POST", "/merchant/v1/invoices", {
    asset: RUSD,
    amount: "500",
    webhook_url: "http://shop/hooks",
  });
  const id = (created.body as { watch_id: string }).watch_id;

  await svc.drain();

  const got = await api("GET", `/merchant/v1/invoices/${id}`);
  assert.equal(got.status, 200);
  const watch = got.body as { status: string; paid: boolean; receipt?: unknown };
  assert.equal(watch.status, "Paid");
  assert.equal(watch.paid, true);
  assert.ok(watch.receipt);
});

test("GET /merchant/v1/invoices lists watches", async () => {
  const { api } = standUp(["Open"]);
  await api("POST", "/merchant/v1/invoices", { asset: RUSD, amount: "1", webhook_url: "http://h" });
  const list = await api("GET", "/merchant/v1/invoices");
  assert.equal(list.status, 200);
  assert.equal((list.body as unknown[]).length, 1);
});

test("GET an unknown watch is 404", async () => {
  const { api } = standUp(["Paid"]);
  const res = await api("GET", "/merchant/v1/invoices/nope");
  assert.equal(res.status, 404);
  assert.equal((res.body as { error: { code: string } }).error.code, "not_found");
});

test("a bad asset yields a 400", async () => {
  const { api } = standUp(["Paid"]);
  const res = await api("POST", "/merchant/v1/invoices", {
    asset: { kind: "UDT", scriptHex: "0xabc", symbol: "RUSD" },
    amount: "100",
    webhook_url: "http://h",
  });
  assert.equal(res.status, 400);
  assert.equal((res.body as { error: { code: string } }).error.code, "bad_request");
});
