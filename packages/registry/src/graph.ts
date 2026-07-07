import {
  type Asset,
  asBig,
  canonicalAssetId,
  udtAsset,
} from "@fiberlsp/protocol";
import type { FiberChannelRpcClient, GraphNodeInfo } from "@fiberlsp/fiber";

export interface GraphProvider {
  pubkey: string;
  node_name: string;
  addresses: string[];
  asset: Asset;
  autoAcceptFloor?: string;
  features: string[];
  advertisesLsp: boolean;
}

export interface GraphDiscoverOptions {
  asset?: Asset;
  minAmount?: string | bigint;
  requireLspFeature?: boolean;
  lspFeatureName?: string;
  includeCkb?: boolean;
  pageSize?: number;
  maxNodes?: number;
}

const DEFAULT_LSP_FEATURE = "lsp";

function nodeAdvertisesLsp(node: GraphNodeInfo, marker: string): boolean {
  const needle = marker.toLowerCase();
  return node.features.some((f) => f.toLowerCase().includes(needle));
}

function floorToDecimal(v: string | null | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  return asBig(v).toString(10);
}

export async function discoverFromGraph(
  rpc: FiberChannelRpcClient,
  opts: GraphDiscoverOptions = {},
): Promise<GraphProvider[]> {
  const nodes = await rpc.graphNodesAll({ pageSize: opts.pageSize, maxNodes: opts.maxNodes });
  const marker = opts.lspFeatureName ?? DEFAULT_LSP_FEATURE;
  const wantId = opts.asset ? canonicalAssetId(opts.asset) : undefined;
  const wantCkb = opts.asset?.kind === "CKB";
  const includeCkb = opts.includeCkb || wantCkb;
  const min = opts.minAmount !== undefined ? asBig(opts.minAmount) : undefined;

  const withinFloor = (floor: string | undefined): boolean =>
    min === undefined || floor === undefined || asBig(floor) <= min;

  const rows: GraphProvider[] = [];
  for (const node of nodes) {
    const advertisesLsp = nodeAdvertisesLsp(node, marker);
    if (opts.requireLspFeature && !advertisesLsp) continue;

    const base = {
      pubkey: node.pubkey,
      node_name: node.node_name,
      addresses: node.addresses,
      features: node.features,
      advertisesLsp,
    };

    if (includeCkb && (!opts.asset || wantCkb)) {
      const floorBig = asBig(node.auto_accept_min_ckb_funding_amount);
      if (floorBig > 0n) {
        const floor = floorBig.toString(10);
        if (withinFloor(floor)) rows.push({ ...base, asset: { kind: "CKB" }, autoAcceptFloor: floor });
      }
    }

    if (!wantCkb) {
      for (const udt of node.udt_cfg_infos) {
        const asset = udtAsset(
          { code_hash: udt.script.code_hash, hash_type: udt.script.hash_type, args: udt.script.args },
          udt.name,
        );
        if (wantId !== undefined && canonicalAssetId(asset) !== wantId) continue;
        const floor = floorToDecimal(udt.auto_accept_amount);
        if (!withinFloor(floor)) continue;
        rows.push({ ...base, asset, autoAcceptFloor: floor });
      }
    }
  }
  return rows;
}
