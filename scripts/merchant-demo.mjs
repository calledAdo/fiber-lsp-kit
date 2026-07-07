// Fiber LSP Kit — the whole merchant flow, end to end, WITH NO FNN NODE.
//
//   npm run demo
//
// Drives the REAL kit code (the reference LSP `Lsp` engine, `LiquidityMonitor`, `buyInboundFromLsp`, the
// server-side `InvoiceWebhookService`, and `SettlementLedger`) over two in-memory mock FNN nodes, and
// delivers the settlement webhook over a REAL local HTTP sink. So `git clone && npm i && npm run demo`
// reproduces the entire story on any machine — no node, no faucet, no network:
//
//   1. LiquidityMonitor sees the merchant has no inbound → buys it from the LSP (the kit provisions it).
//   2. The merchant issues + watches an invoice server-side (InvoiceWebhookService).
//   3. A customer pays it (simulated) → the watch sees it settle → invoice.paid POSTed to the sink.
//   4. SettlementLedger records + reconciles + exports the receipt for accounting.
//
// The live 3-node version of this exact flow (with real routing) is in LIVE_ROUTED_RESULTS.md.
import { udtAsset } from "../packages/protocol/dist/index.js";
import { FiberChannelRpcClient } from "../packages/fiber/dist/index.js";
import { InvoiceService, LiquidityMonitor, LspClient, buyInboundFromLsp, SettlementLedger } from "../packages/client/dist/index.js";
import { Lsp, createApi, InvoiceWebhookService } from "../packages/lsp-server/dist/index.js";
import { createServer } from "node:http";

const RUSD_SCRIPT = {
  code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hash_type: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const RUSD = udtAsset(RUSD_SCRIPT, "RUSD");
const DEC = 100_000_000n; // RUSD 8 decimals
const FLOOR = 300n * DEC; // keep ≥ 300 RUSD inbound on hand
const INVOICE_AMT = 250n * DEC; // this sale is 250 RUSD
const LSP_PUBKEY = "0xLSPPUBKEY";
const MERCHANT_PUBKEY = "0xMERCHANTPUBKEY";
const rusd = (v) => `${Number(BigInt(v)) / Number(DEC)} RUSD`;
const banner = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

// ── mock FNN nodes (the only fiction; every kit component they talk to is the real code) ──────────────
function merchantNode() {
  const state = { inbound: 0n, invoices: new Map() };
  let seq = 0;
  const fetchImpl = async (_url, init) => {
    const { id, method, params } = JSON.parse(init.body ?? "{}");
    let result = null;
    if (method === "list_channels") {
      result = { channels: state.inbound > 0n ? [{
        channel_id: "0xmc", pubkey: LSP_PUBKEY, funding_udt_type_script: RUSD_SCRIPT,
        state: { state_name: "ChannelReady" }, local_balance: "0x0",
        remote_balance: "0x" + state.inbound.toString(16), enabled: true }] : [] };
    } else if (method === "new_invoice") {
      const hash = "0xph" + seq++; state.invoices.set(hash, "Open");
      result = { invoice_address: "fibt1qmerchant" + seq, invoice: { data: { payment_hash: hash } } };
    } else if (method === "get_invoice") {
      result = { status: state.invoices.get(params?.[0]?.payment_hash) ?? "Open" };
    }
    return { json: async () => ({ jsonrpc: "2.0", id, result }) };
  };
  return {
    rpc: new FiberChannelRpcClient({ rpcUrl: "http://merchant", fetchImpl }),
    setInbound: (v) => (state.inbound = BigInt(v)),
    pay: (hash) => state.invoices.set(hash, "Paid"),
  };
}

function lspNode() {
  const state = { channels: [] };
  let seq = 0;
  const fetchImpl = async (_url, init) => {
    const { id, method, params } = JSON.parse(init.body ?? "{}");
    let result = null;
    if (method === "node_info") result = { pubkey: LSP_PUBKEY, addresses: [] };
    else if (method === "list_peers") result = { peers: [{ pubkey: MERCHANT_PUBKEY }] };
    else if (method === "new_invoice") result = { invoice_address: "fibt1qfee" + seq, invoice: { data: { payment_hash: "0xfee" + seq++ } } };
    else if (method === "get_invoice") result = { status: "Paid" };
    else if (method === "open_channel") {
      const p = params[0];
      state.channels.push({ channel_id: "0xlspch" + seq++, pubkey: p.pubkey, funding_udt_type_script: p.funding_udt_type_script ?? null,
        state: { state_name: "ChannelReady" }, local_balance: p.funding_amount, remote_balance: "0x0", enabled: true });
      result = { temporary_channel_id: "0xtmp" + seq };
    } else if (method === "list_channels") {
      const pk = params?.[0]?.pubkey;
      result = { channels: pk ? state.channels.filter((c) => c.pubkey === pk) : state.channels };
    }
    return { json: async () => ({ jsonrpc: "2.0", id, result }) };
  };
  return { rpc: new FiberChannelRpcClient({ rpcUrl: "http://lsp-node", fetchImpl }) };
}

// Bridge the reference LSP's in-process REST API to the HttpFetch the LspClient expects (no socket).
function standUpLspServer(node) {
  let n = 0;
  const lsp = new Lsp({
    rpc: node.rpc, lspPubkey: LSP_PUBKEY, addresses: [],
    supportedAssets: [{ asset: RUSD, min_capacity: (10n * DEC).toString(), max_capacity: (100000n * DEC).toString(),
                        fee_schedule: { base_fee: (10n * 100_000_000n).toString(), proportional_bps: 0 } }],
    feeModes: ["prepaid"], readyPollAttempts: 5, readyPollIntervalMs: 0, sleep: async () => {}, idgen: () => `order_${n++}`,
  });
  const api = createApi(lsp);
  return async (url, init) => {
    const u = new URL(url);
    const { status, body } = await api(init?.method ?? "GET", u.pathname, init?.body ? JSON.parse(init.body) : undefined);
    return { status, json: async () => body };
  };
}

function makeSink() {
  return new Promise((res) => {
    let hit; const received = new Promise((r) => (hit = r));
    const s = createServer((rq, rs) => { const c = []; rq.on("data", (x) => c.push(x));
      rq.on("end", () => { rs.writeHead(200, { "content-type": "application/json" }); rs.end("{}");
        hit({ path: rq.url, event: JSON.parse(Buffer.concat(c).toString("utf8")) }); }); });
    s.listen(0, "127.0.0.1", () => res({ url: `http://127.0.0.1:${s.address().port}/hooks`, received, close: () => s.close() }));
  });
}

// ── the flow ───────────────────────────────────────────────────────────────────────────────────────
const merchant = merchantNode();
const lspRest = new LspClient({ baseUrl: "http://lsp.local", fetchImpl: standUpLspServer(lspNode()) });
const invoices = new InvoiceService({ rpc: merchant.rpc });
const sink = await makeSink();

banner("1. Keep inbound ready ahead of demand  (LiquidityMonitor → buy from the LSP)");
const buy = buyInboundFromLsp(lspRest, {
  feeMode: "prepaid", targetPubkey: MERCHANT_PUBKEY,
  payFee: async (p) => console.log(`   [fee] pay ${p.amount} shannons CKB out-of-band  (invoice ${p.fee_invoice.slice(0, 20)}…)`),
  waitOpts: { attempts: 5, intervalMs: 0, sleep: async () => {} },
});
const monitor = new LiquidityMonitor({
  invoices, targets: [{ asset: RUSD, minInbound: FLOOR.toString(), targetInbound: FLOOR.toString() }],
  handlers: {
    onAlert: (a) => console.log(`   [monitor] inbound ${rusd(a.inbound)} < floor ${rusd(a.minInbound)} → provisioning ${rusd(a.shortfall)}`),
    ensureInbound: async (r) => { await buy(r); merchant.setInbound(FLOOR); console.log(`   [lsp] order channel_active → merchant inbound is now ${rusd(FLOOR)}`); },
  },
});
await monitor.check();

banner("2. Merchant issues + watches an invoice server-side  (InvoiceWebhookService)");
const webhooks = new InvoiceWebhookService({ rpc: merchant.rpc, pollAttempts: 20, pollIntervalMs: 5, now: () => 1_700_000_000, idgen: (() => { let n = 0; return () => `rcpt_${n++}`; })() });
const watch = webhooks.watchExisting ? null : null; // (register issues + watches in one call)
const w = await webhooks.register({ asset: RUSD, amount: INVOICE_AMT.toString(), webhook_url: sink.url, description: "order #42", metadata: { order: "42" } });
console.log(`   [checkout] invoice   ${w.invoice}`);
console.log(`   [checkout] qr_payload → encode in wallet QR: ${w.invoice}`);
console.log(`   [watch]    ${w.watch_id} watching ${w.payment_hash} → webhook to ${sink.url}`);

banner("3. Customer pays; the watch settles it and delivers the webhook");
console.log(`   [node] customer pays… invoice ${w.payment_hash}: Open → Paid`);
merchant.pay(w.payment_hash);
await webhooks.drain();
const hit = await sink.received;
console.log(`   [webhook] POST ${hit.path}  →  ${JSON.stringify({ type: hit.event.type, receipt: { amount: hit.event.receipt.amount, paid: hit.event.receipt.paid, payment_hash: hit.event.receipt.payment_hash } })}`);

banner("4. Back-office: record, reconcile, export  (SettlementLedger)");
const ledger = new SettlementLedger();
const settled = webhooks.get(w.watch_id);
ledger.record(settled.receipt);
console.log(`   [ledger] recorded ${settled.receipt.receipt_id} · ${rusd(settled.receipt.amount)} · paid=${settled.receipt.paid}`);
const report = await ledger.reconcile(merchant.rpc);
console.log(`   [ledger] reconcile vs node: ${report.matched}/${report.checked} matched, ${report.discrepancies.length} discrepancies`);
console.log("   [export] accounting CSV:");
console.log(ledger.export("csv").split("\n").map((l) => "     " + l).join("\n"));

sink.close();
const ok = hit.event.type === "invoice.paid" && hit.event.receipt.paid && BigInt(hit.event.receipt.amount) === INVOICE_AMT && report.matched === 1;
console.log(ok
  ? `\n\x1b[32mPASS ✅\x1b[0m — merchant provisioned inbound, issued a ${rusd(INVOICE_AMT)} invoice, got paid, received a server-side invoice.paid webhook, and reconciled + exported the receipt — no FNN node required.`
  : "\n\x1b[31mFAIL ❌\x1b[0m");
process.exit(ok ? 0 : 1);
