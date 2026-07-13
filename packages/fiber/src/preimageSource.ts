import WebSocket from "ws";

export interface PaymentPreimageObservation {
  /** Resolves to the matching preimage, or undefined if the live subscription closes first. */
  preimage: Promise<string | undefined>;
  close(): void;
}

/** Optional source of a preimage learned by the node that sent a successful payment. */
export interface PaymentPreimageSource {
  /** Resolve only after observation is armed, so callers can safely send the payment afterward. */
  observe(paymentHash: string): Promise<PaymentPreimageObservation>;
}

export interface StoreChangeWebSocket {
  on(event: string, listener: (...args: unknown[]) => void): this;
  send(data: string): void;
  close(): void;
}

export type StoreChangeWebSocketFactory = (
  url: string,
  headers: Record<string, string>,
) => StoreChangeWebSocket;

export interface FnnStoreChangePreimageSourceConfig {
  /** FNN HTTP or WebSocket RPC URL. HTTP(S) is converted to WS(S). */
  rpcUrl: string;
  /** Raw bearer token, matching FiberChannelRpcClient's authToken convention. */
  authToken?: string;
  /** Test/custom-runtime seam. Defaults to the Node `ws` implementation. */
  webSocketFactory?: StoreChangeWebSocketFactory;
}

/**
 * Reads FNN's opt-in `subscribe_store_changes` stream and extracts matching `PutPreimage` events.
 *
 * The stream is live-only in FNN v0.9.0-rc5: it has no cursor or replay. Arm observation before
 * `send_payment`, persist a result immediately, and retain a separate recovery path for disconnects.
 */
export class FnnStoreChangePreimageSource implements PaymentPreimageSource {
  private id = 0;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly factory: StoreChangeWebSocketFactory;

  constructor(config: FnnStoreChangePreimageSourceConfig) {
    this.url = webSocketUrl(config.rpcUrl);
    this.headers = config.authToken ? { authorization: `Bearer ${config.authToken}` } : {};
    this.factory =
      config.webSocketFactory ??
      ((url, headers) => new WebSocket(url, { headers }) as unknown as StoreChangeWebSocket);
  }

  observe(paymentHash: string): Promise<PaymentPreimageObservation> {
    const requestId = ++this.id;
    const expectedHash = paymentHash.toLowerCase();
    const socket = this.factory(this.url, this.headers);

    return new Promise((resolve, reject) => {
      let setupDone = false;
      let subscriptionId: string | number | undefined;
      let resolvePreimage!: (value: string | undefined) => void;
      let preimageDone = false;
      const preimage = new Promise<string | undefined>((done) => {
        resolvePreimage = done;
      });

      const finishPreimage = (value: string | undefined) => {
        if (preimageDone) return;
        preimageDone = true;
        resolvePreimage(value);
      };
      const close = () => {
        finishPreimage(undefined);
        socket.close();
      };
      const failSetup = (error: Error) => {
        if (setupDone) {
          finishPreimage(undefined);
          return;
        }
        setupDone = true;
        reject(error);
        socket.close();
      };

      socket.on("open", () => {
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          method: "subscribe_store_changes",
          params: [],
        }));
      });
      socket.on("message", (data) => {
        let message: StoreChangeMessage;
        try {
          message = JSON.parse(messageText(data)) as StoreChangeMessage;
        } catch {
          return;
        }

        if (message.id === requestId) {
          if (message.error) {
            failSetup(new Error(`FNN subscribe_store_changes errored: ${message.error.message}`));
            return;
          }
          if (message.result === undefined || (typeof message.result !== "string" && typeof message.result !== "number")) {
            failSetup(new Error("FNN subscribe_store_changes returned no subscription id"));
            return;
          }
          subscriptionId = message.result;
          if (!setupDone) {
            setupDone = true;
            resolve({ preimage, close });
          }
          return;
        }

        const params = message.params;
        if (!params || message.method !== "store_changes" || params.subscription !== subscriptionId) return;
        const event = params.result?.PutPreimage;
        if (!event || event.payment_hash.toLowerCase() !== expectedHash) return;
        finishPreimage(event.payment_preimage);
        socket.close();
      });
      socket.on("error", (error) => {
        failSetup(error instanceof Error ? error : new Error(String(error)));
      });
      socket.on("close", () => {
        if (!setupDone) {
          failSetup(new Error("FNN store-change connection closed before subscription was armed"));
          return;
        }
        finishPreimage(undefined);
      });
    });
  }
}

interface StoreChangeMessage {
  id?: number;
  result?: string | number;
  error?: { message: string };
  method?: string;
  params?: {
    subscription?: string | number;
    result?: {
      PutPreimage?: { payment_hash: string; payment_preimage: string };
    };
  };
}

function webSocketUrl(rpcUrl: string): string {
  const url = new URL(rpcUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`unsupported FNN RPC protocol: ${url.protocol}`);
  }
  return url.toString();
}

function messageText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  return String(data);
}
