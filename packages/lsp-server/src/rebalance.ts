/** Standalone circular-rebalancing planner and executor for an LSP-operated Fiber node. */
import {
  CHANNEL_READY,
  type BuildRouterHopRequirement,
  type FiberChannelRpcClient,
  type PaymentResult,
  type RawChannel,
} from "@fiberlsp/fiber";
import {
  CKB,
  asBig,
  assetEquals,
  assetUdtScript,
  udtAsset,
  type Asset,
} from "@fiberlsp/protocol";

export interface RebalanceThreshold {
  asset: Asset;
  /** Minimum acceptable local share of total channel balance, in basis points. */
  minLocalBps: number;
}

function channelAssetOf(channel: RawChannel): Asset {
  return channel.funding_udt_type_script ? udtAsset(channel.funding_udt_type_script) : CKB;
}

function isReadyAssetChannel(channel: RawChannel, asset: Asset): boolean {
  return channel.state?.state_name === CHANNEL_READY && assetEquals(channelAssetOf(channel), asset);
}

/** Return Ready channels in `asset` whose local share is strictly below the configured floor. */
export function needsRebalance(channels: RawChannel[], opts: RebalanceThreshold): RawChannel[] {
  return channels.filter((channel) => {
    if (!isReadyAssetChannel(channel, opts.asset)) return false;
    const local = asBig(channel.local_balance);
    const total = local + asBig(channel.remote_balance);
    return total > 0n && local * 10_000n < total * BigInt(opts.minLocalBps);
  });
}

export interface PlanCircularRebalanceArgs {
  starved: RawChannel;
  donor: RawChannel;
  lspPubkey: string;
  amount: bigint;
}

/**
 * Express a loop that exits through `donor` and returns through `starved`. If the channels have different
 * counterparties, the starved peer is an explicit intermediate waypoint and FNN pathfinds between them.
 */
export function planCircularRebalance(args: PlanCircularRebalanceArgs): {
  hops: BuildRouterHopRequirement[];
} {
  if (!args.donor.channel_outpoint || !args.starved.channel_outpoint) {
    throw new Error("circular rebalance requires finalized channel outpoints");
  }
  const hops: BuildRouterHopRequirement[] = [
    { pubkey: args.donor.pubkey, channelOutpoint: args.donor.channel_outpoint },
  ];
  if (args.donor.pubkey !== args.starved.pubkey) hops.push({ pubkey: args.starved.pubkey });
  hops.push({ pubkey: args.lspPubkey, channelOutpoint: args.starved.channel_outpoint });
  return { hops };
}

export interface RebalanceArgs extends RebalanceThreshold {
  amount: string | bigint;
  /** Route pricing only by default. A real transfer requires explicitly passing `false`. */
  dryRun?: boolean;
}

export type RebalanceResult =
  | { status: "nothing_to_do"; reason: "no_starved_channel" }
  | { status: "nothing_to_do"; reason: "no_eligible_donor"; starvedChannelId: string }
  | {
      status: "dry_run" | "submitted";
      starvedChannelId: string;
      donorChannelId: string;
      payment: PaymentResult;
    };

export class Rebalancer {
  constructor(private readonly rpc: FiberChannelRpcClient) {}

  async rebalance(args: RebalanceArgs): Promise<RebalanceResult> {
    const channels = await this.rpc.listChannels();
    const starved = needsRebalance(channels, args)[0];
    if (!starved) return { status: "nothing_to_do", reason: "no_starved_channel" };

    const amount = asBig(args.amount);
    const floor = BigInt(args.minLocalBps);
    const donors = channels.filter((candidate) => {
      if (candidate.channel_id === starved.channel_id || !candidate.channel_outpoint) return false;
      if (!isReadyAssetChannel(candidate, args.asset)) return false;
      const local = asBig(candidate.local_balance);
      const total = local + asBig(candidate.remote_balance);
      return local >= amount && (local - amount) * 10_000n >= total * floor;
    });
    const donor = donors.sort((a, b) => {
      const aLocal = asBig(a.local_balance);
      const bLocal = asBig(b.local_balance);
      return aLocal === bLocal ? 0 : aLocal > bLocal ? -1 : 1;
    })[0];
    if (!donor) {
      return { status: "nothing_to_do", reason: "no_eligible_donor", starvedChannelId: starved.channel_id };
    }

    const node = await this.rpc.nodeInfo();
    const lspPubkey = node.pubkey ?? node.node_id ?? node.public_key;
    if (!lspPubkey) throw new Error("node_info did not return the LSP pubkey");
    const plan = planCircularRebalance({ starved, donor, lspPubkey, amount });
    const udtTypeScript = assetUdtScript(args.asset);
    const router = await this.rpc.buildRouter({ hops: plan.hops, amount, udtTypeScript });
    const firstHop = router[0];
    if (!firstHop) throw new Error("build_router returned an empty circular route");
    const pricedDebit = asBig(firstHop.amount_received);
    const donorLocal = asBig(donor.local_balance);
    const donorTotal = donorLocal + asBig(donor.remote_balance);
    if (pricedDebit > donorLocal || (donorLocal - pricedDebit) * 10_000n < donorTotal * floor) {
      return { status: "nothing_to_do", reason: "no_eligible_donor", starvedChannelId: starved.channel_id };
    }
    const dryRun = args.dryRun ?? true;
    const sendArgs = {
      router,
      keysend: true,
      udtTypeScript,
    } as const;
    const preflight = await this.rpc.sendPaymentWithRouter({ ...sendArgs, dryRun: true });
    if (dryRun) {
      return {
        status: "dry_run",
        starvedChannelId: starved.channel_id,
        donorChannelId: donor.channel_id,
        payment: preflight,
      };
    }
    if (preflight.status === "Failed") {
      throw new Error(`circular rebalance dry-run failed: ${preflight.failed_error ?? "unknown route failure"}`);
    }
    const payment = await this.rpc.sendPaymentWithRouter(sendArgs);
    return {
      status: "submitted",
      starvedChannelId: starved.channel_id,
      donorChannelId: donor.channel_id,
      payment,
    };
  }
}
