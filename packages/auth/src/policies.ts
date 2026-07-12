import { dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { MerchantPolicy, MerchantPolicyStore } from "./types.js";
import { normalizePubkey } from "./normalize.js";

function normalizedPolicy(policy: MerchantPolicy): MerchantPolicy {
  const merchantPubkey = normalizePubkey(policy.merchantPubkey);
  if (!merchantPubkey) throw new Error("merchantPubkey is required");
  if (policy.maxChannels !== undefined && (!Number.isInteger(policy.maxChannels) || policy.maxChannels < 0)) {
    throw new Error("maxChannels must be a non-negative integer");
  }
  return { ...policy, merchantPubkey, permissions: [...policy.permissions] };
}

export class MemoryMerchantPolicyStore implements MerchantPolicyStore {
  protected readonly policies = new Map<string, MerchantPolicy>();

  async get(pubkey: string): Promise<MerchantPolicy | undefined> {
    const policy = this.policies.get(normalizePubkey(pubkey));
    return policy ? { ...policy, permissions: [...policy.permissions] } : undefined;
  }

  async put(policy: MerchantPolicy): Promise<void> {
    const normalized = normalizedPolicy(policy);
    this.policies.set(normalized.merchantPubkey, normalized);
  }
}

export class FileMerchantPolicyStore extends MemoryMerchantPolicyStore {
  constructor(private readonly path: string) {
    super();
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as MerchantPolicy[];
      for (const policy of parsed) {
        const normalized = normalizedPolicy(policy);
        this.policies.set(normalized.merchantPubkey, normalized);
      }
    }
  }

  override async put(policy: MerchantPolicy): Promise<void> {
    await super.put(policy);
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify([...this.policies.values()], null, 2), { mode: 0o600 });
    renameSync(temp, this.path);
  }
}
