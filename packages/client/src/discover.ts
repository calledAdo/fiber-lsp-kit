/** Provider discovery: fetch the open registry, optionally probe each LSP's live /info and quotes. */
import type { LspInfo } from "@fiberlsp/protocol";
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
