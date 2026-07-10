/* tslint:disable */
/* eslint-disable */

/**
 * wasm entry: prove from `.zkey`/converted-key bytes and `.wtns` bytes, returning
 * `{"proof": …, "publicSignals": […]}` as a JSON string. In-process; no subprocess, no native binary.
 */
export function prove_wasm(zkey: Uint8Array, wtns: Uint8Array): string;
