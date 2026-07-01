// Part D (CKB) — drive the full LSP stack live: client SDK -> REST server -> node #1 opens a
// real CKB channel toward node #2 -> ChannelReady -> order channel_active.
//
// Proves the whole server+client pipeline against live FNN nodes. The RUSD zero-capital hero
// reuses this exact path once node #1 holds RUSD.
import { LspClient } from "../packages/client/dist/index.js";
import { CKB } from "../packages/protocol/dist/index.js";

const CLIENT_PUBKEY = "0344f85475b59dd4427fd7e37e581c9d1d99d74d7d69aa95bd8a538d4ec4e87283";
// Dial address: /p2p/<peer-id> where peer-id is base58(0x1220 ‖ sha256(compressed-pubkey)),
// NOT the hex pubkey. (A bare multiaddr connects at the transport level but never completes the
// fiber Init handshake, so open_channel fails.)
const CLIENT_ADDR = "/ip4/127.0.0.1/tcp/8238/p2p/QmRfWSYZEdXbqsgieWn63Zw3Az3dg6tTMcBKdtGUXhEQxF";

const lsp = new LspClient({ baseUrl: "http://127.0.0.1:8080" });

console.log("== LSP info ==");
const info = await lsp.getInfo();
console.log("  lsp_pubkey:", info.lsp_pubkey);
console.log("  fee_modes:", info.fee_modes.join(", "));

console.log("== buyInboundLiquidity: 300 CKB inbound, from_capacity ==");
const order = await lsp.buyInboundLiquidity({
  asset: CKB,
  amount: "30000000000", // 300 CKB inbound (LSP-funded)
  feeMode: "from_capacity",
  targetPubkey: CLIENT_PUBKEY,
  targetAddress: CLIENT_ADDR,
  clientBalance: "9900000000", // 99 CKB (node #2 auto-funds this); >= 13 CKB fee
  public: true,
  waitOpts: { attempts: 80, intervalMs: 3000 },
  payFee: async (p) => {
    // from_capacity: fee is due in-channel after active. For this live proof we log it;
    // the channel provisioning is the thing under test.
    console.log(`  [fee] ${p.amount} CKB due in-channel (mode=${p.mode}) — skipping actual send for the proof`);
  },
});

console.log("== result ==");
console.log("  order_id:", order.order_id);
console.log("  state:", order.state);
console.log("  fee.total_fee:", order.fee.total_fee, "shannons");
console.log("  channel_outpoint:", order.channel_outpoint ?? "(none)");
if (order.state !== "channel_active") {
  console.log("  failure_reason:", order.failure_reason ?? "(none)");
  process.exit(1);
}
console.log("\nPASS: LSP provisioned a live CKB inbound channel; order is channel_active.");
