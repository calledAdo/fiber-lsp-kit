import assert from "node:assert/strict";
import { test } from "node:test";

import { createDemoOperations } from "../../../scripts/demo/shared/operations.mjs";

function fixture(overrides: Record<string, unknown> = {}) {
  const posts: Array<{ url: string; body: unknown }> = [];
  const updates: Array<{ key: string; value: unknown }> = [];
  const stages: Array<{ kind: string; detail: unknown }> = [];
  const state = {
    "jit-hold": { invoice: "fibt1latest", channelId: "0xchannel" },
    "regular-payment": { invoice: "fibt1regular-latest", paymentHash: "0xregular" },
  } as Record<string, unknown>;
  const cfg = {
    asset: { symbol: "RUSD" },
    control: { merchant: 7102, customer: 7103 },
    topology: { nodes: { customer: { rpc: "http://customer.test" } } },
    toBase: (value: string) => value,
  };
  const deps = {
    customerContext: async () => ({
      rpc: {},
      state: { focusPeer: { maxSingleChannelOutbound: "1000" } },
    }),
    analyzeInvoice: async ({ invoice }: { invoice: string }) => ({
      invoice,
      amount: "500",
      paymentHash: "0xhash",
    }),
    postJson: async (url: string, body: unknown) => {
      posts.push({ url, body });
      if (url.endsWith("/request-invoice")) {
        return { invoice: "fibt1created", netAmount: "495", fee: "5" };
      }
      if (url.endsWith("/regular-invoice")) {
        return { invoice: "fibt1regular-created", paymentHash: "0xregular", amount: "100" };
      }
      if (url.endsWith("/pay-regular")) {
        return {
          status: "Success",
          payment_hash: "0xregular",
          fee: "0x2",
          analysis: {
            invoice: body.invoice,
            amount: "100",
            paymentHash: "0xregular",
            payeePubkey: "0xmerchant",
            estimatedFee: "0x2",
          },
        };
      }
      if (url.endsWith("/wait-regular-payment")) {
        return { status: "Paid", paid: true, paymentHash: "0xregular" };
      }
      if (url.endsWith("/pay")) return { status: "Success", payment_hash: "0xhash" };
      return {
        channelId: "0xchannel",
        periodsPaid: 2,
        totalPaid: "20",
        initialRent: { remainingInbound: "800", amount: "10" },
        payments: [{ period: 1, status: "paid", amount: "10" }],
      };
    },
    readState: (_cfg: unknown, key: string) => state[key],
    mergeState: (_cfg: unknown, key: string, value: unknown) => {
      updates.push({ key, value });
      state[key] = { ...(state[key] as object ?? {}), ...(value as object) };
    },
    onStage: (kind: string, detail: unknown) => stages.push({ kind, detail }),
    now: (() => {
      const values = [1_000, 1_125];
      return () => values.shift() ?? 1_125;
    })(),
    ...overrides,
  };
  return { cfg, deps, posts, updates, stages, state };
}

test("shared invoice operation validates capacity before creating the order", async () => {
  const context = fixture();
  const operations = createDemoOperations(context.cfg, context.deps);

  const result = await operations.requestInvoice({ amount: "500", capacity: "1000" });

  assert.equal(result.invoice, "fibt1created");
  assert.equal(result.analysis.paymentHash, "0xhash");
  assert.equal(result.customerLimit, "1000");
  assert.deepEqual(context.posts, [{
    url: "http://127.0.0.1:7102/request-invoice",
    body: { amount: "500", capacity: "1000" },
  }]);
  assert.deepEqual(context.stages[0], {
    kind: "invoice",
    detail: { amount: "500", capacity: "1000", customerLimit: "1000" },
  });

  await assert.rejects(
    () => operations.requestInvoice({ amount: "1001", capacity: "1000" }),
    /exceeds.*maximum single-channel payment/i,
  );
  assert.equal(context.posts.length, 1, "over-capacity request must not reach the merchant control server");
});

test("shared payment operation accepts an explicit or latest invoice and records success", async () => {
  const context = fixture();
  const operations = createDemoOperations(context.cfg, context.deps);

  const explicit = await operations.payInvoice({ invoice: "fibt1explicit" });
  const latest = await operations.payInvoice({ latest: true });

  assert.equal(explicit.analysis.invoice, "fibt1explicit");
  assert.equal(latest.analysis.invoice, "fibt1latest");
  assert.deepEqual(context.updates, [
    { key: "jit-hold", value: { customerPaymentStatus: "Success" } },
    { key: "jit-hold", value: { customerPaymentStatus: "Success" } },
  ]);
  assert.equal(context.stages.filter((stage) => stage.kind === "pay").length, 2);
});

test("regular payment uses routed analysis and never writes JIT state", async () => {
  const context = fixture({
    analyzeRoutedInvoice: async () => {
      throw new Error("shared operation must not repeat the customer server's route dry-run");
    },
  });
  const operations = createDemoOperations(context.cfg, context.deps);

  const issued = await operations.requestRegularInvoice({ amount: "100" });
  const paid = await operations.payRegularInvoice({ latest: true });

  assert.equal(issued.invoice, "fibt1regular-created");
  assert.equal(paid.invoiceStatus, "Paid");
  assert.equal(paid.elapsedMs, 125);
  assert.deepEqual(context.posts.slice(-3), [
    {
      url: "http://127.0.0.1:7102/regular-invoice",
      body: { amount: "100" },
    },
    {
      url: "http://127.0.0.1:7103/pay-regular",
      body: { invoice: "fibt1regular-created" },
    },
    {
      url: "http://127.0.0.1:7102/wait-regular-payment",
      body: { paymentHash: "0xregular" },
    },
  ]);
  assert.deepEqual(context.updates.map((update) => update.key), ["regular-payment", "regular-payment"]);
  assert.deepEqual(context.updates.at(-1)?.value, {
    invoice: "fibt1regular-created",
    paymentHash: "0xregular",
    amount: "100",
    customerPaymentStatus: "Success",
    merchantInvoiceStatus: "Paid",
    fee: "0x2",
    elapsedMs: 125,
  });
  assert.equal(context.stages.at(-1)?.kind, "regular-pay");
});

test("shared rent operation resolves the latest channel and persists the result", async () => {
  const context = fixture();
  const operations = createDemoOperations(context.cfg, context.deps);

  const result = await operations.streamRent({ latest: true, periods: 2 });

  assert.equal(result.channelId, "0xchannel");
  assert.deepEqual(context.posts.at(-1), {
    url: "http://127.0.0.1:7102/stream-rent",
    body: { channelId: "0xchannel", periods: 2 },
  });
  assert.deepEqual(context.updates.at(-1), { key: "rent", value: result });
  assert.deepEqual(context.stages.at(-1), {
    kind: "rent",
    detail: { channelId: "0xchannel", periods: 2 },
  });
});
