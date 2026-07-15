import { createServer } from "node:http";

import { FiberChannelRpcClient } from "../../../packages/fiber/dist/index.js";
import { demoConsole, shortId } from "./console.mjs";
import { analyzePayableInvoice, analyzeRoutedInvoice, inspectNodeState } from "./node-state.mjs";
import { assertTrampolineSupport } from "./preflight.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_PAYMENT_WAIT_MS = 15 * 60 * 1000;

function terminalPayment(payment) {
  return payment?.status === "Success" || payment?.status === "Failed";
}

export function invoicePaymentDeadline(analysis, now = Date.now()) {
  try {
    const timestamp = Number(BigInt(analysis.timestamp));
    const expirySeconds = Number(BigInt(analysis.expiryTime));
    if (Number.isSafeInteger(timestamp) && Number.isSafeInteger(expirySeconds) && expirySeconds > 0) {
      return { deadlineMs: timestamp + expirySeconds * 1000, source: "invoice" };
    }
  } catch {
    // External invoices may omit expiry metadata; retain a bounded adapter fallback.
  }
  return { deadlineMs: now + DEFAULT_PAYMENT_WAIT_MS, source: "fallback" };
}

export async function waitForTerminalPayment({
  rpc,
  paymentHash,
  deadlineMs,
  deadlineSource = "invoice",
  now = Date.now,
  sleep: wait = sleep,
  pollIntervalMs = 1000,
}) {
  let latest;
  while (now() < deadlineMs) {
    latest = await rpc.getPayment(paymentHash);
    if (terminalPayment(latest)) return latest;
    await wait(Math.min(pollIntervalMs, Math.max(0, deadlineMs - now())));
  }

  latest = await rpc.getPayment(paymentHash);
  if (terminalPayment(latest)) return latest;
  return {
    ...latest,
    status: deadlineSource === "invoice" ? "Expired" : "Timeout",
    payment_hash: paymentHash,
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export async function payInvoice({
  cfg,
  rpc,
  invoice,
  routed = false,
  expectedPayeePubkey,
  trampolinePubkey,
}) {
  const analysis = routed
    ? await analyzeRoutedInvoice({ rpc, invoice, expectedPayeePubkey, trampolinePubkey })
    : await analyzePayableInvoice({ rpc, invoice, asset: cfg.asset });
  demoConsole.run("Customer payment dispatched", `${cfg.fmt(analysis.amount)} · ${shortId(analysis.paymentHash)}`);
  const sent = await rpc.sendPayment({
    invoice,
    trampolineHops: analysis.trampolineHops,
    maxFeeAmount: analysis.maxFeeAmount,
  });
  const paymentHash = sent.payment_hash;
  if (!paymentHash) throw new Error(`send_payment returned ${sent.status ?? "no status"} without a payment hash`);
  demoConsole.info("Payment status", sent.status ?? "sent");
  if (terminalPayment(sent)) {
    return { status: sent.status, payment_hash: paymentHash, fee: sent.fee, analysis };
  }

  const deadline = invoicePaymentDeadline(analysis);
  const payment = await waitForTerminalPayment({
    rpc,
    paymentHash,
    deadlineMs: deadline.deadlineMs,
    deadlineSource: deadline.source,
  });
  return {
    status: payment.status,
    payment_hash: paymentHash,
    fee: payment.fee ?? sent.fee,
    analysis,
  };
}

export async function startCustomerServer(cfg) {
  const rpcUrl = cfg.topology.nodes.customer.rpc;
  const rpc = new FiberChannelRpcClient({ rpcUrl });
  const holdRpc = new FiberChannelRpcClient({ rpcUrl: cfg.topology.nodes[cfg.holdRole].rpc });
  const merchantRpc = new FiberChannelRpcClient({ rpcUrl: cfg.topology.nodes.merchant.rpc });
  const [holdInfo, merchantInfo] = await Promise.all([holdRpc.nodeInfo(), merchantRpc.nodeInfo()]);
  const holdPubkey = holdInfo.pubkey ?? holdInfo.node_id ?? holdInfo.public_key;
  if (!holdPubkey) throw new Error("hold node_info returned no pubkey");
  const merchantPubkey = merchantInfo.pubkey ?? merchantInfo.node_id ?? merchantInfo.public_key;
  if (!merchantPubkey) throw new Error("merchant node_info returned no pubkey");
  const state = await inspectNodeState({ role: "customer", rpc, asset: cfg.asset, focusPeer: holdPubkey });
  demoConsole.heading(cfg.mode === "linked" ? "Linked JIT" : "Same-hash JIT", "Customer");
  demoConsole.ok("Node ready", `${cfg.topology.profile} profile · ${state.peerCount} peer(s)`);
  demoConsole.ok(
    "Checkout path ready",
    `${state.focusPeer.readyChannels} channel(s) · ${cfg.fmt(state.focusPeer.maxSingleChannelOutbound)} maximum`,
  );
  const server = createServer(async (req, res) => {
    const routed = req.url === "/pay-regular";
    if (req.method !== "POST" || (req.url !== "/pay" && !routed)) {
      res.writeHead(404).end();
      return;
    }

    try {
      const { invoice } = await readJson(req);
      if (!invoice) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "body must be { invoice }" }));
        return;
      }
      if (routed) assertTrampolineSupport(holdInfo);
      const result = await payInvoice({
        cfg,
        rpc,
        invoice,
        routed,
        expectedPayeePubkey: routed ? merchantPubkey : undefined,
        trampolinePubkey: routed ? holdPubkey : undefined,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      demoConsole.fail("Customer request failed", message);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  });

  server.listen(cfg.control.customer, "127.0.0.1", () => {
    demoConsole.run("Customer control ready", `http://127.0.0.1:${cfg.control.customer}`);
    demoConsole.info("Full diagnostics", `npm run ${cfg.commands.status}`);
  });
  return server;
}
