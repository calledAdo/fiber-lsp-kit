/**
 * Framework-free REST dispatcher for the LSPS-Fiber HTTP API. Returns { status, body } so it can be
 * unit-tested without a socket and mounted on any server (node:http below, or a serverless handler).
 *
 *   GET  /lsp/v1/info               → LspInfo
 *   POST /lsp/v1/orders             → create an order (body: CreateOrderRequest)
 *   GET  /lsp/v1/orders/:id         → an order's current state
 *   POST /lsp/v1/orders/:id/settle  → notify the LSP a prepaid fee was paid (triggers provisioning)
 */
import type { CreateOrderRequest } from "@fiberlsp/protocol";
import { Lsp, OrderError } from "./lsp.js";

export interface ApiResponse {
  status: number;
  body: unknown;
}

export function createApi(lsp: Lsp) {
  return async function handle(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse> {
    try {
      const parts = path.replace(/^\/+|\/+$/g, "").split("/"); // ["lsp","v1","orders",...]
      const route = parts.slice(0, 3).join("/");

      if (method === "GET" && path.replace(/\/+$/, "") === "/health") {
        return ok({ status: "ok" });
      }
      if (method === "GET" && route === "lsp/v1/info") {
        return ok(lsp.getInfo());
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
      return err(404, "no_route", `${method} ${path}`);
    } catch (e) {
      if (e instanceof OrderError) return err(400, e.code, e.message);
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
