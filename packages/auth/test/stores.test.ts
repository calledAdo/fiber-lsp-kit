import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileMerchantPolicyStore,
  MemoryChallengeStore,
  MemoryMerchantPolicyStore,
  type MerchantPolicy,
} from "../src/index.js";

const policy: MerchantPolicy = {
  merchantPubkey: "02AA",
  maxChannels: 2,
  permissions: ["orders:create"],
};

test("MemoryChallengeStore consumes a challenge exactly once", async () => {
  const store = new MemoryChallengeStore({ randomBytes: () => Buffer.alloc(32, 1) });
  const challenge = await store.issue("02AA");

  assert.equal(await store.consume("02aa", challenge), true);
  assert.equal(await store.consume("02aa", challenge), false);
  assert.equal(await store.consume("02bb", challenge), false);
});

test("MemoryChallengeStore rejects expired challenges", async () => {
  let now = 1_000;
  const store = new MemoryChallengeStore({ ttlMs: 50, now: () => now });
  const challenge = await store.issue("02aa");
  now = 1_051;

  assert.equal(await store.consume("02aa", challenge), false);
});

test("MemoryChallengeStore does not let a wrong pubkey burn a valid challenge", async () => {
  const store = new MemoryChallengeStore();
  const challenge = await store.issue("02aa");

  assert.equal(await store.consume("02bb", challenge), false);
  assert.equal(await store.consume("02aa", challenge), true);
});

test("MemoryMerchantPolicyStore round-trips policies by normalized pubkey", async () => {
  const store = new MemoryMerchantPolicyStore();
  await store.put(policy);

  assert.deepEqual(await store.get("02aa"), { ...policy, merchantPubkey: "02aa" });
});

test("FileMerchantPolicyStore persists policies across instances", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fiberlsp-policies-"));
  const path = join(dir, "policies.json");
  try {
    await new FileMerchantPolicyStore(path).put(policy);
    assert.deepEqual(await new FileMerchantPolicyStore(path).get("02AA"), {
      ...policy,
      merchantPubkey: "02aa",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
