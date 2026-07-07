// DEMO STEP 5 — the merchant STREAMS RENT to keep its leased inbound channel alive.
//
//   node scripts/demo/05-stream-rent.mjs
//
// After activation (the CKB first payment) the lease's ongoing phase is streaming rent in the CHANNEL asset,
// paid by keysend out of revenue over the same channel. This drives StreamingLease.payDue() for a few periods
// against live nodes and shows (a) rent leaving the merchant, (b) it arriving at the LSP — proof of the model.
import { udtAsset } from "../../packages/protocol/dist/index.js";
import { FiberChannelRpcClient } from "../../packages/fiber/dist/index.js";
import { StreamingLease } from "../../packages/client/dist/index.js";

const RUSD_SCRIPT = { code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hash_type: "type", args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b" };
const RUSD = udtAsset(RUSD_SCRIPT, "RUSD");

const MERCHANT_RPC = process.env.MERCHANT_RPC ?? "http://127.0.0.1:8247";
const LSP_RPC = process.env.LSP_RPC ?? "http://127.0.0.1:8227";
const LSP_PUBKEY = process.env.LSP_PUBKEY ?? "023dda5d5349345ca6a26e7389f2f52e59d85f4f833617865675078e8964230109";
const PERIODS = Number(process.env.PERIODS ?? 3);
const CAPACITY = process.env.CAPACITY ?? "1000000000"; // 10 RUSD leased
const n = (v) => (Number(BigInt(v)) / 1e8).toFixed(3);

const merchant = new FiberChannelRpcClient({ rpcUrl: MERCHANT_RPC });
const lsp = new FiberChannelRpcClient({ rpcUrl: LSP_RPC });

// Sum RUSD balance (local for merchant spendable, remote for LSP's earnings from the merchant).
async function rusd(rpc, side) {
  const ch = await rpc.listChannels();
  let sum = 0n;
  for (const c of ch) if (c.funding_udt_type_script) sum += BigInt(c[side]);
  return sum;
}

const lease = new StreamingLease({
  rpc: merchant,
  lspPubkey: LSP_PUBKEY,
  terms: { asset: RUSD, capacity: CAPACITY, rate_bps_per_period: 5, period_seconds: 86400, grace_periods: 2 },
  poll: { attempts: 15, intervalMs: 2000 },
  handlers: {
    onPaid: (p) => console.log(`   ✅ period ${p.period}: rent ${n(p.amount)} RUSD paid — ${p.payment_hash?.slice(0, 18)}… (fee ${p.fee ?? "0x0"})`),
    onSkip: (p) => console.log(`   ⚠️  period ${p.period}: skipped — ${p.reason}`),
  },
});

console.log(`\n=== STEP 5 · Stream rent for a leased RUSD channel (merchant → LSP) ===`);
console.log(`   rent/period: ${n(lease.rent())} RUSD  (5 bps of ${n(CAPACITY)} RUSD leased)`);

const mBefore = await rusd(merchant, "local_balance");
const lBefore = await rusd(lsp, "local_balance");
console.log(`   merchant spendable RUSD before: ${n(mBefore)}   ·   LSP local RUSD before: ${n(lBefore)}`);

for (let i = 0; i < PERIODS; i++) await lease.payDue();

const mAfter = await rusd(merchant, "local_balance");
const lAfter = await rusd(lsp, "local_balance");
console.log(`   merchant spendable RUSD after:  ${n(mAfter)}   (streamed out ${n(mBefore - mAfter)})`);
console.log(`   LSP local RUSD after:           ${n(lAfter)}   (rent received +${n(lAfter - lBefore)})`);
console.log(`   periods paid: ${lease.periodsPaid} · total rent: ${n(lease.totalPaid)} RUSD · lapsed: ${lease.lapsed}`);
console.log(`\n✅ DONE — rent streamed in RUSD over the same channel; the LSP earns while the channel stays open.`);
