/** Order storage. `MemoryOrderStore` is the default; `FileOrderStore` survives a restart. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Order } from "@fiberlsp/protocol";

export interface OrderStore {
  put(order: Order): void;
  get(id: string): Order | undefined;
  all(): Order[];
}

export class MemoryOrderStore implements OrderStore {
  private orders = new Map<string, Order>();

  put(order: Order): void {
    this.orders.set(order.order_id, order);
  }

  get(id: string): Order | undefined {
    return this.orders.get(id);
  }

  all(): Order[] {
    return [...this.orders.values()];
  }
}

/**
 * A durable order store backed by a single JSON file. Loads existing orders on construction and rewrites
 * the file atomically (temp file + rename) on every `put`, so a server restart resumes with its orders
 * intact. Fine for a small deployment or example; production can move to SQLite/Postgres behind the
 * same interface.
 */
export class FileOrderStore implements OrderStore {
  private readonly orders = new Map<string, Order>();

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Order[];
        for (const o of parsed) this.orders.set(o.order_id, o);
      } catch (e) {
        console.warn(`[lsp] could not read order store ${path}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  put(order: Order): void {
    this.orders.set(order.order_id, order);
    this.flush();
  }

  get(id: string): Order | undefined {
    return this.orders.get(id);
  }

  all(): Order[] {
    return [...this.orders.values()];
  }

  private flush(): void {
    const dir = dirname(this.path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.all(), null, 2));
    renameSync(tmp, this.path); // atomic replace
  }
}
