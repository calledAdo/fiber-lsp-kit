/**
 * Multi-LSP quote comparison — a liquidity marketplace primitive.
 *
 * Given several LSPs and a desired order, fetch each one's `/info` and compute what it would charge, using
 * the SAME fee math the server uses (`quoteFee`) applied to each LSP's published `fee_schedule`. This is a
 * pure preview: it never creates an order (which would open a channel). Results come back cheapest-servable
 * first, with a reason attached to any provider that can't serve the request.
 */
import {
  type Asset,
  type AssetOffering,
  type CreateOrderRequest,
  type FeeMode,
  type FeeQuote,
  type LspInfo,
  asBig,
  assetEquals,
  quoteFee,
  validateOrder,
} from "@fiberlsp/protocol";
import type { RegistryProvider } from "@fiberlsp/registry";
import { LspClient, type HttpFetch } from "./LspClient.js";

export interface QuoteRequest {
  asset: Asset;
  /** Inbound capacity wanted (LSP-funded side), in the asset's base unit. */
  amount: string;
  feeMode: FeeMode;
  /** For from_capacity (CKB only): this wallet's CKB contribution, used for validation. */
  clientBalance?: string;
}

export interface ProviderQuote {
  provider: RegistryProvider;
  reachable: boolean;
  info?: LspInfo;
  offering?: AssetOffering;
  /** The CKB fee this LSP would charge; present only when the provider can serve the request. */
  fee?: FeeQuote;
  /** Why this provider can't serve the request (unreachable / asset not offered / out of range / …). */
  error?: string;
}

function normalize(p: RegistryProvider | string): RegistryProvider {
  return typeof p === "string" ? { name: p, base_url: p, chain: "unknown" } : p;
}

/**
 * Fetch each provider's live offering and compute its fee for `request`. Sorted so the cheapest provider
 * that can actually serve the order is first; providers that can't serve it (with a reason) sort last.
 */
export async function compareQuotes(
  providers: (RegistryProvider | string)[],
  request: QuoteRequest,
  fetchImpl?: HttpFetch,
): Promise<ProviderQuote[]> {
  const quotes = await Promise.all(
    providers.map((raw) => quoteFromProvider(normalize(raw), request, fetchImpl)),
  );
  return quotes.sort(cheapestServableFirst);
}

/** The single cheapest provider that can serve the request, or `undefined` if none can. */
export async function bestQuote(
  providers: (RegistryProvider | string)[],
  request: QuoteRequest,
  fetchImpl?: HttpFetch,
): Promise<ProviderQuote | undefined> {
  const ranked = await compareQuotes(providers, request, fetchImpl);
  return ranked.find((q) => q.fee !== undefined);
}

async function quoteFromProvider(
  provider: RegistryProvider,
  request: QuoteRequest,
  fetchImpl?: HttpFetch,
): Promise<ProviderQuote> {
  let info: LspInfo;
  try {
    info = await new LspClient({ baseUrl: provider.base_url, fetchImpl }).getInfo();
  } catch (e) {
    return { provider, reachable: false, error: e instanceof Error ? e.message : String(e) };
  }

  const offering = info.supported_assets.find((o) => assetEquals(o.asset, request.asset));
  if (!offering) return { provider, reachable: true, info, error: "asset not offered" };

  const req: CreateOrderRequest = {
    target_pubkey: "0x00", // placeholder — we only price the order, never submit it
    asset: request.asset,
    lsp_balance: request.amount,
    client_balance: request.clientBalance,
    fee_mode: request.feeMode,
  };
  const err = validateOrder(offering, info.fee_modes, req);
  if (err) return { provider, reachable: true, info, offering, error: err.message };

  return { provider, reachable: true, info, offering, fee: quoteFee(offering, req) };
}

function cheapestServableFirst(a: ProviderQuote, b: ProviderQuote): number {
  const fa = a.fee ? asBig(a.fee.total_fee) : null;
  const fb = b.fee ? asBig(b.fee.total_fee) : null;
  if (fa !== null && fb !== null) return fa < fb ? -1 : fa > fb ? 1 : 0;
  return fa !== null ? -1 : fb !== null ? 1 : 0; // servable providers before unservable ones
}
