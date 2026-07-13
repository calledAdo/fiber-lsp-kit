import { createServer } from "node:http";

import { FiberChannelRpcClient } from "../../../packages/fiber/dist/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export async function payInvoice({ cfg, rpc, invoice }) {
  const parsed = await rpc.parseInvoice(invoice).catch(() => undefined);
  const amount = parsed?.invoice?.amount;
  console.log(`[customer] paying ${amount ? cfg.fmt(amount) : "invoice"}: ${invoice}`);
  const sent = await rpc.sendPayment({ invoice });
  const paymentHash = sent.payment_hash;
  if (!paymentHash) throw new Error(`send_payment returned ${sent.status ?? "no status"} without a payment hash`);
  console.log(`[customer] ${paymentHash.slice(0, 16)}... -> ${sent.status ?? "sent"}`);

  for (let attempt = 0; attempt < 120; attempt++) {
    const payment = await rpc.getPayment(paymentHash);
    if (payment.status === "Success") return { status: "Success", payment_hash: paymentHash };
    if (payment.status === "Failed") return { status: "Failed", payment_hash: paymentHash };
    await sleep(1000);
  }
  return { status: "Timeout", payment_hash: paymentHash };
}

export function startCustomerServer(cfg) {
  const rpcUrl = cfg.topology.nodes.customer.rpc;
  const rpc = new FiberChannelRpcClient({ rpcUrl });
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/pay") {
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
      const result = await payInvoice({ cfg, rpc, invoice });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[customer] ${message}`);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  });

  server.listen(cfg.control.customer, "127.0.0.1", () => {
    console.log(
      `[customer] up on http://127.0.0.1:${cfg.control.customer} ` +
      `(Fiber RPC ${rpcUrl}, ${cfg.topology.profile})`,
    );
  });
  return server;
}
