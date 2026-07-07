import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CKB,
  FiberChannelRpcClient,
  dualSha256,
  exposedSecretProof,
  exposedSecretVerifier,
  udtAsset,
  type AssetOffering,
  type CreateJitOrderRequest,
  type FetchLike,
  type JitTerms,
} from "@fiberlsp/protocol";
import { createApi, JitError, JitService, Lsp } from "@fiberlsp/server";

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
    leg_hash: linked.leg,
    merchant_invoice: "fibt_leg",
    linkage_proof: exposedSecretProof(S),
    amount: "100000000",
    ...over,
  };
}

function makeNode(
  over: {
    legHash?: string;
    legAmount?: string;
    paymentPreimage?: string;
    paymentStatuses?: string[];
    holdStatuses?: string[];
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
            amount: over.legAmount ?? "99000000",
            data: { payment_hash: over.legHash ?? linked.leg },
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
                  enabled: true,
                },
              ]
            : [],
        };
        break;
      case "send_payment":
        captured.sentInvoice = String(p0.invoice);
        result = { payment_hash: linked.leg, status: "Created" };
        break;
      case "get_payment": {
        const status = next(paymentStatuses);
        if (status === "none") {
          return { json: async () => ({ jsonrpc: "2.0", id: 1, error: { message: "payment not found" } }) };
        }
        result = {
          payment_hash: linked.leg,
          status,
          fee: "0x0",
          ...(over.paymentPreimage === undefined ? { payment_preimage: linked.legPreimage } : {}),
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

function makeService(node = makeNode()) {
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
  assert.equal(node.captured.sentInvoice, "fibt_leg");
  assert.equal(node.captured.settled, `${linked.hold}:${linked.holdPreimage}`);
});

test("fallback reveal settles when get_payment omits the leg preimage", async () => {
  const { svc, node } = makeService(makeNode({ paymentPreimage: "" }));
  const order = await svc.createOrder(req());

  const afterRun = await svc.run(order.jit_order_id);
  assert.equal(afterRun.state, "forwarding");
  assert.equal(node.captured.settled, "");

  const settled = await svc.reveal(order.jit_order_id, linked.legPreimage, "tok_1");
  assert.equal(settled.state, "settled");
  assert.equal(node.captured.settled, `${linked.hold}:${linked.holdPreimage}`);
});

test("bad early reveal is rejected and does not poison later settlement", async () => {
  const { svc, node } = makeService();
  const order = await svc.createOrder(req());

  await assert.rejects(
    svc.reveal(order.jit_order_id, other.legPreimage, "tok_1"),
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

test("createOrder rejects duplicate active hold, leg, or merchant invoice", async () => {
  const { svc } = makeService();
  await svc.createOrder(req());

  await assert.rejects(svc.createOrder(req()), (e: JitError) => e.code === "duplicate_order");
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
