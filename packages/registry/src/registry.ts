export type HttpFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface RegistryProvider {
  name: string;
  base_url: string;
  chain: string;
  lsp_pubkey?: string;
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
