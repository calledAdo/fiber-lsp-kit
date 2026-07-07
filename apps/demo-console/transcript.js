// Replay transcript — real values captured from the live 2-node testnet run (see ../../LIVE_RESULTS.md).
// The console replays these so the demo needs no live node. Nothing here is invented: order id, fee,
// channel outpoint, payment hash and balances are the actual figures from the recorded RUSD flow.
export const LSP_PUBKEY = "023dda5d5349345ca6a26e7389f2f52e59d85f4f833617865675078e8964230109";
export const CLIENT_PUBKEY = "0344f85475b59dd4427fd7e37e581c9d1d99d74d7d69aa95bd8a538d4ec4e87283";

const RUSD_ASSET = {
  kind: "UDT",
  symbol: "RUSD",
  scriptHex:
    "0x550000001000000030000000310000001142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a0120000000878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};

export const TRANSCRIPT = {
  // GET /lsp/v1/info
  info: {
    lsp_pubkey: LSP_PUBKEY,
    addresses: ["/ip4/127.0.0.1/tcp/8228"],
    chain: "testnet",
    fee_modes: ["prepaid", "from_capacity"],
    order_expiry_seconds: 3600,
    operator: "fiber-lsp-kit reference server",
    supported_assets: [
      {
        asset: { kind: "CKB" },
        min_capacity: "10000000000",
        max_capacity: "10000000000000",
        fee_schedule: { base_fee: "1000000000", proportional_bps: 100 },
      },
      {
        asset: RUSD_ASSET,
        min_capacity: "1000000000",
        max_capacity: "100000000000",
        fee_schedule: { base_fee: "1000000000", proportional_bps: 0 },
      },
    ],
  },

  // The order lifecycle for "buy 10 RUSD inbound, prepaid". Each entry is the order object as the API
  // returns it at that stage (order_id / fee / outpoint are the real recorded values).
  order_id: "544e03e3-3fa3-429a-a668-578ac0d58270",
  fee_total: "1000000000", // 10 CKB
  channel_outpoint: "0x12f252a46f6504870efe284f9f1b540c1192ded02fb8085f5b322b55b3f0b8f7:0",
  fee_invoice: "fibt10000000001p...prepaid-ckb-fee",

  request: {
    target_pubkey: CLIENT_PUBKEY,
    asset: RUSD_ASSET,
    lsp_balance: "1000000000", // 10 RUSD
    fee_mode: "prepaid",
    public: true,
  },

  // Part F — the client receives 5 RUSD over the purchased inbound (0 → 5 RUSD).
  receive: {
    payment_hash: "0x5b393cffcd231d91c9d902679c74cc72c977450de8e948534678865f8db2bf32",
    amount: "500000000", // 5 RUSD
    before: "0",
    after: "500000000",
  },

  // GET /lsp/v1/liquidity after the flow (real snapshot).
  liquidity: {
    lsp_pubkey: LSP_PUBKEY,
    generated_at: 1782987903,
    assets: [
      { asset: RUSD_ASSET, channel_count: 2, ready_channel_count: 2, outbound: "1500000000", inbound: "500000000" },
      { asset: { kind: "CKB" }, channel_count: 3, ready_channel_count: 3, outbound: "45300000000", inbound: "5000000000" },
    ],
  },
};
