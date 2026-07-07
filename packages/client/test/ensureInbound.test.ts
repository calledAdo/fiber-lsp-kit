import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FiberChannelRpcClient,
  udtAsset,
  type AssetOffering,
  type UdtTypeScript,
} from "@fiberlsp/protocol";
import { Lsp, createApi } from "@fiberlsp/server";
import { makeMockRpc } from "../../lsp-server/test/mockRpc.js";
import {
  InvoiceService,
  LspClient,
  buyInboundFromLsp,
  type HttpFetch,
  type ReceiveReadiness,
} from "@fiberlsp/client";

const RUSD_SCRIPT: UdtTypeScript = {
  code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hash_type: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const RUSD = udtAsset(RUSD_SCRIPT, "RUSD");

/** Stand up the REAL LSP server in-process and expose it as an HttpFetch the LspClient can call. */
function standUpLsp(makeReady: boolean): HttpFetch {
  const mock = makeMockRpc({ lspPubkey: "0xLSP", makeReady });
  const offerings: AssetOffering[] = [
    { asset: RUSD, min_capacity: "10", max_capacity: "1000000", fee_schedule: { base_fee: "1000", proportional_bps: 0 } },
  ];
  const lsp = new Lsp({
    rpc: new FiberChannelRpcClient({ rpcUrl: "http://mock", fetchImpl: mock.fetchImpl }),
    lspPubkey: "0xLSP",
    addresses: [],
    supportedAssets: offerings,
    feeModes: ["prepaid"],
    readyPollAttempts: 1,
    readyPollIntervalMs: 0,
    sleep: async () => {},
    idgen: () => "o",
  });
  const api = createApi(lsp);
  return async (url, init) => {
    const u = new URL(url);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const { status, body: out } = await api(init?.method ?? "GET", u.pathname, body);
    return { status, json: async () => out };
  };
}

function readiness(shortfall: string): ReceiveReadiness {
  return { asset: RUSD, amount: shortfall, inbound: "0", canReceive: false, shortfall };
}

const FAST_WAIT = { attempts: 3, intervalMs: 0, sleep: async () => {} };

test("buyInboundFromLsp buys exactly the shortfall and resolves on channel_active", async () => {
  const lsp = new LspClient({ baseUrl: "http://lsp", fetchImpl: standUpLsp(true) });
  let bought: string | undefined;
  const ensure = buyInboundFromLsp(lsp, {
    feeMode: "prepaid",
    targetPubkey: "0xCLIENT",
    payFee: async (_payment, order) => {
      bought = order.request.lsp_balance; // capture what the order actually requested
    },
    waitOpts: FAST_WAIT,
  });
  await ensure(readiness("500"));
  assert.equal(bought, "500");
});

test("amountFor lets you provision a buffer above the shortfall", async () => {
  const lsp = new LspClient({ baseUrl: "http://lsp", fetchImpl: standUpLsp(true) });
  let bought: string | undefined;
  const ensure = buyInboundFromLsp(lsp, {
    feeMode: "prepaid",
    targetPubkey: "0xCLIENT",
    payFee: async (_p, order) => {
      bought = order.request.lsp_balance;
    },
    amountFor: (shortfall) => (BigInt(shortfall) * 4n).toString(),
    waitOpts: FAST_WAIT,
  });
  await ensure(readiness("500"));
  assert.equal(bought, "2000"); // 4× buffer
});

test("buyInboundFromLsp throws if the order never reaches channel_active", async () => {
  const lsp = new LspClient({ baseUrl: "http://lsp", fetchImpl: standUpLsp(false) }); // channel never readies
  const ensure = buyInboundFromLsp(lsp, {
    feeMode: "prepaid",
    targetPubkey: "0xCLIENT",
    payFee: async () => {},
    waitOpts: { attempts: 2, intervalMs: 0, sleep: async () => {} },
  });
  await assert.rejects(() => ensure(readiness("500")), /did not complete/);
});

test("InvoiceService.receive drives buyInboundFromLsp end-to-end, then issues the invoice", async () => {
  const lsp = new LspClient({ baseUrl: "http://lsp", fetchImpl: standUpLsp(true) });

  // A stateful receiver node: inbound starts at 0 and flips once the LSP delivers the channel.
  const recv = { inbound: 0n };
  const recvFetch = async (_url: string, i: { body?: string }) => {
    const { id, method } = JSON.parse(i.body ?? "{}");
    let result: unknown = null;
    if (method === "list_channels") {
      result = {
        channels:
          recv.inbound > 0n
            ? [
                {
                  channel_id: "0xc",
                  pubkey: "0xLSP",
                  funding_udt_type_script: RUSD_SCRIPT,
                  state: { state_name: "ChannelReady" },
                  local_balance: "0x0",
                  remote_balance: "0x" + recv.inbound.toString(16),
                  enabled: true,
                },
              ]
            : [],
      };
    } else if (method === "new_invoice") {
      result = { invoice_address: "fibt1qshop", invoice: { data: { payment_hash: "0xph" } } };
    }
    return { json: async () => ({ jsonrpc: "2.0", id, result }) };
  };
  const svc = new InvoiceService({
    rpc: new FiberChannelRpcClient({ rpcUrl: "http://recv", fetchImpl: recvFetch }),
  });

  const buy = buyInboundFromLsp(lsp, {
    feeMode: "prepaid",
    targetPubkey: "0xCLIENT",
    payFee: async () => {},
    waitOpts: FAST_WAIT,
  });

  const issued = await svc.receive({
    asset: RUSD,
    amount: "500",
    description: "order#42",
    ensureInbound: async (r) => {
      await buy(r); // real LSP order: createOrder → settle → channel_active
      recv.inbound = 500n; // the delivered channel now shows as the receiver's inbound
    },
  });

  assert.equal(issued.invoice, "fibt1qshop");
  assert.equal(issued.paymentHash, "0xph");
  assert.equal(issued.amount, "500");
});
