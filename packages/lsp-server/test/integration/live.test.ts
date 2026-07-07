/**
 * Env-gated live integration test — runs the REAL FNN RPC surface, not a mock.
 *
 * These are read-only / non-spending checks (node_info, list_channels-backed liquidity, and an invoice
 * round-trip), so they're safe to run against a funded node without opening channels. The flagship
 * channel-open + receive flows are proven separately by scripts/part-c…f and recorded in LIVE_RESULTS.md.
 *
 * Run against a live node:
 *   LIVE_FIBER_RPC=http://127.0.0.1:8227 npm run test:live
 * Without LIVE_FIBER_RPC set, every check is skipped (so CI stays green offline).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FiberChannelRpcClient } from "@fiberlsp/fiber";
import { Lsp } from "@fiberlsp/server";

const RPC = process.env.LIVE_FIBER_RPC;
const gate = RPC ? false : "set LIVE_FIBER_RPC to run live integration tests";

test("live: node_info returns this node's pubkey", { skip: gate }, async () => {
  const rpc = new FiberChannelRpcClient({ rpcUrl: RPC! });
  const info = await rpc.nodeInfo();
  const pubkey = info.pubkey ?? info.node_id ?? info.public_key;
  assert.ok(pubkey && typeof pubkey === "string" && pubkey.length > 0, "pubkey present");
});

test("live: liquidity() returns a well-formed per-asset snapshot", { skip: gate }, async () => {
  const rpc = new FiberChannelRpcClient({ rpcUrl: RPC! });
  const info = await rpc.nodeInfo();
  const lsp = new Lsp({
    rpc,
    lspPubkey: info.pubkey ?? "",
    addresses: [],
    supportedAssets: [],
    feeModes: ["prepaid"],
  });
  const snap = await lsp.liquidity();
  assert.equal(typeof snap.lsp_pubkey, "string");
  assert.ok(Array.isArray(snap.assets));
  for (const a of snap.assets) {
    assert.ok(typeof a.outbound === "string" && typeof a.inbound === "string");
    assert.ok(a.channel_count >= a.ready_channel_count);
    assert.doesNotThrow(() => BigInt(a.outbound)); // decimal string
  }
});

test("live: new_invoice → get_invoice reports Open (fee-verifier RPC path)", { skip: gate }, async () => {
  const rpc = new FiberChannelRpcClient({ rpcUrl: RPC! });
  const inv = await rpc.newInvoice({ amount: "100", description: "test:live fee-verifier smoke" });
  const paymentHash = inv.invoice?.data?.payment_hash;
  assert.ok(paymentHash, "new_invoice returns a nested payment_hash");
  const { status } = await rpc.getInvoice(paymentHash!);
  assert.equal(status, "Open"); // freshly minted, unpaid
});
