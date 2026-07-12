import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  SignedCapabilityService,
  merchantScopePermission,
  type MerchantCapabilityContext,
} from "../src/index.js";

const merchant = { pubkey: "02aa", verifiedAt: 1_000 };
const policy = { merchantPubkey: "02aa", permissions: ["orders:create"], maxChannels: 2 };
const ctx: MerchantCapabilityContext = { merchant, policy };

function fixture(openChannels = 0) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    service: new SignedCapabilityService({
      privateKey,
      publicKey,
      quota: { usage: async () => ({ openChannels }) },
    }),
    publicKey,
  };
}

test("SignedCapabilityService authorizes an issued in-policy permission", async () => {
  const { service } = fixture();
  const token = await service.issue(ctx);

  assert.deepEqual(await service.authorize(token, { permission: "orders:create" }), { allowed: true });
  assert.deepEqual(await service.authorize(token, { permission: merchantScopePermission("02AA") }), {
    allowed: true,
  });
});

test("SignedCapabilityService denies out-of-policy and cross-merchant permissions", async () => {
  const { service } = fixture();
  const token = await service.issue(ctx);

  assert.equal((await service.authorize(token, { permission: "orders:delete" })).allowed, false);
  assert.equal((await service.authorize(token, { permission: merchantScopePermission("02bb") })).allowed, false);
});

test("SignedCapabilityService denies when live usage reaches maxChannels", async () => {
  const { service } = fixture(2);
  const token = await service.issue(ctx);
  assert.deepEqual(await service.authorize(token, { permission: "orders:create" }), {
    allowed: false,
    code: "quota_exceeded",
    reason: "merchant has reached maxChannels",
  });
});

test("SignedCapabilityService rejects tampered tokens and tokens signed by another root", async () => {
  const first = fixture();
  const second = fixture();
  const token = await first.service.issue(ctx);
  const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");

  assert.equal((await first.service.authorize(tampered, { permission: "orders:create" })).allowed, false);
  assert.equal((await second.service.authorize(token, { permission: "orders:create" })).allowed, false);
});
