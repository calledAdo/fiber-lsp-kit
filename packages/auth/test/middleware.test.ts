import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { FiberChannelRpcClient, type FetchLike } from "@fiberlsp/fiber";
import { createApi, type JitService, type Lsp } from "@fiberlsp/server";
import {
  MemoryChallengeStore,
  MemoryMerchantPolicyStore,
  SignedCapabilityService,
  SignedFiberInvoiceVerifier,
  createAdminPolicyMiddleware,
  createMerchantAuthMiddleware,
} from "../src/index.js";

const PUBKEY = "0344f85475b59dd4427fd7e37e581c9d1d99d74d7d69aa95bd8a538d4ec4e87283";
const NOW = 1_750_000_000_000;

function fixture() {
  let parsedDescription = "";
  let openChannels = 0;
  const challenges = new MemoryChallengeStore({ now: () => NOW });
  const policies = new MemoryMerchantPolicyStore();
  const fetchImpl: FetchLike = async (_url, init) => {
    const { id } = JSON.parse(String(init.body));
    return {
      json: async () => ({
        jsonrpc: "2.0",
        id,
        result: {
          invoice: {
            currency: "Fibt",
            signature: "signed",
            data: {
              timestamp: `0x${NOW.toString(16)}`,
              attrs: [
                { payee_public_key: PUBKEY },
                { description: parsedDescription },
                { expiry_time: "0x258" },
              ],
            },
          },
        },
      }),
    };
  };
  const proofVerifier = new SignedFiberInvoiceVerifier({
    rpc: new FiberChannelRpcClient({ rpcUrl: "http://node", fetchImpl }),
    challenges,
    expectedCurrency: "Fibt",
    now: () => NOW,
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const capabilities = new SignedCapabilityService({
    privateKey,
    publicKey,
    quota: { usage: async () => ({ openChannels }) },
    now: () => NOW,
  });
  const calls: Array<{ action: string; token?: string }> = [];
  const jit = {
    terms: { modes: ["linked"] },
    createOrder: async (body: unknown) => ({ jit_order_id: "jit_1", order_token: "order-token", body }),
    run: async () => {},
    getOrder: (_id: string, token?: string) => {
      calls.push({ action: "get", token });
      return { jit_order_id: "jit_1" };
    },
    reveal: async (_id: string, _preimage: string, token?: string) => {
      calls.push({ action: "reveal", token });
      return { jit_order_id: "jit_1" };
    },
    cancel: async (_id: string, token?: string) => {
      calls.push({ action: "cancel", token });
      return { jit_order_id: "jit_1" };
    },
  } as unknown as JitService;
  const lsp = {
    getInfo: () => ({ lsp_pubkey: "02lsp", addresses: [], supported_assets: [], fee_modes: [] }),
    liquidity: async () => ({ assets: [] }),
  } as unknown as Lsp;
  const middleware = createMerchantAuthMiddleware({ challenges, proofVerifier, policies, capabilities });
  const handle = createApi(lsp, { jit, middleware: [middleware] });

  return {
    challenges,
    policies,
    calls,
    handle,
    setDescription(value: string) {
      parsedDescription = value;
    },
    setOpenChannels(value: number) {
      openChannels = value;
    },
  };
}

async function issueToken(f: ReturnType<typeof fixture>): Promise<string> {
  await f.policies.put({ merchantPubkey: PUBKEY, maxChannels: 1, permissions: ["orders:create"] });
  const challengeResponse = await f.handle("POST", "/lsp/v1/auth/challenge", { pubkey: PUBKEY });
  assert.equal(challengeResponse.status, 200);
  const challenge = (challengeResponse.body as { challenge: string }).challenge;
  f.setDescription(challenge);
  const tokenResponse = await f.handle("POST", "/lsp/v1/auth/token", {
    invoice: "fibt1signed",
    pubkey: PUBKEY,
  });
  assert.equal(tokenResponse.status, 200);
  return (tokenResponse.body as { token: string }).token;
}

test("merchant middleware guards JIT create and permits challenge-verified own-pubkey creation", async () => {
  const f = fixture();
  const body = { target_pubkey: PUBKEY };
  const unauthenticated = await f.handle("POST", "/lsp/v1/jit/orders", body);
  assert.deepEqual(unauthenticated, {
    status: 401,
    body: { error: { code: "missing_bearer", message: "Authorization bearer token is required" } },
  });
  assert.equal((await f.handle("POST", "/lsp/v1/orders", body)).status, 401);

  const token = await issueToken(f);
  const created = await f.handle("POST", "/lsp/v1/jit/orders", body, {
    authorization: `Bearer ${token}`,
  });
  assert.equal(created.status, 201);

  const wrongMerchant = await f.handle("POST", "/lsp/v1/jit/orders", { target_pubkey: "02bb" }, {
    authorization: `Bearer ${token}`,
  });
  assert.equal(wrongMerchant.status, 403);
});

test("merchant middleware maps live channel quota exhaustion to 429", async () => {
  const f = fixture();
  const token = await issueToken(f);
  f.setOpenChannels(1);

  const response = await f.handle("POST", "/lsp/v1/jit/orders", { target_pubkey: PUBKEY }, {
    authorization: `Bearer ${token}`,
  });
  assert.deepEqual(response, {
    status: 429,
    body: { error: { code: "quota_exceeded", message: "merchant has reached maxChannels" } },
  });
});

test("merchant middleware does not double-guard JIT per-order token routes", async () => {
  const f = fixture();
  f.setOpenChannels(99);
  const headers = { authorization: "Bearer order-token" };

  assert.equal((await f.handle("GET", "/lsp/v1/jit/orders/jit_1", undefined, headers)).status, 200);
  assert.equal((await f.handle("POST", "/lsp/v1/jit/orders/jit_1/reveal", { preimage: "0x01" }, headers)).status, 200);
  assert.equal((await f.handle("POST", "/lsp/v1/jit/orders/jit_1/cancel", undefined, headers)).status, 200);
  assert.deepEqual(f.calls, [
    { action: "get", token: "order-token" },
    { action: "reveal", token: "order-token" },
    { action: "cancel", token: "order-token" },
  ]);
});

test("admin policy middleware requires deployment-supplied authorization", async () => {
  const policies = new MemoryMerchantPolicyStore();
  const denied = createAdminPolicyMiddleware(policies, async () => false);
  const allowed = createAdminPolicyMiddleware(policies, async () => true);
  const request = {
    method: "PUT",
    path: "/lsp/v1/admin/policies",
    body: { merchantPubkey: PUBKEY, permissions: ["orders:create"] },
  };
  const next = async () => ({ status: 404, body: null });

  assert.equal((await denied(request, next)).status, 401);
  assert.equal((await allowed(request, next)).status, 200);
  assert.ok(await policies.get(PUBKEY));
});
