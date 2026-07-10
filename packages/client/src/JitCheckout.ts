/**
 * JitCheckout -- the merchant side of a JIT channel order, in either mode the LSP offers.
 *
 * The customer pays the LSP's hold invoice; the LSP opens a fresh channel to the merchant and pays the leg
 * invoice; settling the leg reveals the secret that settles the hold. The merchant always generates that
 * secret, so the LSP cannot settle before paying.
 *
 * `same_hash` — both invoices carry sha256(S). Nothing to prove: no proving key, no wasm, no ceremony.
 *               Requires the LSP to run a separate paying node, which it advertises.
 * `linked`    — the LSP runs one node, so the hashes must differ and `proveLinkage` must build a
 *               zero-knowledge proof that they share S.
 *
 * With no `mode` configured, `same_hash` is chosen whenever the LSP offers it: it is the mode that costs the
 * merchant nothing.
 */
import {
  type Asset,
  type JitMode,
  type JitOrder,
  type JitTerms,
  type LinkageProof,
  type LspInfo,
  asBig,
  assetUdtScript,
  dualSha256,
  jitForwardAmount,
  sameHashLink,
} from "@fiberlsp/protocol";
import type { FiberChannelRpcClient } from "@fiberlsp/fiber";

export interface JitCheckoutConfig {
  /** The merchant's own FNN node; issues the leg invoice and receives the forward. */
  rpc: FiberChannelRpcClient;
  /** The LSP REST base URL, e.g. http://lsp.example:8080 */
  lspBaseUrl: string;
  /** The merchant node's pubkey; the JIT channel is opened toward it. */
  merchantPubkey: string;
  /** Multiaddr the LSP can connect to. */
  merchantAddress?: string;
  fetchImpl?: typeof fetch;
  randomBytes?: (n: number) => Uint8Array;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Pin the JIT mode. Omit to prefer `same_hash` when the LSP offers it, else `linked`. Pin `linked` only to
   * keep the customer's hold hash unrelated to the merchant leg's.
   */
  mode?: JitMode;
  /** Required by `linked` mode: build a proof linking hold_hash and leg_hash without exposing the secret. */
  proveLinkage?: (holdHash: string, legHash: string, secretHex: string) => LinkageProof | Promise<LinkageProof>;
  /** Seconds the leg invoice is set to outlive the LSP hold window (covers the on-chain open). Default 1800. */
  legExpiryBufferSeconds?: number;
}

export interface JitCheckoutRequest {
  asset: Asset;
  /** Gross amount the customer pays, in the asset's base unit. The merchant nets amount - jit fee. */
  amount: string;
  description?: string;
  expirySeconds?: number;
  webhookUrl?: string;
}

export interface JitCheckoutSession {
  /** The mode this session negotiated. */
  mode: JitMode;
  /** Show this to the customer: the LSP node's hold invoice. */
  invoice: string;
  /** Customer-facing hold hash. */
  paymentHash: string;
  order: JitOrder;
  netAmount: string;
  fee: string;
  settle(opts?: { attempts?: number; intervalMs?: number }): Promise<JitOrder>;
  cancel(): Promise<JitOrder>;
}

export class JitCheckoutError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "JitCheckoutError";
  }
}

export class JitCheckout {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly randomBytes: (n: number) => Uint8Array;

  constructor(private readonly cfg: JitCheckoutConfig) {
    this.fetchImpl = cfg.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.randomBytes =
      cfg.randomBytes ??
      ((n) => {
        const b = new Uint8Array(n);
        globalThis.crypto.getRandomValues(b);
        return b;
      });
  }

  async terms(): Promise<JitTerms | undefined> {
    const info = await this.req<LspInfo>("GET", "/lsp/v1/info");
    return info.jit;
  }

  /** The mode this checkout will use: the pinned one if it is on offer, else the cheapest one that is. */
  private selectMode(terms: JitTerms): JitMode {
    const offered = terms.modes ?? ["linked"];
    const mode = this.cfg.mode ?? (offered.includes("same_hash") ? "same_hash" : "linked");
    if (!offered.includes(mode)) {
      throw new JitCheckoutError("unsupported_mode", `LSP does not offer JIT mode "${mode}" (offers: ${offered})`);
    }
    if (mode === "linked" && !this.cfg.proveLinkage) {
      throw new JitCheckoutError("missing_linkage_prover", "linked JIT mode requires a linkage proof builder");
    }
    return mode;
  }

  async checkout(req: JitCheckoutRequest): Promise<JitCheckoutSession> {
    const terms = await this.terms();
    if (!terms) throw new JitCheckoutError("no_jit", "this LSP does not offer JIT channels");
    const mode = this.selectMode(terms);

    const secret = "0x" + hex(this.randomBytes(32));
    // Both modes settle the leg with S itself; they differ only in what the hold hash is, and whether the
    // relationship between the two hashes has to be proven.
    const link =
      mode === "same_hash"
        ? (() => {
            const l = sameHashLink(secret);
            return { hold: l.hash, leg: l.hash, legPreimage: l.preimage };
          })()
        : dualSha256(secret);
    const net = jitForwardAmount(terms, req.amount);

    // The leg must outlive the LSP hold (which the LSP may set up to terms.max_expiry_seconds), or it could
    // expire before the LSP forwards. Give it max_expiry plus slack for the on-chain open, never less.
    const legExpiry =
      Math.max(req.expirySeconds ?? 0, terms.max_expiry_seconds) + (this.cfg.legExpiryBufferSeconds ?? 1800);
    const legInv = await this.cfg.rpc.newInvoice({
      amount: net,
      description: req.description ?? "jit checkout (merchant leg)",
      udtTypeScript: assetUdtScript(req.asset),
      expirySeconds: legExpiry,
      paymentPreimage: link.legPreimage,
      hashAlgorithm: "sha256",
    });
    const legHash = legInv.invoice?.data?.payment_hash;
    if (!legHash) throw new JitCheckoutError("no_hash", "merchant node returned no payment_hash");
    if (legHash !== link.leg) {
      throw new JitCheckoutError("hash_mismatch", "node payment_hash does not match the expected leg hash");
    }

    const proof = mode === "linked" ? await this.cfg.proveLinkage!(link.hold, link.leg, secret) : undefined;
    const order = await this.req<JitOrder>("POST", "/lsp/v1/jit/orders", {
      target_pubkey: this.cfg.merchantPubkey,
      target_address: this.cfg.merchantAddress,
      asset: req.asset,
      mode,
      hold_hash: link.hold,
      leg_hash: link.leg,
      merchant_invoice: legInv.invoice_address,
      ...(proof ? { linkage_proof: proof } : {}),
      amount: asBig(req.amount).toString(10),
      expiry_seconds: req.expirySeconds,
      webhook_url: req.webhookUrl,
    });
    const token = order.order_token;
    if (!token) throw new JitCheckoutError("missing_order_token", "LSP did not return an order token");

    const settle = async (opts: { attempts?: number; intervalMs?: number } = {}): Promise<JitOrder> => {
      const attempts = opts.attempts ?? 300;
      const intervalMs = opts.intervalMs ?? 2000;
      for (let i = 0; i < attempts; i++) {
        const { status } = await this.cfg.rpc.getInvoice(legHash);
        if (status === "Paid") break;
        if (status === "Cancelled" || status === "Expired") {
          throw new JitCheckoutError("leg_" + status.toLowerCase(), `leg invoice is ${status}`);
        }
        if (i === attempts - 1) throw new JitCheckoutError("timeout", "leg invoice never paid");
        await this.sleep(intervalMs);
      }

      let revealed = false;
      for (let i = 0; i < attempts; i++) {
        const current = await this.req<JitOrder>("GET", `/lsp/v1/jit/orders/${order.jit_order_id}`, undefined, token);
        if (current.state === "settled") return current;
        if (current.state === "refunded" || current.state === "expired") {
          throw new JitCheckoutError("order_" + current.state, `JIT order is ${current.state}`);
        }
        if (!revealed && current.state === "forwarding") {
          revealed = true;
          const afterReveal = await this.req<JitOrder>(
            "POST",
            `/lsp/v1/jit/orders/${order.jit_order_id}/reveal`,
            { preimage: link.legPreimage },
            token,
          );
          if (afterReveal.state === "settled") return afterReveal;
        }
        if (i === attempts - 1) throw new JitCheckoutError("timeout", "JIT order never settled");
        await this.sleep(intervalMs);
      }
      throw new JitCheckoutError("timeout", "JIT order never settled");
    };

    return {
      mode,
      invoice: order.hold_invoice,
      paymentHash: link.hold,
      order,
      netAmount: order.forward_amount,
      fee: order.fee,
      settle,
      cancel: () => this.req<JitOrder>("POST", `/lsp/v1/jit/orders/${order.jit_order_id}/cancel`, undefined, token),
    };
  }

  private async req<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    const headers: Record<string, string> = {};
    if (body) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await this.fetchImpl(this.cfg.lspBaseUrl.replace(/\/+$/, "") + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as T | { error?: { code: string; message: string } };
    if (res.status >= 400) {
      const e = (json as { error?: { code: string; message: string } }).error;
      throw new JitCheckoutError(e?.code ?? "http_" + res.status, e?.message ?? `HTTP ${res.status}`);
    }
    return json as T;
  }
}

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
