import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exposedSecretProof,
  exposedSecretVerifier,
  sameHashLink,
  udtAsset,
  type AssetOffering,
  type CreateJitOrderRequest,
  type JitTerms,
} from "@fiberlsp/protocol";
import { FiberChannelRpcClient, type FetchLike } from "@fiberlsp/fiber";
import { JitError, JitService } from "@fiberlsp/server";

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
const link = sameHashLink(S);

function req(over: Partial<CreateJitOrderRequest> = {}): CreateJitOrderRequest {
  return {
    target_pubkey: "0xMERCHANT",
    target_address: "/ip4/127.0.0.1/tcp/9999",
    asset: RUSD,
    mode: "same_hash",
    hold_hash: link.hash,
    merchant_payment_hash: link.hash,
    merchant_invoice: "fibt_merchant",
    amount: "100000000",
    ...over,
  };
}

/** The hold node: mints, watches, settles and cancels the customer's hold invoice. It never pays. */
function makeHoldNode(over: { paymentPreimage?: string } = {}) {
  void over;
  const calls: string[] = [];
  const captured = { holdInvoiceHash: "", settled: "", cancelled: "" };
  const fetchImpl: FetchLike = async (_url, init) => {
    const { method, params } = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
    const p0 = (params[0] ?? {}) as Record<string, unknown>;
    calls.push(method);
    let result: unknown = null;
    switch (method) {
      case "new_invoice":
        captured.holdInvoiceHash = String(p0.payment_hash);
        result = { invoice_address: "fibt_hold", invoice: { data: { payment_hash: p0.payment_hash } } };
        break;
      case "parse_invoice":
        result = { invoice: { amount: "99000000", data: { payment_hash: link.hash } } };
        break;
      case "get_invoice":
        result = { status: "Received" };
        break;
      case "list_channels":
        result = { channels: [] };
        break;
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

/** The paying node: funds the JIT channel and pays the merchant invoice. It never holds. */
function makePayNode(over: { paymentPreimage?: string } = {}) {
  let opened = false;
  const calls: string[] = [];
  const captured = { openedFunding: "", sentInvoice: "" };
  const paymentStatuses = ["none", "Success"];
  const fetchImpl: FetchLike = async (_url, init) => {
    const { method, params } = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
    const p0 = (params[0] ?? {}) as Record<string, unknown>;
    calls.push(method);
    let result: unknown = null;
    switch (method) {
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
                  enabled: true,
                },
              ]
            : [],
        };
        break;
      case "send_payment":
        captured.sentInvoice = String(p0.invoice);
        result = { payment_hash: link.hash, status: "Created" };
        break;
      case "get_payment": {
        const status = paymentStatuses.length > 1 ? paymentStatuses.shift()! : paymentStatuses[0]!;
        if (status === "none") {
          return { json: async () => ({ jsonrpc: "2.0", id: 1, error: { message: "payment not found" } }) };
        }
        result = {
          payment_hash: link.hash,
          status,
          fee: "0x0",
          payment_preimage: over.paymentPreimage ?? link.preimage,
        };
        break;
      }
    }
    return { json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
  return { fetchImpl, calls, captured };
}

function makeService(opts: { linked?: boolean; twoNode?: boolean; payPreimage?: string } = {}) {
  const hold = makeHoldNode();
  const pay = makePayNode(opts.payPreimage === undefined ? {} : { paymentPreimage: opts.payPreimage });
  const svc = new JitService({
    rpc: new FiberChannelRpcClient({ rpcUrl: "http://hold", fetchImpl: hold.fetchImpl }),
    ...(opts.twoNode === false
      ? {}
      : { payRpc: new FiberChannelRpcClient({ rpcUrl: "http://pay", fetchImpl: pay.fetchImpl }) }),
    terms,
    supportedAssets: [offering],
    ...(opts.linked === false ? {} : { linkageVerifier: exposedSecretVerifier }),
    pollIntervalMs: 0,
    readyPollAttempts: 3,
    sleep: async () => {},
    idgen: () => "jit_1",
    tokenGenerator: () => "tok_1",
  });
  return { svc, hold, pay };
}

test("same_hash JIT settles the hold with the merchant preimage itself — no proof anywhere", async () => {
  const { svc, hold, pay } = makeService({ linked: false });

  assert.deepEqual(svc.modes, ["same_hash"]);
  const order = await svc.createOrder(req());
  assert.equal(order.request.mode, "same_hash");
  assert.equal(hold.captured.holdInvoiceHash, link.hash);

  const settled = await svc.run(order.jit_order_id);
  assert.equal(settled.state, "settled");

  // The hold settles with S, the very preimage the merchant used for its own invoice.
  assert.equal(hold.captured.settled, `${link.hash}:${link.preimage}`);
  assert.equal(pay.captured.sentInvoice, "fibt_merchant");
});

test("same_hash puts the channel open and the merchant payment on the paying node, the hold on the other", async () => {
  const { svc, hold, pay } = makeService({ linked: false });
  await svc.run((await svc.createOrder(req())).jit_order_id);

  assert.ok(pay.calls.includes("open_channel"), "paying node must fund the channel");
  assert.ok(pay.calls.includes("send_payment"), "paying node must pay the merchant invoice");
  assert.ok(!hold.calls.includes("open_channel"), "hold node must not open the channel");
  assert.ok(!hold.calls.includes("send_payment"), "hold node must not pay the merchant invoice");

  assert.ok(hold.calls.includes("new_invoice"), "hold node must mint the hold invoice");
  assert.ok(hold.calls.includes("settle_invoice"), "hold node must settle the hold invoice");
  assert.ok(!pay.calls.includes("new_invoice"), "paying node must not mint the hold invoice");
});

test("same_hash needs no linkage_proof, and does not mind one being absent", async () => {
  const { svc } = makeService({ linked: false });
  const order = await svc.createOrder(req()); // no linkage_proof field at all
  assert.equal(order.state, "created");
});

test("same_hash refuses hashes that differ", async () => {
  const { svc, hold } = makeService({ linked: false });
  await assert.rejects(
    svc.createOrder(req({ hold_hash: "0x" + "11".repeat(32) })),
    (e: JitError) => e.code === "hash_mismatch",
  );
  assert.ok(!hold.calls.includes("new_invoice"), "must reject before minting a hold invoice");
});

test("linked refuses hashes that coincide — one node cannot hold and pay the same hash", async () => {
  const { svc } = makeService();
  await assert.rejects(
    svc.createOrder(req({ mode: "linked", linkage_proof: exposedSecretProof(S) })),
    (e: JitError) => e.code === "hash_mismatch",
  );
});

test("linked refuses a missing proof", async () => {
  const { svc } = makeService();
  await assert.rejects(
    svc.createOrder(req({ mode: "linked", hold_hash: "0x" + "11".repeat(32) })),
    (e: JitError) => e.code === "missing_linkage_proof",
  );
});

test("a single-node LSP does not offer same_hash, and says so", async () => {
  const { svc } = makeService({ twoNode: false });
  assert.deepEqual(svc.modes, ["linked"]);
  assert.deepEqual(svc.terms.modes, ["linked"]);
  await assert.rejects(svc.createOrder(req()), (e: JitError) => e.code === "unsupported_mode");
});

test("a two-node LSP with a verification key advertises both modes", () => {
  const { svc } = makeService();
  assert.deepEqual(svc.modes, ["linked", "same_hash"]);
  assert.deepEqual(svc.terms.modes, ["linked", "same_hash"]);
});

test("JitService refuses to run with neither a verifier nor a paying node", () => {
  assert.throws(
    () =>
      new JitService({
        rpc: new FiberChannelRpcClient({ rpcUrl: "http://hold", fetchImpl: makeHoldNode().fetchImpl }),
        terms,
        supportedAssets: [offering],
      }),
    /linkageVerifier .* or a distinct payRpc/,
  );
});

test("JitService refuses a paying node that is the hold node", () => {
  const rpc = new FiberChannelRpcClient({ rpcUrl: "http://hold", fetchImpl: makeHoldNode().fetchImpl });
  assert.throws(
    () => new JitService({ rpc, payRpc: rpc, terms, supportedAssets: [offering] }),
    /must be a different node/,
  );
});

test("same_hash refunds rather than settle when the paying node returns a preimage that is not S", async () => {
  const { svc, hold } = makeService({ linked: false, payPreimage: "0x" + "ee".repeat(32) });
  const out = await svc.run((await svc.createOrder(req())).jit_order_id);

  assert.equal(out.state, "refunded");
  assert.equal(hold.captured.settled, "", "hold must never settle on a preimage that does not open it");
  assert.equal(hold.captured.cancelled, link.hash);
});
