import { randomBytes as nodeRandomBytes } from "node:crypto";
import type { ChallengeStore } from "./types.js";
import { normalizePubkey } from "./normalize.js";

export interface MemoryChallengeStoreOptions {
  ttlMs?: number;
  now?: () => number;
  randomBytes?: () => Uint8Array;
}

export class MemoryChallengeStore implements ChallengeStore {
  private readonly entries = new Map<string, { pubkey: string; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly randomBytes: () => Uint8Array;

  constructor(opts: MemoryChallengeStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
    this.randomBytes = opts.randomBytes ?? (() => nodeRandomBytes(32));
  }

  async issue(pubkey: string): Promise<string> {
    const normalized = normalizePubkey(pubkey);
    if (!normalized) throw new Error("pubkey is required");
    const nonce = Buffer.from(this.randomBytes()).toString("hex");
    const challenge = `fiberlsp-auth:v1:${normalized}:${nonce}`;
    this.entries.set(challenge, { pubkey: normalized, expiresAt: this.now() + this.ttlMs });
    return challenge;
  }

  async consume(pubkey: string, challenge: string): Promise<boolean> {
    const entry = this.entries.get(challenge);
    if (!entry) return false;
    if (this.now() > entry.expiresAt) {
      this.entries.delete(challenge);
      return false;
    }
    if (entry.pubkey !== normalizePubkey(pubkey)) return false;
    this.entries.delete(challenge);
    return true;
  }
}
