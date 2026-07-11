// LIVE STEP 3 — the merchant GENERATES AN INVOICE.
//
// The merchant node mints a node-native RUSD invoice via the kit's `InvoiceService`, prints the payable
// string + payment hash (the QR payload), and saves it for step 4.
//
// Config comes from the selected network profile (NETWORK=<name>, default testnet). See lib/profile.mjs.
import { FiberChannelRpcClient } from "../../packages/fiber/dist/index.js";
import { InvoiceService } from "../../packages/client/dist/index.js";
import { loadProfile, saveState } from "./lib/profile.mjs";

const P = loadProfile();
const AMOUNT = P.amounts.invoice;

const svc = new InvoiceService({ rpc: new FiberChannelRpcClient({ rpcUrl: P.nodes.merchant.rpc }) });

console.log(`\n=== STEP 3 · Merchant issues an invoice for ${P.fmt(AMOUNT)}  [${P.name}] ===`);
const issued = await svc.issue({ asset: P.udt, amount: AMOUNT, description: "demo order" });
console.log(`   invoice:      ${issued.invoice}`);
console.log(`   payment_hash: ${issued.paymentHash}`);
console.log(`   qr_payload → encode this in the wallet QR: ${issued.invoice}`);

saveState("invoice", { invoice: issued.invoice, payment_hash: issued.paymentHash, amount: AMOUNT });
console.log("   (saved to scripts/live/.state/invoice.json — step 4 reads it)");
