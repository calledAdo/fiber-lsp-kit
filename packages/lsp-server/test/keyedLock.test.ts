import { test } from "node:test";
import assert from "node:assert/strict";
import { makeKeyedLock } from "@fiberlsp/server";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("same key runs exclusively — no overlap", async () => {
  const lock = makeKeyedLock();
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const job = (name: string) =>
    lock.run("M", async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(`start-${name}`);
      await tick();
      order.push(`end-${name}`);
      active--;
    });
  await Promise.all([job("a"), job("b"), job("c")]);
  assert.equal(maxActive, 1, "never two at once for the same key");
  // Each job fully finishes before the next starts.
  assert.deepEqual(order, ["start-a", "end-a", "start-b", "end-b", "start-c", "end-c"]);
});

test("different keys run concurrently", async () => {
  const lock = makeKeyedLock();
  let active = 0;
  let maxActive = 0;
  const job = (key: string) =>
    lock.run(key, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick();
      active--;
    });
  await Promise.all([job("M1"), job("M2"), job("M3")]);
  assert.equal(maxActive, 3, "different keys overlap");
});

test("a rejected job does not wedge the queue for its key", async () => {
  const lock = makeKeyedLock();
  await assert.rejects(lock.run("M", async () => {
    throw new Error("boom");
  }));
  // The next job for the same key still runs.
  const out = await lock.run("M", async () => "ok");
  assert.equal(out, "ok");
});
