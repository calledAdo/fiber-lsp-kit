import { test } from "node:test";
import assert from "node:assert/strict";
import {
  udtAsset,
  CKB,
  rentPerPeriod,
  periodsElapsed,
  describeLease,
  leaseTermsFor,
  quoteLease,
  type AssetOffering,
  type LeaseTerms,
  type UdtTypeScript,
} from "@fiberlsp/protocol";

const RUSD_SCRIPT: UdtTypeScript = {
  code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hash_type: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const RUSD = udtAsset(RUSD_SCRIPT, "RUSD");

const terms = (over: Partial<LeaseTerms> = {}): LeaseTerms => ({
  asset: RUSD,
  capacity: "1000000000", // 10 RUSD
  rate_bps_per_period: 5, // 0.05% of capacity per period
  period_seconds: 86400, // daily
  grace_periods: 2,
  ...over,
});

test("rentPerPeriod is bps of capacity", () => {
  // 5 bps of 10 RUSD = 0.0005 * 1e9 = 500000 (0.005 RUSD)
  assert.equal(rentPerPeriod(terms()).toString(10), "500000");
});

test("rentPerPeriod rounds up so the LSP never under-charges", () => {
  assert.equal(rentPerPeriod(terms({ capacity: "1", rate_bps_per_period: 1 })).toString(10), "1");
});

test("periodsElapsed floors and never goes negative", () => {
  assert.equal(periodsElapsed(1000, 1000 + 3 * 3600, 3600), 3);
  assert.equal(periodsElapsed(1000, 1000 + 3599, 3600), 0);
  assert.equal(periodsElapsed(1000, 500, 3600), 0);
  assert.equal(periodsElapsed(1000, 5000, 0), 0);
});

test("describeLease is a readable one-liner carrying the per-period rent", () => {
  const s = describeLease(terms());
  assert.match(s, /RUSD/);
  assert.match(s, /5bps\/86400s/);
  assert.match(s, /→ 500000\/period/);
});

const leaseOffering: AssetOffering = {
  asset: RUSD,
  min_capacity: "1000000000",
  max_capacity: "100000000000",
  fee_schedule: { base_fee: "1000000000", proportional_bps: 0 }, // 10 CKB activation, flat for UDT
  stream: { rate_bps_per_period: 5, period_seconds: 86400, grace_periods: 2 },
};

test("quoteLease returns CKB activation + channel-asset streaming rent", () => {
  const q = quoteLease(leaseOffering, "1000000000");
  assert.equal(q.activation.amount, "1000000000"); // 10 CKB, flat (UDT channel → no proportional term)
  assert.equal(q.activation.asset.kind, "CKB");
  assert.ok(q.stream);
  assert.equal(q.stream!.rentPerPeriod, "500000"); // 5 bps of 10 RUSD, in RUSD
  assert.equal(q.stream!.terms.asset.symbol, "RUSD");
  assert.equal(q.stream!.terms.capacity, "1000000000");
});

test("quoteLease of a purchase-only offering has activation but no stream", () => {
  const { stream, ...rest } = leaseOffering;
  void stream;
  const q = quoteLease(rest, "1000000000");
  assert.equal(q.activation.amount, "1000000000");
  assert.equal(q.stream, undefined);
});

test("leaseTermsFor binds advertised stream terms to a chosen capacity", () => {
  const t = leaseTermsFor(leaseOffering, 2_000_000_000n);
  assert.equal(t?.capacity, "2000000000");
  assert.equal(t?.period_seconds, 86400);
  assert.equal(rentPerPeriod(t!).toString(10), "1000000"); // 5 bps of 20 RUSD
});

test("CKB channel activation applies the proportional fee term", () => {
  const ckbOffering: AssetOffering = {
    asset: CKB,
    min_capacity: "0",
    max_capacity: "1000000000000",
    fee_schedule: { base_fee: "1000000000", proportional_bps: 100 }, // 10 CKB + 1%
  };
  const q = quoteLease(ckbOffering, "10000000000"); // 100 CKB capacity
  // 10 CKB base + 1% of 100 CKB (1e10) = 1e9 + 1e8 = 1_100_000_000
  assert.equal(q.activation.amount, "1100000000");
});
