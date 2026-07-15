import { createServer } from "node:http";

import { InvoiceService, LspClient, StreamingLease } from "../../../packages/client/dist/index.js";
import { FiberChannelRpcClient } from "../../../packages/fiber/dist/index.js";
import { leaseTermsFor } from "../../../packages/protocol/dist/index.js";
import { demoConsole, shortId } from "./console.mjs";
import { channelCapacity, inspectNodeState } from "./node-state.mjs";
import { saveState, updateState } from "./state.mjs";

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") : undefined;
}

export async function payRentPeriods(lease, periods) {
  const payments = [];
  for (let period = 0; period < periods; period++) {
    const payment = await lease.payDue();
    payments.push(payment);
    if (payment.status !== "paid") break;
  }
  return payments;
}

export async function startMerchantServer(cfg, createCheckout) {
  const lsp = new LspClient({ baseUrl: cfg.lspRest });
  const merchantRpc = new FiberChannelRpcClient({ rpcUrl: cfg.topology.nodes.merchant.rpc });
  const invoices = new InvoiceService({ rpc: merchantRpc });
  const info = await merchantRpc.nodeInfo();
  const merchantPubkey = info.pubkey ?? info.node_id ?? info.public_key ?? "";
  if (!merchantPubkey) throw new Error("merchant node_info returned no pubkey");
  const merchantAddress = cfg.peerAddress("merchant", merchantPubkey);

  const lspInfo = await lsp.getInfo();
  const offered = lspInfo.jit?.modes ?? [];
  if (offered.length !== 1 || offered[0] !== cfg.mode) {
    throw new Error(`expected the LSP to offer only ${cfg.mode}; received [${offered.join(", ")}]`);
  }
  const checkout = await createCheckout({ rpc: merchantRpc, lsp, merchantPubkey, merchantAddress });
  const merchantState = await inspectNodeState({ role: "merchant", rpc: merchantRpc, asset: cfg.asset });
  demoConsole.heading(cfg.mode === "linked" ? "Linked JIT" : "Same-hash JIT", "Merchant");
  demoConsole.ok("Node ready", `${cfg.topology.profile} profile · ${merchantState.peerCount} peer(s)`);
  demoConsole.ok(
    "JIT channel state",
    merchantState.assetTotals.readyChannels === 0
      ? "no existing channel · ready for provisioning"
      : `${merchantState.assetTotals.readyChannels} existing ${cfg.asset.symbol} channel(s)`,
  );
  demoConsole.ok("LSP mode available", cfg.mode);

  async function startCheckout(body) {
    const amount = body?.amount;
    const capacity = body?.capacity;
    if (amount === undefined || capacity === undefined) {
      throw new Error("body must include amount and capacity");
    }
    if (BigInt(amount) <= 0n || BigInt(capacity) <= 0n) {
      throw new Error("amount and capacity must be greater than zero");
    }
    const session = await checkout.checkout({
      asset: cfg.asset,
      amount,
      channelCapacity: capacity,
      description: "sale #1",
    });
    const openedCapacity = session.order?.request?.channel_capacity ?? capacity;
    const state = {
      invoice: session.invoice,
      paymentHash: session.paymentHash,
      capacity: openedCapacity,
    };
    saveState(cfg, "jit-hold", state);
    demoConsole.ok("Hold invoice created", `${cfg.fmt(amount)} customer payment`);
    demoConsole.info("Merchant net amount", cfg.fmt(session.netAmount));

    session.settle({ attempts: 600, intervalMs: 1000 })
      .then((order) => {
        if (order.state === "settled" && order.channel_outpoint) {
          updateState(cfg, "jit-hold", { channelId: order.channel_outpoint });
          demoConsole.ok("Merchant channel ready", shortId(order.channel_outpoint));
          demoConsole.ok("Checkout settled", "merchant paid and customer hold released");
        } else {
          demoConsole.warn("Checkout ended", order.state);
        }
      })
      .catch((error) => demoConsole.fail("Settlement watcher failed", error.message));

    return { invoice: session.invoice, netAmount: session.netAmount, fee: session.fee };
  }

  async function streamRent(body) {
    const offering = (await lsp.getInfo()).supported_assets.find((candidate) => candidate.stream);
    if (!offering) throw new Error("the LSP advertises no streaming lease terms");
    const channelId = body?.channelId;
    const periods = body?.periods;
    if (!channelId) throw new Error("body must include channelId");
    if (!Number.isSafeInteger(periods) || periods <= 0) throw new Error("periods must be a positive integer");
    const channel = (await merchantRpc.listChannels()).find(
      (candidate) => candidate.channel_id === channelId || candidate.channel_outpoint === channelId,
    );
    if (!channel) throw new Error(`channel ${channelId} was not found on the merchant node`);
    const capacity = channelCapacity(channel);
    const terms = leaseTermsFor(offering, capacity);
    if (!terms) throw new Error("the selected offering has no streaming lease terms");
    const lease = new StreamingLease({
      rpc: merchantRpc,
      channelId,
      terms,
      handlers: {
        onPaid: (payment) => demoConsole.ok(
          `Rent period ${payment.period}`,
          `${cfg.fmt(payment.amount)} paid · ${cfg.fmt(payment.remainingInbound)} inbound remains`,
        ),
      },
    });
    const initialRent = await lease.currentRent();
    const payments = await payRentPeriods(lease, periods);
    return {
      channelId: initialRent.channelId,
      capacity: capacity.toString(10),
      initialRent,
      periodsPaid: lease.periodsPaid,
      totalPaid: lease.totalPaid.toString(),
      payments,
    };
  }

  async function createRegularInvoice(body) {
    const amount = body?.amount;
    if (amount === undefined || BigInt(amount) <= 0n) throw new Error("body must include a positive amount");
    const issued = await invoices.receive({
      asset: cfg.asset,
      amount,
      description: "repeat sale",
    });
    demoConsole.ok("Regular invoice created", cfg.fmt(issued.amount));
    return issued;
  }

  async function waitForRegularPayment(body) {
    const paymentHash = body?.paymentHash;
    if (!paymentHash) throw new Error("body must include paymentHash");
    const outcome = await invoices.waitForPayment(paymentHash, { attempts: 120, intervalMs: 1000 });
    if (!outcome.paid) throw new Error(`merchant invoice ended as ${outcome.status}`);
    demoConsole.ok("Regular payment received", shortId(paymentHash));
    return outcome;
  }

  const routes = new Map([
    ["/request-invoice", startCheckout],
    ["/regular-invoice", createRegularInvoice],
    ["/wait-regular-payment", waitForRegularPayment],
    ["/stream-rent", streamRent],
  ]);
  const server = createServer(async (req, res) => {
    const handler = req.method === "POST" ? routes.get(req.url ?? "") : undefined;
    if (!handler) {
      res.writeHead(404).end();
      return;
    }
    try {
      const result = await handler(await readJson(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      demoConsole.fail("Merchant request failed", message);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  });
  server.listen(cfg.control.merchant, "127.0.0.1", () => {
    demoConsole.run("Merchant control ready", `http://127.0.0.1:${cfg.control.merchant}`);
    demoConsole.info("Full diagnostics", `npm run ${cfg.commands.status}`);
  });
  return server;
}
