import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CKB, type Order } from "@fiberlsp/protocol";
import { FileOrderStore } from "@fiberlsp/server";

function sampleOrder(id: string): Order {
  return {
    order_id: id,
    state: "channel_active",
    request: { target_pubkey: "0xCLIENT", asset: CKB, lsp_balance: "50000", fee_mode: "from_capacity" },
    fee: { asset: CKB, base_fee: "1000", proportional_fee: "0", total_fee: "1000", fee_mode: "from_capacity" },
    payment: { mode: "from_capacity", amount: "1000", lsp_pubkey: "0xLSP" },
    channel_outpoint: "0xoutpoint:0",
    expires_at: 2_000,
    created_at: 1_000,
  };
}

test("FileOrderStore persists orders across a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "lspkit-store-"));
  const path = join(dir, "orders.json");
  try {
    const first = new FileOrderStore(path);
    first.put(sampleOrder("order_1"));
    first.put(sampleOrder("order_2"));

    // A fresh store reading the same file resumes with both orders.
    const reopened = new FileOrderStore(path);
    assert.equal(reopened.all().length, 2);
    assert.equal(reopened.get("order_1")?.state, "channel_active");
    assert.equal(reopened.get("order_2")?.channel_outpoint, "0xoutpoint:0");
    assert.equal(reopened.get("missing"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
