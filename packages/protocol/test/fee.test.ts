import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CKB,
  udtAsset,
  computeFee,
  quoteFee,
  validateOrder,
  type AssetOffering,
  type CreateOrderRequest,
  type FeeMode,
} from "@fiberlsp/protocol";

const RUSD = udtAsset(
  {
    code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
    hash_type: "type",
    args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
  },
  "RUSD",
);

const ckbOffering: AssetOffering = {
  asset: CKB,
  min_capacity: "100",
  max_capacity: "1000000",
  fee_schedule: { base_fee: "1000", proportional_bps: 100 }, // flat 1000 + 1%
};
const rusdOffering: AssetOffering = {
  asset: RUSD,
  min_capacity: "10",
  max_capacity: "1000000",
  fee_schedule: { base_fee: "1000", proportional_bps: 100 },
};
const feeModes: FeeMode[] = ["prepaid", "from_capacity"];

test("computeFee applies proportional for CKB channels (ceil division)", () => {
  const f = computeFee(ckbOffering.fee_schedule, "50000", true);
  assert.equal(f.base, 1000n);
  assert.equal(f.proportional, 500n); // 1% of 50000
  assert.equal(f.total, 1500n);
});

test("computeFee drops proportional when not applied (UDT)", () => {
  const f = computeFee(rusdOffering.fee_schedule, "50000", false);
  assert.equal(f.proportional, 0n);
  assert.equal(f.total, 1000n); // flat base only
});

test("quoteFee: CKB channel charges base + proportional, denominated in CKB", () => {
  const req: CreateOrderRequest = {
    target_pubkey: "0xabc",
    asset: CKB,
    lsp_balance: "50000",
    client_balance: "2000",
    fee_mode: "from_capacity",
  };
  const q = quoteFee(ckbOffering, req);
  assert.equal(q.asset.kind, "CKB");
  assert.equal(q.total_fee, "1500");
});

test("quoteFee: UDT channel charges flat CKB base only (no oracle)", () => {
  const req: CreateOrderRequest = {
    target_pubkey: "0xabc",
    asset: RUSD,
    lsp_balance: "50000",
    fee_mode: "prepaid",
  };
  const q = quoteFee(rusdOffering, req);
  assert.equal(q.asset.kind, "CKB"); // fee is CKB even for a RUSD channel
  assert.equal(q.total_fee, "1000");
});

test("validateOrder rejects capacity below min / above max", () => {
  const base: CreateOrderRequest = {
    target_pubkey: "0xabc",
    asset: CKB,
    lsp_balance: "10",
    fee_mode: "prepaid",
  };
  assert.equal(validateOrder(ckbOffering, feeModes, base)?.code, "below_min_capacity");
  assert.equal(
    validateOrder(ckbOffering, feeModes, { ...base, lsp_balance: "99999999" })?.code,
    "above_max_capacity",
  );
});

test("validateOrder: from_capacity is CKB-only", () => {
  const req: CreateOrderRequest = {
    target_pubkey: "0xabc",
    asset: RUSD,
    lsp_balance: "50000",
    fee_mode: "from_capacity",
    client_balance: "999999",
  };
  assert.equal(validateOrder(rusdOffering, feeModes, req)?.code, "from_capacity_requires_ckb");
});

test("validateOrder: from_capacity requires client_balance >= fee", () => {
  const req: CreateOrderRequest = {
    target_pubkey: "0xabc",
    asset: CKB,
    lsp_balance: "50000",
    fee_mode: "from_capacity",
    client_balance: "100", // fee is 1500
  };
  assert.equal(validateOrder(ckbOffering, feeModes, req)?.code, "insufficient_client_balance");
});

test("validateOrder: happy path returns null", () => {
  const req: CreateOrderRequest = {
    target_pubkey: "0xabc",
    asset: RUSD,
    lsp_balance: "50000",
    fee_mode: "prepaid",
  };
  assert.equal(validateOrder(rusdOffering, feeModes, req), null);
});
