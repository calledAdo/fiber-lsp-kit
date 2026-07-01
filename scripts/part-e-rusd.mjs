// Part E (RUSD) — THE HERO. Client SDK -> REST server -> node #1 opens a real RUSD (UDT) channel
// toward node #2 with the client contributing ZERO RUSD -> ChannelReady -> order channel_active.
// The client ends up able to RECEIVE RUSD having never held any. Impossible on Lightning.
import { LspClient } from "../packages/client/dist/index.js";
import { udtAsset } from "../packages/protocol/dist/index.js";

const RUSD = udtAsset(
  {
    code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
    hash_type: "type",
    args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
  },
  "RUSD",
);

const CLIENT_PUBKEY = "0344f85475b59dd4427fd7e37e581c9d1d99d74d7d69aa95bd8a538d4ec4e87283";
const CLIENT_ADDR = "/ip4/127.0.0.1/tcp/8238/p2p/QmRfWSYZEdXbqsgieWn63Zw3Az3dg6tTMcBKdtGUXhEQxF";

const lsp = new LspClient({ baseUrl: "http://127.0.0.1:8080" });

console.log("== buyInboundLiquidity: 10 RUSD inbound, prepaid (fee in CKB) ==");
const order = await lsp.buyInboundLiquidity({
  asset: RUSD,
  amount: "1000000000", // 10 RUSD (8 decimals); must be >= client auto_accept_amount floor (10 RUSD)
  feeMode: "prepaid",
  targetPubkey: CLIENT_PUBKEY,
  targetAddress: CLIENT_ADDR,
  public: true,
  waitOpts: { attempts: 80, intervalMs: 3000 },
  payFee: async (p) => {
    // prepaid fee is CKB. A zero-capital client has no Fiber outbound, so the real payment is
    // out-of-band CKB (on-chain / pre-existing channel). For this proof we log the invoice and let
    // settleFee provision — the RUSD channel open is the thing under test.
    console.log(`  [fee] pay ${p.amount} shannons CKB out-of-band; invoice: ${p.fee_invoice?.slice(0, 24)}…`);
  },
});

console.log("== result ==");
console.log("  order_id:", order.order_id);
console.log("  state:", order.state);
console.log("  asset:", order.request.asset.symbol ?? order.request.asset.kind);
console.log("  fee.total_fee:", order.fee.total_fee, "shannons (CKB)");
console.log("  channel_outpoint:", order.channel_outpoint ?? "(none)");
if (order.state !== "channel_active") {
  console.log("  failure_reason:", order.failure_reason ?? "(none)");
  process.exit(1);
}
console.log("\nPASS: client can now RECEIVE 10 RUSD — having never held any RUSD. That is impossible on Lightning.");
