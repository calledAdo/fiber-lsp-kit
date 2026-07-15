import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { payRentPeriods } from "../../../scripts/demo/shared/merchant-server.mjs";

test("demo rent batching stops after a dispatched payment is not confirmed", async () => {
  const outcomes = [
    { status: "skipped", reason: "payment did not confirm in time", payment_hash: "0xuncertain" },
    { status: "paid", payment_hash: "0xduplicate" },
  ];
  let attempts = 0;
  const lease = {
    async payDue() {
      return outcomes[attempts++];
    },
  };

  const payments = await payRentPeriods(lease, 3);

  assert.equal(attempts, 1);
  assert.deepEqual(payments, [outcomes[0]]);
});

test("merchant demo does not replace real payment polling with zero-delay checks", () => {
  const source = readFileSync(
    new URL("../../../scripts/demo/shared/merchant-server.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /poll\s*:\s*\{[^}]*intervalMs\s*:\s*0/s);
  assert.doesNotMatch(source, /poll\s*:\s*\{[^}]*sleep\s*:\s*async/s);
});
