/**
 * Storage for invoice watches — the registrations the invoice-webhook service polls to settlement.
 *
 * `MemoryWatchStore` is the default; `FileWatchStore` (atomic temp-file + rename, same pattern as
 * `FileOrderStore`) survives a restart so `InvoiceWebhookService.resume()` can pick up watches that were
 * still pending when the process died — a merchant backend never loses a settlement notification.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Asset, InvoiceStatus, Receipt } from "@fiberlsp/protocol";

/** A registered invoice the service watches on the merchant's node until it settles. */
export interface InvoiceWatch {
  watch_id: string;
  /** Where the `invoice.*` webhook is delivered when this invoice settles. */
  webhook_url: string;
  /** The payable invoice string. */
  invoice: string;
  payment_hash: string;
  asset: Asset;
  /** Amount invoiced, in the asset's base unit (decimal string). */
  amount: string;
  description?: string;
  metadata?: Record<string, string>;
  /** Last observed invoice status. */
  status: InvoiceStatus;
  paid: boolean;
  created_at: number;
  settled_at?: number;
  /** The settlement record, set once the invoice reaches a terminal state. */
  receipt?: Receipt;
}

export interface WatchStore {
  put(watch: InvoiceWatch): void;
  get(id: string): InvoiceWatch | undefined;
  all(): InvoiceWatch[];
}

export class MemoryWatchStore implements WatchStore {
  private readonly watches = new Map<string, InvoiceWatch>();
  put(watch: InvoiceWatch): void {
    this.watches.set(watch.watch_id, watch);
  }
  get(id: string): InvoiceWatch | undefined {
    return this.watches.get(id);
  }
  all(): InvoiceWatch[] {
    return [...this.watches.values()];
  }
}

export class FileWatchStore implements WatchStore {
  private readonly watches = new Map<string, InvoiceWatch>();

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as InvoiceWatch[];
        for (const w of parsed) this.watches.set(w.watch_id, w);
      } catch (e) {
        console.warn(
          `[merchant] could not read watch store ${path}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  }

  put(watch: InvoiceWatch): void {
    this.watches.set(watch.watch_id, watch);
    this.flush();
  }

  get(id: string): InvoiceWatch | undefined {
    return this.watches.get(id);
  }

  all(): InvoiceWatch[] {
    return [...this.watches.values()];
  }

  private flush(): void {
    const dir = dirname(this.path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.all(), null, 2));
    renameSync(tmp, this.path); // atomic replace
  }
}
