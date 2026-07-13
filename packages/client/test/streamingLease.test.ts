import { test } from "node:test";
import assert from "node:assert/strict";
import { udtAsset, type LeaseTerms, type UdtTypeScript } from "@fiberlsp/protocol";
import { FiberChannelRpcClient } from "@fiberlsp/fiber";
import { StreamingLease, type LapseInfo, type RentPayment } from "@fiberlsp/client";

const RUSD_SCRIPT: UdtTypeScript = {
  code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hash_type: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const RUSD = udtAsset(RUSD_SCRIPT, "RUSD");
const LSP = "023dda5d5349345ca6a26e7389f2f52e59d85f4f833617865675078e8964230109";

const terms = (over: Partial<LeaseTerms> = {}): LeaseTerms => ({
  asset: RUSD,
  capacity: "1000000000", // 10 RUSD → rent 500000 (0.005 RUSD) at 5 bps
  rate_bps_per_period: 5,
  period_seconds: 86400,
  grace_periods: 2,
  ...over,
});

/**
 * A payer node whose spendable (local) balance gates affordability, exactly like FNN routing: send_payment
 * (dry-run or real) fails to build a route when the amount exceeds spendable. A real send moves the rent to
 * the LSP — modelling how paying rent back over the same channel restores the merchant's inbound.
 */
function payer(spendable: bigint, remainingInbound = 1_000_000_000n, peerPubkey = LSP) {
  const state = { spendable, remainingInbound, sent: [] as { hash: string; amount: bigint; target: string }[] };
  const fetchImpl = async (_url: string, i: { body?: string }) => {
    const { id, method, params } = JSON.parse(i.body ?? "{}");
    const p = params?.[0] ?? {};
    let result: unknown = null;
    let error: { code: number; message: string } | null = null;
    if (method === "send_payment") {
      const amount = BigInt(p.amount);
      if (amount > state.spendable) {
        error = { code: -1, message: "no route: insufficient balance" }; // FNN can't route it
      } else if (p.dry_run) {
        result = { payment_hash: "0xdry", status: "Created", fee: "0x0" };
      } else {
        const hash = "0xpay" + state.sent.length;
        state.sent.push({ hash, amount, target: p.target_pubkey });
        state.spendable -= amount; // rent leaves the merchant → toward the LSP (restores inbound)
        state.remainingInbound += amount;
        result = { payment_hash: hash, status: "Created", fee: "0x0" }; // terminal via get_payment
      }
    } else if (method === "list_channels") {
      result = {
        channels: [{
          channel_id: "0xlease-channel",
          channel_outpoint: "0xlease-outpoint",
          pubkey: peerPubkey,
          funding_udt_type_script: RUSD_SCRIPT,
          state: { state_name: "ChannelReady" },
          local_balance: "0x" + state.spendable.toString(16),
          remote_balance: "0x" + state.remainingInbound.toString(16),
          enabled: true,
        }],
      };
    } else if (method === "get_payment") {
      result = { payment_hash: p.payment_hash, status: "Success", fee: "0x0" };
    }
    return { json: async () => ({ jsonrpc: "2.0", id, result, error }) };
  };
  return { state, rpc: new FiberChannelRpcClient({ rpcUrl: "http://m", fetchImpl }) };
}

const CLOCK = { now: () => 1_700_000_000 };
const FAST = { poll: { attempts: 5, intervalMs: 0, sleep: async () => {} } };
const CHANNEL = { channelId: "0xlease-outpoint" };

test("rent() is the per-period rent in base units", () => {
  const lease = new StreamingLease({ rpc: payer(0n).rpc, terms: terms(), ...CHANNEL, ...CLOCK, ...FAST });
  assert.equal(lease.rent(), "500000");
});

test("payDue settles rent by keysend when affordable", async () => {
  const n = payer(1_000_000n); // has revenue
  const paid: RentPayment[] = [];
  const lease = new StreamingLease({ rpc: n.rpc, terms: terms(), handlers: { onPaid: (p) => paid.push(p) }, ...CHANNEL, ...CLOCK, ...FAST });
  const p = await lease.payDue();
  assert.equal(p.status, "paid");
  assert.equal(p.amount, "500000");
  assert.equal(p.remainingInbound, "1000000000");
  assert.ok(p.payment_hash?.startsWith("0xpay"));
  assert.equal(lease.periodsPaid, 1);
  assert.equal(lease.totalPaid, "500000");
  assert.equal(lease.consecutiveMisses, 0);
  assert.equal(lease.lastPaidAt, 1_700_000_000);
  assert.equal(paid.length, 1);
  assert.equal(n.state.sent.length, 1); // exactly one real keysend (dry-run moved nothing)
});

test("payDue skips (no funds pre-revenue) and counts a miss", async () => {
  const skips: RentPayment[] = [];
  const lease = new StreamingLease({ rpc: payer(0n).rpc, terms: terms(), handlers: { onSkip: (p) => skips.push(p) }, ...CHANNEL, ...CLOCK, ...FAST });
  const p = await lease.payDue();
  assert.equal(p.status, "skipped");
  assert.match(p.reason ?? "", /insufficient balance/);
  assert.equal(lease.periodsPaid, 0);
  assert.equal(lease.consecutiveMisses, 1);
  assert.equal(skips.length, 1);
});

test("rent resumes once revenue arrives (replenish-from-revenue)", async () => {
  const n = payer(0n);
  const lease = new StreamingLease({ rpc: n.rpc, terms: terms(), ...CHANNEL, ...CLOCK, ...FAST });
  assert.equal((await lease.payDue()).status, "skipped"); // no sales yet
  n.state.spendable = 1_000_000n; // a customer paid the merchant
  const p = await lease.payDue();
  assert.equal(p.status, "paid");
  assert.equal(lease.periodsPaid, 1);
  assert.equal(lease.consecutiveMisses, 0); // reset by the successful payment
});

test("consecutive misses beyond grace fire onLapse exactly once", async () => {
  const lapses: LapseInfo[] = [];
  const lease = new StreamingLease({
    rpc: payer(0n).rpc,
    terms: terms({ grace_periods: 1 }),
    ...CHANNEL,
    handlers: { onLapse: (l) => lapses.push(l) },
    ...CLOCK,
    ...FAST,
  });
  await lease.payDue(); // miss 1 (1 > 1? no)
  assert.equal(lease.lapsed, false);
  await lease.payDue(); // miss 2 (2 > 1 → lapse)
  assert.equal(lease.lapsed, true);
  await lease.payDue(); // miss 3 — must not re-fire
  assert.equal(lapses.length, 1);
  assert.equal(lapses[0].grace, 1);
  assert.equal(lapses[0].consecutiveMisses, 2);
});

test("start streams rent once per period until stopped", async () => {
  const n = payer(10_000_000n);
  const lease = new StreamingLease({ rpc: n.rpc, terms: terms(), ...CHANNEL, ...CLOCK, ...FAST });
  let handle: { stop: () => void; done: Promise<void> };
  handle = lease.start({
    intervalMs: 0,
    sleep: async () => {
      if (lease.periodsPaid >= 3) handle.stop();
    },
  });
  await handle.done;
  assert.ok(lease.periodsPaid >= 3);
  assert.equal(lease.totalPaid, String(500000 * lease.periodsPaid));
});

test("payDue prices each period from the bound channel's live remaining inbound", async () => {
  const n = payer(600_000_000n, 400_000_000n);
  const lease = new StreamingLease({ rpc: n.rpc, terms: terms(), ...CHANNEL, ...CLOCK, ...FAST });

  const first = await lease.payDue();
  assert.equal(first.status, "paid");
  assert.equal(first.remainingInbound, "400000000");
  assert.equal(first.amount, "200000");

  n.state.spendable += 200_000_000n;
  n.state.remainingInbound -= 200_000_000n;
  const second = await lease.payDue();
  assert.equal(second.status, "paid");
  assert.equal(second.remainingInbound, "200200000");
  assert.equal(second.amount, "100100");
});

test("payDue does not use another channel when the bound channel is absent", async () => {
  const n = payer(1_000_000n);
  const lease = new StreamingLease({
    rpc: n.rpc,
    terms: terms(),
    channelId: "0xanother-lease",
    ...CLOCK,
    ...FAST,
  });

  const result = await lease.payDue();
  assert.equal(result.status, "skipped");
  assert.match(result.reason ?? "", /bound lease channel.*not found/i);
  assert.equal(n.state.sent.length, 0);
});

test("zero remaining inbound settles a zero-rent period without sending a payment", async () => {
  const n = payer(1_000_000_000n, 0n);
  const lease = new StreamingLease({ rpc: n.rpc, terms: terms(), ...CHANNEL, ...CLOCK, ...FAST });

  const result = await lease.payDue();
  assert.equal(result.status, "paid");
  assert.equal(result.remainingInbound, "0");
  assert.equal(result.amount, "0");
  assert.equal(result.payment_hash, undefined);
  assert.equal(n.state.sent.length, 0);
});

test("payDue derives the rent recipient from the bound channel peer", async () => {
  const payingNode = "02" + "ab".repeat(32);
  const n = payer(1_000_000n, 1_000_000_000n, payingNode);
  const lease = new StreamingLease({ rpc: n.rpc, terms: terms(), ...CHANNEL, ...CLOCK, ...FAST });

  assert.equal((await lease.payDue()).status, "paid");
  assert.equal(n.state.sent[0].target, payingNode);
});
