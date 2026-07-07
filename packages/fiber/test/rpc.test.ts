import { test } from "node:test";
import assert from "node:assert/strict";
import { FiberChannelRpcClient } from "@fiberlsp/fiber";

test("openChannel serializes decimal funding as FNN hex", async () => {
  let captured: unknown;
  const rpc = new FiberChannelRpcClient({
    rpcUrl: "http://fnn.test",
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(String(init.body));
      return {
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: { temporary_channel_id: "0xtemp" },
        }),
      };
    },
  });

  await rpc.openChannel({
    pubkey: "0x02aa",
    fundingAmount: "100000000",
    public: true,
  });

  assert.deepEqual(captured, {
    jsonrpc: "2.0",
    id: 1,
    method: "open_channel",
    params: [
      {
        pubkey: "0x02aa",
        funding_amount: "0x5f5e100",
        public: true,
      },
    ],
  });
});
