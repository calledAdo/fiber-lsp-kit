import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FiberChannelRpcClient,
  udtAsset,
  type GraphNodeInfo,
  type GraphNodesPage,
  type LspInfo,
} from "@fiberlsp/protocol";
import {
  discoverFromGraph,
  discoverProviders,
  type HttpFetch,
  type Registry,
} from "@fiberlsp/client";

const RUSD_SCRIPT = {
  code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hash_type: "type" as const,
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const RUSD = udtAsset(RUSD_SCRIPT, "RUSD");
const OTHER_SCRIPT = { ...RUSD_SCRIPT, args: "0xdeadbeef" };

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

function udtCfg(script: typeof RUSD_SCRIPT, name: string, floorHex?: string) {
  return { name, script, auto_accept_amount: floorHex ?? null, cell_deps: [] };
}

/** A scripted FNN JSON-RPC transport that replays graph_nodes pages in order. */
function graphRpc(pages: GraphNodesPage[]) {
  let call = 0;
  const fetchImpl = async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(init.body ?? "{}");
    const page = pages[call++] ?? { nodes: [], last_cursor: "0x" };
    return { json: async () => ({ jsonrpc: "2.0", id: body.id, result: page }) };
  };
  return new FiberChannelRpcClient({ rpcUrl: "http://mock", fetchImpl });
}

const NODES = [
  node({ pubkey: "0x02aa", udt_cfg_infos: [udtCfg(RUSD_SCRIPT, "RUSD", "0x3e8")] }), // floor 1000
  node({ pubkey: "0x02bb", features: ["LspProvider"], udt_cfg_infos: [udtCfg(RUSD_SCRIPT, "RUSD")] }), // no floor
  node({ pubkey: "0x02cc", udt_cfg_infos: [udtCfg(OTHER_SCRIPT, "OTHER", "0x1")] }), // different UDT
  node({ pubkey: "0x02dd", udt_cfg_infos: [udtCfg(RUSD_SCRIPT, "RUSD", "0x186a0")] }), // floor 100000
];

test("discoverFromGraph finds every node advertising the asset, excluding others", async () => {
  const rows = await discoverFromGraph(graphRpc([{ nodes: NODES, last_cursor: "0x" }]), { asset: RUSD });
  const byKey = Object.fromEntries(rows.map((r) => [r.pubkey, r]));
  assert.deepEqual(Object.keys(byKey).sort(), ["0x02aa", "0x02bb", "0x02dd"]); // not 0x02cc (OTHER)
  assert.equal(byKey["0x02aa"]?.autoAcceptFloor, "1000");
  assert.equal(byKey["0x02bb"]?.autoAcceptFloor, undefined); // capability, no auto-accept floor
  assert.equal(byKey["0x02dd"]?.autoAcceptFloor, "100000");
});

test("minAmount drops nodes whose auto-accept floor exceeds the intended buy", async () => {
  const rows = await discoverFromGraph(graphRpc([{ nodes: NODES, last_cursor: "0x" }]), {
    asset: RUSD,
    minAmount: "5000",
  });
  // 0x02dd's floor (100000) > 5000 → dropped; the floorless node is kept.
  assert.deepEqual(rows.map((r) => r.pubkey).sort(), ["0x02aa", "0x02bb"]);
});

test("requireLspFeature keeps only nodes advertising the LSP flag", async () => {
  const rows = await discoverFromGraph(graphRpc([{ nodes: NODES, last_cursor: "0x" }]), {
    asset: RUSD,
    requireLspFeature: true,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.pubkey, "0x02bb");
  assert.equal(rows[0]?.advertisesLsp, true);
});

test("graphNodesAll paginates until a short page", async () => {
  const rpc = graphRpc([
    { nodes: [NODES[0]!], last_cursor: "0x01" },
    { nodes: [NODES[1]!], last_cursor: "0x02" },
    { nodes: [], last_cursor: "0x" },
  ]);
  const rows = await discoverFromGraph(rpc, { asset: RUSD, pageSize: 1 });
  assert.deepEqual(rows.map((r) => r.pubkey), ["0x02aa", "0x02bb"]);
});

test("discoverProviders merges a registry provider with its graph node by pubkey", async () => {
  const registry: Registry = {
    version: 1,
    providers: [{ name: "A", base_url: "http://a.lsp", chain: "testnet" }],
  };
  const info: LspInfo = {
    lsp_pubkey: "0x02aa", // same node as the graph row → they merge
    addresses: ["/ip4/1.2.3.4/tcp/8228"],
    chain: "testnet",
    supported_assets: [
      { asset: RUSD, min_capacity: "10", max_capacity: "100000", fee_schedule: { base_fee: "1000", proportional_bps: 0 } },
    ],
    fee_modes: ["prepaid"],
    order_expiry_seconds: 3600,
  };
  const httpFetch: HttpFetch = async (url) => {
    if (url === "http://reg/registry.json") return { status: 200, json: async () => registry };
    if (url === "http://a.lsp/lsp/v1/info") return { status: 200, json: async () => info };
    throw new Error(`unexpected ${url}`);
  };

  const resolved = await discoverProviders({
    registryUrl: "http://reg/registry.json",
    rpc: graphRpc([{ nodes: [NODES[0]!], last_cursor: "0x" }]),
    asset: RUSD,
    fetchImpl: httpFetch,
  });

  assert.equal(resolved.length, 1);
  const p = resolved[0]!;
  assert.deepEqual(p.sources.sort(), ["graph", "registry"]);
  assert.equal(p.base_url, "http://a.lsp"); // orderable (from the registry)
  assert.equal(p.reachable, true);
  assert.equal(p.autoAcceptFloor, "1000"); // capability (from the graph)
  assert.ok(p.asset && p.asset.kind === "UDT");
});
