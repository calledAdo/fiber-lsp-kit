import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CKB,
  dualSha256,
  exposedSecretProof,
  exposedSecretVerifier,
  udtAsset,
  type AssetOffering,
  type CreateJitOrderRequest,
  type JitTerms,
} from "@fiberlsp/protocol";
import { FiberChannelRpcClient, type FetchLike } from "@fiberlsp/fiber";
import { createApi, JitError, JitService, Lsp, MemoryJitStore } from "@fiberlsp/server";

const RUSD = udtAsset(
  {
    code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
    hash_type: "type",
    args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
  },
  "RUSD",
);

const terms: JitTerms = { fee_bps: 100, fee_base: "0", min_payment: "1000000", max_expiry_seconds: 3600 };
const offering: AssetOffering = {
  asset: RUSD,
  min_capacity: "1000000000",
  max_capacity: "2000000000",
  fee_schedule: { base_fee: "0", proportional_bps: 0 },
};

const S = "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const linked = dualSha256(S);
const other = dualSha256("0x" + "22".repeat(32));

function req(over: Partial<CreateJitOrderRequest> = {}): CreateJitOrderRequest {
  return {
    target_pubkey: "0xMERCHANT",
    target_address: "/ip4/127.0.0.1/tcp/9999",
    asset: RUSD,
    hold_hash: linked.hold,
    merchant_payment_hash: linked.merchantPaymentHash,
    merchant_invoice: "fibt_merchant",
    linkage_proof: exposedSecretProof(S),
    amount: "100000000",
    ...over,
  };
}

function makeNode(
  over: {
    merchantPaymentHash?: string;
    merchantInvoiceAmount?: string;
    paymentPreimage?: string;
    paymentStatuses?: string[];
    holdStatuses?: string[];
    merchantInvoiceTimestamp?: string; // hex ms
    merchantInvoiceExpirySec?: string; // hex seconds
    tlcExpiryMsHex?: string; // hex ms; adds a pending_tlc for linked.hold on the opened channel
  } = {},
) {
  let opened = false;
  const calls: string[] = [];
  const captured = {
    holdInvoiceHash: "",
    holdInvoiceAlgorithm: "",
    openedFunding: "",
    settled: "",
    cancelled: "",
    sentInvoice: "",
  };
  const paymentStatuses = over.paymentStatuses ? [...over.paymentStatuses] : ["none", "Success"];
  const holdStatuses = over.holdStatuses ? [...over.holdStatuses] : ["Received"];
  const next = (xs: string[]) => (xs.length > 1 ? xs.shift()! : xs[0]!);

  const fetchImpl: FetchLike = async (_url, init) => {
    const { method, params } = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
    const p0 = (params[0] ?? {}) as Record<string, unknown>;
    calls.push(method);
    let result: unknown = null;
    switch (method) {
      case "new_invoice":
        captured.holdInvoiceHash = String(p0.payment_hash);
        captured.holdInvoiceAlgorithm = String(p0.hash_algorithm);
        result = { invoice_address: "fibt_hold", invoice: { data: { payment_hash: p0.payment_hash } } };
        break;
      case "parse_invoice":
        result = {
          invoice: {
            amount: over.merchantInvoiceAmount ?? "99000000",
            data: {
              payment_hash: over.merchantPaymentHash ?? linked.merchantPaymentHash,
              ...(over.merchantInvoiceTimestamp ? { timestamp: over.merchantInvoiceTimestamp } : {}),
              ...(over.merchantInvoiceExpirySec ? { attrs: [{ expiry_time: over.merchantInvoiceExpirySec }] } : {}),
            },
          },
        };
        break;
      case "get_invoice":
        result = { status: next(holdStatuses) };
        break;
      case "list_peers":
        result = { peers: [{ pubkey: "0xMERCHANT" }] };
        break;
      case "open_channel":
        opened = true;
        captured.openedFunding = String(p0.funding_amount);
        result = { temporary_channel_id: "0xtmp" };
        break;
      case "list_channels":
        result = {
          channels: opened
            ? [
                {
                  channel_id: "0xchan",
                  channel_outpoint: "0xout:0",
                  pubkey: "0xMERCHANT",
                  funding_udt_type_script: RUSD.udt,
                  state: { state_name: "ChannelReady" },
                  local_balance: captured.openedFunding,
                  remote_balance: "0x0",
                  ...(over.tlcExpiryMsHex
                    ? { pending_tlcs: [{ payment_hash: linked.hold, expiry: over.tlcExpiryMsHex }] }
                    : {}),
                  enabled: true,
                },
              ]
            : [],
        };
        break;
      case "send_payment":
        captured.sentInvoice = String(p0.invoice);
        result = { payment_hash: linked.merchantPaymentHash, status: "Created" };
        break;
      case "get_payment": {
        const status = next(paymentStatuses);
        if (status === "none") {
          return { json: async () => ({ jsonrpc: "2.0", id: 1, error: { message: "payment not found" } }) };
        }
        result = {
          payment_hash: linked.merchantPaymentHash,
          status,
          fee: "0x0",
          ...(over.paymentPreimage === undefined ? { payment_preimage: linked.merchantPreimage } : {}),
          ...(over.paymentPreimage ? { payment_preimage: over.paymentPreimage } : {}),
        };
        break;
      }
      case "settle_invoice":
        captured.settled = `${p0.payment_hash}:${p0.payment_preimage}`;
        break;
      case "cancel_invoice":
        captured.cancelled = String(p0.payment_hash);
        break;
    }
    return { json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };

  return { fetchImpl, calls, captured };
}

function makeService(
  node = makeNode(),
  preimageSource?: {
    observe(paymentHash: string): Promise<{ preimage: Promise<string | undefined>; close(): void }>;
  },
) {
  const svc = new JitService({
    rpc: new FiberChannelRpcClient({ rpcUrl: "http://node", fetchImpl: node.fetchImpl }),
    terms,
    supportedAssets: [offering],
    linkageVerifier: exposedSecretVerifier,
    pollIntervalMs: 0,
    readyPollAttempts: 3,
    sleep: async () => {},
    idgen: () => "jit_1",
    tokenGenerator: () => "tok_1",
    ...(preimageSource ? { preimageSource } : {}),
  });
  return { svc, node };
}

test("single-node JIT holds A, pays B, derives hold preimage, and settles", async () => {
  const { svc, node } = makeService();
  const order = await svc.createOrder(req());

  assert.equal(order.order_token, "tok_1");
  assert.equal(order.request.hold_hash, linked.hold);
  assert.equal(node.captured.holdInvoiceHash, linked.hold);
  assert.equal(node.captured.holdInvoiceAlgorithm, "sha256");

  const settled = await svc.run(order.jit_order_id);
  assert.equal(settled.state, "settled");
  assert.equal(node.captured.sentInvoice, "fibt_merchant");
  assert.equal(node.captured.settled, `${linked.hold}:${linked.holdPreimage}`);
});

test("fallback reveal settles when get_payment omits the merchant preimage", async () => {
  const { svc, node } = makeService(makeNode({ paymentPreimage: "" }));
  const order = await svc.createOrder(req());

  const afterRun = await svc.run(order.jit_order_id);
  assert.equal(afterRun.state, "forwarding");
  assert.equal(node.captured.settled, "");

  const settled = await svc.reveal(order.jit_order_id, linked.merchantPreimage, "tok_1");
  assert.equal(settled.state, "settled");
  assert.equal(node.captured.settled, `${linked.hold}:${linked.holdPreimage}`);
});

test("observes the paying node before forwarding and settles without merchant reveal", async () => {
  const node = makeNode({ paymentPreimage: "" });
  const lifecycle: string[] = [];
  const originalFetch = node.fetchImpl;
  node.fetchImpl = async (url, init) => {
    const request = JSON.parse(String(init.body)) as { method: string };
    if (request.method === "send_payment") lifecycle.push("send");
    return originalFetch(url, init);
  };
  const source = {
    async observe(paymentHash: string) {
      lifecycle.push("observe");
      assert.equal(paymentHash, linked.merchantPaymentHash);
      return {
        preimage: Promise.resolve(linked.merchantPreimage),
        close() {
          lifecycle.push("close");
        },
      };
    },
  };
  const { svc } = makeService(node, source);

  const settled = await svc.run((await svc.createOrder(req())).jit_order_id);

  assert.equal(settled.state, "settled");
  assert.deepEqual(lifecycle, ["observe", "send", "close"]);
  assert.equal(node.captured.settled, `${linked.hold}:${linked.holdPreimage}`);
});

test("ignores an invalid observed preimage and leaves the reveal fallback available", async () => {
  const node = makeNode({ paymentPreimage: "" });
  const source = {
    async observe() {
      return { preimage: Promise.resolve(other.merchantPreimage), close() {} };
    },
  };
  const { svc } = makeService(node, source);
  const order = await svc.createOrder(req());

  const afterRun = await svc.run(order.jit_order_id);

  assert.equal(afterRun.state, "forwarding");
  assert.equal(node.captured.settled, "");
  assert.equal((await svc.reveal(order.jit_order_id, linked.merchantPreimage, "tok_1")).state, "settled");
});

test("bad early reveal is rejected and does not poison later settlement", async () => {
  const { svc, node } = makeService();
  const order = await svc.createOrder(req());

  await assert.rejects(
    svc.reveal(order.jit_order_id, other.merchantPreimage, "tok_1"),
    (e: JitError) => e.code === "bad_preimage",
  );

  const settled = await svc.run(order.jit_order_id);
  assert.equal(settled.state, "settled");
  assert.equal(node.captured.cancelled, "");
});

test("createOrder rejects invalid proof before minting a hold invoice", async () => {
  const { svc, node } = makeService();
  await assert.rejects(
    svc.createOrder(req({ linkage_proof: exposedSecretProof("0x" + "ff".repeat(32)) })),
    (e: JitError) => e.code === "linkage_invalid",
  );
  assert.ok(!node.calls.includes("new_invoice"));
});

test("createOrder enforces offered asset and capacity limits", async () => {
  const { svc } = makeService();

  await assert.rejects(svc.createOrder(req({ asset: CKB })), (e: JitError) => e.code === "unsupported_asset");
  await assert.rejects(
    svc.createOrder(req({ channel_capacity: "3000000000" })),
    (e: JitError) => e.code === "capacity_too_large",
  );
});

test("createOrder rejects a duplicate active hold or merchant invoice", async () => {
  const { svc } = makeService();
  await svc.createOrder(req());

  await assert.rejects(svc.createOrder(req()), (e: JitError) => e.code === "duplicate_order");
});

test("createOrder rejects (as a 4xx JitError) when the fee exceeds the payment", async () => {
  const node = makeNode();
  const svc = new JitService({
    rpc: new FiberChannelRpcClient({ rpcUrl: "http://node", fetchImpl: node.fetchImpl }),
    terms: { ...terms, fee_base: "100000000", min_payment: "1" }, // flat fee >= the payment
    supportedAssets: [offering],
    linkageVerifier: exposedSecretVerifier,
    sleep: async () => {},
    idgen: () => "jit_1",
    tokenGenerator: () => "tok_1",
  });
  await assert.rejects(
    svc.createOrder(req({ amount: "100000000" })),
    (e: JitError) => e.code === "fee_exceeds_amount",
  );
  assert.ok(!node.calls.includes("new_invoice"), "no hold minted when the fee swallows the payment");
});

test("createOrder rejects a merchant invoice that expires before the hold", async () => {
  const nowSec = 1_000_000;
  const node = makeNode({
    merchantInvoiceTimestamp: "0x" + (BigInt(nowSec) * 1000n).toString(16), // merchant invoice created "now"
    merchantInvoiceExpirySec: "0xa", // valid only 10s → expires long before the ~600s hold
  });
  const svc = new JitService({
    rpc: new FiberChannelRpcClient({ rpcUrl: "http://node", fetchImpl: node.fetchImpl }),
    terms,
    supportedAssets: [offering],
    linkageVerifier: exposedSecretVerifier,
    pollIntervalMs: 0,
    readyPollAttempts: 3,
    sleep: async () => {},
    now: () => nowSec,
    idgen: () => "jit_1",
    tokenGenerator: () => "tok_1",
  });
  await assert.rejects(
    svc.createOrder(req()),
    (e: JitError) => e.code === "merchant_invoice_expiry_too_short",
  );
});

test("run refunds when the on-chain TLC expiry is too close, even though the invoice expiry is not", async () => {
  const nowSec = 1_000_000;
  const node = makeNode({ tlcExpiryMsHex: "0x" + (BigInt(nowSec + 30) * 1000n).toString(16) }); // TLC dies in 30s
  const svc = new JitService({
    rpc: new FiberChannelRpcClient({ rpcUrl: "http://node", fetchImpl: node.fetchImpl }),
    terms,
    supportedAssets: [offering],
    linkageVerifier: exposedSecretVerifier,
    pollIntervalMs: 0,
    readyPollAttempts: 3,
    settleMarginSeconds: 60, // reserve 60s > 30s remaining on the TLC → too close
    sleep: async () => {},
    now: () => nowSec,
    idgen: () => "jit_1",
    tokenGenerator: () => "tok_1",
  });
  const order = await svc.createOrder(req({ expiry_seconds: 600 })); // hold expiry far away (nowSec+600)
  const done = await svc.run(order.jit_order_id);
  assert.equal(done.state, "refunded"); // the TLC ceiling, not the invoice, forced the refund
  assert.equal(node.captured.sentInvoice, "", "merchant invoice never paid");
});

test("resume() re-drives a forwarding order to settlement (crash recovery)", async () => {
  const node = makeNode({ paymentStatuses: ["Success"] });
  const store = new MemoryJitStore();
  const svc = new JitService({
    rpc: new FiberChannelRpcClient({ rpcUrl: "http://node", fetchImpl: node.fetchImpl }),
    terms,
    supportedAssets: [offering],
    linkageVerifier: exposedSecretVerifier,
    store,
    pollIntervalMs: 0,
    readyPollAttempts: 3,
    sleep: async () => {},
    idgen: () => "jit_1",
    tokenGenerator: () => "tok_1",
  });
  const order = await svc.createOrder(req());
  // simulate a crash after the channel opened and the merchant was paid — order left in "forwarding"
  store.put({ ...store.get(order.jit_order_id)!, state: "forwarding", channel_outpoint: "0xout" });

  svc.resume();
  await new Promise((r) => setTimeout(r, 20)); // let the background re-driven run() finish

  assert.equal(svc.getOrder(order.jit_order_id, "tok_1")!.state, "settled");
  assert.equal(node.captured.settled, `${linked.hold}:${linked.holdPreimage}`);
});

test("terms advertise the computed min_expiry_seconds so a merchant can inspect the floor", () => {
  const { svc } = makeService(); // pollIntervalMs 0, readyPollAttempts 3, settleMargin default 60
  assert.equal(svc.terms.min_expiry_seconds, 60); // 2*openBudget(0) + settleMargin(60)
  assert.equal(svc.terms.max_expiry_seconds, terms.max_expiry_seconds);
});

test("JIT fee is pluggable via feeFor (pricing is policy, not mechanism)", async () => {
  const node = makeNode({ merchantInvoiceAmount: "99999995" });
  const svc = new JitService({
    rpc: new FiberChannelRpcClient({ rpcUrl: "http://node", fetchImpl: node.fetchImpl }),
    terms,
    supportedAssets: [offering],
    linkageVerifier: exposedSecretVerifier,
    feeFor: () => 5n, // flat 5-unit fee regardless of the static terms
    pollIntervalMs: 0,
    readyPollAttempts: 3,
    sleep: async () => {},
    idgen: () => "jit_1",
    tokenGenerator: () => "tok_1",
  });
  const order = await svc.createOrder(req({ amount: "100000000" }));
  assert.equal(order.fee, "5");
  assert.equal(order.forward_amount, "99999995");
});

test("concurrent creates with the same merchant payment hash cannot both pass the duplicate guard", async () => {
  const { svc } = makeService();
  const results = await Promise.allSettled([svc.createOrder(req()), svc.createOrder(req())]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  assert.equal(fulfilled.length, 1, "exactly one create wins");
  assert.equal(rejected.length, 1, "the concurrent duplicate is refused");
  assert.equal((rejected[0].reason as JitError).code, "duplicate_order");
});

test("order read and controls require the per-order bearer token", async () => {
  const { svc } = makeService();
  const order = await svc.createOrder(req());

  assert.throws(() => svc.getOrder(order.jit_order_id), (e: JitError) => e.code === "unauthorized");
  assert.throws(() => svc.getOrder(order.jit_order_id, "bad"), (e: JitError) => e.code === "unauthorized");
  assert.equal(svc.getOrder(order.jit_order_id, "tok_1")?.state, "created");

  await assert.rejects(svc.cancel(order.jit_order_id, "bad"), (e: JitError) => e.code === "unauthorized");
});

test("REST API uses canonical JIT route with bearer auth and no linked alias", async () => {
  const node = makeNode();
  const rpc = new FiberChannelRpcClient({ rpcUrl: "http://node", fetchImpl: node.fetchImpl });
  const svc = new JitService({
    rpc,
    terms,
    supportedAssets: [offering],
    linkageVerifier: exposedSecretVerifier,
    pollIntervalMs: 0,
    readyPollAttempts: 3,
    sleep: async () => {},
    idgen: () => "jit_1",
    tokenGenerator: () => "tok_1",
  });
  const lsp = new Lsp({
    rpc,
    lspPubkey: "0xLSP",
    addresses: [],
    supportedAssets: [offering],
    feeModes: ["prepaid"],
  });
  const api = createApi(lsp, { jit: svc });

  const created = await api("POST", "/lsp/v1/jit/orders", req());
  assert.equal(created.status, 201);
  const id = (created.body as { jit_order_id: string }).jit_order_id;

  const missingToken = await api("GET", `/lsp/v1/jit/orders/${id}`);
  assert.equal(missingToken.status, 401);

  const authed = await api("GET", `/lsp/v1/jit/orders/${id}`, undefined, { authorization: "Bearer tok_1" });
  assert.equal(authed.status, 200);

  const linkedAlias = await api("POST", "/lsp/v1/jit/linked/orders", req());
  assert.equal(linkedAlias.status, 404);
});

test("createOrder bumps a too-short hold to cover the open+forward+settle budget", async () => {
  const node = makeNode();
  const svc = new JitService({
    rpc: new FiberChannelRpcClient({ rpcUrl: "http://node", fetchImpl: node.fetchImpl }),
    terms,
    supportedAssets: [offering],
    linkageVerifier: exposedSecretVerifier,
    // open budget = ceil(3 * 1000 / 1000) = 3s; minExpiry = 2*3 + 10 = 16s
    pollIntervalMs: 1000,
    readyPollAttempts: 3,
    settleMarginSeconds: 10,
    sleep: async () => {},
    now: () => 1_000,
    idgen: () => "jit_1",
    tokenGenerator: () => "tok_1",
  });
  // Merchant asks for a reckless 2s hold; the LSP must widen it to the 16s safety floor.
  const order = await svc.createOrder(req({ expiry_seconds: 2 }));
  assert.equal(order.expires_at - order.created_at, 16);
});

test("createOrder refuses when the safe hold cannot fit inside max_expiry_seconds", async () => {
  const node = makeNode();
  const svc = new JitService({
    rpc: new FiberChannelRpcClient({ rpcUrl: "http://node", fetchImpl: node.fetchImpl }),
    // max_expiry 100s is smaller than the minExpiry the open budget demands
    terms: { ...terms, max_expiry_seconds: 100 },
    supportedAssets: [offering],
    linkageVerifier: exposedSecretVerifier,
    pollIntervalMs: 1000,
    readyPollAttempts: 100, // open budget 100s → minExpiry = 210s > 100s
    settleMarginSeconds: 10,
    sleep: async () => {},
    idgen: () => "jit_1",
    tokenGenerator: () => "tok_1",
  });
  await assert.rejects(svc.createOrder(req()), (e: JitError) => e.code === "expiry_unsafe");
  assert.ok(!node.calls.includes("new_invoice"), "no hold minted when no safe expiry exists");
});

test("run refunds instead of paying the merchant when the hold is about to expire", async () => {
  const node = makeNode();
  let clock = 1_000;
  const svc = new JitService({
    rpc: new FiberChannelRpcClient({ rpcUrl: "http://node", fetchImpl: node.fetchImpl }),
    terms,
    supportedAssets: [offering],
    linkageVerifier: exposedSecretVerifier,
    pollIntervalMs: 0,
    readyPollAttempts: 3,
    settleMarginSeconds: 60,
    sleep: async () => {},
    now: () => clock,
    idgen: () => "jit_1",
    tokenGenerator: () => "tok_1",
  });
  // hold created at t=1000 for 600s → expires_at 1600; reserve = 0 + 60 = 60
  const order = await svc.createOrder(req({ expiry_seconds: 600 }));
  // jump to t=1560 so now+reserve (1620) >= expires_at (1600): too close to safely forward
  clock = 1_560;
  const done = await svc.run(order.jit_order_id);
  assert.equal(done.state, "refunded");
  assert.match(done.failure_reason ?? "", /hold lifetime/);
  assert.equal(node.captured.sentInvoice, "", "merchant invoice was never paid");
  assert.equal(node.captured.cancelled, linked.hold, "hold was cancelled so the payer is refunded");
});
