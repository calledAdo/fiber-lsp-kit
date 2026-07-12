import { test } from "node:test";
import assert from "node:assert/strict";
import { FiberChannelRpcClient, type FetchLike } from "@fiberlsp/fiber";
import { udtAsset, CKB, type UdtTypeScript } from "@fiberlsp/protocol";
import { closeLease, summarizePayments, LspLedger } from "../src/index.js";

const RUSD: UdtTypeScript = { code_hash: "0x" + "11".repeat(32), hash_type: "type", args: "0x" };
const rusd = udtAsset(RUSD, "RUSD");

/** Build a client over an inline JSON-RPC handler and record every method call. */
function clientFrom(handler: (method: string, p0: any) => unknown): { rpc: FiberChannelRpcClient; calls: any[] } {
  const calls: any[] = [];
  const fetchImpl: FetchLike = async (_u, init) => {
    const { id, method, params } = JSON.parse(String(init.body));
    calls.push({ method, p0: params?.[0] });
    return { json: async () => ({ jsonrpc: "2.0", id, result: handler(method, params?.[0] ?? {}) }) };
  };
  return { rpc: new FiberChannelRpcClient({ rpcUrl: "http://x", fetchImpl }), calls };
}

test("closeLease cooperatively closes only the Ready RUSD channel toward the merchant", async () => {
  const channels = [
    { channel_id: "0xc1", pubkey: "0xMERCHANT", funding_udt_type_script: RUSD, state: { state_name: "ChannelReady" }, local_balance: "0x1", remote_balance: "0x0", enabled: true },
    { channel_id: "0xc2", pubkey: "0xMERCHANT", funding_udt_type_script: null, state: { state_name: "ChannelReady" }, local_balance: "0x1", remote_balance: "0x0", enabled: true }, // CKB — wrong asset
    { channel_id: "0xc3", pubkey: "0xMERCHANT", funding_udt_type_script: RUSD, state: { state_name: "NegotiatingFunding" }, local_balance: "0x1", remote_balance: "0x0", enabled: true }, // not Ready
  ];
  const { rpc, calls } = clientFrom((method, p0) => {
    if (method === "list_channels") return { channels: p0.pubkey ? channels.filter((c) => c.pubkey === p0.pubkey) : channels };
    if (method === "shutdown_channel") return null;
    return null;
  });

  const res = await closeLease({ rpc, merchantPubkey: "0xMERCHANT", asset: rusd });
  assert.deepEqual(res.closed, ["0xc1"]);
  const shutdowns = calls.filter((c) => c.method === "shutdown_channel");
  assert.equal(shutdowns.length, 1);
  assert.equal(shutdowns[0].p0.channel_id, "0xc1");
  assert.equal(shutdowns[0].p0.force, undefined); // cooperative by default
});

test("closeLease passes force through and is a no-op when nothing is Ready", async () => {
  const { rpc, calls } = clientFrom((method) => (method === "list_channels" ? { channels: [] } : null));
  const res = await closeLease({ rpc, merchantPubkey: "0xM", asset: CKB, force: true });
  assert.deepEqual(res.closed, []);
  assert.equal(calls.filter((c) => c.method === "shutdown_channel").length, 0);
});

test("summarizePayments folds per-asset totals and a status breakdown", () => {
  const s = summarizePayments([
    { payment_hash: "0x1", status: "Success", amount: "0x64", fee: "0x1", udt_type_script: RUSD }, // 100 sent, 1 fee
    { payment_hash: "0x2", status: "Success", amount: "0xa", fee: "0x0", udt_type_script: RUSD }, //  10 sent
    { payment_hash: "0x3", status: "Success", amount: "0x5" }, // CKB, 5 sent, no fee field
    { payment_hash: "0x4", status: "Failed" },
    { payment_hash: "0x5", status: "Inflight" },
  ]);
  assert.equal(s.total, 5);
  assert.equal(s.succeeded, 3);
  assert.equal(s.failed, 1);
  assert.equal(s.inflight, 1);
  const rusdLine = s.by_asset.find((l) => l.asset !== "CKB");
  assert.equal(rusdLine?.sent, "110");
  assert.equal(rusdLine?.fees, "1");
  assert.equal(rusdLine?.count, 2);
  const ckbLine = s.by_asset.find((l) => l.asset === "CKB");
  assert.equal(ckbLine?.sent, "5");
});

test("LspLedger reads the node's list_payments", async () => {
  const { rpc } = clientFrom((method) =>
    method === "list_payments" ? { payments: [{ payment_hash: "0x1", status: "Success", amount: "0x7", udt_type_script: RUSD }] } : null,
  );
  const s = await new LspLedger(rpc).summary();
  assert.equal(s.succeeded, 1);
  assert.equal(s.by_asset[0].sent, "7");
});
