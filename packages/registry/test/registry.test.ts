import { test } from "node:test";
import assert from "node:assert/strict";
import { FiberChannelRpcClient, type GraphNodeInfo, type GraphNodesPage } from "@fiberlsp/fiber";
import {
  discoverFromGraph,
  discoverProviders,
  fetchRegistry,
  type HttpFetch,
  type Registry,
} from "@fiberlsp/registry";
import { udtAsset, type LspInfo } from "@fiberlsp/protocol";

const RUSD_SCRIPT = {
  code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hash_type: "type" as const,
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const RUSD = udtAsset(RUSD_SCRIPT, "RUSD");

function node(over: Partial<GraphNodeInfo> & { pubkey: string }): GraphNodeInfo {
  return {
    node_name: "n",
    version: "0.9",
    addresses: ["/ip4/1.2.3.4/tcp/8228"],
    features: [],
    timestamp: "0x0",
    chain_hash: "0x0",
    auto_accept_min_ckb_funding_amount: "0x0",
    udt_cfg_infos: [],
    ...over,
  };
}

function graphRpc(pages: GraphNodesPage[]) {
  let call = 0;
  const fetchImpl = async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(init.body ?? "{}");
    const page = pages[call++] ?? { nodes: [], last_cursor: "0x" };
    return { json: async () => ({ jsonrpc: "2.0", id: body.id, result: page }) };
  };
  return new FiberChannelRpcClient({ rpcUrl: "http://mock", fetchImpl });
}

test("fetchRegistry loads a static providers file", async () => {
  const registry: Registry = {
    version: 1,
    providers: [{ name: "LSP", base_url: "https://lsp.test", chain: "testnet", lsp_pubkey: "0x02aa" }],
  };
  const fetchImpl: HttpFetch = async () => ({ status: 200, json: async () => registry });

  assert.deepEqual(await fetchRegistry("https://example.test/providers.json", fetchImpl), registry);
});

test("discoverFromGraph finds UDT-capable nodes and applies minAmount floors", async () => {
  const rows = await discoverFromGraph(
    graphRpc([
      {
        last_cursor: "0x",
        nodes: [
          node({
            pubkey: "0x02aa",
            udt_cfg_infos: [{ name: "RUSD", script: RUSD_SCRIPT, auto_accept_amount: "0x3e8", cell_deps: [] }],
          }),
          node({
            pubkey: "0x02bb",
            udt_cfg_infos: [{ name: "RUSD", script: RUSD_SCRIPT, auto_accept_amount: "0x186a0", cell_deps: [] }],
          }),
        ],
      },
    ]),
    { asset: RUSD, minAmount: "5000" },
  );

  assert.deepEqual(rows.map((r) => r.pubkey), ["0x02aa"]);
  assert.equal(rows[0]?.autoAcceptFloor, "1000");
});

test("discoverProviders merges registry and graph by lsp_pubkey", async () => {
  const info: LspInfo = {
    lsp_pubkey: "0x02aa",
    addresses: ["/ip4/1.2.3.4/tcp/8228"],
    chain: "testnet",
    supported_assets: [],
    fee_modes: ["prepaid"],
    order_expiry_seconds: 600,
  };
  const registry: Registry = {
    version: 1,
    providers: [{ name: "LSP", base_url: "https://lsp.test", chain: "testnet", lsp_pubkey: "0x02aa" }],
  };
  const fetchImpl: HttpFetch = async (url) => {
    if (url.endsWith("/lsp/v1/info")) return { status: 200, json: async () => info };
    return { status: 200, json: async () => registry };
  };
  const rpc = graphRpc([
    {
      last_cursor: "0x",
      nodes: [
        node({
          pubkey: "0x02aa",
          features: ["LspProvider"],
          udt_cfg_infos: [{ name: "RUSD", script: RUSD_SCRIPT, auto_accept_amount: "0x1", cell_deps: [] }],
        }),
      ],
    },
  ]);

  const providers = await discoverProviders({ registryUrl: "https://example.test/providers.json", rpc, fetchImpl, asset: RUSD });

  assert.equal(providers.length, 1);
  assert.deepEqual(providers[0]?.sources.sort(), ["graph", "registry"]);
  assert.equal(providers[0]?.base_url, "https://lsp.test");
  assert.equal(providers[0]?.reachable, true);
});
