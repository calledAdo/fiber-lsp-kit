import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CKB, udtAsset, type UdtTypeScript } from "@fiberlsp/protocol";
import { SettlementLedger, FileLedgerStore, type Receipt } from "@fiberlsp/client";

const RUSD_SCRIPT: UdtTypeScript = {
  code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hash_type: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const RUSD = udtAsset(RUSD_SCRIPT, "RUSD");

function receipt(over: Partial<Receipt> & Pick<Receipt, "receipt_id">): Receipt {
  return {
    invoice: "inv",
    payment_hash: "0x" + over.receipt_id,
    asset: RUSD,
    amount: "100",
    status: "Paid",
    paid: true,
    issued_at: 1_700_000_000,
    settled_at: 1_700_000_000,
    ...over,
  };
}

test("list filters by paid/asset/time and sorts newest-issued first", () => {
  const l = new SettlementLedger();
  l.record(receipt({ receipt_id: "a", issued_at: 100 }));
  l.record(receipt({ receipt_id: "b", issued_at: 300, paid: false, status: "Expired", settled_at: undefined }));
  l.record(receipt({ receipt_id: "c", issued_at: 200, asset: CKB }));

  assert.deepEqual(
    l.list().map((r) => r.receipt_id),
    ["b", "c", "a"], // 300, 200, 100
  );
  assert.deepEqual(
    l.list({ paid: true }).map((r) => r.receipt_id),
    ["c", "a"],
  );
  assert.deepEqual(
    l.list({ asset: RUSD }).map((r) => r.receipt_id),
    ["b", "a"],
  );
  assert.deepEqual(
    l.list({ since: 150, until: 250 }).map((r) => r.receipt_id),
    ["c"],
  );
});

test("totals roll up received and fees per asset over paid receipts only", () => {
  const l = new SettlementLedger();
  l.record(receipt({ receipt_id: "a", amount: "100", fee_paid: "10" }));
  l.record(receipt({ receipt_id: "b", amount: "250", fee_paid: "10" }));
  l.record(receipt({ receipt_id: "c", amount: "999", paid: false, status: "Expired" })); // not counted in received
  l.record(receipt({ receipt_id: "d", amount: "5", asset: CKB }));

  const totals = l.totals();
  const rusd = totals.find((t) => t.label === "RUSD");
  assert.ok(rusd);
  assert.equal(rusd.receipt_count, 3);
  assert.equal(rusd.paid_count, 2);
  assert.equal(rusd.received, "350"); // 100 + 250, expired excluded
  assert.equal(rusd.fees_paid, "20");

  const ckb = totals.find((t) => t.label === "CKB");
  assert.equal(ckb?.received, "5");
});

test("reconcile flags receipts whose recorded status disagrees with the node", async () => {
  const l = new SettlementLedger();
  l.record(receipt({ receipt_id: "a" })); // recorded Paid, node Paid → match
  l.record(receipt({ receipt_id: "b", paid: false, status: "Open", settled_at: undefined })); // node now Paid → drift

  const nodeStatus: Record<string, "Paid" | "Open"> = { "0xa": "Paid", "0xb": "Paid" };
  const report = await l.reconcile({
    getInvoice: async (hash: string) => ({ status: nodeStatus[hash] }),
  });

  assert.equal(report.checked, 2);
  assert.equal(report.matched, 1);
  assert.equal(report.discrepancies.length, 1);
  assert.deepEqual(report.discrepancies[0], {
    receipt_id: "b",
    payment_hash: "0xb",
    recorded_status: "Open",
    node_status: "Paid",
  });
});

test("export renders CSV (ISO times, quoted cells) and JSON", () => {
  const l = new SettlementLedger();
  l.record(receipt({ receipt_id: "a", amount: "100", description: "shoes, size 42", fee_paid: "10" }));

  const csv = l.export("csv");
  const [header, row] = csv.split("\n");
  assert.equal(
    header,
    "receipt_id,status,paid,asset,amount,fee_paid,issued_at,settled_at,payment_hash,description",
  );
  assert.match(row, /^a,Paid,true,RUSD,100,10,/);
  assert.match(row, /2023-11-14T22:13:20\.000Z/); // 1_700_000_000s as ISO
  assert.match(row, /"shoes, size 42"$/); // comma-bearing cell quoted

  const json = JSON.parse(l.export("json")) as Receipt[];
  assert.equal(json.length, 1);
  assert.equal(json[0].receipt_id, "a");
});

test("FileLedgerStore persists receipts across instances", () => {
  const dir = mkdtempSync(join(tmpdir(), "fiberlsp-ledger-"));
  const path = join(dir, "ledger.json");
  try {
    const first = new SettlementLedger(new FileLedgerStore(path));
    first.record(receipt({ receipt_id: "a", amount: "500" }));

    const reloaded = new SettlementLedger(new FileLedgerStore(path));
    const rows = reloaded.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].receipt_id, "a");
    assert.equal(rows[0].amount, "500");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
