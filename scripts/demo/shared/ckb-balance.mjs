function littleEndianUint(hex) {
  const bytes = Buffer.from(String(hex).replace(/^0x/, ""), "hex");
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index--) {
    value = value * 256n + BigInt(bytes[index]);
  }
  return value;
}

export function createCkbAssetBalanceProvider({
  rpcUrl,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  ttlMs = 30_000,
  timeoutMs = 5_000,
}) {
  const cache = new Map();

  return async ({ nodeInfo, asset }) => {
    const lockScript = nodeInfo.default_funding_lock_script;
    const typeScript = asset.kind === "UDT" ? asset.udt : undefined;
    if (!lockScript) throw new Error("FNN node_info returned no default_funding_lock_script");
    if (!typeScript) throw new Error("on-chain demo balance currently requires a UDT Script object");

    const key = JSON.stringify([lockScript, typeScript]);
    const cached = cache.get(key);
    if (cached && now() - cached.cachedAt < ttlMs) return cached.value;

    let total = 0n;
    let cursor;
    do {
      const params = [{ script: lockScript, script_type: "lock", filter: { script: typeScript } }, "asc", "0x64"];
      if (cursor) params.push(cursor);
      const response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "get_cells", params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json();
      if (payload.error) throw new Error(`CKB get_cells failed: ${payload.error.message}`);
      const objects = payload.result?.objects ?? [];
      for (const cell of objects) total += littleEndianUint(cell.output_data);
      const next = payload.result?.last_cursor;
      cursor = objects.length === 100 && next && next !== cursor ? next : undefined;
    } while (cursor);

    const value = { amount: total.toString(10), checkedAt: new Date(now()).toISOString() };
    cache.set(key, { cachedAt: now(), value });
    return value;
  };
}
