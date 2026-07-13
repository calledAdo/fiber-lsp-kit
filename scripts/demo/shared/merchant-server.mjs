import { createServer } from "node:http";

import { LspClient, StreamingLease } from "../../../packages/client/dist/index.js";
import { FiberChannelRpcClient } from "../../../packages/fiber/dist/index.js";
import { leaseTermsFor } from "../../../packages/protocol/dist/index.js";
import { loadState, saveState } from "./state.mjs";

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") : undefined;
}

export async function startMerchantServer(cfg, createCheckout) {
  const lsp = new LspClient({ baseUrl: cfg.lspRest });
  const merchantRpc = new FiberChannelRpcClient({ rpcUrl: cfg.topology.nodes.merchant.rpc });
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

  async function startCheckout(body) {
    const amount = body?.amount ?? cfg.amounts.jitPayment;
    const capacity = body?.capacity ?? cfg.amounts.jitCapacity;
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
    console.log(`[merchant] hold invoice: ${session.invoice}`);
    console.log(`[merchant] customer pays ${cfg.fmt(amount)}; merchant nets ${cfg.fmt(session.netAmount)}`);

    session.settle({ attempts: 600, intervalMs: 1000 })
      .then((order) => {
        if (order.state === "settled" && order.channel_outpoint) {
          saveState(cfg, "jit-hold", { ...state, channelId: order.channel_outpoint });
          console.log(`[merchant] settled; channel ${order.channel_outpoint} is ready`);
        } else {
          console.log(`[merchant] order ended as ${order.state}`);
        }
      })
      .catch((error) => console.error(`[merchant] settlement watcher: ${error.message}`));

    return { invoice: session.invoice, netAmount: session.netAmount, fee: session.fee };
  }

  async function streamRent() {
    const offering = (await lsp.getInfo()).supported_assets.find((candidate) => candidate.stream);
    if (!offering) throw new Error("the LSP advertises no streaming lease terms");
    const state = loadState(cfg, "jit-hold");
    if (!state?.channelId) throw new Error("the JIT channel has not settled yet");
    const lease = new StreamingLease({
      rpc: merchantRpc,
      channelId: state.channelId,
      terms: leaseTermsFor(offering, state.capacity ?? cfg.amounts.jitCapacity),
      poll: { attempts: 5, intervalMs: 0, sleep: async () => {} },
      handlers: {
        onPaid: (payment) => console.log(
          `[merchant] rent period ${payment.period}: ${cfg.fmt(payment.remainingInbound)} remaining inbound, ` +
          `paid ${cfg.fmt(payment.amount)}`,
        ),
      },
    });
    const payments = [];
    for (let period = 0; period < 3; period++) payments.push(await lease.payDue());
    return { periodsPaid: lease.periodsPaid, totalPaid: lease.totalPaid.toString(), payments };
  }

  const routes = new Map([
    ["/request-invoice", startCheckout],
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
      console.error(`[merchant] ${message}`);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  });
  server.listen(cfg.control.merchant, "127.0.0.1", () => {
    console.log(
      `[merchant] up with zero channels on http://127.0.0.1:${cfg.control.merchant} ` +
      `(Fiber RPC ${cfg.topology.nodes.merchant.rpc}, ${cfg.topology.profile})`,
    );
  });
  return server;
}
