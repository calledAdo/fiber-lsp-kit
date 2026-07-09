import { test } from "node:test";
import assert from "node:assert/strict";
import { receivedTlcExpirySeconds, invoiceExpirySeconds, type RawChannel } from "@fiberlsp/fiber";

const ms = (sec: number) => "0x" + (BigInt(sec) * 1000n).toString(16);

test("receivedTlcExpirySeconds returns the matching TLC expiry in seconds (ms → s)", () => {
  const channels = [
    { pending_tlcs: [{ payment_hash: "0xAA", expiry: ms(1_700_000_000) }] },
    { pending_tlcs: [{ payment_hash: "0xbb", expiry: ms(1_700_000_500) }] },
  ] as unknown as RawChannel[];
  assert.equal(receivedTlcExpirySeconds(channels, "0xaa"), 1_700_000_000); // case-insensitive match
  assert.equal(receivedTlcExpirySeconds(channels, "0xcc"), undefined); // no match
});

test("receivedTlcExpirySeconds takes the earliest expiry across duplicates", () => {
  const channels = [
    { pending_tlcs: [{ payment_hash: "0xAA", expiry: ms(1_700_000_900) }] },
    { pending_tlcs: [{ payment_hash: "0xAA", expiry: ms(1_700_000_100) }] },
  ] as unknown as RawChannel[];
  assert.equal(receivedTlcExpirySeconds(channels, "0xaa"), 1_700_000_100);
});

test("receivedTlcExpirySeconds tolerates channels without pending_tlcs", () => {
  const channels = [{}, { pending_tlcs: [] }] as unknown as RawChannel[];
  assert.equal(receivedTlcExpirySeconds(channels, "0xaa"), undefined);
});

test("invoiceExpirySeconds = timestamp(ms→s) + expiry_time(s)", () => {
  const parsed = {
    invoice: { data: { timestamp: ms(2_000_000_000), attrs: [{ expiry_time: "0xe10" }] } }, // +3600s
  };
  assert.equal(invoiceExpirySeconds(parsed), 2_000_000_000 + 3600);
});

test("invoiceExpirySeconds is undefined when timestamp or expiry_time is missing", () => {
  assert.equal(invoiceExpirySeconds({ invoice: { data: { attrs: [{ expiry_time: "0xe10" }] } } }), undefined);
  assert.equal(invoiceExpirySeconds({ invoice: { data: { timestamp: ms(1) } } }), undefined);
});
