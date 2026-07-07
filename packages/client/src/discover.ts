/**
 * Provider discovery — two sources the caller uses together or apart.
 *
 *  1. A static **open registry** (`fetchRegistry` / `discover`) — a phonebook of LSP REST endpoints. This is
 *     the **practical default**: it carries the endpoint (which the graph does not), so a wallet can fetch
 *     `/info` and place an order immediately, with no graph scan.
 *
 *  2. The **gossip network graph** (`discoverFromGraph`) — the **more authentic** signal: every Fiber node
 *     broadcasts which assets it will auto-accept and the minimum, on-chain-verifiable and registry-free
 *     (FNN's own opener reads it). It carries no REST endpoint yet, so today it sits under the registry as a
 *     trust/verification layer rather than the ordering path.
 *
 * `discoverProviders` unions the two: the registry says *where to order*, the graph confirms *who can*, and a
 * live `/lsp/v1/info` fetch says *at what price*. As nodes advertise an LSP endpoint natively (see
 * docs/upstream-fiber-findings.md), the graph subsumes the registry.
 */
import {
  type Asset,
  type GraphNodeInfo,
  type LspInfo,
  FiberChannelRpcClient,
  asBig,
  canonicalAssetId,
  udtAsset,
} from "@fiberlsp/protocol";
import { LspClient, type HttpFetch } from "./LspClient.js";

export interface RegistryProvider {
  name: string;
  base_url: string;
  chain: string;
  operator?: string;
  note?: string;
}

export interface Registry {
  version: number;
  providers: RegistryProvider[];
}

export async function fetchRegistry(url: string, fetchImpl?: HttpFetch): Promise<Registry> {
  const f = fetchImpl ?? (globalThis.fetch as unknown as HttpFetch);
  const res = await f(url);
  return (await res.json()) as Registry;
}

export interface DiscoveredProvider extends RegistryProvider {
  info?: LspInfo;
  reachable: boolean;
}

/** Fetch the registry and query each provider's live /info (best-effort; unreachable ones are marked). */
export async function discover(
  registryUrl: string,
  fetchImpl?: HttpFetch,
): Promise<DiscoveredProvider[]> {
  const registry = await fetchRegistry(registryUrl, fetchImpl);
  return Promise.all(
    registry.providers.map(async (p) => {
      try {
        const info = await new LspClient({ baseUrl: p.base_url, fetchImpl }).getInfo();
        return { ...p, info, reachable: true };
      } catch {
        return { ...p, reachable: false };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Graph-native discovery
// ---------------------------------------------------------------------------

/** A capability row derived from one node's graph announcement, for a single asset it supports. */
export interface GraphProvider {
  pubkey: string;
  node_name: string;
  /** Reachable p2p multiaddrs (transport, not a REST endpoint). */
  addresses: string[];
  /** The asset this row advertises support for. */
  asset: Asset;
  /** The node's advertised auto-accept minimum for this asset (base units, decimal), if any. */
  autoAcceptFloor?: string;
  /** Feature names the node advertises. */
  features: string[];
  /** True if the node lights the (proposed) LSP-provider feature — an explicit "I sell inbound" signal. */
  advertisesLsp: boolean;
}

export interface GraphDiscoverOptions {
  /** Restrict to nodes advertising support for this asset. Omit to return every UDT-capable row. */
  asset?: Asset;
  /**
   * The inbound amount you intend to buy (base units). Drops nodes whose advertised auto-accept floor is
   * above it, since they wouldn't auto-accept a channel that small. Nodes with no advertised floor are kept.
   */
  minAmount?: string | bigint;
  /** Only return nodes advertising the LSP-provider feature. Default false (graph has no such flag yet). */
  requireLspFeature?: boolean;
  /** Substring that marks the LSP-provider feature name (case-insensitive). Default "lsp". */
  lspFeatureName?: string;
  /** Also emit CKB-capability rows (nodes with CKB auto-accept enabled). Implied when `asset` is CKB. */
  includeCkb?: boolean;
  pageSize?: number;
  maxNodes?: number;
}

const DEFAULT_LSP_FEATURE = "lsp";

function nodeAdvertisesLsp(node: GraphNodeInfo, marker: string): boolean {
  const needle = marker.toLowerCase();
  return node.features.some((f) => f.toLowerCase().includes(needle));
}

/** hex/decimal → decimal string, or undefined when the value is absent. */
function floorToDecimal(v: string | null | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  return asBig(v).toString(10);
}

/**
 * Scan the gossip graph for nodes that can serve inbound liquidity — no registry, no central host.
 *
 * Returns one row per (node, matching asset). This is a *capability* view: it tells you a node speaks the
 * asset and what it will auto-accept, which is necessary for an LSP but not proof it sells inbound at a
 * price. Pair it with `/info` (via `discoverProviders`) to get the commercial offer.
 */
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

    // CKB capability: a non-zero minimum means CKB auto-accept is enabled.
    if (includeCkb && (!opts.asset || wantCkb)) {
      const floorBig = asBig(node.auto_accept_min_ckb_funding_amount);
      if (floorBig > 0n) {
        const floor = floorBig.toString(10);
        if (withinFloor(floor)) rows.push({ ...base, asset: { kind: "CKB" }, autoAcceptFloor: floor });
      }
    }

    // UDT capability: one row per configured UDT (filtered to the requested asset if given).
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

// ---------------------------------------------------------------------------
// Merged discovery (graph ∪ registry)
// ---------------------------------------------------------------------------

/** A provider resolved from one or both sources, enriched with its live offer where reachable. */
export interface ResolvedProvider {
  /** Which source(s) surfaced this provider. */
  sources: Array<"graph" | "registry">;
  name: string;
  pubkey?: string;
  /** REST endpoint, if known (from the registry or an endpoint resolver). */
  base_url?: string;
  /** p2p multiaddrs (from the graph announcement or the LSP's /info). */
  addresses?: string[];
  /** Graph-advertised asset capability, when discovered by asset. */
  asset?: Asset;
  autoAcceptFloor?: string;
  advertisesLsp?: boolean;
  /** Live /lsp/v1/info, when an endpoint was known and reachable. */
  info?: LspInfo;
  reachable?: boolean;
}

export interface DiscoverProvidersOptions {
  /** URL of the open registry (the endpoint phonebook). Optional. */
  registryUrl?: string;
  /** A connected FNN RPC client used to read the gossip graph. Optional. */
  rpc?: FiberChannelRpcClient;
  /** Restrict discovery to this asset. */
  asset?: Asset;
  /** Inbound amount you intend to buy — prunes graph nodes whose auto-accept floor exceeds it. */
  minAmount?: string | bigint;
  /**
   * Resolve a graph-discovered node to its REST endpoint. The graph carries p2p addresses, not the
   * `/lsp/v1` URL, so graph-only providers need this to become orderable (until nodes advertise it
   * natively — see docs/upstream-fiber-findings.md). Return undefined to leave a node discovery-only.
   */
  resolveEndpoint?: (g: GraphProvider) => string | undefined;
  /** Extra knobs passed through to the graph scan. */
  graph?: Omit<GraphDiscoverOptions, "asset" | "minAmount">;
  fetchImpl?: HttpFetch;
}

function normPubkey(s: string | undefined): string | undefined {
  return s ? s.toLowerCase().replace(/^0x/, "") : undefined;
}

async function tryGetInfo(baseUrl: string, fetchImpl?: HttpFetch): Promise<LspInfo | undefined> {
  try {
    return await new LspClient({ baseUrl, fetchImpl }).getInfo();
  } catch {
    return undefined;
  }
}

/**
 * Union graph-native discovery with the registry into one deduplicated provider list.
 *
 * Registry entries carry the REST endpoint; graph entries carry on-chain-verifiable capability. Where a
 * registry provider's `/info` pubkey matches a graph node, the two are merged into a single record that is
 * both reachable *and* confirmed on the graph. Results are ordered orderable-and-reachable first.
 */
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

  // Registry side: resolve /info first so we learn each provider's pubkey (to join against the graph).
  await Promise.all(
    registry.map(async (p) => {
      const info = await tryGetInfo(p.base_url, opts.fetchImpl);
      const key = normPubkey(info?.lsp_pubkey) ?? `url:${p.base_url}`;
      byKey.set(key, {
        sources: ["registry"],
        name: p.name,
        pubkey: info?.lsp_pubkey,
        base_url: p.base_url,
        addresses: info?.addresses,
        info,
        reachable: info !== undefined,
      });
    }),
  );

  // Graph side: merge onto a matching registry record by pubkey, else add a new one.
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
  if (p.base_url && p.reachable) return 0; // orderable now
  if (p.base_url) return 1; // has an endpoint but unreachable
  return 2; // graph-only, no endpoint yet
}

function orderableReachableFirst(a: ResolvedProvider, b: ResolvedProvider): number {
  return rank(a) - rank(b);
}
