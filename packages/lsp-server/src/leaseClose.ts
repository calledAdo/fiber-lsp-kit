/**
 * closeLease — the LSP side of ending a streaming lease.
 *
 * When a merchant's rent stream lapses (misses exceed `grace_periods`, signalled by `StreamingLease`'s
 * `onLapse`), the LSP is entitled to reclaim the capital it locked in the leased channel. This helper does
 * exactly that: it finds the Ready channel(s) the LSP opened toward the merchant in the lease asset and
 * cooperatively closes them, returning the funds on-chain.
 *
 * It is the counterpart to the JIT `abandonChannel` cleanup (which only drops a never-Ready open): here the
 * channel *did* go live and served the merchant, and we close it cleanly once the lease is over or defaulted.
 *
 * Cooperative by default (`force: false`); pass `force` to unilaterally close if the peer is unreachable.
 */
import { type Asset, assetEquals, udtAsset, CKB } from "@fiberlsp/protocol";
import { CHANNEL_READY, type FiberChannelRpcClient, type RawChannel } from "@fiberlsp/fiber";

export interface CloseLeaseArgs {
  rpc: FiberChannelRpcClient;
  /** The merchant node the leased channel was opened toward. */
  merchantPubkey: string;
  /** The lease asset — only channels funded in this asset are closed. */
  asset: Asset;
  /** Unilateral close instead of cooperative (use only when the peer is unreachable). Default false. */
  force?: boolean;
}

export interface CloseLeaseResult {
  /** Channel ids that were closed. */
  closed: string[];
}

/** The asset a channel is funded in, derived from its `funding_udt_type_script` (absent ⇒ CKB). */
function channelAssetOf(ch: RawChannel): Asset {
  return ch.funding_udt_type_script ? udtAsset(ch.funding_udt_type_script) : CKB;
}

/**
 * Cooperatively close every Ready channel the LSP holds toward `merchantPubkey` in `asset`. Idempotent: a
 * channel already closed simply won't appear as Ready, so re-running is a no-op.
 */
export async function closeLease(args: CloseLeaseArgs): Promise<CloseLeaseResult> {
  const channels = await args.rpc.listChannels(args.merchantPubkey);
  const targets = channels.filter(
    (ch) => ch.state?.state_name === CHANNEL_READY && assetEquals(channelAssetOf(ch), args.asset),
  );
  const closed: string[] = [];
  for (const ch of targets) {
    await args.rpc.shutdownChannel({ channelId: ch.channel_id, force: args.force });
    closed.push(ch.channel_id);
  }
  return { closed };
}
