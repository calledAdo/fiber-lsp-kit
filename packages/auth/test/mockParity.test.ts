import assert from "node:assert/strict";
import test from "node:test";

import { createWorld, makeNode } from "../../../scripts/demo/shared/mock-node.mjs";

test("mock parse_invoice returns the live signed proof fields", () => {
  const world = createWorld();
  const merchant = makeNode(world, "merchant", 9101);
  const lsp = makeNode(world, "lsp", 9102);
  const description = "fiberlsp-auth:v1:testnet:merchant:nonce";
  const minted = merchant.rpc("new_invoice", [{
    amount: "0x0",
    currency: "Fibt",
    description,
    expiry: "0x258",
  }]);
  const parsed = lsp.rpc("parse_invoice", [{ invoice: minted.invoice_address }]);

  assert.equal(parsed.invoice.currency, "Fibt");
  assert.equal(typeof parsed.invoice.signature, "string");
  assert.ok(parsed.invoice.signature.length > 0);
  assert.ok(parsed.invoice.data.timestamp);
  assert.deepEqual(parsed.invoice.data.attrs, [
    { payee_public_key: merchant.pubkey },
    { description },
    { expiry_time: "0x258" },
  ]);
});
