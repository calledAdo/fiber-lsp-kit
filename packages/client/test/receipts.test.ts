import { test } from "node:test";
import assert from "node:assert/strict";
import { udtAsset, type UdtTypeScript } from "@fiberlsp/protocol";
import { buildReceipt, type IssuedInvoice, type InvoiceOutcome } from "@fiberlsp/client";

const RUSD_SCRIPT: UdtTypeScript = {
  code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hash_type: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const RUSD = udtAsset(RUSD_SCRIPT, "RUSD");

const issued: IssuedInvoice = { invoice: "fibt1qshop", paymentHash: "0xph", asset: RUSD, amount: "500" };
const paid: InvoiceOutcome = { status: "Paid", paid: true, paymentHash: "0xph" };
const expired: InvoiceOutcome = { status: "Expired", paid: false, paymentHash: "0xph" };

const CTX = { idgen: () => "rcpt_1", now: () => 1_700_000_000 };

test("buildReceipt stamps settled_at and carries context on a paid invoice", () => {
  const r = buildReceipt(issued, paid, {
    ...CTX,
    description: "order #42",
    fee_paid: "1000",
    metadata: { cart: "abc" },
  });
  assert.equal(r.receipt_id, "rcpt_1");
  assert.equal(r.paid, true);
  assert.equal(r.status, "Paid");
  assert.equal(r.invoice, "fibt1qshop");
  assert.equal(r.payment_hash, "0xph");
  assert.equal(r.amount, "500");
  assert.equal(r.issued_at, 1_700_000_000);
  assert.equal(r.settled_at, 1_700_000_000);
  assert.equal(r.fee_paid, "1000");
  assert.equal(r.description, "order #42");
  assert.deepEqual(r.metadata, { cart: "abc" });
});

test("buildReceipt records an unpaid terminal outcome with no settled_at", () => {
  const r = buildReceipt(issued, expired, CTX);
  assert.equal(r.paid, false);
  assert.equal(r.status, "Expired");
  assert.equal(r.settled_at, undefined);
});

test("buildReceipt honours an explicit settled_at over the clock", () => {
  const r = buildReceipt(issued, paid, { ...CTX, settled_at: 1_700_000_123 });
  assert.equal(r.issued_at, 1_700_000_000);
  assert.equal(r.settled_at, 1_700_000_123);
});
