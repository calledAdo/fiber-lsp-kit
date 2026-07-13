/**
 * Framework-free REST dispatcher for the LSPS-Fiber HTTP API. Returns { status, body } so it can be
 * unit-tested without a socket and mounted on any server (node:http below, or a serverless handler).
 *
 *   GET  /lsp/v1/info                    → LspInfo (+ `jit` terms when a JitService is mounted)
 *   GET  /lsp/v1/liquidity               → LiquiditySnapshot (per-asset inbound/outbound capacity)
 *   POST /lsp/v1/orders                  → create an order (body: CreateOrderRequest)
 *   GET  /lsp/v1/orders/:id              → an order's current state
 *   POST /lsp/v1/orders/:id/settle       → notify the LSP a prepaid fee was paid (triggers provisioning)
 *   POST /lsp/v1/jit/orders              → register a linked JIT intent (body: CreateJitOrderRequest) → hold invoice
 *   GET  /lsp/v1/jit/orders/:id          → a JIT order's current state
 *   POST /lsp/v1/jit/orders/:id/reveal   → explicit recovery if paying-node observation was lost
 *   POST /lsp/v1/jit/orders/:id/cancel
 */
import type { CreateJitOrderRequest, CreateOrderRequest } from "@fiberlsp/protocol";
import type { Lsp } from "./lsp.js";
import { OrderError, type PrepaidService } from "./prepaid.js";
import { JitError, type JitService } from "./jit.js";

export interface ApiResponse {
  status: number;
  body: unknown;
}

export type ApiHeaders = Record<string, string | string[] | undefined>;

/** A parsed inbound request, passed through the middleware chain. */
export interface ApiRequest {
  method: string;
  path: string;
  body?: unknown;
  headers?: ApiHeaders;
}

/**
 * Cross-cutting policy that wraps the core dispatcher: auth, rate limiting, logging, metrics. Call `next()`
 * to continue the chain (and inspect/replace its response), or return early to short-circuit (e.g. a 401).
 * Middleware is *policy* — the core routing/state machine it wraps stays rigid.
 */
export type ApiMiddleware = (req: ApiRequest, next: () => Promise<ApiResponse>) => Promise<ApiResponse>;

export function createApi(
  lsp: Lsp,
  opts: { prepaid?: PrepaidService; jit?: JitService; middleware?: ApiMiddleware[] } = {},
) {
  const { prepaid, jit } = opts;
  const core = async (req: ApiRequest): Promise<ApiResponse> => {
    const { method, path, body, headers } = req;
    try {
      const parts = path.replace(/^\/+|\/+$/g, "").split("/"); // ["lsp","v1","orders",...]
      const route = parts.slice(0, 3).join("/");

      if (method === "GET" && path.replace(/\/+$/, "") === "/health") {
        return ok({ status: "ok" });
      }
      if (method === "GET" && route === "lsp/v1/info") {
        const jitTerms = jit?.terms;
        return ok(jitTerms ? { ...lsp.getInfo(), jit: jitTerms } : lsp.getInfo());
      }
      if (method === "GET" && route === "lsp/v1/liquidity") {
        return ok(await lsp.liquidity());
      }
      if (prepaid && method === "POST" && route === "lsp/v1/orders" && parts.length === 3) {
        const order = await prepaid.createOrder(body as CreateOrderRequest);
        return { status: 201, body: order };
      }
      if (prepaid && route === "lsp/v1/orders" && parts[3]) {
        const id = parts[3];
        if (method === "GET" && parts.length === 4) {
          const order = prepaid.getOrder(id);
          return order ? ok(order) : err(404, "not_found", `order ${id} not found`);
        }
        if (method === "POST" && parts[4] === "settle" && parts.length === 5) {
          return ok(await prepaid.settleFee(id));
        }
      }
      if (jit && parts[2] === "jit" && parts[3] === "orders") {
        if (method === "POST" && parts.length === 4) {
          const order = await jit.createOrder(body as CreateJitOrderRequest);
          // The orchestration runs for minutes (on-chain open) — fire it and return the hold invoice now.
          void jit.run(order.jit_order_id).catch((e) => {
            console.warn(`[jit] run(${order.jit_order_id}) failed: ${e instanceof Error ? e.message : e}`);
          });
          return { status: 201, body: order };
        }
        const id = parts[4];
        if (id && method === "GET" && parts.length === 5) {
          const order = jit.getOrder(id, bearer(headers));
          return order ? ok(order) : err(404, "not_found", `jit order ${id} not found`);
        }
        if (id && method === "POST" && parts[5] === "reveal" && parts.length === 6) {
          const preimage = (body as { preimage?: string } | undefined)?.preimage;
          if (!preimage) return err(400, "missing_preimage", "body must be { preimage }");
          return ok(await jit.reveal(id, preimage, bearer(headers)));
        }
        if (id && method === "POST" && parts[5] === "cancel" && parts.length === 6) {
          return ok(await jit.cancel(id, bearer(headers)));
        }
      }
      return err(404, "no_route", `${method} ${path}`);
    } catch (e) {
      if (e instanceof OrderError) return err(400, e.code, e.message);
      if (e instanceof JitError) {
        const status = e.code === "not_found" ? 404 : e.code === "unauthorized" ? 401 : 400;
        return err(status, e.code, e.message);
      }
      return err(500, "internal", e instanceof Error ? e.message : String(e));
    }
  };

  // Compose middleware around the core dispatcher (last in the array runs closest to core).
  const chain = (opts.middleware ?? []).reduceRight<(req: ApiRequest) => Promise<ApiResponse>>(
    (next, mw) => (req) => mw(req, () => next(req)),
    core,
  );

  return function handle(
    method: string,
    path: string,
    body?: unknown,
    headers?: ApiHeaders,
  ): Promise<ApiResponse> {
    return chain({ method, path, body, headers });
  };
}

function ok(body: unknown): ApiResponse {
  return { status: 200, body };
}
function err(status: number, code: string, message: string): ApiResponse {
  return { status, body: { error: { code, message } } };
}

function bearer(headers?: ApiHeaders): string | undefined {
  const raw = headers?.authorization ?? headers?.Authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1];
}
