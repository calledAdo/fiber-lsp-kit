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
 *   POST /lsp/v1/jit/orders/:id/reveal   → merchant reveals the leg preimage (body: { preimage }) → settle
 *   POST /lsp/v1/jit/orders/:id/cancel
 */
import type { CreateJitOrderRequest, CreateOrderRequest } from "@fiberlsp/protocol";
import { Lsp, OrderError } from "./lsp.js";
import { JitError, type JitService } from "./jit.js";

export interface ApiResponse {
  status: number;
  body: unknown;
}

export type ApiHeaders = Record<string, string | string[] | undefined>;

export function createApi(
  lsp: Lsp,
  opts: { jit?: JitService } = {},
) {
  const jit = opts.jit;
  return async function handle(
    method: string,
    path: string,
    body?: unknown,
    headers?: ApiHeaders,
  ): Promise<ApiResponse> {
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
      if (method === "POST" && route === "lsp/v1/orders" && parts.length === 3) {
        const order = await lsp.createOrder(body as CreateOrderRequest);
        return { status: 201, body: order };
      }
      if (route === "lsp/v1/orders" && parts[3]) {
        const id = parts[3];
        if (method === "GET" && parts.length === 4) {
          const order = lsp.getOrder(id);
          return order ? ok(order) : err(404, "not_found", `order ${id} not found`);
        }
        if (method === "POST" && parts[4] === "settle" && parts.length === 5) {
          return ok(await lsp.settleFee(id));
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
