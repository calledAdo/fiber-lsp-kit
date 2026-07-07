/**
 * Framework-free REST dispatcher for the merchant invoice-webhook API. Same `{ status, body }` shape as
 * `createApi`, so it mounts on the same node:http server (see server.ts) behind the `/merchant` prefix.
 *
 *   POST /merchant/v1/invoices        → issue an invoice + start watching it (body: RegisterInvoiceRequest)
 *   GET  /merchant/v1/invoices        → list watches
 *   GET  /merchant/v1/invoices/:id    → a watch's current state (status, receipt once settled)
 *
 * When the watched invoice settles, the service POSTs an `invoice.*` webhook to the registration's
 * `webhook_url`; this API is the control plane for registering and inspecting those watches.
 */
import type { ApiResponse } from "./api.js";
import { InvoiceWebhookService, type RegisterInvoiceRequest } from "./invoiceWebhooks.js";

export function createMerchantApi(service: InvoiceWebhookService) {
  return async function handle(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse> {
    try {
      const parts = path.replace(/^\/+|\/+$/g, "").split("/"); // ["merchant","v1","invoices",...]
      const route = parts.slice(0, 3).join("/");

      if (route === "merchant/v1/invoices") {
        if (method === "POST" && parts.length === 3) {
          const watch = await service.register(body as RegisterInvoiceRequest);
          return { status: 201, body: watch };
        }
        if (method === "GET" && parts.length === 3) {
          return ok(service.list());
        }
        if (method === "GET" && parts[3] && parts.length === 4) {
          const watch = service.get(parts[3]);
          return watch ? ok(watch) : err(404, "not_found", `watch ${parts[3]} not found`);
        }
      }
      return err(404, "no_route", `${method} ${path}`);
    } catch (e) {
      return err(400, "bad_request", e instanceof Error ? e.message : String(e));
    }
  };
}

function ok(body: unknown): ApiResponse {
  return { status: 200, body };
}
function err(status: number, code: string, message: string): ApiResponse {
  return { status, body: { error: { code, message } } };
}
