/**
 * A per-key async mutex. `run(key, fn)` runs `fn` exclusively among calls sharing the same key — later
 * calls for that key queue until earlier ones finish — while different keys run fully in parallel.
 *
 * Used to serialize JIT channel opens per merchant pubkey: concurrent opens to the SAME merchant would
 * make the "which channel to this peer is new" detection ambiguous, so we let only one be in flight at a
 * time. Opens to DIFFERENT merchants are independent and stay concurrent.
 */
export function makeKeyedLock() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prev = tails.get(key) ?? Promise.resolve();
      // Chain fn after prev regardless of whether prev resolved or rejected.
      const result = prev.then(fn, fn);
      // The tail tracks completion only (swallow value/error) so the chain never wedges.
      const tail = result.then(
        () => {},
        () => {},
      );
      tails.set(key, tail);
      // Best-effort cleanup: once this is the last in line, drop the entry so the map doesn't grow.
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
  };
}

export type KeyedLock = ReturnType<typeof makeKeyedLock>;
