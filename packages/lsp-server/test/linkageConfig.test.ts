import { test } from "node:test";
import assert from "node:assert/strict";
import type { LinkageVerifier } from "@fiberlsp/protocol";
import { selectLinkageVerifiers } from "@fiberlsp/server";

const groth16: LinkageVerifier = { scheme: "groth16-dual-sha256-v1", verify: () => true };
const exposedSecret: LinkageVerifier = { scheme: "exposed-secret-v1", verify: () => true };

test("a loaded Groth16 verifier alone is used and no warning is emitted", () => {
  const warns: string[] = [];
  const verifiers = selectLinkageVerifiers({
    groth16,
    allowExposedSecret: false,
    exposedSecret,
    warn: (m) => warns.push(m),
  });
  assert.deepEqual(verifiers, [groth16]);
  assert.equal(warns.length, 0);
});

test("exposed-secret alone is allowed (test path) and warns", () => {
  const warns: string[] = [];
  const verifiers = selectLinkageVerifiers({
    allowExposedSecret: true,
    exposedSecret,
    warn: (m) => warns.push(m),
  });
  assert.deepEqual(verifiers, [exposedSecret]);
  assert.equal(warns.length, 1);
  assert.match(warns[0]!, /unsafe/);
});

test("exposed-secret alongside a real Groth16 verifier refuses to start", () => {
  assert.throws(
    () => selectLinkageVerifiers({ groth16, allowExposedSecret: true, exposedSecret }),
    /refusing to start/,
  );
});

test("no verifier configured yields an empty list so JIT stays disabled", () => {
  const verifiers = selectLinkageVerifiers({ allowExposedSecret: false, exposedSecret });
  assert.deepEqual(verifiers, []);
});
