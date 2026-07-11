// LIVE STEP 5 — the merchant STREAMS RENT to keep its leased inbound channel alive.
//
// After activation (the CKB first payment) the lease's ongoing phase is streaming rent in the CHANNEL asset,
// paid by keysend out of revenue over the same channel. This drives StreamingLease.payDue() for a few periods
// against live nodes and shows (a) rent leaving the merchant, (b) it arriving at the LSP — proof of the model.
//
// Config comes from the selected network profile (NETWORK=<name>, default testnet). See lib/profile.mjs.
import { FiberChannelRpcClient } from "../../packages/fiber/dist/index.js";
import { StreamingLease } from "../../packages/client/dist/index.js";
import { loadProfile } from "./lib/profile.mjs";

const P = loadProfile();
const PERIODS = P.amounts.periods;
const CAPACITY = P.amounts.capacity;
const n = (v) => P.fmt(v);

const merchant = new FiberChannelRpcClient({ rpcUrl: P.nodes.merchant.rpc });
const lsp = new FiberChannelRpcClient({ rpcUrl: P.nodes.lsp.rpc });

// Sum the profile-asset balance (local for merchant spendable, remote for LSP's earnings from the merchant).
async function held(rpc, side) {
  const ch = await rpc.listChannels();
  let sum = 0n;
  for (const c of ch) if (P.isRusd(c.funding_udt_type_script)) sum += BigInt(c[side]);
  return sum;
}

const lease = new StreamingLease({
  rpc: merchant,
  lspPubkey: P.nodes.lsp.pubkey,
  terms: { asset: P.udt, capacity: CAPACITY, rate_bps_per_period: 5, period_seconds: 86400, grace_periods: 2 },
  poll: { attempts: 15, intervalMs: 2000 },
  handlers: {
    onPaid: (p) => console.log(`   ✅ period ${p.period}: rent ${n(p.amount)} paid — ${p.payment_hash?.slice(0, 18)}… (fee ${p.fee ?? "0x0"})`),
    onSkip: (p) => console.log(`   ⚠️  period ${p.period}: skipped — ${p.reason}`),
  },
});

console.log(`\n=== STEP 5 · Stream rent for a leased ${P.asset.symbol} channel (merchant → LSP)  [${P.name}] ===`);
console.log(`   rent/period: ${n(lease.rent())}  (5 bps of ${n(CAPACITY)} leased)`);

const mBefore = await held(merchant, "local_balance");
const lBefore = await held(lsp, "local_balance");
console.log(`   merchant spendable before: ${n(mBefore)}   ·   LSP local before: ${n(lBefore)}`);

for (let i = 0; i < PERIODS; i++) await lease.payDue();

const mAfter = await held(merchant, "local_balance");
const lAfter = await held(lsp, "local_balance");
console.log(`   merchant spendable after:  ${n(mAfter)}   (streamed out ${n(mBefore - mAfter)})`);
console.log(`   LSP local after:           ${n(lAfter)}   (rent received +${n(lAfter - lBefore)})`);
console.log(`   periods paid: ${lease.periodsPaid} · total rent: ${n(lease.totalPaid)} · lapsed: ${lease.lapsed}`);
console.log(`\n✅ DONE — rent streamed over the same channel; the LSP earns while the channel stays open.`);
