import assert from "node:assert/strict";

import { LspClient, StreamingLease } from "../../../packages/client/dist/index.js";
import { asBig, jitFee, jitForwardAmount } from "../../../packages/protocol/dist/index.js";

const pass = (message) => console.log(`  ok  ${message}`);

export function demoOffering(cfg) {
  return {
    asset: cfg.asset,
    min_capacity: "1000000000",
    max_capacity: "100000000000",
    fee_schedule: { base_fee: "0", proportional_bps: 0 },
    stream: { rate_bps_per_period: 5, period_seconds: 86_400, grace_periods: 2 },
  };
}

export function demoJitTerms(cfg) {
  return {
    fee_bps: cfg.jit.feeBps,
    fee_base: cfg.jit.feeBase,
    min_payment: cfg.jit.minPayment,
    max_expiry_seconds: 3600,
  };
}

export function apiLspClient(api) {
  return new LspClient({
    baseUrl: "http://lsp.test",
    fetchImpl: async (url, init) => {
      const requestUrl = new URL(url);
      const result = await api(
        init?.method ?? "GET",
        requestUrl.pathname,
        init?.body ? JSON.parse(String(init.body)) : undefined,
        init?.headers,
      );
      return { status: result.status, json: async () => result.body };
    },
  });
}

export async function runJitSale({ cfg, terms, checkout, customerRpc, merchantRpc }) {
  const session = await checkout.checkout({
    asset: cfg.asset,
    amount: cfg.amounts.jitPayment,
    channelCapacity: cfg.amounts.jitCapacity,
    description: "sale #1",
  });
  assert.equal(session.mode, cfg.mode);
  pass(`checkout negotiated ${session.mode}`);

  const fee = jitFee(terms, asBig(cfg.amounts.jitPayment));
  const net = jitForwardAmount(terms, asBig(cfg.amounts.jitPayment));
  assert.equal(session.fee, fee.toString(10));
  assert.equal(session.netAmount, net.toString(10));
  assert.equal(asBig(session.netAmount) + asBig(session.fee), asBig(cfg.amounts.jitPayment));
  pass(`${cfg.fmt(cfg.amounts.jitPayment)} = ${cfg.fmt(session.netAmount)} net + ${cfg.fmt(session.fee)} fee`);

  const parsed = await customerRpc.parseInvoice(session.invoice);
  assert.equal(parsed.invoice.amount, asBig(cfg.amounts.jitPayment).toString(10));
  const held = await customerRpc.sendPayment({ invoice: session.invoice });
  assert.equal(held.status, "Inflight");
  pass("customer payment is held before channel provisioning");

  const order = await session.settle({ attempts: 100, intervalMs: 0 });
  assert.equal(order.state, "settled");
  assert.ok(order.channel_outpoint);
  assert.equal((await customerRpc.getPayment(session.paymentHash)).status, "Success");
  pass(`merchant paid and hold released after channel ${order.channel_outpoint} became ready`);

  const lease = new StreamingLease({
    rpc: merchantRpc,
    channelId: order.channel_outpoint,
    terms: {
      asset: cfg.asset,
      capacity: cfg.amounts.jitCapacity,
      rate_bps_per_period: 5,
      period_seconds: 86_400,
      grace_periods: 2,
    },
    poll: { attempts: 3, intervalMs: 0, sleep: async () => {} },
  });
  return { session, order, lease, rent: await lease.currentRent() };
}

export async function runRentPeriods({ cfg, lease, periods = 3 }) {
  const payments = [];
  for (let period = 0; period < periods; period++) {
    const payment = await lease.payDue();
    assert.equal(payment.status, "paid");
    payments.push(payment);
  }
  assert.equal(lease.periodsPaid, periods);
  pass(`streamed ${periods} live-priced rent periods (${cfg.fmt(lease.totalPaid)})`);
  return payments;
}
