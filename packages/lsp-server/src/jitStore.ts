/**
 * JIT order storage. The record extends the wire `JitOrder` with a paying-node-observed or recovery-revealed
 * preimage so a server restart between capture and settle can still settle the held payment.
 * `MemoryJitStore` is the default; `FileJitStore` survives a restart.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JitOrder } from "@fiberlsp/protocol";

/** A stored JIT order: the wire order plus the preimage once the LSP learns it. */
export interface JitOrderRecord extends JitOrder {
  /** Per-order bearer token. Never sent on GET/reveal/cancel responses. */
  order_token: string;
  /** Persisted before settling, whether learned from FNN or supplied through explicit recovery. */
  preimage?: string;
}

export interface JitStore {
  put(order: JitOrderRecord): void;
  get(id: string): JitOrderRecord | undefined;
  all(): JitOrderRecord[];
}

export class MemoryJitStore implements JitStore {
  private orders = new Map<string, JitOrderRecord>();

  put(order: JitOrderRecord): void {
    this.orders.set(order.jit_order_id, order);
  }

  get(id: string): JitOrderRecord | undefined {
    return this.orders.get(id);
  }

  all(): JitOrderRecord[] {
    return [...this.orders.values()];
  }
}

/** Durable single-JSON-file store (temp file + rename, like FileOrderStore). */
export class FileJitStore implements JitStore {
  private readonly orders = new Map<string, JitOrderRecord>();

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as JitOrderRecord[];
        for (const o of parsed) this.orders.set(o.jit_order_id, o);
      } catch (e) {
        console.warn(`[jit] could not read store ${path}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  put(order: JitOrderRecord): void {
    this.orders.set(order.jit_order_id, order);
    this.flush();
  }

  get(id: string): JitOrderRecord | undefined {
    return this.orders.get(id);
  }

  all(): JitOrderRecord[] {
    return [...this.orders.values()];
  }

  private flush(): void {
    const dir = dirname(this.path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.all(), null, 2), { mode: 0o600 });
    renameSync(tmp, this.path); // atomic replace
  }
}
