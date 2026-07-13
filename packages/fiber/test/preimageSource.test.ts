import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FnnStoreChangePreimageSource,
  type StoreChangeWebSocket,
  type StoreChangeWebSocketFactory,
} from "@fiberlsp/fiber";

const HASH = "0x" + "11".repeat(32);
const PREIMAGE = "0x" + "22".repeat(32);

class ScriptedSocket implements StoreChangeWebSocket {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  sent: string[] = [];
  closed = false;

  on(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.emit("close");
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function harness() {
  const sockets: ScriptedSocket[] = [];
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const factory: StoreChangeWebSocketFactory = (url, headers) => {
    calls.push({ url, headers });
    const socket = new ScriptedSocket();
    sockets.push(socket);
    queueMicrotask(() => socket.emit("open"));
    return socket;
  };
  return { factory, sockets, calls };
}

test("arms an authenticated store-change subscription and resolves the matching preimage", async () => {
  const h = harness();
  const source = new FnnStoreChangePreimageSource({
    rpcUrl: "https://fnn.example/rpc",
    authToken: "secret",
    webSocketFactory: h.factory,
  });
  const observing = source.observe(HASH);
  await new Promise((resolve) => setImmediate(resolve));
  const socket = h.sockets[0]!;
  const subscribe = JSON.parse(socket.sent[0]!) as { id: number; method: string; params: unknown[] };
  assert.equal(subscribe.method, "subscribe_store_changes");
  assert.deepEqual(subscribe.params, []);
  socket.emit("message", JSON.stringify({ jsonrpc: "2.0", id: subscribe.id, result: 7 }));
  const observation = await observing;

  socket.emit("message", JSON.stringify({
    jsonrpc: "2.0",
    method: "store_changes",
    params: { subscription: 7, result: { PutPreimage: { payment_hash: "0x" + "ff".repeat(32), payment_preimage: PREIMAGE } } },
  }));
  socket.emit("message", JSON.stringify({
    jsonrpc: "2.0",
    method: "store_changes",
    params: { subscription: 7, result: { PutPreimage: { payment_hash: HASH, payment_preimage: PREIMAGE } } },
  }));

  assert.equal(await observation.preimage, PREIMAGE);
  assert.deepEqual(h.calls, [{ url: "wss://fnn.example/rpc", headers: { authorization: "Bearer secret" } }]);
  assert.equal(socket.closed, true);
});

test("rejects observation setup when FNN has not enabled the pubsub module", async () => {
  const h = harness();
  const source = new FnnStoreChangePreimageSource({ rpcUrl: "http://127.0.0.1:8227", webSocketFactory: h.factory });
  const observing = source.observe(HASH);
  await new Promise((resolve) => setImmediate(resolve));
  const socket = h.sockets[0]!;
  const subscribe = JSON.parse(socket.sent[0]!) as { id: number };
  socket.emit("message", JSON.stringify({
    jsonrpc: "2.0",
    id: subscribe.id,
    error: { code: -32601, message: "Method not found" },
  }));

  await assert.rejects(observing, /Method not found/);
  assert.equal(socket.closed, true);
});

test("resolves undefined when the live-only subscription disconnects before the preimage", async () => {
  const h = harness();
  const source = new FnnStoreChangePreimageSource({ rpcUrl: "ws://127.0.0.1:8227", webSocketFactory: h.factory });
  const observing = source.observe(HASH);
  await new Promise((resolve) => setImmediate(resolve));
  const socket = h.sockets[0]!;
  const subscribe = JSON.parse(socket.sent[0]!) as { id: number };
  socket.emit("message", JSON.stringify({ jsonrpc: "2.0", id: subscribe.id, result: 9 }));
  const observation = await observing;
  socket.emit("close");

  assert.equal(await observation.preimage, undefined);
});
