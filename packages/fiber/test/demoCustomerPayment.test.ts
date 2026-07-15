import assert from "node:assert/strict";
import { test } from "node:test";

import {
  invoicePaymentDeadline,
  payInvoice,
  waitForTerminalPayment,
} from "../../../scripts/demo/shared/customer-server.mjs";

test("invoice payment deadline combines FNN's millisecond timestamp with second expiry", () => {
  assert.deepEqual(
    invoicePaymentDeadline({ timestamp: "0x19f6488dd1a", expiryTime: "0x618" }, 0),
    { deadlineMs: 1_784_099_678_938, source: "invoice" },
  );
});

test("payment watcher performs a final status read at the invoice expiry boundary", async () => {
  let now = 1_000;
  const statuses = ["Inflight", "Success"];
  const calls: string[] = [];
  const rpc = {
    async getPayment(paymentHash: string) {
      calls.push(paymentHash);
      return { status: statuses.shift() ?? "Success", fee: "0x2" };
    },
  };

  const result = await waitForTerminalPayment({
    rpc,
    paymentHash: "0xpayment",
    deadlineMs: 2_000,
    now: () => now,
    sleep: async (ms: number) => { now += ms; },
    pollIntervalMs: 1_000,
  });

  assert.equal(result.status, "Success");
  assert.equal(result.fee, "0x2");
  assert.equal(calls.length, 2, "the second read must happen at the deadline");
});

test("payment watcher reports invoice expiry when FNN remains nonterminal", async () => {
  let now = 5_000;
  let calls = 0;
  const rpc = {
    async getPayment() {
      calls += 1;
      return { status: "Inflight" };
    },
  };

  const result = await waitForTerminalPayment({
    rpc,
    paymentHash: "0xpayment",
    deadlineMs: 6_000,
    deadlineSource: "invoice",
    now: () => now,
    sleep: async (ms: number) => { now += ms; },
    pollIntervalMs: 1_000,
  });

  assert.equal(result.status, "Expired");
  assert.equal(calls, 2, "one poll plus one final boundary read");
});

test("regular payment uses the selected LSP trampoline for dry-run and real send", async () => {
  const sends: Array<Record<string, unknown>> = [];
  const rpc = {
    async parseInvoice() {
      return {
        invoice: {
          currency: "Fibt",
          amount: "500",
          data: {
            timestamp: "0x1",
            payment_hash: "0xhash",
            attrs: [{ payee_public_key: "0xmerchant" }, { expiry_time: "0xe10" }],
          },
        },
      };
    },
    async sendPayment(args: Record<string, unknown>) {
      sends.push(args);
      return { payment_hash: "0xhash", status: "Created", fee: "0x2" };
    },
    async getPayment() {
      return { payment_hash: "0xhash", status: "Success", fee: "0x2" };
    },
  };

  const result = await payInvoice({
    cfg: { fmt: (value: string) => value },
    rpc,
    invoice: "fibt1invoice",
    routed: true,
    expectedPayeePubkey: "0xmerchant",
    trampolinePubkey: "0xlsp",
  });

  assert.equal(result.status, "Success");
  assert.deepEqual(sends, [
    {
      invoice: "fibt1invoice",
      trampolineHops: ["0xlsp"],
      maxFeeAmount: "5",
      dryRun: true,
    },
    {
      invoice: "fibt1invoice",
      trampolineHops: ["0xlsp"],
      maxFeeAmount: "5",
    },
  ]);
});
