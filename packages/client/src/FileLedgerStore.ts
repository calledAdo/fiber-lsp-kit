/**
 * FileLedgerStore — a durable {@link LedgerStore} backed by a single JSON file.
 *
 * Loads existing receipts on construction and rewrites the file atomically (temp file + rename) on every
 * `put`, so a merchant backend restart resumes with its settlement history intact. Node-only (imports
 * `node:fs`); kept in its own module so the pure ledger core stays runnable in any environment. Fine for a
 * reference deployment — a production merchant would move to SQLite/Postgres behind the same interface.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Receipt } from "@fiberlsp/protocol";
import type { LedgerStore } from "./SettlementLedger.js";

export class FileLedgerStore implements LedgerStore {
  private readonly receipts = new Map<string, Receipt>();

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Receipt[];
        for (const r of parsed) this.receipts.set(r.receipt_id, r);
      } catch (e) {
        console.warn(
          `[fiberlsp] could not read ledger ${path}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  }

  put(receipt: Receipt): void {
    this.receipts.set(receipt.receipt_id, receipt);
    this.flush();
  }

  get(id: string): Receipt | undefined {
    return this.receipts.get(id);
  }

  all(): Receipt[] {
    return [...this.receipts.values()];
  }

  private flush(): void {
    const dir = dirname(this.path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.all(), null, 2));
    renameSync(tmp, this.path); // atomic replace
  }
}
