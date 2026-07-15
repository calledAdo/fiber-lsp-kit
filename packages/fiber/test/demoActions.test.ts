import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseInvoiceCommandArgs,
  parsePayCommandArgs,
  parseRegularInvoiceCommandArgs,
  parseRentCommandArgs,
} from "../../../scripts/demo/shared/actions.mjs";

test("invoice command requires an explicit amount and capacity", () => {
  assert.deepEqual(
    parseInvoiceCommandArgs(["--amount", "1.25", "--capacity", "10"]),
    { amount: "1.25", capacity: "10" },
  );
  assert.throws(() => parseInvoiceCommandArgs([]), /--amount is required/i);
  assert.throws(() => parseInvoiceCommandArgs(["--amount", "1"]), /--capacity is required/i);
  assert.throws(() => parseInvoiceCommandArgs(["--capacity", "10"]), /--amount is required/i);
});

test("pay command accepts either an explicit invoice or the latest saved invoice", () => {
  assert.deepEqual(parsePayCommandArgs(["--invoice", "fibt1invoice"]), {
    invoice: "fibt1invoice",
    latest: false,
  });
  assert.deepEqual(parsePayCommandArgs(["--latest"]), { invoice: undefined, latest: true });
  assert.throws(() => parsePayCommandArgs([]), /--invoice.*--latest/i);
  assert.throws(
    () => parsePayCommandArgs(["--invoice", "fibt1invoice", "--latest"]),
    /only one/i,
  );
});

test("regular invoice command requires an explicit amount", () => {
  assert.deepEqual(parseRegularInvoiceCommandArgs(["--amount", "1.25"]), { amount: "1.25" });
  assert.throws(() => parseRegularInvoiceCommandArgs([]), /--amount is required/i);
});

test("rent command accepts either a channel or latest state and validates periods", () => {
  assert.deepEqual(parseRentCommandArgs(["--channel", "0xchannel", "--periods", "2"]), {
    channelId: "0xchannel",
    latest: false,
    periods: 2,
  });
  assert.deepEqual(parseRentCommandArgs(["--latest"]), {
    channelId: undefined,
    latest: true,
    periods: 3,
  });
  assert.throws(() => parseRentCommandArgs([]), /--channel.*--latest/i);
  assert.throws(
    () => parseRentCommandArgs(["--channel", "0xchannel", "--periods", "0"]),
    /positive integer/i,
  );
});
