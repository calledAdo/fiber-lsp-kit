export interface VerifiedMerchant {
  pubkey: string;
  verifiedAt: number;
}

export interface MerchantProofVerifier {
  verify(proof: unknown): Promise<VerifiedMerchant>;
}

export interface MerchantPolicy {
  merchantPubkey: string;
  maxChannels?: number;
  permissions: string[];
}

export interface MerchantPolicyStore {
  get(pubkey: string): Promise<MerchantPolicy | undefined>;
  put(policy: MerchantPolicy): Promise<void>;
}

export interface MerchantQuotaUsage {
  openChannels: number;
}

export interface MerchantQuotaProvider {
  usage(pubkey: string): Promise<MerchantQuotaUsage>;
}

export interface MerchantCapabilityContext {
  merchant: VerifiedMerchant;
  policy: MerchantPolicy;
}

export interface AuthorizationRequest {
  permission: string;
}

export type AuthDecision =
  | { allowed: true }
  | { allowed: false; code: string; reason: string };

export interface MerchantCapabilityService {
  issue(ctx: MerchantCapabilityContext): Promise<string>;
  authorize(token: string, req: AuthorizationRequest): Promise<AuthDecision>;
}

export interface ChallengeStore {
  issue(pubkey: string): Promise<string>;
  consume(pubkey: string, challenge: string): Promise<boolean>;
}
