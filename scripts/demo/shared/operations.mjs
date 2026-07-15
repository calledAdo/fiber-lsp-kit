import { FiberChannelRpcClient } from "../../../packages/fiber/dist/index.js";
import { analyzePayableInvoice, inspectNodeState } from "./node-state.mjs";
import { loadState, updateState } from "./state.mjs";

async function postJson(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`cannot reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `request failed with HTTP ${response.status}`);
  return result;
}

function positiveBaseAmount(cfg, human, name) {
  if (human === undefined || human === null || String(human).trim() === "") {
    throw new Error(`${name} is required`);
  }
  const amount = cfg.toBase(String(human));
  if (BigInt(amount) <= 0n) throw new Error(`${name} must be greater than zero`);
  return amount;
}

async function defaultCustomerContext(cfg, rpcFactory) {
  const hold = cfg.topology.nodes[cfg.holdRole];
  if (!hold) throw new Error(`demo configuration has no hold role named ${cfg.holdRole}`);
  const holdRpc = rpcFactory(hold.rpc);
  const info = await holdRpc.nodeInfo();
  const holdPubkey = info.pubkey ?? info.node_id ?? info.public_key;
  if (!holdPubkey) throw new Error("hold node_info returned no pubkey");
  const rpc = rpcFactory(cfg.topology.nodes.customer.rpc);
  const state = await inspectNodeState({ role: "customer", rpc, asset: cfg.asset, focusPeer: holdPubkey });
  return { rpc, state };
}

export function createDemoOperations(cfg, deps = {}) {
  const rpcFactory = deps.rpcFactory ?? ((rpcUrl) => new FiberChannelRpcClient({ rpcUrl }));
  const customerContext = deps.customerContext ?? (() => defaultCustomerContext(cfg, rpcFactory));
  const analyzeInvoice = deps.analyzeInvoice ?? ((input) => analyzePayableInvoice(input));
  const send = deps.postJson ?? postJson;
  const readState = deps.readState ?? loadState;
  const mergeState = deps.mergeState ?? updateState;
  const onStage = deps.onStage ?? (() => {});
  const now = deps.now ?? Date.now;

  return {
    async requestInvoice({ amount: humanAmount, capacity: humanCapacity } = {}) {
      const amount = positiveBaseAmount(cfg, humanAmount, "amount");
      const capacity = positiveBaseAmount(cfg, humanCapacity, "capacity");
      const { rpc, state } = await customerContext();
      const available = BigInt(state.focusPeer.maxSingleChannelOutbound);
      if (BigInt(amount) > available) {
        throw new Error(
          `requested ${amount} exceeds the customer's maximum single-channel payment ${available}`,
        );
      }
      onStage("invoice", { amount, capacity, customerLimit: available.toString(10) });
      const result = await send(`http://127.0.0.1:${cfg.control.merchant}/request-invoice`, { amount, capacity });
      const analysis = await analyzeInvoice({ rpc, invoice: result.invoice, asset: cfg.asset });
      return {
        ...result,
        analysis,
        requestedAmount: amount,
        requestedCapacity: capacity,
        customerLimit: available.toString(10),
      };
    },

    async payInvoice({ invoice, latest = false } = {}) {
      if (invoice && latest) throw new Error("use only one of invoice or latest");
      const saved = latest ? readState(cfg, "jit-hold") : undefined;
      const selected = invoice ?? saved?.invoice;
      if (!selected) throw new Error("provide an invoice or select the latest saved invoice");
      const rpc = rpcFactory(cfg.topology.nodes.customer.rpc);
      const analysis = await analyzeInvoice({ rpc, invoice: selected, asset: cfg.asset });
      onStage("pay", { analysis });
      const result = await send(`http://127.0.0.1:${cfg.control.customer}/pay`, { invoice: selected });
      if (result.status !== "Success") throw new Error(`JIT payment ended as ${result.status}`);
      mergeState(cfg, "jit-hold", { customerPaymentStatus: result.status });
      return { ...result, analysis };
    },

    async requestRegularInvoice({ amount: humanAmount } = {}) {
      const amount = positiveBaseAmount(cfg, humanAmount, "amount");
      onStage("regular-invoice", { amount });
      const result = await send(`http://127.0.0.1:${cfg.control.merchant}/regular-invoice`, { amount });
      mergeState(cfg, "regular-payment", {
        invoice: result.invoice,
        paymentHash: result.paymentHash,
        amount: result.amount ?? amount,
        customerPaymentStatus: undefined,
        merchantInvoiceStatus: "Open",
        fee: undefined,
        elapsedMs: undefined,
      });
      return result;
    },

    async payRegularInvoice({ invoice, latest = false } = {}) {
      if (invoice && latest) throw new Error("use only one of invoice or latest");
      const saved = latest ? readState(cfg, "regular-payment") : undefined;
      const selected = invoice ?? saved?.invoice;
      if (!selected) throw new Error("provide a regular invoice or select the latest saved invoice");
      onStage("regular-pay", { invoice: selected });
      const startedAt = now();
      const payment = await send(`http://127.0.0.1:${cfg.control.customer}/pay-regular`, { invoice: selected });
      if (payment.status !== "Success") throw new Error(`regular payment ended as ${payment.status}`);
      const analysis = payment.analysis;
      if (!analysis?.paymentHash) throw new Error("customer payment returned no parsed payment hash");
      const invoiceOutcome = await send(
        `http://127.0.0.1:${cfg.control.merchant}/wait-regular-payment`,
        { paymentHash: analysis.paymentHash },
      );
      if (!invoiceOutcome.paid) throw new Error(`merchant invoice ended as ${invoiceOutcome.status}`);
      const elapsedMs = now() - startedAt;
      mergeState(cfg, "regular-payment", {
        invoice: selected,
        paymentHash: analysis.paymentHash,
        amount: analysis.amount,
        customerPaymentStatus: payment.status,
        merchantInvoiceStatus: invoiceOutcome.status,
        fee: payment.fee,
        elapsedMs,
      });
      return {
        ...payment,
        analysis,
        invoiceStatus: invoiceOutcome.status,
        elapsedMs,
      };
    },

    async streamRent({ channelId, latest = false, periods = 3 } = {}) {
      if (channelId && latest) throw new Error("use only one of channelId or latest");
      if (!Number.isSafeInteger(periods) || periods <= 0) throw new Error("periods must be a positive integer");
      const saved = latest ? readState(cfg, "jit-hold") : undefined;
      const selected = channelId ?? saved?.channelId;
      if (!selected) throw new Error("provide a channel or select the latest settled channel");
      onStage("rent", { channelId: selected, periods });
      const result = await send(`http://127.0.0.1:${cfg.control.merchant}/stream-rent`, {
        channelId: selected,
        periods,
      });
      mergeState(cfg, "rent", result);
      return result;
    },
  };
}
