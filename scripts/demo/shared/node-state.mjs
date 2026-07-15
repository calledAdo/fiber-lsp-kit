import { channelAsset, invoiceAttr, isChannelReady } from "../../../packages/fiber/dist/index.js";
import { asBig, assetEquals, describeAsset } from "../../../packages/protocol/dist/index.js";

function nodePubkey(info) {
  return info.pubkey ?? info.node_id ?? info.public_key;
}

function samePubkey(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function usableForAsset(channel, asset) {
  return channel.enabled && isChannelReady(channel) && assetEquals(channelAsset(channel), asset);
}

function channelId(channel) {
  return channel.channel_outpoint ?? channel.channel_id;
}

export function channelCapacity(channel) {
  return asBig(channel.local_balance) + asBig(channel.remote_balance);
}

export function singleChannelPaymentLimit(channels, peerPubkey, asset) {
  let selected;
  for (const channel of channels) {
    if (!samePubkey(channel.pubkey, peerPubkey) || !usableForAsset(channel, asset)) continue;
    if (!selected || asBig(channel.local_balance) > asBig(selected.local_balance)) selected = channel;
  }
  return selected
    ? { amount: asBig(selected.local_balance), channelId: selected.channel_id }
    : { amount: 0n, channelId: undefined };
}

export async function inspectNodeState({ role, rpc, asset, focusPeer }) {
  const [info, peers, channels] = await Promise.all([
    rpc.nodeInfo(),
    rpc.listPeers(),
    rpc.listChannels(),
  ]);
  const pubkey = nodePubkey(info);
  if (!pubkey) throw new Error(`${role} node_info returned no pubkey`);
  if (!info.chain_hash) throw new Error(`${role} node_info returned no chain_hash`);

  const channelStates = channels.map((channel) => ({
    channelId: channelId(channel),
    temporaryChannelId: channel.channel_id,
    peerPubkey: channel.pubkey,
    state: channel.state?.state_name ?? "Unknown",
    enabled: channel.enabled,
    asset: describeAsset(channelAsset(channel)),
    assetMatches: assetEquals(channelAsset(channel), asset),
    ready: isChannelReady(channel),
    localBalance: asBig(channel.local_balance).toString(10),
    remoteBalance: asBig(channel.remote_balance).toString(10),
  }));
  const matchingReady = channels.filter((channel) => usableForAsset(channel, asset));
  const result = {
    role,
    pubkey,
    chainHash: info.chain_hash,
    peerCount: peers.length,
    peers: peers.map((peer) => peer.pubkey),
    channels: channelStates,
    assetTotals: {
      readyChannels: matchingReady.length,
      totalOutbound: matchingReady.reduce((sum, channel) => sum + asBig(channel.local_balance), 0n).toString(10),
      totalInbound: matchingReady.reduce((sum, channel) => sum + asBig(channel.remote_balance), 0n).toString(10),
    },
  };

  if (!focusPeer) return result;
  const focused = matchingReady.filter((channel) => samePubkey(channel.pubkey, focusPeer));
  const limit = singleChannelPaymentLimit(channels, focusPeer, asset);
  return {
    ...result,
    focusPeer: {
      pubkey: focusPeer,
      connected: peers.some((peer) => samePubkey(peer.pubkey, focusPeer)),
      readyChannels: focused.length,
      totalOutbound: focused.reduce((sum, channel) => sum + asBig(channel.local_balance), 0n).toString(10),
      totalInbound: focused.reduce((sum, channel) => sum + asBig(channel.remote_balance), 0n).toString(10),
      maxSingleChannelOutbound: limit.amount.toString(10),
      maxChannelId: limit.channelId,
    },
  };
}

async function parseInvoiceSummary({ rpc, invoice }) {
  const parsed = await rpc.parseInvoice(invoice);
  if (!parsed?.invoice) throw new Error("FNN could not parse the supplied invoice");
  const amount = parsed.invoice.amount;
  if (amount === undefined || asBig(amount) <= 0n) throw new Error("invoice has no positive amount");
  const payeePubkey = invoiceAttr(parsed, "payee_public_key");
  if (!payeePubkey) throw new Error("invoice has no payee_public_key");
  const paymentHash = parsed.invoice.data?.payment_hash;
  if (!paymentHash) throw new Error("invoice has no payment_hash");

  return {
    invoice,
    currency: parsed.invoice.currency,
    amount: asBig(amount).toString(10),
    paymentHash,
    payeePubkey,
    description: invoiceAttr(parsed, "description"),
    expiryTime: invoiceAttr(parsed, "expiry_time"),
    timestamp: parsed.invoice.data?.timestamp,
  };
}

export async function analyzePayableInvoice({ rpc, invoice, asset }) {
  const summary = await parseInvoiceSummary({ rpc, invoice });

  const channels = await rpc.listChannels(summary.payeePubkey);
  const limit = singleChannelPaymentLimit(channels, summary.payeePubkey, asset);
  if (asBig(summary.amount) > limit.amount) {
    throw new Error(
      `invoice amount ${asBig(summary.amount)} exceeds the available single-channel outbound capacity ${limit.amount}`,
    );
  }

  return {
    ...summary,
    maxSingleChannelOutbound: limit.amount.toString(10),
    channelId: limit.channelId,
  };
}

export async function analyzeRoutedInvoice({ rpc, invoice, expectedPayeePubkey, trampolinePubkey }) {
  const summary = await parseInvoiceSummary({ rpc, invoice });
  if (expectedPayeePubkey && !samePubkey(summary.payeePubkey, expectedPayeePubkey)) {
    throw new Error("regular invoice does not belong to the configured merchant");
  }
  const trampolineHops = trampolinePubkey ? [trampolinePubkey] : undefined;
  const maxFeeAmount = trampolinePubkey
    ? ((asBig(summary.amount) + 99n) / 100n).toString(10)
    : undefined;
  const dryRun = await rpc.sendPayment({ invoice, trampolineHops, maxFeeAmount, dryRun: true });
  if (dryRun.status === "Failed") {
    throw new Error(`no payable route to merchant: ${dryRun.failed_error ?? "FNN route dry-run failed"}`);
  }
  return { ...summary, estimatedFee: dryRun.fee, trampolineHops, maxFeeAmount };
}

function short(value) {
  const text = String(value ?? "");
  return text.length > 22 ? `${text.slice(0, 12)}...${text.slice(-8)}` : text;
}

export function formatNodeState(state, cfg) {
  const lines = [
    `[${state.role}] node ${state.pubkey}`,
    `[${state.role}] chain ${state.chainHash}; ${state.peerCount} connected peer(s); ${state.channels.length} channel(s)`,
    `[${state.role}] ready ${cfg.asset.symbol}: ${state.assetTotals.readyChannels} channel(s), ` +
      `${cfg.fmt(state.assetTotals.totalOutbound)} outbound, ${cfg.fmt(state.assetTotals.totalInbound)} inbound`,
  ];
  for (const channel of state.channels) {
    const balances = channel.assetMatches
      ? `${cfg.fmt(channel.localBalance)} outbound / ${cfg.fmt(channel.remoteBalance)} inbound`
      : `${channel.localBalance} outbound / ${channel.remoteBalance} inbound`;
    lines.push(
      `[${state.role}] channel ${channel.channelId} -> ${short(channel.peerPubkey)}: ` +
      `${channel.state}, ${channel.enabled ? "enabled" : "disabled"}, ${channel.asset}; ${balances}`,
    );
  }
  if (state.focusPeer) {
    lines.push(
      `[${state.role}] checkout path -> ${short(state.focusPeer.pubkey)}: ` +
      `${state.focusPeer.connected ? "connected" : "disconnected"}, ` +
      `${state.focusPeer.readyChannels} ready channel(s), maximum single-channel payment ` +
      `${cfg.fmt(state.focusPeer.maxSingleChannelOutbound)}`,
    );
  }
  return lines.join("\n");
}

export function formatInvoiceAnalysis(summary, cfg) {
  return [
    `invoice currency: ${summary.currency ?? "unknown"}`,
    `invoice amount: ${cfg.fmt(summary.amount)}`,
    `invoice payment hash: ${summary.paymentHash ?? "unknown"}`,
    `invoice payee: ${summary.payeePubkey}`,
    `invoice description: ${summary.description ?? "none"}`,
    `invoice expiry: ${summary.expiryTime ?? "not exposed"}`,
    `customer payment channel: ${summary.channelId ?? "none"}`,
    `maximum single-channel payment: ${cfg.fmt(summary.maxSingleChannelOutbound)}`,
  ].join("\n");
}
