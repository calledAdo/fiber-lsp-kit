// DEMO STEP 2 — the merchant GENERATES AN INVOICE.
//
//   node <this>
//
// The merchant node (node#3) mints a node-native RUSD invoice via the kit's `InvoiceService`, prints the
// payable string + payment hash (the QR payload), and saves it to `.invoice.json` for step 3.
import { FiberChannelRpcClient, udtAsset } from "../../packages/protocol/dist/index.js";
import { InvoiceService } from "../../packages/client/dist/index.js";
import { writeFileSync } from "node:fs";

const RUSD = udtAsset(
  { code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a", hash_type: "type",
    args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b" }, "RUSD");

const MERCHANT_RPC = process.env.MERCHANT_RPC ?? "http://127.0.0.1:8247";
const AMOUNT = process.env.AMOUNT ?? "300000000"; // 3 RUSD

const svc = new InvoiceService({ rpc: new FiberChannelRpcClient({ rpcUrl: MERCHANT_RPC }) });

console.log(`\n=== STEP 3 · Merchant issues an invoice for ${Number(BigInt(AMOUNT)) / 1e8} RUSD ===`);
const issued = await svc.issue({ asset: RUSD, amount: AMOUNT, description: "demo order" });
console.log(`   invoice:      ${issued.invoice}`);
console.log(`   payment_hash: ${issued.paymentHash}`);
console.log(`   qr_payload → encode this in the wallet QR: ${issued.invoice}`);

writeFileSync(
  new URL("./.invoice.json", import.meta.url),
  JSON.stringify({ invoice: issued.invoice, payment_hash: issued.paymentHash, amount: AMOUNT }, null, 2),
);
console.log("   (saved to scripts/demo/.invoice.json — step 3 reads it)");
