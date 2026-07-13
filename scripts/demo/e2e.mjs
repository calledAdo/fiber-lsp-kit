// End-to-end test of the whole demo flow against the mock nodes, in one process (so it runs anywhere).
//
//   node scripts/demo/e2e.mjs
//
// It uses the SAME mock-node logic the daemon serves (lib/mock-node.mjs), the SAME config (demo.config.json),
// and the SAME package APIs the servers use — JitCheckout, InvoiceService, StreamingLease, createApi/JitService
// — then asserts everything lines up: the JIT sale settles, the amounts reconcile, the direct payment settles
// over the open channel, and rent streams. If the linked artifacts are present it runs `linked` with a REAL
// Groth16 proof + verifier; otherwise it runs `same_hash`.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  createGroth16DualSha256Verifier, verifyGroth16Bn254, jitFee, jitForwardAmount, asBig,
} from "../../packages/protocol/dist/index.js";
import { FiberChannelRpcClient } from "../../packages/fiber/dist/index.js";
import { JitCheckout, LspClient, InvoiceService, StreamingLease } from "../../packages/client/dist/index.js";
import { Lsp, JitService, createApi, LspLedger, closeLease, Rebalancer } from "../../packages/lsp-server/dist/index.js";
import { loadConfig } from "./lib/config.mjs";
import { createWorld, makeNode } from "./lib/mock-node.mjs";

const cfg = loadConfig();
const P = cfg.amounts;
const ok = (label) => console.log(`  ✓ ${label}`);

// ── the mock network + in-process RPC clients (bridge the mock node fn to FiberChannelRpcClient) ──
const world = createWorld();
const nodes = {
  lsp: makeNode(world, "lsp", cfg.mock.ports.lsp),
  merchant: makeNode(world, "merchant", cfg.mock.ports.merchant),
  customer: makeNode(world, "customer", cfg.mock.ports.customer),
};
const client = (node) => new FiberChannelRpcClient({
  rpcUrl: `http://${node.role}`,
  fetchImpl: async (_u, init) => {
    const { id, method, params } = JSON.parse(init.body ?? "{}");
    return { json: async () => ({ jsonrpc: "2.0", id, result: node.rpc(method, params) }) };
  },
});
const lspRpc = client(nodes.lsp);
const merchantRpc = client(nodes.merchant);
const customerRpc = client(nodes.customer);

// ── stand up the real LSP (mirrors packages/lsp-server/server.js) ──
const offering = { asset: cfg.udt, min_capacity: "1000000000", max_capacity: "100000000000", fee_schedule: { base_fee: "0", proportional_bps: 0 } };
const terms = { fee_bps: 100, fee_base: "50000000", min_payment: "500000000", max_expiry_seconds: 3600 };
const haveArtifacts = existsSync(cfg.artifactsAbs.vk) && existsSync(cfg.artifactsAbs.zkey) && existsSync(cfg.artifactsAbs.wasm);

let payRpc, verifier, proveLinkage, expectMode;
if (haveArtifacts) {
  expectMode = "linked";
  const vk = JSON.parse(readFileSync(cfg.artifactsAbs.vk, "utf8"));
  verifier = createGroth16DualSha256Verifier({ verificationKey: vk, verifyGroth16: (v, pub, proof) => verifyGroth16Bn254(v, pub, proof) });
  const { makeLinkedProver } = await import("../../packages/prover-linked/dist/index.js");
  const prover = makeLinkedProver({ zkeyPath: cfg.artifactsAbs.zkey, wasmPath: cfg.artifactsAbs.wasm });
  proveLinkage = (h, l, s) => prover(h, l, s);
} else {
  expectMode = "same_hash"; // needs a distinct paying node
  payRpc = client(makeNode(world, "lspPay", (cfg.mock.ports.lsp ?? 9227) + 100));
}

const lsp = new Lsp({ rpc: lspRpc, lspPubkey: nodes.lsp.pubkey, addresses: [], supportedAssets: [offering], feeModes: ["prepaid"] });
const jit = new JitService({
  rpc: lspRpc, ...(payRpc ? { payRpc } : {}), ...(verifier ? { linkageVerifier: verifier } : {}),
  terms, supportedAssets: [offering], minCapacity: "1000000000",
  pollIntervalMs: 0, readyPollAttempts: 20, sleep: async () => {}, idgen: (() => { let n = 0; return () => `jit_${n++}`; })(),
});
const api = createApi(lsp, { jit });
const lspClient = new LspClient({ baseUrl: "http://lsp", fetchImpl: async (url, init) => {
  const u = new URL(url);
  const { status, body } = await api(init?.method ?? "GET", u.pathname, init?.body ? JSON.parse(init.body) : undefined, init?.headers);
  return { status, json: async () => body };
} });

console.log(`E2E demo flow  (mode: ${expectMode})`);

// ── 1) the JIT sale (request-invoice + pay) ──
const merchantPubkey = (await merchantRpc.nodeInfo()).pubkey;
const merchantAddress = cfg.peerAddr("merchant", merchantPubkey);
const checkout = new JitCheckout({ rpc: merchantRpc, lsp: lspClient, merchantPubkey, merchantAddress, mode: expectMode, proveLinkage });
const session = await checkout.checkout({ asset: cfg.udt, amount: P.jitPayment, channelCapacity: P.jitCapacity, description: "sale #1" });
assert.equal(session.mode, expectMode); ok(`JIT checkout negotiated ${session.mode}`);

// amounts reconcile: what the customer pays = what the merchant nets + the fee, per the protocol math
const fee = jitFee(terms, asBig(P.jitPayment));
const forward = jitForwardAmount(terms, asBig(P.jitPayment));
assert.equal(session.fee, fee.toString(10));
assert.equal(session.netAmount, forward.toString(10));
assert.equal((asBig(session.netAmount) + asBig(session.fee)).toString(10), asBig(P.jitPayment).toString(10));
ok(`amounts in sync: pay ${cfg.fmt(P.jitPayment)} = net ${cfg.fmt(session.netAmount)} + fee ${cfg.fmt(session.fee)}`);

// the hold invoice carries the gross amount the customer will pay
const parsedHold = await customerRpc.parseInvoice(session.invoice);
assert.equal(parsedHold.invoice.amount, asBig(P.jitPayment).toString(10));
ok(`hold invoice encodes the amount (${cfg.fmt(parsedHold.invoice.amount)})`);

// customer pays the hold; the LSP opens the channel, forwards, settles
await customerRpc.sendPayment({ invoice: session.invoice });
const settled = await session.settle({ intervalMs: 0 });
assert.equal(settled.state, "settled"); assert.ok(settled.channel_outpoint);
ok(`JIT settled — channel opened (${settled.channel_outpoint})`);
const held = await customerRpc.getPayment(session.paymentHash);
assert.equal(held.status, "Success");
ok(`customer hold payment released → Success`);

// ── 2) a direct sale over the now-open channel ──
const issued = await new InvoiceService({ rpc: merchantRpc }).issue({ asset: cfg.udt, amount: P.jitPayment, description: "sale #2" });
const parsedDirect = await customerRpc.parseInvoice(issued.invoice);
assert.equal(parsedDirect.invoice.amount, asBig(P.jitPayment).toString(10));
const directPay = await customerRpc.sendPayment({ invoice: issued.invoice });
assert.equal(directPay.status, "Success");
// The preimage is surfaced by get_payment (not send_payment) — same as a real fnn node.
const directSettled = await customerRpc.getPayment(directPay.payment_hash);
assert.equal(directSettled.status, "Success"); assert.ok(directSettled.payment_preimage);
ok(`direct invoice paid over the open channel (${cfg.fmt(P.jitPayment)}, preimage via get_payment)`);

// ── 3) streaming rent ──
const lease = new StreamingLease({
  rpc: merchantRpc, lspPubkey: nodes.lsp.pubkey,
  terms: { asset: cfg.udt, capacity: P.jitCapacity, rate_bps_per_period: 5, period_seconds: 86400, grace_periods: 2 },
  poll: { attempts: 3, intervalMs: 0, sleep: async () => {} }, handlers: {},
});
const expectedRent = (asBig(P.jitCapacity) * 5n) / 10000n;
assert.equal(lease.rent(), expectedRent.toString(10));
for (let i = 0; i < 3; i++) { const r = await lease.payDue(); assert.equal(r.status, "paid"); }
assert.equal(lease.periodsPaid, 3);
ok(`rent streamed: 3 periods × ${cfg.fmt(lease.rent())} = ${cfg.fmt(lease.totalPaid)}`);

// ── 4) LSP accounting + capital reclaim (A2 + A1) ──
// The paying node is the LSP's own node under `linked`, or the separate pay node under `same_hash`.
const ledger = await new LspLedger(payRpc ?? lspRpc).summary();
assert.ok(ledger.succeeded >= 1, "the LSP node should have at least the merchant payment on its ledger");
assert.ok(ledger.by_asset.length >= 1);
ok(`LSP ledger reconciles ${ledger.succeeded} sent payment(s) across ${ledger.by_asset.length} asset(s)`);

// The lease is over: the LSP cooperatively closes the channel it opened toward the merchant and reclaims capital.
const before = (await lspRpc.listChannels(merchantPubkey)).filter((c) => c.state?.state_name === "ChannelReady").length;
assert.ok(before >= 1, "the JIT channel should be Ready before close");
const closed = await closeLease({ rpc: lspRpc, merchantPubkey, asset: cfg.udt });
assert.ok(closed.closed.length >= 1);
const after = (await lspRpc.listChannels(merchantPubkey)).filter((c) => c.state?.state_name === "ChannelReady").length;
assert.equal(after, before - closed.closed.length);
ok(`lease closed: reclaimed ${closed.closed.length} channel(s), ${after} still Ready`);

// ── 5) standalone circular rebalance (B2) ──
// Seed two parallel channels after the lease-close demonstration so the mock can exercise an observable
// donor -> starved balance shift through the exact graph/build/send RPC path used with a live FNN node.
const rebalanceAmount = 100_000_000n;
const starvedChannel = {
  channel_id: "0xrebalance_starved",
  channel_outpoint: "0xrebalance_starved_out",
  pubkey: merchantPubkey,
  funding_udt_type_script: cfg.asset.script,
  state: { state_name: "ChannelReady" },
  local_balance: "0x" + (100_000_000n).toString(16),
  remote_balance: "0x" + (900_000_000n).toString(16),
  enabled: true,
};
const donorChannel = {
  channel_id: "0xrebalance_donor",
  channel_outpoint: "0xrebalance_donor_out",
  pubkey: merchantPubkey,
  funding_udt_type_script: cfg.asset.script,
  state: { state_name: "ChannelReady" },
  local_balance: "0x" + (900_000_000n).toString(16),
  remote_balance: "0x" + (100_000_000n).toString(16),
  enabled: true,
};
nodes.lsp.channels.push(starvedChannel, donorChannel);
const starvedBefore = asBig(starvedChannel.local_balance);
const donorBefore = asBig(donorChannel.local_balance);
const rebalanced = await new Rebalancer(lspRpc).rebalance({
  asset: cfg.udt,
  minLocalBps: 2_000,
  amount: rebalanceAmount,
  dryRun: false,
});
assert.equal(rebalanced.status, "submitted");
assert.equal(asBig(starvedChannel.local_balance), starvedBefore + rebalanceAmount);
assert.equal(asBig(donorChannel.local_balance), donorBefore - rebalanceAmount);
ok(`circular rebalance shifted ${cfg.fmt(rebalanceAmount)} from donor to starved channel`);

console.log("\nPASS ✅ — full demo flow in sync end to end.");
