/**
 * Lsp — the provider's identity and live capacity: what `GET /lsp/v1/info` and `GET /lsp/v1/liquidity` return.
 *
 * This is one brick. Provisioning is others: `PrepaidService` (buy inbound up front) and `JitService` (create
 * it against a held payment). The API composes whichever the deployment mounts; nothing here knows about
 * orders. `getInfo()` advertises the offering (assets, fee modes) that those services actually fulfil.
 */
import {
  type AssetLiquidity,
  type AssetOffering,
  type FeeMode,
  type LiquiditySnapshot,
  type LspInfo,
  asBig,
  assetEquals,
  canonicalAssetId,
} from "@fiberlsp/protocol";
import { channelAsset, isChannelReady, type FiberChannelRpcClient } from "@fiberlsp/fiber";

export interface LspConfig {
  rpc: FiberChannelRpcClient;
  lspPubkey: string;
  addresses: string[];
  chain?: string;
  supportedAssets: AssetOffering[];
  feeModes: FeeMode[];
  orderExpirySeconds?: number;
  operator?: string;
  version?: string;
  /** seconds; injectable for tests */
  now?: () => number;
}

export class Lsp {
  private readonly cfg: Required<Pick<LspConfig, "orderExpirySeconds" | "chain" | "now">> & LspConfig;

  constructor(config: LspConfig) {
    this.cfg = {
      chain: "testnet",
      orderExpirySeconds: 3600,
      now: () => Math.floor(Date.now() / 1000),
      ...config,
    };
  }

  getInfo(): LspInfo {
    return {
      lsp_pubkey: this.cfg.lspPubkey,
      addresses: this.cfg.addresses,
      chain: this.cfg.chain,
      supported_assets: this.cfg.supportedAssets,
      fee_modes: this.cfg.feeModes,
      order_expiry_seconds: this.cfg.orderExpirySeconds,
      operator: this.cfg.operator,
      version: this.cfg.version,
    };
  }

  /**
   * A live snapshot of the LSP's capacity, grouped by asset — the data behind a liquidity dashboard.
   * `outbound` (summed local balances) is what the LSP can send / has already provisioned to peers;
   * `inbound` (summed remote balances) is what it can receive. Read straight from `list_channels`.
   */
  async liquidity(): Promise<LiquiditySnapshot> {
    const channels = await this.cfg.rpc.listChannels();
    const groups = new Map<string, AssetLiquidity>();
    for (const c of channels) {
      const asset = channelAsset(c);
      const key = canonicalAssetId(asset);
      if (key === null) continue;
      let g = groups.get(key);
      if (!g) {
        // Prefer the offering's asset descriptor so the dashboard shows the symbol (e.g. "RUSD").
        const offered = this.cfg.supportedAssets.find((o) => assetEquals(o.asset, asset));
        g = {
          asset: offered?.asset ?? asset,
          channel_count: 0,
          ready_channel_count: 0,
          outbound: "0",
          inbound: "0",
        };
        groups.set(key, g);
      }
      g.channel_count += 1;
      if (isChannelReady(c)) g.ready_channel_count += 1;
      g.outbound = (asBig(g.outbound) + asBig(c.local_balance)).toString();
      g.inbound = (asBig(g.inbound) + asBig(c.remote_balance)).toString();
    }
    return {
      lsp_pubkey: this.cfg.lspPubkey,
      generated_at: this.cfg.now(),
      assets: [...groups.values()],
    };
  }
}
