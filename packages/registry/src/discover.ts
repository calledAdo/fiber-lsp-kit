import {
  type Asset,
  type LspInfo,
} from "@fiberlsp/protocol";
import type { FiberChannelRpcClient } from "@fiberlsp/fiber";
import {
  fetchRegistry,
  type HttpFetch,
  type RegistryProvider,
} from "./registry.js";
import {
  discoverFromGraph,
  type GraphDiscoverOptions,
  type GraphProvider,
} from "./graph.js";

export interface DiscoveredProvider extends RegistryProvider {
  info?: LspInfo;
  reachable: boolean;
}

export interface ResolvedProvider {
  sources: Array<"graph" | "registry">;
  name: string;
  pubkey?: string;
  base_url?: string;
  addresses?: string[];
  asset?: Asset;
  autoAcceptFloor?: string;
  advertisesLsp?: boolean;
  info?: LspInfo;
  reachable?: boolean;
}

export interface DiscoverProvidersOptions {
  registryUrl?: string;
  rpc?: FiberChannelRpcClient;
  asset?: Asset;
  minAmount?: string | bigint;
  resolveEndpoint?: (g: GraphProvider) => string | undefined;
  graph?: Omit<GraphDiscoverOptions, "asset" | "minAmount">;
  fetchImpl?: HttpFetch;
}

async function tryGetInfo(baseUrl: string, fetchImpl?: HttpFetch): Promise<LspInfo | undefined> {
  const f = fetchImpl ?? (globalThis.fetch as unknown as HttpFetch);
  try {
    const res = await f(baseUrl.replace(/\/+$/, "") + "/lsp/v1/info", { method: "GET" });
    if (res.status >= 400) return undefined;
    return (await res.json()) as LspInfo;
  } catch {
    return undefined;
  }
}

export async function discover(
  registryUrl: string,
  fetchImpl?: HttpFetch,
): Promise<DiscoveredProvider[]> {
  const registry = await fetchRegistry(registryUrl, fetchImpl);
  return Promise.all(
    registry.providers.map(async (p) => {
      const info = await tryGetInfo(p.base_url, fetchImpl);
      return { ...p, info, reachable: info !== undefined };
    }),
  );
}

function normPubkey(s: string | undefined): string | undefined {
  return s ? s.toLowerCase().replace(/^0x/, "") : undefined;
}

export async function discoverProviders(
  opts: DiscoverProvidersOptions,
): Promise<ResolvedProvider[]> {
  const [graphRows, registry] = await Promise.all([
    opts.rpc
      ? discoverFromGraph(opts.rpc, { ...opts.graph, asset: opts.asset, minAmount: opts.minAmount })
      : Promise.resolve([] as GraphProvider[]),
    opts.registryUrl
      ? fetchRegistry(opts.registryUrl, opts.fetchImpl).then((r) => r.providers)
      : Promise.resolve([] as RegistryProvider[]),
  ]);

  const byKey = new Map<string, ResolvedProvider>();

  await Promise.all(
    registry.map(async (p) => {
      const info = await tryGetInfo(p.base_url, opts.fetchImpl);
      const pubkey = info?.lsp_pubkey ?? p.lsp_pubkey;
      const key = normPubkey(pubkey) ?? `url:${p.base_url}`;
      byKey.set(key, {
        sources: ["registry"],
        name: p.name,
        pubkey,
        base_url: p.base_url,
        addresses: info?.addresses,
        info,
        reachable: info !== undefined,
      });
    }),
  );

  for (const g of graphRows) {
    const key = normPubkey(g.pubkey) ?? `node:${g.pubkey}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.sources.includes("graph")) existing.sources.push("graph");
      existing.asset ??= g.asset;
      existing.autoAcceptFloor ??= g.autoAcceptFloor;
      existing.advertisesLsp = g.advertisesLsp;
      existing.addresses ??= g.addresses;
      continue;
    }
    const base_url = opts.resolveEndpoint?.(g);
    const info = base_url ? await tryGetInfo(base_url, opts.fetchImpl) : undefined;
    byKey.set(key, {
      sources: ["graph"],
      name: g.node_name || g.pubkey,
      pubkey: g.pubkey,
      base_url,
      addresses: g.addresses,
      asset: g.asset,
      autoAcceptFloor: g.autoAcceptFloor,
      advertisesLsp: g.advertisesLsp,
      info,
      reachable: base_url ? info !== undefined : undefined,
    });
  }

  return [...byKey.values()].sort(orderableReachableFirst);
}

function rank(p: ResolvedProvider): number {
  if (p.base_url && p.reachable) return 0;
  if (p.base_url) return 1;
  return 2;
}

function orderableReachableFirst(a: ResolvedProvider, b: ResolvedProvider): number {
  return rank(a) - rank(b);
}
