import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { udtAsset, type UdtTypeScript, type WebhookEvent } from "@fiberlsp/protocol";
import { FiberChannelRpcClient } from "@fiberlsp/fiber";
import { InvoiceWebhookService, FileWatchStore } from "@fiberlsp/server";

const RUSD_SCRIPT: UdtTypeScript = {
  code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hash_type: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const RUSD = udtAsset(RUSD_SCRIPT, "RUSD");

/** Scripted merchant node: `new_invoice` mints a fixed invoice; `get_invoice` replays `statuses`. */
function merchantNode(statuses: string[]) {
  let gi = 0;
  const calls: string[] = [];
  const rpc = new FiberChannelRpcClient({
    rpcUrl: "http://merchant",
    fetchImpl: async (_url, init) => {
      const { id, method } = JSON.parse((init.body as string) ?? "{}");
      calls.push(method);
      let result: unknown = null;
      if (method === "new_invoice") {
        result = { invoice_address: "fibt1qshop", invoice: { data: { payment_hash: "0xph" } } };
      } else if (method === "get_invoice") {
        result = { status: statuses[Math.min(gi++, statuses.length - 1)] };
      }
      return { json: async () => ({ jsonrpc: "2.0", id, result }) };
    },
  });
  return { rpc, calls };
}

// Deterministic clocks/ids; instant polling.
function fast(over: Record<string, unknown> = {}) {
  let n = 0;
  return {
    pollAttempts: 5,
    pollIntervalMs: 0,
    sleep: async () => {},
    now: () => 1_700_000_000,
    idgen: () => `id_${n++}`,
    ...over,
  };
}

test("register issues an invoice, watches it, and delivers invoice.paid on settlement", async () => {
  const { rpc } = merchantNode(["Open", "Paid"]);
  const events: WebhookEvent[] = [];
  const svc = new InvoiceWebhookService({
    rpc,
    deliver: async (_url, ev) => void events.push(ev),
    ...fast(),
  });

  const watch = await svc.register({
    asset: RUSD,
    amount: "500",
    webhook_url: "http://shop/hooks",
    description: "order #42",
    metadata: { cart: "abc" },
  });
  assert.equal(watch.invoice, "fibt1qshop");
  assert.equal(watch.payment_hash, "0xph");
  assert.equal(watch.status, "Open"); // freshly registered, not yet settled
  assert.equal(watch.paid, false);

  await svc.drain();

  const settled = svc.get(watch.watch_id);
  assert.equal(settled?.status, "Paid");
  assert.equal(settled?.paid, true);
  assert.equal(settled?.settled_at, 1_700_000_000);
  assert.equal(settled?.receipt?.payment_hash, "0xph");
  assert.equal(settled?.receipt?.description, "order #42");
  assert.deepEqual(settled?.receipt?.metadata, { cart: "abc" });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "invoice.paid");
  assert.equal(events[0].receipt.amount, "500");
});

test("watchExisting on an expired invoice delivers invoice.expired with an unpaid receipt", async () => {
  const { rpc } = merchantNode(["Expired"]);
  const events: WebhookEvent[] = [];
  const svc = new InvoiceWebhookService({ rpc, deliver: async (_u, ev) => void events.push(ev), ...fast() });

  svc.watchExisting({
    invoice: "fibt1qexisting",
    payment_hash: "0xabc",
    asset: RUSD,
    amount: "250",
    webhook_url: "http://shop/hooks",
  });
  await svc.drain();

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "invoice.expired");
  assert.equal(events[0].receipt.paid, false);
  assert.equal(events[0].receipt.settled_at, undefined);
});

test("a webhook delivery failure still finalizes the watch", async () => {
  const { rpc } = merchantNode(["Paid"]);
  const svc = new InvoiceWebhookService({
    rpc,
    deliver: async () => {
      throw new Error("backend down");
    },
    ...fast(),
  });
  const watch = svc.watchExisting({
    invoice: "fibt1q",
    payment_hash: "0xph",
    asset: RUSD,
    amount: "100",
    webhook_url: "http://shop/hooks",
  });
  await svc.drain(); // must not reject despite the delivery throwing

  const settled = svc.get(watch.watch_id);
  assert.equal(settled?.paid, true);
  assert.ok(settled?.receipt); // receipt persisted even though the webhook failed
});

test("register rejects a UDT asset that carries no Script object", async () => {
  const { rpc } = merchantNode(["Paid"]);
  const svc = new InvoiceWebhookService({ rpc, deliver: async () => {}, ...fast() });
  const bareHex = { kind: "UDT" as const, scriptHex: "0xabc", symbol: "RUSD" };
  await assert.rejects(
    () => svc.register({ asset: bareHex, amount: "100", webhook_url: "http://shop/hooks" }),
    /udtAsset/,
  );
});

test("resume re-attaches a pending watch persisted across a restart, then delivers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fiberlsp-watch-"));
  const path = join(dir, "watches.json");
  try {
    // First process: invoice stays Open (poll budget of 1 → never finalizes), watch persisted.
    const first = merchantNode(["Open"]);
    const svcA = new InvoiceWebhookService({
      rpc: first.rpc,
      store: new FileWatchStore(path),
      deliver: async () => {},
      ...fast({ pollAttempts: 1 }),
    });
    const watch = svcA.watchExisting({
      invoice: "fibt1q",
      payment_hash: "0xph",
      asset: RUSD,
      amount: "500",
      webhook_url: "http://shop/hooks",
    });
    await svcA.drain();
    assert.equal(svcA.get(watch.watch_id)?.status, "Open"); // still pending, undelivered

    // Second process: same store, node now reports Paid; resume() picks the watch back up.
    const second = merchantNode(["Paid"]);
    const events: WebhookEvent[] = [];
    const svcB = new InvoiceWebhookService({
      rpc: second.rpc,
      store: new FileWatchStore(path),
      deliver: async (_u, ev) => void events.push(ev),
      ...fast(),
    });
    svcB.resume();
    await svcB.drain();

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "invoice.paid");
    assert.equal(svcB.get(watch.watch_id)?.paid, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
