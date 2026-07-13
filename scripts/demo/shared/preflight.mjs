import { channelAsset, FnnStoreChangePreimageSource, isChannelReady } from "../../../packages/fiber/dist/index.js";
import { asBig, assetEquals, describeAsset } from "../../../packages/protocol/dist/index.js";

function nodePubkey(info) {
  return info.pubkey ?? info.node_id ?? info.public_key;
}

export async function inspectNode(role, rpc) {
  const info = await rpc.nodeInfo();
  const pubkey = nodePubkey(info);
  if (!pubkey) throw new Error(`${role} node_info did not return a pubkey`);
  if (!info.chain_hash) throw new Error(`${role} node_info did not return chain_hash`);
  return { role, pubkey, chainHash: info.chain_hash };
}

export function assertSameChain(nodes) {
  const byChain = new Map();
  for (const node of nodes) {
    const roles = byChain.get(node.chainHash) ?? [];
    roles.push(node.role);
    byChain.set(node.chainHash, roles);
  }
  if (byChain.size <= 1) return;

  const details = [...byChain.entries()]
    .map(([chainHash, roles]) => `${roles.join(", ")}=${chainHash}`)
    .join("; ");
  throw new Error(`configured nodes are on different Fiber chains: ${details}`);
}

export function assertDistinctNodes(nodes) {
  const byPubkey = new Map();
  for (const node of nodes) {
    const key = node.pubkey.toLowerCase();
    const existing = byPubkey.get(key);
    if (existing) throw new Error(`${existing.role} and ${node.role} resolve to the same node (${node.pubkey})`);
    byPubkey.set(key, node);
  }
}

function channelProblem(channel, asset, amount) {
  if (!channel.enabled) return "is disabled";
  if (!isChannelReady(channel)) return `is not ready (${channel.state?.state_name ?? "unknown state"})`;
  if (!assetEquals(channelAsset(channel), asset)) {
    return `has the wrong asset (${describeAsset(channelAsset(channel))}, expected ${describeAsset(asset)})`;
  }
  const outbound = asBig(channel.local_balance);
  if (outbound < amount) return `has insufficient outbound capacity (${outbound} < ${amount})`;
  return undefined;
}

export async function assertCustomerHoldChannel({ customerRpc, holdPubkey, asset, amount }) {
  const required = asBig(amount);
  const channels = await customerRpc.listChannels(holdPubkey);
  if (channels.length === 0) throw new Error(`customer has no channel to the hold node ${holdPubkey}`);

  const usable = channels.find((channel) => channelProblem(channel, asset, required) === undefined);
  if (!usable) {
    const details = channels
      .map((channel) => `${channel.channel_id} ${channelProblem(channel, asset, required)}`)
      .join("; ");
    throw new Error(`customer-to-hold channel is unusable: ${details}`);
  }

  const peers = await customerRpc.listPeers();
  if (!peers.some((peer) => peer.pubkey.toLowerCase() === holdPubkey.toLowerCase())) {
    throw new Error(`customer is not connected to hold node ${holdPubkey}`);
  }

  return {
    channelId: usable.channel_id,
    outbound: asBig(usable.local_balance),
  };
}

export async function assertPreimageObservation(rpcUrl) {
  const source = new FnnStoreChangePreimageSource({ rpcUrl });
  const observation = await source.observe("0x" + "00".repeat(32));
  observation.close();
}

export function formatPreflightReport({ profile, nodes, customerChannel }) {
  const lines = [`demo profile: ${profile}`];
  for (const node of nodes) lines.push(`${node.role}: ${node.pubkey} (${node.chainHash})`);
  lines.push(`customer -> hold: ${customerChannel.channelId}, outbound ${customerChannel.outbound}`);
  return lines.join("\n");
}
