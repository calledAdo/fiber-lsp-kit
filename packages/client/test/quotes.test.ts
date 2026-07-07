import { test } from "node:test";
import assert from "node:assert/strict";
import { udtAsset, CKB, type AssetOffering } from "@fiberlsp/protocol";
import { FiberChannelRpcClient } from "@fiberlsp/fiber";
import { Lsp, createApi } from "@fiberlsp/server";
import { makeMockRpc } from "../../lsp-server/test/mockRpc.js";
import { compareQuotes, bestQuote, type HttpFetch, type RegistryProvider } from "@fiberlsp/client";

const RUSD = udtAsset(
  {
    code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
    hash_type: "type",
    args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
  },
  "RUSD",
);

function handleFor(baseFee: string) {
  const mock = makeMockRpc({ lspPubkey: "0xLSP", makeReady: true });
  const offerings: AssetOffering[] = [
    { asset: RUSD, min_capacity: "10", max_capacity: "1000000", fee_schedule: { base_fee: baseFee, proportional_bps: 0 } },
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
  return createApi(lsp);
}

// Two LSPs at different prices, routed by hostname through one fetch impl.
const handles: Record<string, ReturnType<typeof createApi>> = {
  "a.lsp": handleFor("2000"), // pricier
  "b.lsp": handleFor("1000"), // cheaper
};
const fetchImpl: HttpFetch = async (url, init) => {
  const u = new URL(url);
  const handle = handles[u.hostname];
  if (!handle) throw new Error(`unreachable: ${u.hostname}`);
  const body = init?.body ? JSON.parse(init.body) : undefined;
  const { status, body: out } = await handle(init?.method ?? "GET", u.pathname, body);
  return { status, json: async () => out };
};

const providers: RegistryProvider[] = [
  { name: "A", base_url: "http://a.lsp", chain: "testnet" },
  { name: "B", base_url: "http://b.lsp", chain: "testnet" },
  { name: "Down", base_url: "http://down.lsp", chain: "testnet" }, // unreachable
];

test("compareQuotes ranks reachable LSPs cheapest-first and flags the unreachable one", async () => {
  const ranked = await compareQuotes(providers, { asset: RUSD, amount: "100000", feeMode: "prepaid" }, fetchImpl);
  assert.equal(ranked.length, 3);
  assert.equal(ranked[0]?.provider.name, "B"); // cheaper base_fee
  assert.equal(ranked[0]?.fee?.total_fee, "1000");
  assert.equal(ranked[1]?.provider.name, "A");
  assert.equal(ranked[1]?.fee?.total_fee, "2000");
  // the unreachable provider sorts last, has no fee, and is marked
  assert.equal(ranked[2]?.provider.name, "Down");
  assert.equal(ranked[2]?.reachable, false);
  assert.equal(ranked[2]?.fee, undefined);
});

test("bestQuote returns the single cheapest servable provider", async () => {
  const best = await bestQuote(providers, { asset: RUSD, amount: "100000", feeMode: "prepaid" }, fetchImpl);
  assert.equal(best?.provider.name, "B");
  assert.equal(best?.fee?.total_fee, "1000");
});

test("a request no LSP can serve yields errors and no best quote", async () => {
  // CKB not offered by either LSP → both reachable but 'asset not offered'
  const ranked = await compareQuotes(providers, { asset: CKB, amount: "100000", feeMode: "prepaid" }, fetchImpl);
  const servable = ranked.filter((q) => q.fee);
  assert.equal(servable.length, 0);
  const reachableWithError = ranked.filter((q) => q.reachable && q.error === "asset not offered");
  assert.equal(reachableWithError.length, 2);
  const best = await bestQuote(providers, { asset: CKB, amount: "100000", feeMode: "prepaid" }, fetchImpl);
  assert.equal(best, undefined);
});
