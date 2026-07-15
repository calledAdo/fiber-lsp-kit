import assert from "node:assert/strict";
import { test } from "node:test";

import { createCkbAssetBalanceProvider } from "../../../scripts/demo/shared/ckb-balance.mjs";

const lockScript = {
  code_hash: "0x" + "11".repeat(32),
  hash_type: "type",
  args: "0xaaaa",
};
const typeScript = {
  code_hash: "0x" + "22".repeat(32),
  hash_type: "type",
  args: "0xbbbb",
};

test("CKB balance provider sums little-endian UDT cell data and caches the result", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const fetchImpl = async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return {
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: {
          objects: [
            { output_data: "0x00ca9a3b000000000000000000000000" },
            { output_data: "0x00127a00000000000000000000000000" },
          ],
          last_cursor: "0xend",
        },
      }),
    };
  };
  const provider = createCkbAssetBalanceProvider({
    rpcUrl: "http://ckb.test",
    fetchImpl,
    now: () => 1_720_000_000_000,
    ttlMs: 30_000,
  });
  const input = {
    role: "lsp",
    nodeInfo: { default_funding_lock_script: lockScript },
    asset: { kind: "UDT", udt: typeScript },
  };

  const first = await provider(input);
  const second = await provider(input);

  assert.deepEqual(first, { amount: "1008000000", checkedAt: "2024-07-03T09:46:40.000Z" });
  assert.deepEqual(second, first);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].method, "get_cells");
  assert.deepEqual((requests[0].params as unknown[])[0], {
    script: lockScript,
    script_type: "lock",
    filter: { script: typeScript },
  });
});
