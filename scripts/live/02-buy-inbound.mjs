// LIVE STEP 2 — take the LSP's offer and OPEN A PUBLIC RUSD CHANNEL. Merchant funds ZERO.
//
//   (requires the LSP reference server running — see scripts/live/README.md)
//
// Uses the wallet SDK `LspClient` against the LSP's REST API (the real wallet↔LSP integration): quote →
// order → pay fee (out-of-band CKB for a zero-capital merchant) → poll until the channel is active.
//
// Config comes from the selected network profile (NETWORK=<name>, default testnet). See lib/profile.mjs.
import { LspClient } from "../../packages/client/dist/index.js";
import { loadProfile, loadState } from "./lib/profile.mjs";

const P = loadProfile();
const { base_url, amount } = loadState("lsp");
const lsp = new LspClient({ baseUrl: base_url });

console.log(`\n=== STEP 2 · Take the offer → open a public ${P.asset.symbol} channel for ${P.fmt(amount)} inbound (merchant funds 0)  [${P.name}] ===`);
const order = await lsp.buyInboundLiquidity({
  asset: P.udt,
  amount,
  feeMode: "prepaid",
  targetPubkey: P.nodes.merchant.pubkey,
  targetAddress: P.nodes.merchant.address,
  public: true,
  payFee: async (p) => console.log(`   [fee] pay ${p.amount} shannons CKB out-of-band  (invoice ${p.fee_invoice?.slice(0, 20)}…)`),
  waitOpts: { attempts: 120, intervalMs: 5000 }, // on-chain funding confirmation
});
console.log(`   order ${order.order_id} → ${order.state}`);
if (order.state !== "channel_active") { console.error(`   ❌ ${order.failure_reason ?? order.state}`); process.exit(1); }
console.log(`   ✅ channel_active — outpoint ${order.channel_outpoint}`);
console.log(`   merchant now holds ${P.fmt(amount)} of inbound it can receive over (funded 0)`);
