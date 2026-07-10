/**
 * Linkage-verifier selection for a JIT deployment.
 *
 * Kept pure and separate from `server.ts` (which boots a socket on import): all IO — reading the Groth16
 * verification key from disk — is resolved by the caller and passed in as an already-built verifier.
 * This function only makes the *decision* of which verifiers run, and enforces the safety invariant that the
 * unsafe exposed-secret mode never coexists with a real zero-knowledge verifier.
 */
import type { LinkageVerifier } from "@fiberlsp/protocol";

export interface SelectLinkageVerifiersOptions {
  /** The Groth16 verifier when a verification key loaded successfully; `undefined` if none configured or the load failed. */
  groth16?: LinkageVerifier;
  /** Whether `JIT_ALLOW_UNSAFE_EXPOSED_SECRET=1` was set. */
  allowExposedSecret: boolean;
  /** The exposed-secret verifier, appended only on the unsafe path. */
  exposedSecret: LinkageVerifier;
  /** Warning sink; defaults to `console.warn`. */
  warn?: (msg: string) => void;
}

/**
 * Decide which linkage verifiers a JIT deployment runs. Returns `[]` when JIT should stay disabled (caller
 * mounts JIT only when the result is non-empty). Throws when the unsafe exposed-secret verifier is requested
 * alongside a real Groth16 verifier — an operator who believes JIT is trustless must never silently accept the
 * downgrade that hands the merchant secret to the LSP.
 */
export function selectLinkageVerifiers(opts: SelectLinkageVerifiersOptions): LinkageVerifier[] {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const verifiers: LinkageVerifier[] = [];
  if (opts.groth16) verifiers.push(opts.groth16);
  if (opts.allowExposedSecret) {
    if (opts.groth16) {
      throw new Error(
        "[jit] refusing to start: JIT_ALLOW_UNSAFE_EXPOSED_SECRET=1 is set alongside a loaded Groth16 " +
          "verification key. The exposed-secret mode reveals the merchant secret to the LSP and is test-only. " +
          "Unset one of LINKED_JIT_VK_PATH or JIT_ALLOW_UNSAFE_EXPOSED_SECRET.",
      );
    }
    warn("[jit] enabling unsafe exposed-secret linkage verifier; use only for local tests");
    verifiers.push(opts.exposedSecret);
  }
  return verifiers;
}
