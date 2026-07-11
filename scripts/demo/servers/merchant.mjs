// TERMINAL 2 — the merchant, with ZERO channels. Long-running; logs invoice creation and settlement.
//
//   node scripts/demo/servers/merchant.mjs [--download]
//
// Exposes a tiny local control port. `actions/request-invoice.mjs` POSTs to it to begin a JIT checkout: the
// merchant negotiates the mode the LSP offers (building a REAL Groth16 linkage proof for `linked` when the
// proving artifacts are present, else `same_hash`), prints the customer's hold invoice, and then waits — in
// the background — for the LSP to open a channel, forward the leg, and settle. It logs both moments.
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { FiberChannelRpcClient } from "../../../packages/fiber/dist/index.js";
import { JitCheckout, LspClient, InvoiceService, StreamingLease } from "../../../packages/client/dist/index.js";
import { loadConfig, saveState } from "../lib/config.mjs";
import { ensureArtifacts } from "../lib/artifacts.mjs";

const cfg = loadConfig();
const lsp = new LspClient({ baseUrl: cfg.lspRest });
const merchantRpc = new FiberChannelRpcClient({ rpcUrl: cfg.roles.merchant.fnn[0] });
const me = await merchantRpc.nodeInfo();
const merchantPubkey = me.pubkey ?? me.node_id ?? me.public_key ?? "";

const download = process.argv.includes("--download");
const artifacts = await ensureArtifacts("merchant", cfg, { download, allowSkip: true }); // null ⇒ can only do same_hash

async function startCheckout() {
  const info = await lsp.getInfo();
  const offered = info.jit?.modes ?? [];
  if (offered.length === 0) throw new Error("the LSP advertises no JIT modes — is the LSP server up?");

  const canProve = artifacts && existsSync(artifacts.zkey) && existsSync(artifacts.wasm);
  let mode, proveLinkage;
  if (offered.includes("linked") && canProve) {
    mode = "linked";
    const { makeLinkedProver } = await import("../../../packages/prover-linked/dist/index.js");
    const prover = makeLinkedProver({ zkeyPath: artifacts.zkey, wasmPath: artifacts.wasm });
    proveLinkage = async (holdHash, legHash, secretHex) => {
      console.log(`[merchant] proving linkage (secret stays private)…`);
      const t = Date.now();
      const proof = await prover(holdHash, legHash, secretHex);
      console.log(`[merchant] Groth16 proof built in ${((Date.now() - t) / 1000).toFixed(1)}s → sending to the LSP to verify`);
      return proof;
    };
  } else if (offered.includes("same_hash")) {
    mode = "same_hash";
  } else {
    throw new Error("LSP offers only 'linked' but proving artifacts are missing (rerun with --download or build the circuit)");
  }

  const checkout = new JitCheckout({ rpc: merchantRpc, lsp, merchantPubkey, mode, proveLinkage });
  const session = await checkout.checkout({ asset: cfg.udt, amount: cfg.amounts.jitPayment, channelCapacity: cfg.amounts.jitCapacity, description: "in-store sale #1" });

  console.log(`[merchant] mode ${session.mode} — hold invoice: ${session.invoice}`);
  console.log(`[merchant] customer pays ${cfg.fmt(cfg.amounts.jitPayment)}; merchant nets ${cfg.fmt(session.netAmount)} (fee ${cfg.fmt(session.fee)})`);
  saveState("jit-hold", { invoice: session.invoice, paymentHash: session.paymentHash, mode: session.mode });

  // Wait for settlement in the background; the control response returns the hold invoice immediately.
  session.settle({ attempts: 600, intervalMs: 1000 })
    .then((o) => console.log(o.state === "settled"
      ? `[merchant] ✅ SETTLED — channel ${o.channel_outpoint} opened; the first sale bought the channel`
      : `[merchant] ⚠️ order ${o.state}`))
    .catch((e) => console.log(`[merchant] settle error: ${e.message}`));

  return { invoice: session.invoice, mode: session.mode, netAmount: session.netAmount, fee: session.fee };
}

// A plain invoice over an ALREADY-OPEN channel (run after the JIT sale) — no hold, no proof, direct settlement.
async function directInvoice() {
  const svc = new InvoiceService({ rpc: merchantRpc });
  const issued = await svc.issue({ asset: cfg.udt, amount: cfg.amounts.jitPayment, description: "repeat sale (channel already open)" });
  console.log(`[merchant] direct invoice (channel already open): ${issued.invoice}`);
  saveState("direct-invoice", { invoice: issued.invoice, paymentHash: issued.paymentHash });
  return { invoice: issued.invoice, paymentHash: issued.paymentHash };
}

// Stream rent to the LSP for a few periods — keysend out of revenue over the same channel.
async function streamRent() {
  const info = await lsp.getInfo();
  const lease = new StreamingLease({
    rpc: merchantRpc,
    lspPubkey: info.lsp_pubkey,
    terms: { asset: cfg.udt, capacity: cfg.amounts.jitCapacity, rate_bps_per_period: 5, period_seconds: 86400, grace_periods: 2 },
    poll: { attempts: 5, intervalMs: 0, sleep: async () => {} },
    handlers: {
      onPaid: (p) => console.log(`[merchant] rent period ${p.period}: paid ${cfg.fmt(p.amount)} (keysend ${p.payment_hash?.slice(0, 14)}…)`),
      onSkip: (p) => console.log(`[merchant] rent period ${p.period}: skipped — ${p.reason}`),
    },
  });
  const periods = 3;
  for (let i = 0; i < periods; i++) await lease.payDue();
  console.log(`[merchant] rent streamed: ${lease.periodsPaid} period(s), total ${cfg.fmt(lease.totalPaid)}`);
  return { periodsPaid: lease.periodsPaid, totalPaid: lease.totalPaid.toString(), ratePerPeriod: lease.rent().toString() };
}

const routes = {
  "/request-invoice": startCheckout,
  "/direct-invoice": directInvoice,
  "/stream-rent": streamRent,
};

createServer((req, res) => {
  const handler = req.method === "POST" && routes[req.url];
  if (!handler) { res.writeHead(404).end(); return; }
  handler()
    .then((out) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out)); })
    .catch((e) => { console.error(`[merchant] ${e.message}`); res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
}).listen(cfg.roles.merchant.control, "127.0.0.1", () =>
  console.log(`[merchant] up — zero channels, control on http://127.0.0.1:${cfg.roles.merchant.control}  (fnn ${cfg.roles.merchant.fnn[0]}${cfg.roles.merchant.mock ? " · mock" : ""})`));
