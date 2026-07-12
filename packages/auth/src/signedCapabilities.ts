import {
  sign,
  verify,
  type KeyLike,
} from "node:crypto";
import type {
  AuthDecision,
  AuthorizationRequest,
  MerchantCapabilityContext,
  MerchantCapabilityService,
  MerchantQuotaProvider,
} from "./types.js";
import { normalizePubkey } from "./normalize.js";

const TOKEN_PREFIX = "fiberlsp1";
const SCOPE_PREFIX = "merchant:act-as:";

interface SignedCapabilityPayload {
  version: 1;
  merchantPubkey: string;
  permissions: string[];
  maxChannels?: number;
  issuedAt: number;
}

export interface SignedCapabilityServiceConfig {
  privateKey?: KeyLike;
  publicKey: KeyLike;
  quota: MerchantQuotaProvider;
  now?: () => number;
}

export function merchantScopePermission(pubkey: string): string {
  return SCOPE_PREFIX + normalizePubkey(pubkey);
}

export class SignedCapabilityService implements MerchantCapabilityService {
  private readonly now: () => number;

  constructor(private readonly config: SignedCapabilityServiceConfig) {
    this.now = config.now ?? Date.now;
  }

  async issue(ctx: MerchantCapabilityContext): Promise<string> {
    if (!this.config.privateKey) throw new Error("privateKey is required to issue capabilities");
    const merchantPubkey = normalizePubkey(ctx.merchant.pubkey);
    if (!merchantPubkey || merchantPubkey !== normalizePubkey(ctx.policy.merchantPubkey)) {
      throw new Error("verified merchant does not match policy merchantPubkey");
    }
    const payload: SignedCapabilityPayload = {
      version: 1,
      merchantPubkey,
      permissions: [...ctx.policy.permissions],
      ...(ctx.policy.maxChannels === undefined ? {} : { maxChannels: ctx.policy.maxChannels }),
      issuedAt: this.now(),
    };
    const header = encode({ alg: "EdDSA", typ: "FIBERLSP-CAP" });
    const body = encode(payload);
    const signingInput = `${header}.${body}`;
    const signature = sign(null, Buffer.from(signingInput), this.config.privateKey).toString("base64url");
    return `${TOKEN_PREFIX}.${signingInput}.${signature}`;
  }

  async authorize(token: string, req: AuthorizationRequest): Promise<AuthDecision> {
    const payload = this.decode(token);
    if (!payload) return denied("invalid_token", "capability token is invalid");

    if (req.permission.startsWith(SCOPE_PREFIX)) {
      if (req.permission !== merchantScopePermission(payload.merchantPubkey)) {
        return denied("merchant_mismatch", "capability is bound to a different merchant");
      }
    } else if (!payload.permissions.includes(req.permission)) {
      return denied("permission_denied", `capability does not grant ${req.permission}`);
    }

    if (payload.maxChannels !== undefined) {
      const usage = await this.config.quota.usage(payload.merchantPubkey);
      if (usage.openChannels >= payload.maxChannels) {
        return denied("quota_exceeded", "merchant has reached maxChannels");
      }
    }
    return { allowed: true };
  }

  private decode(token: string): SignedCapabilityPayload | undefined {
    const [prefix, header, body, signature, extra] = token.split(".");
    if (prefix !== TOKEN_PREFIX || !header || !body || !signature || extra !== undefined) return undefined;
    const signingInput = `${header}.${body}`;
    let valid = false;
    try {
      const signatureBytes = Buffer.from(signature, "base64url");
      if (signatureBytes.toString("base64url") !== signature) return undefined;
      valid = verify(null, Buffer.from(signingInput), this.config.publicKey, signatureBytes);
    } catch {
      return undefined;
    }
    if (!valid) return undefined;
    try {
      const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
      return isPayload(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function denied(code: string, reason: string): AuthDecision {
  return { allowed: false, code, reason };
}

function isPayload(value: unknown): value is SignedCapabilityPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return payload.version === 1
    && typeof payload.merchantPubkey === "string"
    && Array.isArray(payload.permissions)
    && payload.permissions.every((permission) => typeof permission === "string")
    && typeof payload.issuedAt === "number"
    && (payload.maxChannels === undefined
      || (typeof payload.maxChannels === "number" && Number.isInteger(payload.maxChannels) && payload.maxChannels >= 0));
}
