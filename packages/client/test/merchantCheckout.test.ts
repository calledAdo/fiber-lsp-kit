import { test } from "node:test";
import assert from "node:assert/strict";
import { FiberChannelRpcClient, udtAsset, type UdtTypeScript } from "@fiberlsp/protocol";
import {
  InvoiceService,
  MerchantCheckout,
  ReceiveNotReadyError,
  type WebhookEvent,
} from "@fiberlsp/client";

const RUSD_SCRIPT: UdtTypeScript = {
  code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hash_type: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const RUSD = udtAsset(RUSD_SCRIPT, "RUSD");

/** Scripted receiver node: `inbound` is a mutable ready-channel remote_balance; `statuses` replay get_invoice. */
function node(init: { inbound?: bigint; statuses?: string[] } = {}) {
  const state = { inbound: init.inbound ?? 0n };
  const statuses = init.statuses ?? ["Paid"];
  let gi = 0;
  const calls: string[] = [];
  const fetchImpl = async (_url: string, i: { body?: string }) => {
    const { id, method } = JSON.parse(i.body ?? "{}");
    calls.push(method);
    let result: unknown = null;
    if (method === "list_channels") {
      result = {
        channels:
          state.inbound > 0n
            ? [
                {
                  channel_id: "0xc",
                  pubkey: "0xpeer",
                  funding_udt_type_script: RUSD_SCRIPT,
                  state: { state_name: "ChannelReady" },
                  local_balance: "0x0",
                  remote_balance: "0x" + state.inbound.toString(16),
                  enabled: true,
                },
              ]
            : [],
      };
    } else if (method === "new_invoice") {
      result = { invoice_address: "fibt1qmerchant", invoice: { data: { payment_hash: "0xph" } } };
    } else if (method === "get_invoice") {
      result = { status: statuses[Math.min(gi++, statuses.length - 1)] };
    }
    return { json: async () => ({ jsonrpc: "2.0", id, result }) };
  };
  const svc = new InvoiceService({ rpc: new FiberChannelRpcClient({ rpcUrl: "http://m", fetchImpl }) });
  return { svc, state, calls };
}

const CLOCK = { now: () => 1_700_000_000, idgen: () => "pi_1" };
const FAST = { intervalMs: 0, sleep: async () => {} };

test("createIntent issues a payable intent when inbound is sufficient", async () => {
  const { svc } = node({ inbound: 500n });
  const co = new MerchantCheckout({ invoices: svc, ...CLOCK });
  const intent = await co.createIntent({
    asset: RUSD,
    amount: "500",
    description: "order #42",
    expirySeconds: 3600,
    metadata: { cart: "abc" },
  });
  assert.equal(intent.intent_id, "pi_1");
  assert.equal(intent.invoice, "fibt1qmerchant");
  assert.equal(intent.qr_payload, "fibt1qmerchant"); // QR encodes the payable invoice
  assert.equal(intent.payment_hash, "0xph");
  assert.equal(intent.amount, "500");
  assert.equal(intent.created_at, 1_700_000_000);
  assert.equal(intent.expires_at, 1_700_000_000 + 3600);
  assert.deepEqual(intent.metadata, { cart: "abc" });
});

test("createIntent throws when inbound is short and no provisioner is configured", async () => {
  const { svc } = node({ inbound: 0n });
  const co = new MerchantCheckout({ invoices: svc, ...CLOCK });
  await assert.rejects(
    () => co.createIntent({ asset: RUSD, amount: "500" }),
    (e) => e instanceof ReceiveNotReadyError && e.readiness.shortfall === "500",
  );
});

test("createIntent uses the instance-default ensureInbound to provision, then issues", async () => {
  const n = node({ inbound: 0n });
  const co = new MerchantCheckout({
    invoices: n.svc,
    ensureInbound: async (r) => {
      assert.equal(r.shortfall, "500");
      n.state.inbound = 500n; // LSP delivered the channel
    },
    ...CLOCK,
  });
  const intent = await co.createIntent({ asset: RUSD, amount: "500" });
  assert.equal(intent.invoice, "fibt1qmerchant");
  // readiness → provision → re-check → issue
  assert.deepEqual(n.calls, ["list_channels", "list_channels", "new_invoice"]);
});

test("checkout drives issue → settle → receipt and fires an invoice.paid webhook", async () => {
  const { svc } = node({ inbound: 500n, statuses: ["Open", "Paid"] });
  const events: WebhookEvent[] = [];
  const co = new MerchantCheckout({
    invoices: svc,
    webhookUrl: "http://shop/hooks",
    postWebhook: async (_url, ev) => void events.push(ev),
    idgen: () => "id",
    now: () => 1_700_000_000,
  });
  const { intent, receipt } = await co.checkout(
    { asset: RUSD, amount: "500", description: "order #42", metadata: { cart: "abc" } },
    FAST,
  );
  assert.equal(intent.invoice, "fibt1qmerchant");
  assert.equal(receipt.paid, true);
  assert.equal(receipt.status, "Paid");
  assert.equal(receipt.settled_at, 1_700_000_000);
  assert.equal(receipt.description, "order #42"); // folded from the intent
  assert.deepEqual(receipt.metadata, { cart: "abc" });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "invoice.paid");
  assert.equal(events[0].receipt.payment_hash, "0xph");
});

test("an expired invoice yields an unpaid receipt and an invoice.expired webhook", async () => {
  const { svc } = node({ inbound: 500n, statuses: ["Expired"] });
  const events: WebhookEvent[] = [];
  const co = new MerchantCheckout({
    invoices: svc,
    postWebhook: async (_url, ev) => void events.push(ev),
    ...CLOCK,
  });
  const { receipt } = await co.checkout(
    { asset: RUSD, amount: "500" },
    { ...FAST, webhookUrl: "http://shop/hooks" },
  );
  assert.equal(receipt.paid, false);
  assert.equal(receipt.status, "Expired");
  assert.equal(receipt.settled_at, undefined);
  assert.equal(events[0].type, "invoice.expired");
});

test("a webhook delivery failure never breaks checkout", async () => {
  const { svc } = node({ inbound: 500n });
  const co = new MerchantCheckout({
    invoices: svc,
    webhookUrl: "http://shop/hooks",
    postWebhook: async () => {
      throw new Error("backend down");
    },
    ...CLOCK,
  });
  const { receipt } = await co.checkout({ asset: RUSD, amount: "500" }, FAST);
  assert.equal(receipt.paid, true); // receipt still returned despite webhook failure
});
