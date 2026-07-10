import { test } from "node:test";
import assert from "node:assert/strict";
import {
  udtAsset,
  CKB,
  type AssetOffering,
} from "@fiberlsp/protocol";
import { FiberChannelRpcClient } from "@fiberlsp/fiber";
import { Lsp, PrepaidService, createApi } from "@fiberlsp/server";
import { makeMockRpc } from "../../lsp-server/test/mockRpc.js";
import { LspClient, type HttpFetch } from "@fiberlsp/client";

const RUSD = udtAsset(
  {
    code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
    hash_type: "type",
    args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
  },
  "RUSD",
);

const offerings: AssetOffering[] = [
  {
    asset: RUSD,
    min_capacity: "10",
    max_capacity: "1000000",
    fee_schedule: { base_fee: "1000", proportional_bps: 0 },
  },
];

/** Wire the client's HTTP layer straight to the in-process API dispatcher — full stack, no socket. */
function inProcessClient() {
  const mock = makeMockRpc({ lspPubkey: "0xLSP", makeReady: true });
  const rpc = new FiberChannelRpcClient({ rpcUrl: "http://mock", fetchImpl: mock.fetchImpl });
  const lsp = new Lsp({
    rpc,
    lspPubkey: "0xLSP",
    addresses: ["/ip4/127.0.0.1/tcp/8228"],
    supportedAssets: offerings,
    feeModes: ["prepaid"],
  });
  const prepaid = new PrepaidService({
    rpc,
    lspPubkey: "0xLSP",
    supportedAssets: offerings,
    feeModes: ["prepaid"],
    readyPollAttempts: 2,
    readyPollIntervalMs: 0,
    sleep: async () => {},
    idgen: (() => {
      let n = 0;
      return () => `order_${++n}`;
    })(),
  });
  const handle = createApi(lsp, { prepaid });
  const fetchImpl: HttpFetch = async (url, init) => {
    const path = new URL(url, "http://lsp").pathname;
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const { status, body: out } = await handle(init?.method ?? "GET", path, body);
    return { status, json: async () => out };
  };
  return new LspClient({ baseUrl: "http://lsp", fetchImpl });
}

test("client getInfo returns the LSP's offering", async () => {
  const client = inProcessClient();
  const info = await client.getInfo();
  assert.equal(info.lsp_pubkey, "0xLSP");
  assert.equal(info.supported_assets[0]?.asset.kind, "UDT");
  assert.ok(info.fee_modes.includes("prepaid"));
});

test("buyInboundLiquidity: full prepaid RUSD flow ends channel_active", async () => {
  const client = inProcessClient();
  const paidInvoices: string[] = [];
  const order = await client.buyInboundLiquidity({
    asset: RUSD,
    amount: "100000",
    feeMode: "prepaid",
    targetPubkey: "0xCLIENT",
    targetAddress: "/ip4/127.0.0.1/tcp/8238",
    waitOpts: { attempts: 2, intervalMs: 0, sleep: async () => {} },
    payFee: async (payment) => {
      if (payment.mode === "prepaid") paidInvoices.push(payment.fee_invoice);
    },
  });
  assert.equal(order.state, "channel_active");
  assert.equal(order.channel_outpoint, "0xoutpoint:0");
  assert.equal(paidInvoices.length, 1);
  assert.match(paidInvoices[0] ?? "", /^fibt_fee_/);
});

test("client surfaces LSP validation errors as LspApiError", async () => {
  const client = inProcessClient();
  await assert.rejects(
    () =>
      client.createOrder({
        target_pubkey: "0xC",
        asset: RUSD,
        lsp_balance: "1", // below min
        fee_mode: "prepaid",
      }),
    (e: unknown) => e instanceof Error && e.name === "LspApiError",
  );
});
