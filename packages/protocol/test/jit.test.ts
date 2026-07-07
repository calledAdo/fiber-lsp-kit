import { test } from "node:test";
import assert from "node:assert/strict";
import { jitFee, jitForwardAmount, type JitTerms } from "@fiberlsp/protocol";

const terms = (over: Partial<JitTerms> = {}): JitTerms => ({
  fee_bps: 100, // 1% of the payment
  fee_base: "0",
  min_payment: "10000000", // 0.1 RUSD
  max_expiry_seconds: 3600,
  ...over,
});

test("jitFee: proportional bps of the gross payment, ceil-rounded", () => {
  // 1% of 1.00 RUSD (1e8) = 0.01 RUSD
  assert.equal(jitFee(terms(), "100000000"), 1000000n);
  // ceil: 1% of 101 units = 1.01 → 2
  assert.equal(jitFee(terms(), 101n), 2n);
});

test("jitFee: flat base added on top of the proportional part", () => {
  assert.equal(jitFee(terms({ fee_base: "5000" }), "100000000"), 1005000n);
  // pure-flat schedule
  assert.equal(jitFee(terms({ fee_bps: 0, fee_base: "7" }), "100000000"), 7n);
});

test("jitForwardAmount: gross minus fee, in the channel asset", () => {
  assert.equal(jitForwardAmount(terms(), "100000000"), 99000000n);
});

test("jitForwardAmount: throws when the payment cannot cover the fee", () => {
  assert.throws(() => jitForwardAmount(terms({ fee_base: "200000000" }), "100000000"), /does not cover/);
});
