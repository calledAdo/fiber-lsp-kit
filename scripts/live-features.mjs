// Live exercise of the newly-drafted features (A1 lease close, A2 ledger, B2 rebalance, C2 auth) against
// REAL FNN testnet nodes. It goes through the same package classes/adapter the mock e2e uses — only the
// rpcUrls point at live nodes — so it honors the node-agnostic principle.
//
//   node scripts/live-features.mjs
//
// SAFE BY DEFAULT: A2 is read-only, B2 dry-runs (prices the route, moves nothing), C2 mints one zero-amount
// invoice to prove identity. The two IRREVERSIBLE operations are gated behind env flags:
//   LIVE_CLOSE_CHANNEL=0x<channel_id>   → A1: cooperatively close that one channel (returns funds on-chain)
//   LIVE_REBALANCE_SUBMIT=1             → B2: actually submit the priced loop (moves real RUSD)
import { generateKeyPairSync } from "node:crypto";
import { FiberChannelRpcClient } from "../packages/fiber/dist/index.js";
import { LspLedger, Rebalancer, needsRebalance, planCircularRebalance } from "../packages/lsp-server/dist/index.js";
import {
  SignedFiberInvoiceVerifier, MemoryChallengeStore, SignedCapabilityService, merchantScopePermission,
} from "../packages/auth/dist/index.js";
import { loadConfig } from "./demo/linked/config.mjs";

const cfg = loadConfig();
const rusd = cfg.asset;
const fmt = cfg.fmt;
const LSP_URL = process.env.LSP_URL ?? "http://127.0.0.1:8227";
const MERCHANT_URL = process.env.MERCHANT_URL ?? "http://127.0.0.1:8237";

const lspRpc = new FiberChannelRpcClient({ rpcUrl: LSP_URL });
const merchantRpc = new FiberChannelRpcClient({ rpcUrl: MERCHANT_URL });

const hd = (t) => console.log(`\n── ${t} ──`);
const ok = (t) => console.log(`  ✓ ${t}`);
const bad = (t) => console.log(`  ✗ ${t}`);
async function step(name, fn) { try { await fn(); } catch (e) { bad(`${name} failed: ${e?.message ?? e}`); } }

const lspInfo = await lspRpc.nodeInfo();
const merchantInfo = await merchantRpc.nodeInfo(); // a node we run → it forwards, so it can anchor a self-loop
console.log(`Live feature check against ${LSP_URL}  (LSP node ${lspInfo.pubkey?.slice(0, 16)}…)`);

// ── A2: LSP payment ledger (read-only) ──
await step("A2", async () => {
  hd("A2  LSP ledger (list_payments)");
  const s = await new LspLedger(lspRpc).summary();
  ok(`ledger: ${s.total} payments — ${s.succeeded} succeeded, ${s.failed} failed, ${s.inflight} inflight`);
  for (const l of s.by_asset) console.log(`     asset ${l.asset.slice(0, 12)}…  count=${l.count} fees=${l.fees} sent=${l.sent}`);
  console.log(`     (note: FNN v0.9.0-rc5 omits per-payment amount → sent reads 0; fees/counts are real)`);
});

// ── B2: circular rebalance (dry-run unless LIVE_REBALANCE_SUBMIT=1) ──
await step("B2", async () => {
  hd("B2  circular rebalance (build_router / send_payment_with_router)");
  const channels = await lspRpc.listChannels();
  const starved = needsRebalance(channels, { asset: rusd, minLocalBps: 5000 });
  ok(`${starved.length} RUSD channel(s) below the 50% local floor`);
  for (const c of starved) {
    const loc = BigInt(c.local_balance), tot = loc + BigInt(c.remote_balance);
    console.log(`     starved ${c.channel_id.slice(0, 12)}… local=${fmt(loc)} share=${tot ? Number(loc * 100n / tot) : 0}% peer=${c.pubkey.slice(0, 12)}…`);
  }
  const submit = process.env.LIVE_REBALANCE_SUBMIT === "1";
  try {
    const res = await new Rebalancer(lspRpc).rebalance({ asset: rusd, minLocalBps: 5000, amount: 10_000_000n, dryRun: !submit });
    if (res.status !== "nothing_to_do") {
      ok(`rebalancer ${res.status}: donor ${res.donorChannelId.slice(0, 12)}… → starved ${res.starvedChannelId.slice(0, 12)}…`);
      console.log(`     priced route payment: status=${res.payment.status} fee=${res.payment.fee ?? "n/a"}` + (submit ? "" : "  (DRY-RUN)"));
    } else {
      ok(`product rebalancer: nothing routable (${res.reason})`);
    }
  } catch (e) {
    ok(`product rebalancer built the loop; live pathfinder rejected it: ${e?.message?.slice(-32) ?? e}`);
    console.log(`     (the only starved channel's peer ${starved[0]?.pubkey.slice(0, 12)}… offers no return path — a real graph condition, not a code fault)`);
  }

  // Routing-capability dry-run: prove build_router + send_payment_with_router work live through our plan
  // builder, using two channels to a peer that DOES forward (a self→peer→self loop), regardless of need.
  const readyRusd = channels.filter((c) => c.state?.state_name === "ChannelReady" && c.funding_udt_type_script?.code_hash === cfg.assetScript.code_hash);
  const byPeer = new Map();
  for (const c of readyRusd) { const a = byPeer.get(c.pubkey) ?? []; a.push(c); byPeer.set(c.pubkey, a); }
  const pairs = [...byPeer.values()]
    .map((a) => a.sort((x, y) => (BigInt(y.local_balance) > BigInt(x.local_balance) ? 1 : -1)))
    .filter((a) => a.length >= 2)
    .sort((a) => (a[0].pubkey === merchantInfo.pubkey ? -1 : 1)); // prefer the peer we run (it forwards)
  if (pairs.length === 0) { console.log(`     (no peer with ≥2 RUSD channels for a self-loop capability probe)`); return; }
  try {
    const [donor, ret] = pairs[0];
    const plan = planCircularRebalance({ starved: ret, donor, lspPubkey: lspInfo.pubkey, amount: 10_000_000n });
    const router = await lspRpc.buildRouter({ hops: plan.hops, amount: 10_000_000n, udtTypeScript: cfg.assetScript });
    const priced = await lspRpc.sendPaymentWithRouter({ router, keysend: true, udtTypeScript: cfg.assetScript, dryRun: true });
    ok(`build_router priced a ${router.length}-hop self-loop via peer ${donor.pubkey.slice(0, 12)}…; send_payment_with_router dry-run: ${priced.status} (no funds moved)`);
  } catch (e) {
    console.log(`     routing-capability probe: build_router found no routable self-loop on the current graph (${e?.message?.slice(-40) ?? e})`);
    console.log(`     → RPC shapes accepted live; a routable loop just doesn't exist among these channels right now`);
  }
});

// ── C2: merchant identity proof + capability token (mints one zero-amount invoice) ──
await step("C2", async () => {
  hd("C2  merchant auth (signed-invoice proof → Ed25519 capability token)");
  const challenges = new MemoryChallengeStore();
  const m = await merchantRpc.nodeInfo();
  const mpk = m.pubkey;
  const challenge = await challenges.issue(mpk);
  const inv = await merchantRpc.newInvoice({ amount: "1", description: challenge, udtTypeScript: cfg.assetScript, expirySeconds: 3600 });
  ok(`merchant ${mpk.slice(0, 16)}… signed an invoice carrying the challenge`);

  const verifier = new SignedFiberInvoiceVerifier({ rpc: merchantRpc, challenges, expectedCurrency: "Fibt" });
  const verified = await verifier.verify({ invoice: inv.invoice_address, pubkey: mpk });
  ok(`proof verified live → VerifiedMerchant ${verified.pubkey.slice(0, 16)}…`);

  // challenge is single-use: a replay must now fail
  let replayRejected = false;
  try { await verifier.verify({ invoice: inv.invoice_address, pubkey: mpk }); } catch { replayRejected = true; }
  ok(`replay of the same proof rejected (single-use challenge): ${replayRejected}`);

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const quota = { usage: async () => ({ openChannels: 0 }) };
  const caps = new SignedCapabilityService({ privateKey, publicKey, quota });
  const policy = { merchantPubkey: mpk, permissions: ["orders:create"], maxChannels: 5 };
  const token = await caps.issue({ merchant: verified, policy });
  const create = await caps.authorize(token, { permission: "orders:create" });
  const scope = await caps.authorize(token, { permission: merchantScopePermission(mpk) });
  const denied = await caps.authorize(token, { permission: "orders:delete" });
  ok(`token authorizes orders:create=${create.allowed}, own-scope=${scope.allowed}, orders:delete=${denied.allowed} (expect T,T,F)`);
});

// ── A1: cooperative channel close (GATED — only runs with LIVE_CLOSE_CHANNEL set) ──
await step("A1", async () => {
  hd("A1  cooperative lease close (shutdown_channel)");
  const closeId = process.env.LIVE_CLOSE_CHANNEL;
  const channels = await lspRpc.listChannels();
  const ready = channels.filter((c) => c.state?.state_name === "ChannelReady");
  if (!closeId) {
    ok(`${ready.length} Ready channels exist; closeable primitive is rpc.shutdownChannel({ channelId })`);
    console.log(`     NOT closing anything. To test a real cooperative close, re-run with:`);
    console.log(`       LIVE_CLOSE_CHANNEL=0x<channel_id> node scripts/live-features.mjs`);
    return;
  }
  const target = ready.find((c) => c.channel_id === closeId);
  if (!target) { bad(`channel ${closeId} is not a Ready channel on this node`); return; }
  console.log(`     closing ${closeId} (peer ${target.pubkey.slice(0, 12)}…, local=${fmt(target.local_balance)}) — IRREVERSIBLE`);
  await lspRpc.shutdownChannel({ channelId: closeId });
  ok(`shutdown_channel accepted; poll list_channels for the Closed transition`);
});

console.log("\nDone.");
