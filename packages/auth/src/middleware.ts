import type {
  AuthDecision,
  ChallengeStore,
  MerchantCapabilityService,
  MerchantPolicy,
  MerchantPolicyStore,
  MerchantProofVerifier,
} from "./types.js";
import { merchantScopePermission } from "./signedCapabilities.js";
import { normalizePubkey } from "./normalize.js";

export type AuthApiHeaders = Record<string, string | string[] | undefined>;

export interface AuthApiRequest {
  method: string;
  path: string;
  body?: unknown;
  headers?: AuthApiHeaders;
}

export interface AuthApiResponse {
  status: number;
  body: unknown;
}

export type AuthApiMiddleware = (
  req: AuthApiRequest,
  next: () => Promise<AuthApiResponse>,
) => Promise<AuthApiResponse>;

export interface MerchantAuthMiddlewareDeps {
  challenges: ChallengeStore;
  proofVerifier: MerchantProofVerifier;
  policies: MerchantPolicyStore;
  capabilities: MerchantCapabilityService;
}

export function createMerchantAuthMiddleware(deps: MerchantAuthMiddlewareDeps): AuthApiMiddleware {
  return async (req, next) => {
    const path = normalizedPath(req.path);

    if (req.method === "POST" && path === "/lsp/v1/auth/challenge") {
      const pubkey = stringField(req.body, "pubkey");
      if (!pubkey) return error(400, "missing_pubkey", "body must include pubkey");
      try {
        return { status: 200, body: { challenge: await deps.challenges.issue(pubkey) } };
      } catch (cause) {
        return error(400, "invalid_pubkey", message(cause));
      }
    }

    if (req.method === "POST" && path === "/lsp/v1/auth/token") {
      try {
        const merchant = await deps.proofVerifier.verify(req.body);
        const policy = await deps.policies.get(merchant.pubkey);
        if (!policy || normalizePubkey(policy.merchantPubkey) !== normalizePubkey(merchant.pubkey)) {
          return error(403, "merchant_not_registered", "merchant has no active policy");
        }
        return { status: 200, body: { token: await deps.capabilities.issue({ merchant, policy }) } };
      } catch (cause) {
        return error(401, "invalid_merchant_proof", message(cause));
      }
    }

    if (!isGuardedCreate(req.method, path)) return next();

    const token = bearer(req.headers);
    if (!token) return error(401, "missing_bearer", "Authorization bearer token is required");

    const permission = await deps.capabilities.authorize(token, { permission: "orders:create" });
    if (!permission.allowed) return decisionError(permission);

    const targetPubkey = stringField(req.body, "target_pubkey");
    if (!targetPubkey) return error(403, "merchant_scope", "order target_pubkey is required for merchant authorization");
    const scope = await deps.capabilities.authorize(token, {
      permission: merchantScopePermission(targetPubkey),
    });
    if (!scope.allowed) return decisionError(scope);

    return next();
  };
}

export type AdminRequestAuthorizer = (req: AuthApiRequest) => boolean | Promise<boolean>;

export function createAdminPolicyMiddleware(
  policies: MerchantPolicyStore,
  authorizeAdmin: AdminRequestAuthorizer,
): AuthApiMiddleware {
  return async (req, next) => {
    if (req.method !== "PUT" || normalizedPath(req.path) !== "/lsp/v1/admin/policies") return next();
    if (!(await authorizeAdmin(req))) return error(401, "admin_unauthorized", "admin authorization failed");
    if (!isPolicy(req.body)) {
      return error(400, "invalid_policy", "body must be { merchantPubkey, permissions, maxChannels? }");
    }
    try {
      await policies.put(req.body);
      return { status: 200, body: { policy: req.body } };
    } catch (cause) {
      return error(400, "invalid_policy", message(cause));
    }
  };
}

function isGuardedCreate(method: string, path: string): boolean {
  return method === "POST" && (path === "/lsp/v1/orders" || path === "/lsp/v1/jit/orders");
}

function normalizedPath(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  return normalized || "/";
}

function bearer(headers?: AuthApiHeaders): string | undefined {
  const raw = headers?.authorization ?? headers?.Authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  return /^Bearer\s+(.+)$/i.exec(value)?.[1];
}

function stringField(body: unknown, field: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isPolicy(body: unknown): body is MerchantPolicy {
  if (!body || typeof body !== "object") return false;
  const policy = body as Record<string, unknown>;
  return typeof policy.merchantPubkey === "string"
    && Array.isArray(policy.permissions)
    && policy.permissions.every((permission) => typeof permission === "string")
    && (policy.maxChannels === undefined || typeof policy.maxChannels === "number");
}

function decisionError(decision: Exclude<AuthDecision, { allowed: true }>): AuthApiResponse {
  const status = decision.code === "invalid_token" ? 401 : decision.code === "quota_exceeded" ? 429 : 403;
  return error(status, decision.code, decision.reason);
}

function error(status: number, code: string, message: string): AuthApiResponse {
  return { status, body: { error: { code, message } } };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
