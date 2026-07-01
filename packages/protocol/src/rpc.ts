/**
 * FiberChannelRpcClient — a typed wrapper over the FNN JSON-RPC surface the LSP needs.
 *
 * Field shapes are pinned to FNN v0.9 (read from source):
 *   Peer:    connect_peer { address?, pubkey?, save? }
 *   Channel: open_channel { pubkey, funding_amount(hex), funding_udt_type_script?, public?, ... }
 *              -> { temporary_channel_id }
 *            list_channels { pubkey?, include_closed?, only_pending? } -> { channels: [...] }
 *   Invoice: new_invoice { amount(hex), currency, udt_type_script?, expiry(hex)? } -> { invoice_address, .. }
 *   Info:    node_info -> { node_id/public_key, addresses, ... }
 *
 * FNN encodes u64/u128 as 0x-hex strings; we convert amounts via num.ts at this boundary only.
 */
import type { UdtTypeScript } from "./types.js";
import { toHex } from "./num.js";

export type FetchLike = (url: string, init: RequestInit) => Promise<{ json(): Promise<unknown> }>;

export interface RpcClientConfig {
  rpcUrl: string;
  fetchImpl?: FetchLike;
}

/** A channel as returned by list_channels (fields the LSP cares about). */
export interface RawChannel {
  channel_id: string;
  channel_outpoint?: string | null;
  pubkey: string;
  funding_udt_type_script?: UdtTypeScript | null;
  state: { state_name: string; state_flags?: unknown };
  local_balance: string; // hex u128
  remote_balance: string; // hex u128
  enabled: boolean;
}

export interface OpenChannelArgs {
  pubkey: string;
  /** LSP-funded amount = the client's inbound capacity, in the asset's base unit (decimal or bigint). */
  fundingAmount: string | bigint;
  udtTypeScript?: UdtTypeScript;
  public?: boolean;
}

export class FiberChannelRpcClient {
  private readonly url: string;
  private readonly fetchImpl: FetchLike;
  private id = 0;

  constructor(cfg: RpcClientConfig) {
    this.url = cfg.rpcUrl;
    this.fetchImpl = cfg.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
    });
    const json = (await res.json()) as { result?: T; error?: { message: string } };
    if (json.error) throw new Error(`FNN ${method} failed: ${json.error.message}`);
    return json.result as T;
  }

  nodeInfo(): Promise<{ node_id?: string; public_key?: string; addresses?: string[] }> {
    return this.call("node_info", []);
  }

  connectPeer(address: string, save = true): Promise<null> {
    return this.call("connect_peer", [{ address, save }]);
  }

  /** Open a channel toward `pubkey`, funding it entirely from the LSP (that becomes the peer's inbound). */
  async openChannel(args: OpenChannelArgs): Promise<{ temporary_channel_id: string }> {
    const params: Record<string, unknown> = {
      pubkey: args.pubkey,
      funding_amount: toHex(args.fundingAmount),
      public: args.public ?? true,
    };
    if (args.udtTypeScript) params.funding_udt_type_script = args.udtTypeScript;
    return this.call("open_channel", [params]);
  }

  async listChannels(pubkey?: string): Promise<RawChannel[]> {
    const r = await this.call<{ channels?: RawChannel[] }>("list_channels", [
      pubkey ? { pubkey } : {},
    ]);
    return r.channels ?? [];
  }

  /** Create an invoice (used for the prepaid fee). `amount` in base unit; UDT optional. */
  newInvoice(args: {
    amount: string | bigint;
    currency?: string;
    description?: string;
    udtTypeScript?: UdtTypeScript;
    expirySeconds?: number;
  }): Promise<{ invoice_address: string; payment_hash?: string }> {
    const params: Record<string, unknown> = {
      amount: toHex(args.amount),
      currency: args.currency ?? "Fibt",
    };
    if (args.description) params.description = args.description;
    if (args.udtTypeScript) params.udt_type_script = args.udtTypeScript;
    if (args.expirySeconds) params.expiry = toHex(args.expirySeconds);
    return this.call("new_invoice", [params]);
  }
}

/** FNN's "channel is open and usable" state name. */
export const CHANNEL_READY = "ChannelReady";

export function isChannelReady(c: RawChannel): boolean {
  return c.state?.state_name === CHANNEL_READY;
}
