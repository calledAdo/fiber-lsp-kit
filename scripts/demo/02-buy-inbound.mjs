// DEMO STEP 2 — take the LSP's offer and OPEN A PUBLIC RUSD CHANNEL. Merchant funds ZERO.
//
//   node <this>       (requires the LSP reference server running — see scripts/demo/README.md)
//
// Uses the wallet SDK `LspClient` against the LSP's REST API (the real wallet↔LSP integration): quote →
// order → pay fee (out-of-band CKB for a zero-capital merchant) → poll until the channel is active.
import { udtAsset } from "../../packages/protocol/dist/index.js";
import { LspClient } from "../../packages/client/dist/index.js";
import { readFileSync } from "node:fs";

const RUSD = udtAsset(
  { code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a", hash_type: "type",
    args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b" }, "RUSD");

const MERCHANT_PUBKEY = process.env.MERCHANT_PUBKEY ?? "023f29ba8a73ebe47aa8bbc120aac4f5daa562327136e25a4c9c5267abe1d7e631";
const MERCHANT_ADDR = process.env.MERCHANT_ADDR ?? "/ip4/127.0.0.1/tcp/8248/p2p/QmZVFHXpd51kNWynudyNRKegCGRhGdeERHodi2CqJPvCTr";
const n = (v) => Number(BigInt(v)) / 1e8;

const { base_url, amount } = JSON.parse(readFileSync(new URL("./.lsp.json", import.meta.url)));
const lsp = new LspClient({ baseUrl: base_url });

console.log(`\n=== STEP 2 · Take the offer → open a public RUSD channel for ${n(amount)} RUSD inbound (merchant funds 0) ===`);
const order = await lsp.buyInboundLiquidity({
  asset: RUSD,
  amount,
  feeMode: "prepaid",
  targetPubkey: MERCHANT_PUBKEY,
  targetAddress: MERCHANT_ADDR,
  public: true,
  payFee: async (p) => console.log(`   [fee] pay ${p.amount} shannons CKB out-of-band  (invoice ${p.fee_invoice?.slice(0, 20)}…)`),
  waitOpts: { attempts: 120, intervalMs: 5000 }, // on-chain funding confirmation
});
console.log(`   order ${order.order_id} → ${order.state}`);
if (order.state !== "channel_active") { console.error(`   ❌ ${order.failure_reason ?? order.state}`); process.exit(1); }
console.log(`   ✅ channel_active — outpoint ${order.channel_outpoint}`);
console.log(`   merchant now holds ${n(amount)} RUSD of inbound it can receive over (funded 0)`);
