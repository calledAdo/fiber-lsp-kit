/**
 * openChannelAndAwait — the shared "open a channel and wait until it's usable" mechanism.
 *
 * Both the inbound-lease flow (Lsp.provision) and JIT (JitService) need the exact same, subtle
 * sequence against FNN, so it lives here once instead of being maintained twice:
 *
 *   1. connect_peer only if not already peered (a redundant connect crashes the acceptor's gossip actor);
 *   2. snapshot channel ids to this peer BEFORE opening;
 *   3. open_channel;
 *   4. poll list_channels, identifying the freshly-opened channel by *novelty* (not in the snapshot) + peer
 *      + asset — never by balance, because a CKB channel's occupied-cell reserve makes local_balance smaller
 *      than the requested funding amount.
 *
 * This is deliberately rigid: the ordering is a correctness contract with FNN, not a policy knob.
 */
import {
  assetUdtScript,
  canonicalAssetId,
  udtAsset,
  CKB,
  type Asset,
  type UdtTypeScript,
} from "@fiberlsp/protocol";
import { isChannelReady, type FiberChannelRpcClient, type RawChannel } from "./rpc.js";

/** The asset a channel is denominated in, from its `funding_udt_type_script` (null ⇒ CKB). */
export function channelAsset(c: RawChannel): Asset {
  const s = c.funding_udt_type_script as UdtTypeScript | null | undefined;
  return s ? udtAsset(s) : CKB;
}

export interface OpenChannelAndAwaitArgs {
  /** Peer to open toward. */
  pubkey: string;
  /** Multiaddr to `connect_peer` to when not already peered. */
  address?: string;
  /** Channel funding, in the asset's base unit (decimal string or bigint). */
  fundingAmount: string | bigint;
  /** Asset the channel is denominated in; its UDT script (if any) is derived for `open_channel`. */
  asset: Asset;
  public?: boolean;
  readyPollAttempts: number;
  pollIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
  /**
   * Abandon the half-open orphan channel if it never reaches ChannelReady. JIT wants this (a stray funding
   * retry that lands after the caller gave up must not strand liquidity); the lease flow leaves it for retry.
   */
  abandonOrphanOnTimeout?: boolean;
  /**
   * Re-establish the session and retry `open_channel` when it fails with FNN's "feature not found / waiting for
   * Init" error. This is the JIT-to-a-brand-new-node case (see upstream finding #11): the acceptor has no
   * channel yet, so FNN's inbound-no-channel protection evicts/flaps the session and clears its exchanged
   * `features`, and `open_channel`'s `check_feature_compatibility` then rejects. A fresh `connect_peer`
   * (save=false, so it doesn't feed the saved-peer reconnect flapping) re-exchanges `Init`; firing `open_channel`
   * immediately after lands the funding handshake inside the ~30s window, and once the channel is pending the
   * peer is no longer "no-channel" and is no longer evicted. Off for the lease flow, whose acceptor is
   * already an established peer. Default retry count is 4.
   */
  reconnectOnFeatureMiss?: boolean;
  featureRetryAttempts?: number;
}

/** FNN's rejection when the acceptor's `Init`/features aren't in `peer_session_map` (upstream finding #11). */
function isFeatureMiss(e: unknown): boolean {
  return /feature not found|waiting for peer to send Init/i.test(String((e as Error)?.message ?? e));
}

/**
 * Open a channel to `args.pubkey` in `args.asset` and poll until it reaches ChannelReady, returning that
 * channel. Returns `null` on timeout (optionally abandoning the orphan first). Throws only if an RPC before
 * the poll loop throws — callers treat that as a provisioning failure.
 */
export async function openChannelAndAwait(
  rpc: FiberChannelRpcClient,
  args: OpenChannelAndAwaitArgs,
): Promise<RawChannel | null> {
  if (args.address) {
    const peers = await rpc.listPeers();
    if (!peers.some((p) => p.pubkey === args.pubkey)) await rpc.connectPeer(args.address);
  }

  const before = new Set((await rpc.listChannels(args.pubkey)).map((c) => c.channel_id));
  const open = () => rpc.openChannel({
    pubkey: args.pubkey,
    fundingAmount: args.fundingAmount,
    udtTypeScript: assetUdtScript(args.asset),
    public: args.public ?? true,
  });
  if (args.reconnectOnFeatureMiss && args.address) {
    const tries = args.featureRetryAttempts ?? 4;
    for (let attempt = 0; ; attempt++) {
      try {
        await open();
        break;
      } catch (e) {
        if (!isFeatureMiss(e) || attempt >= tries - 1) throw e;
        // Session was evicted/flapped and lost its features: force a fresh Init exchange, then retry at once.
        try { await rpc.connectPeer(args.address, false); } catch { /* dial may race the flap; the retry covers it */ }
        await args.sleep(args.pollIntervalMs);
      }
    }
  } else {
    await open();
  }

  const wantId = canonicalAssetId(args.asset);
  const isOurs = (c: RawChannel) => !before.has(c.channel_id) && canonicalAssetId(channelAsset(c)) === wantId;

  for (let i = 0; i < args.readyPollAttempts; i++) {
    const channels = await rpc.listChannels(args.pubkey);
    const match = channels.find((c) => isOurs(c) && isChannelReady(c));
    if (match) return match;
    if (i < args.readyPollAttempts - 1) await args.sleep(args.pollIntervalMs);
  }

  if (args.abandonOrphanOnTimeout) {
    try {
      for (const c of await rpc.listChannels(args.pubkey)) {
        if (isOurs(c) && !isChannelReady(c)) await rpc.abandonChannel(c.channel_id);
      }
    } catch {
      /* caller proceeds regardless (e.g. to refund) */
    }
  }
  return null;
}
