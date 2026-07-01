/**
 * A scripted FNN transport for offline tests. It drives the REAL FiberChannelRpcClient / Lsp code paths:
 * after an open_channel call it makes list_channels report a matching ChannelReady channel, exactly as a
 * live node would once the funding tx confirms.
 */
import type { FetchLike, UdtTypeScript } from "@fiberlsp/protocol";

export interface MockRpcOpts {
  lspPubkey?: string;
  /** If false, list_channels keeps returning a non-ready channel (to test the timeout path). */
  makeReady?: boolean;
}

export function makeMockRpc(opts: MockRpcOpts = {}): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  let lastOpen: { pubkey: string; funding_amount: string; udt?: UdtTypeScript | null } | null = null;

  const fetchImpl: FetchLike = async (_url, init) => {
    const { method, params } = JSON.parse(String(init.body)) as {
      method: string;
      params: unknown[];
    };
    calls.push(method);
    const p0 = (params[0] ?? {}) as Record<string, unknown>;

    let result: unknown;
    switch (method) {
      case "node_info":
        result = { node_id: opts.lspPubkey ?? "0xLSPPUBKEY", addresses: ["/ip4/127.0.0.1/tcp/8228"] };
        break;
      case "new_invoice":
        result = { invoice_address: `fibt_fee_${p0.amount}`, payment_hash: "0xhash" };
        break;
      case "connect_peer":
        result = null;
        break;
      case "open_channel":
        lastOpen = {
          pubkey: String(p0.pubkey),
          funding_amount: String(p0.funding_amount),
          udt: (p0.funding_udt_type_script as UdtTypeScript | undefined) ?? null,
        };
        result = { temporary_channel_id: "0xtemp" };
        break;
      case "list_channels": {
        const channels = lastOpen
          ? [
              {
                channel_id: "0xchan",
                channel_outpoint: "0xoutpoint:0",
                pubkey: lastOpen.pubkey,
                funding_udt_type_script: lastOpen.udt ?? null,
                state: {
                  state_name: opts.makeReady === false ? "AwaitingChannelReady" : "ChannelReady",
                },
                local_balance: lastOpen.funding_amount, // LSP-funded = client inbound
                remote_balance: "0x0",
                enabled: true,
              },
            ]
          : [];
        result = { channels };
        break;
      }
      default:
        result = null;
    }
    return { json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };

  return { fetchImpl, calls };
}
