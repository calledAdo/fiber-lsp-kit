import { FiberChannelRpcClient } from "../../../packages/fiber/dist/index.js";
import { inspectNodeState } from "./node-state.mjs";
import { loadState } from "./state.mjs";

function nodePubkey(info) {
  return info.pubkey ?? info.node_id ?? info.public_key;
}

function safeCheckout(state) {
  if (!state) return {
    invoice: undefined,
    invoiceReady: false,
    paymentHash: undefined,
    requestedCapacity: undefined,
    channelId: undefined,
    customerPaymentStatus: undefined,
    settled: false,
  };
  return {
    invoice: state.invoice,
    invoiceReady: Boolean(state.invoice),
    paymentHash: state.paymentHash,
    requestedCapacity: state.capacity,
    channelId: state.channelId,
    customerPaymentStatus: state.customerPaymentStatus ?? (state.channelId ? "Success" : undefined),
    settled: Boolean(state.channelId),
  };
}

function safeRent(state) {
  if (!state) return undefined;
  return {
    channelId: state.channelId,
    capacity: state.capacity,
    periodsPaid: state.periodsPaid,
    totalPaid: state.totalPaid,
    initialRent: state.initialRent && {
      remainingInbound: state.initialRent.remainingInbound,
      amount: state.initialRent.amount,
    },
    payments: (state.payments ?? []).map((payment) => ({
      period: payment.period,
      status: payment.status,
      amount: payment.amount,
      remainingInbound: payment.remainingInbound,
      reason: payment.reason,
    })),
  };
}

function safeRegularPayment(state) {
  if (!state) return undefined;
  return {
    invoice: state.invoice,
    paymentHash: state.paymentHash,
    amount: state.amount,
    customerPaymentStatus: state.customerPaymentStatus,
    merchantInvoiceStatus: state.merchantInvoiceStatus,
    fee: state.fee,
    elapsedMs: state.elapsedMs,
    settled: state.customerPaymentStatus === "Success" && state.merchantInvoiceStatus === "Paid",
  };
}

export async function collectDashboardSnapshot(cfg, {
  now = Date.now,
  rpcFactory = (url) => new FiberChannelRpcClient({ rpcUrl: url }),
  balanceProvider,
} = {}) {
  const rpcs = Object.fromEntries(
    Object.entries(cfg.topology.nodes).map(([role, node]) => [role, rpcFactory(node.rpc, role)]),
  );
  const holdInfo = await rpcs[cfg.holdRole].nodeInfo();
  const holdPubkey = nodePubkey(holdInfo);
  if (!holdPubkey) throw new Error(`${cfg.holdRole} node_info returned no pubkey`);

  const stateList = await Promise.all(Object.entries(rpcs).map(([role, rpc]) =>
    inspectNodeState({
      role,
      rpc,
      asset: cfg.asset,
      focusPeer: role === "customer" ? holdPubkey : undefined,
    }),
  ));
  const nodes = Object.fromEntries(stateList.map((state) => [state.role, state]));
  if (balanceProvider) {
    const lspRoles = Object.keys(rpcs).filter((role) => role !== "customer" && role !== "merchant");
    await Promise.all(lspRoles.map(async (role) => {
      try {
        const nodeInfo = role === cfg.holdRole ? holdInfo : await rpcs[role].nodeInfo();
        nodes[role].onchainAsset = await balanceProvider({ role, nodeInfo, asset: cfg.asset });
      } catch (error) {
        nodes[role].onchainAsset = {
          error: error instanceof Error ? error.message : String(error),
          checkedAt: new Date(now()).toISOString(),
        };
      }
    }));
  }
  const assetConfig = cfg.assetConfig ?? {
    symbol: cfg.asset.symbol,
    decimals: cfg.assetDecimals ?? 0,
  };

  return {
    generatedAt: new Date(now()).toISOString(),
    scenario: {
      mode: cfg.mode,
      profile: cfg.topology.profile,
      asset: { symbol: assetConfig.symbol, decimals: assetConfig.decimals },
    },
    nodes,
    checkout: safeCheckout(loadState(cfg, "jit-hold")),
    regularPayment: safeRegularPayment(loadState(cfg, "regular-payment")),
    rent: safeRent(loadState(cfg, "rent")),
  };
}
