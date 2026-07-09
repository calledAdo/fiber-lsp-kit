import { test } from "node:test";
import assert from "node:assert/strict";
import { udtAsset, type UdtTypeScript, type WebhookEvent } from "@fiberlsp/protocol";
import { FiberChannelRpcClient } from "@fiberlsp/fiber";
import {
  InvoiceService,
  DirectReceive,
  JitReceive,
  MerchantCheckout,
  autoStrategy,
  type JitCheckout,
  type OriginateRequest,
} from "@fiberlsp/client";

const RUSD_SCRIPT: UdtTypeScript = {
  code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hash_type: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const RUSD = udtAsset(RUSD_SCRIPT, "RUSD");
const CLOCK = { now: () => 1_700_000_000, idgen: () => "rc_1" };
const FAST = { intervalMs: 0, sleep: async () => {} };

/** Scripted receiver node: `inbound` is a ready-channel remote balance; `statuses` replays get_invoice. */
function invoiceService(init: { inbound?: bigint; statuses?: string[] } = {}) {
  const state = { inbound: init.inbound ?? 0n };
  const statuses = init.statuses ?? ["Paid"];
  let gi = 0;
  const fetchImpl = async (_url: string, i: { body?: string }) => {
    const { id, method } = JSON.parse(i.body ?? "{}");
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
  return { svc: new InvoiceService({ rpc: new FiberChannelRpcClient({ rpcUrl: "http://m", fetchImpl }) }), state };
}

/** Fake JitCheckout: originate returns a session whose settle() resolves to a chosen state or throws a code. */
function fakeJit(over: { settleState?: string; settleThrowCode?: string } = {}) {
  const seen: { req?: unknown } = {};
  const jit = {
    checkout: async (req: unknown) => {
      seen.req = req;
      return {
        invoice: "fibt_hold",
        paymentHash: "0xhold",
        order: { jit_order_id: "j1", state: "created", request: {}, hold_invoice: "fibt_hold", forward_amount: "99", fee: "1", expires_at: 1_700_003_600, created_at: 1_700_000_000 },
        netAmount: "99",
        fee: "1",
        settle: async () => {
          if (over.settleThrowCode) {
            const e = new Error("jit failed") as Error & { code: string };
            e.code = over.settleThrowCode;
            throw e;
          }
          return { state: over.settleState ?? "settled" };
        },
        cancel: async () => ({ state: "refunded" }),
      };
    },
  };
  return { jit: jit as unknown as JitCheckout, seen };
}

const req: OriginateRequest = { asset: RUSD, amount: "500", description: "order #7", metadata: { cart: "z" } };

test("DirectReceive originates over existing inbound and settles into a Paid receipt", async () => {
  const { svc } = invoiceService({ inbound: 500n, statuses: ["Open", "Paid"] });
  const strat = new DirectReceive({ invoices: svc, ...CLOCK });
  const handle = await strat.originate({ ...req, expirySeconds: 3600 });
  assert.equal(handle.strategy, "direct");
  assert.equal(handle.invoice, "fibt1qmerchant");
  assert.equal(handle.payment_hash, "0xph");
  assert.equal(handle.expires_at, 1_700_000_000 + 3600);
  const receipt = await handle.awaitSettlement(FAST);
  assert.equal(receipt.paid, true);
  assert.equal(receipt.status, "Paid");
  assert.equal(receipt.description, "order #7");
  assert.deepEqual(receipt.metadata, { cart: "z" });
});

test("JitReceive maps a settled order to a Paid receipt and fires the invoice.paid webhook", async () => {
  const events: WebhookEvent[] = [];
  const { jit, seen } = fakeJit({ settleState: "settled" });
  const strat = new JitReceive({ jit, postWebhook: async (_u, ev) => void events.push(ev as WebhookEvent), ...CLOCK });
  const handle = await strat.originate({ ...req, webhookUrl: "http://shop/hooks" });
  assert.equal(handle.strategy, "jit");
  assert.equal(handle.invoice, "fibt_hold"); // customer pays the LSP hold invoice
  assert.equal((seen.req as { amount: string }).amount, "500");
  const receipt = await handle.awaitSettlement(FAST);
  assert.equal(receipt.paid, true);
  assert.equal(receipt.status, "Paid");
  assert.equal(receipt.fee_paid, "1");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "invoice.paid");
});

test("JitReceive maps a settlement failure to an unpaid terminal receipt without throwing", async () => {
  const { jit } = fakeJit({ settleThrowCode: "order_expired" });
  const strat = new JitReceive({ jit, ...CLOCK });
  const handle = await strat.originate(req);
  const receipt = await handle.awaitSettlement(FAST);
  assert.equal(receipt.paid, false);
  assert.equal(receipt.status, "Expired");
});

test("autoStrategy uses direct when inbound suffices and jit when it is short", async () => {
  const jitProbe: string[] = [];
  const directProbe: string[] = [];
  const direct = { name: "direct", originate: async (r: OriginateRequest) => (directProbe.push(r.amount), { invoice: "d", payment_hash: "0x", asset: r.asset, amount: r.amount, strategy: "direct", awaitSettlement: async () => ({}) as never }) };
  const jit = { name: "jit", originate: async (r: OriginateRequest) => (jitProbe.push(r.amount), { invoice: "j", payment_hash: "0x", asset: r.asset, amount: r.amount, strategy: "jit", awaitSettlement: async () => ({}) as never }) };

  const flush = invoiceService({ inbound: 500n });
  const autoFlush = autoStrategy({ invoices: flush.svc, direct, jit });
  const h1 = await autoFlush.originate(req);
  assert.equal(h1.strategy, "direct");

  const empty = invoiceService({ inbound: 0n });
  const autoEmpty = autoStrategy({ invoices: empty.svc, direct, jit });
  const h2 = await autoEmpty.originate(req);
  assert.equal(h2.strategy, "jit");

  assert.deepEqual(directProbe, ["500"]);
  assert.deepEqual(jitProbe, ["500"]);
});

test("MerchantCheckout delegates to a configured strategy for both origination and settlement", async () => {
  const { jit } = fakeJit({ settleState: "settled" });
  const co = new MerchantCheckout({
    invoices: invoiceService().svc, // unused for origination when a strategy is set
    strategy: new JitReceive({ jit, ...CLOCK }),
    ...CLOCK,
  });
  const { intent, receipt } = await co.checkout({ asset: RUSD, amount: "500", description: "d" }, FAST);
  assert.equal(intent.invoice, "fibt_hold"); // came from the JIT strategy, not invoices.receive
  assert.equal(intent.qr_payload, "fibt_hold");
  assert.equal(receipt.paid, true);
  assert.equal(receipt.status, "Paid");
});
