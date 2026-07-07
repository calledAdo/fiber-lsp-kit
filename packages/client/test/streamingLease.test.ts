import { test } from "node:test";
import assert from "node:assert/strict";
import { FiberChannelRpcClient, udtAsset, type LeaseTerms, type UdtTypeScript } from "@fiberlsp/protocol";
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
function payer(spendable: bigint) {
  const state = { spendable, sent: [] as { hash: string; amount: bigint }[] };
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
        state.sent.push({ hash, amount });
        state.spendable -= amount; // rent leaves the merchant → toward the LSP (restores inbound)
        result = { payment_hash: hash, status: "Created", fee: "0x0" }; // terminal via get_payment
      }
    } else if (method === "get_payment") {
      result = { payment_hash: p.payment_hash, status: "Success", fee: "0x0" };
    }
    return { json: async () => ({ jsonrpc: "2.0", id, result, error }) };
  };
  return { state, rpc: new FiberChannelRpcClient({ rpcUrl: "http://m", fetchImpl }) };
}

const CLOCK = { now: () => 1_700_000_000 };
const FAST = { poll: { attempts: 5, intervalMs: 0, sleep: async () => {} } };

test("rent() is the per-period rent in base units", () => {
  const lease = new StreamingLease({ rpc: payer(0n).rpc, lspPubkey: LSP, terms: terms(), ...CLOCK, ...FAST });
  assert.equal(lease.rent(), "500000");
});

test("payDue settles rent by keysend when affordable", async () => {
  const n = payer(1_000_000n); // has revenue
  const paid: RentPayment[] = [];
  const lease = new StreamingLease({ rpc: n.rpc, lspPubkey: LSP, terms: terms(), handlers: { onPaid: (p) => paid.push(p) }, ...CLOCK, ...FAST });
  const p = await lease.payDue();
  assert.equal(p.status, "paid");
  assert.equal(p.amount, "500000");
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
  const lease = new StreamingLease({ rpc: payer(0n).rpc, lspPubkey: LSP, terms: terms(), handlers: { onSkip: (p) => skips.push(p) }, ...CLOCK, ...FAST });
  const p = await lease.payDue();
  assert.equal(p.status, "skipped");
  assert.match(p.reason ?? "", /insufficient balance/);
  assert.equal(lease.periodsPaid, 0);
  assert.equal(lease.consecutiveMisses, 1);
  assert.equal(skips.length, 1);
});

test("rent resumes once revenue arrives (replenish-from-revenue)", async () => {
  const n = payer(0n);
  const lease = new StreamingLease({ rpc: n.rpc, lspPubkey: LSP, terms: terms(), ...CLOCK, ...FAST });
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
    lspPubkey: LSP,
    terms: terms({ grace_periods: 1 }),
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
  const lease = new StreamingLease({ rpc: n.rpc, lspPubkey: LSP, terms: terms(), ...CLOCK, ...FAST });
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
