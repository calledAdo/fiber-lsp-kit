import { invoiceAttr, type FiberChannelRpcClient } from "@fiberlsp/fiber";
import type { ChallengeStore, MerchantProofVerifier, VerifiedMerchant } from "./types.js";
import { normalizePubkey } from "./normalize.js";

export interface SignedFiberInvoiceVerifierConfig {
  rpc: FiberChannelRpcClient;
  challenges: ChallengeStore;
  expectedCurrency: string;
  now?: () => number;
}

export class SignedFiberInvoiceVerifier implements MerchantProofVerifier {
  private readonly now: () => number;

  constructor(private readonly config: SignedFiberInvoiceVerifierConfig) {
    this.now = config.now ?? Date.now;
  }

  async verify(proof: unknown): Promise<VerifiedMerchant> {
    if (!isProof(proof)) throw new Error("proof must be { invoice, pubkey }");
    const pubkey = normalizePubkey(proof.pubkey);
    if (!pubkey) throw new Error("proof pubkey is required");

    const parsed = await this.config.rpc.parseInvoice(proof.invoice);
    if (!parsed.invoice.signature) throw new Error("invoice signature is required");
    if (parsed.invoice.currency !== this.config.expectedCurrency) {
      throw new Error(`invoice currency must be ${this.config.expectedCurrency}`);
    }

    const payee = invoiceAttr(parsed, "payee_public_key");
    if (!payee || normalizePubkey(payee) !== pubkey) throw new Error("invoice payee does not match proof pubkey");

    const timestamp = parsed.invoice.data?.timestamp;
    const expiry = invoiceAttr(parsed, "expiry_time");
    if (!timestamp || !expiry) throw new Error("invoice timestamp and expiry_time are required");
    let expiresAt: bigint;
    try {
      expiresAt = BigInt(timestamp) + BigInt(expiry) * 1000n;
    } catch {
      throw new Error("invoice timestamp or expiry_time is invalid");
    }
    if (BigInt(this.now()) >= expiresAt) throw new Error("invoice is expired");

    const challenge = invoiceAttr(parsed, "description");
    if (!challenge || !(await this.config.challenges.consume(pubkey, challenge))) {
      throw new Error("invoice challenge is unknown, expired, or already used");
    }
    return { pubkey, verifiedAt: this.now() };
  }
}

function isProof(value: unknown): value is { invoice: string; pubkey: string } {
  if (!value || typeof value !== "object") return false;
  const proof = value as Record<string, unknown>;
  return typeof proof.invoice === "string" && proof.invoice.length > 0 && typeof proof.pubkey === "string";
}
