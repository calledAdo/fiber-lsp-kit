import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dualSha256,
  exposedSecretProof,
  udtAsset,
  type JitOrder,
  type JitTerms,
} from "@fiberlsp/protocol";
import { FiberChannelRpcClient, type FetchLike } from "@fiberlsp/fiber";
import { JitCheckout, JitCheckoutError, LspClient } from "@fiberlsp/client";

const RUSD = udtAsset(
  {
    code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
    hash_type: "type",
    args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
  },
  "RUSD",
);

const S = "0x" + "aa".repeat(32);
const linked = dualSha256(S);
const terms: JitTerms = { fee_bps: 100, fee_base: "0", min_payment: "1", max_expiry_seconds: 3600 };

function makeMerchantRpc(legStatuses: string[]) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const next = () => (legStatuses.length > 1 ? legStatuses.shift()! : legStatuses[0]!);
  const fetchImpl: FetchLike = async (_url, init) => {
    const { method, params } = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
    const p0 = (params[0] ?? {}) as Record<string, unknown>;
    calls.push({ method, params: p0 });
    let result: unknown = null;
    if (method === "new_invoice") {
      result = { invoice_address: "fibt_leg", invoice: { data: { payment_hash: linked.leg } } };
    } else if (method === "get_invoice") {
      result = { status: next() };
    }
    return { json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
  return { fetchImpl, calls };
}

function makeLspRest(orderStates: JitOrder["state"][] = ["forwarding", "settled"]) {
  const calls: { method: string; path: string; body?: unknown; auth?: string }[] = [];
  const nextState = () => (orderStates.length > 1 ? orderStates.shift()! : orderStates[0]!);
  const order = (state: JitOrder["state"]): JitOrder => ({
    jit_order_id: "jit_1",
    state,
    request: {
      target_pubkey: "0xM",
      asset: RUSD,
      hold_hash: linked.hold,
      leg_hash: linked.leg,
      merchant_invoice: "fibt_leg",
      amount: "100000000",
      channel_capacity: "1000000000",
      expiry_seconds: 600,
    },
    hold_invoice: "fibt_hold_customer",
    forward_amount: "99000000",
    fee: "1000000",
    expires_at: 999,
    created_at: 1,
  });
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace("http://lsp", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const auth = init?.headers ? (init.headers as Record<string, string>).authorization : undefined;
    calls.push({ method: init?.method ?? "GET", path, body, auth });
    if (path === "/lsp/v1/info") {
      return { status: 200, json: async () => ({ jit: terms }) } as Response;
    }
    if (path === "/lsp/v1/jit/orders" && init?.method === "POST") {
      return { status: 201, json: async () => ({ ...order("created"), order_token: "tok_1" }) } as Response;
    }
    if (path === "/lsp/v1/jit/orders/jit_1" && init?.method === "GET") {
      return { status: 200, json: async () => order(nextState()) } as Response;
    }
    if (path === "/lsp/v1/jit/orders/jit_1/reveal" && init?.method === "POST") {
      return { status: 200, json: async () => order("settled") } as Response;
    }
    throw new Error("unexpected " + path);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function makeCheckout(legStatuses: string[], orderStates?: JitOrder["state"][]) {
  const merchant = makeMerchantRpc(legStatuses);
  const rest = makeLspRest(orderStates);
  const checkout = new JitCheckout({
    rpc: new FiberChannelRpcClient({ rpcUrl: "http://merchant", fetchImpl: merchant.fetchImpl }),
    lsp: new LspClient({ baseUrl: "http://lsp", fetchImpl: rest.fetchImpl }),
    merchantPubkey: "0xM",
    merchantAddress: "/ip4/127.0.0.1/tcp/9999",
    randomBytes: () => new Uint8Array(32).fill(0xaa),
    sleep: async () => {},
    proveLinkage: (_hold, _leg, secret) => exposedSecretProof(secret),
  });
  return { checkout, merchant, rest };
}

test("checkout registers canonical single-node JIT order and returns customer hold invoice", async () => {
  const { checkout, merchant, rest } = makeCheckout(["Open"]);
  const session = await checkout.checkout({ asset: RUSD, amount: "100000000" });

  assert.equal(session.invoice, "fibt_hold_customer");
  assert.equal(session.paymentHash, linked.hold);
  assert.equal(session.netAmount, "99000000");

  const invoice = merchant.calls.find((c) => c.method === "new_invoice")!.params;
  assert.equal(invoice.payment_preimage, linked.legPreimage);
  assert.equal(invoice.hash_algorithm, "sha256");

  const intent = rest.calls.find((c) => c.path === "/lsp/v1/jit/orders")!.body as Record<string, unknown>;
  assert.equal(intent.hold_hash, linked.hold);
  assert.equal(intent.leg_hash, linked.leg);
  assert.ok(!("payment_hash" in intent));
});

test("settle reveals leg preimage with bearer token when LSP has not auto-settled", async () => {
  const { checkout, rest } = makeCheckout(["Open", "Paid"], ["forwarding"]);
  const session = await checkout.checkout({ asset: RUSD, amount: "100000000" });
  const settled = await session.settle({ intervalMs: 0 });

  assert.equal(settled.state, "settled");
  const reveal = rest.calls.find((c) => c.path.endsWith("/reveal"))!;
  assert.equal(reveal.auth, "Bearer tok_1");
  assert.deepEqual(reveal.body, { preimage: linked.legPreimage });
});

test("settle returns settled order without reveal when LSP already derived the hold preimage", async () => {
  const { checkout, rest } = makeCheckout(["Paid"], ["settled"]);
  const session = await checkout.checkout({ asset: RUSD, amount: "100000000" });
  const settled = await session.settle({ intervalMs: 0 });

  assert.equal(settled.state, "settled");
  assert.ok(!rest.calls.some((c) => c.path.endsWith("/reveal")));
});

test("checkout requires an explicit linkage proof builder", async () => {
  const merchant = makeMerchantRpc(["Open"]);
  const rest = makeLspRest();
  const checkout = new JitCheckout({
    rpc: new FiberChannelRpcClient({ rpcUrl: "http://merchant", fetchImpl: merchant.fetchImpl }),
    lsp: new LspClient({ baseUrl: "http://lsp", fetchImpl: rest.fetchImpl }),
    merchantPubkey: "0xM",
    randomBytes: () => new Uint8Array(32).fill(0xaa),
  } as unknown as ConstructorParameters<typeof JitCheckout>[0]);

  await assert.rejects(
    checkout.checkout({ asset: RUSD, amount: "100000000" }),
    (e: JitCheckoutError) => e.code === "missing_linkage_prover",
  );
});
