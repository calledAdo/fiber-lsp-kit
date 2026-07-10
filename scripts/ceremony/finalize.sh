#!/usr/bin/env bash
#
# Phase-2 ceremony: finalise the chain against a public, unpredictable beacon, then export the verification
# key and verify the whole thing.
#
# The beacon removes the last contributor's privileged position: nobody, including them, could have known the
# beacon value while contributing. Use a value that did not exist when the last contribution was made and
# that no participant controls — e.g. the hash of a CKB block at an announced future height.
#
#   ./finalize.sh <last.zkey> <beacon-hash-hex> [iterations-exp]
#
# See docs/CEREMONY.md.
set -euo pipefail

usage() { echo "usage: finalize.sh <last.zkey> <beacon-hash-hex> [iterations-exp]" >&2; exit 1; }
[ $# -ge 2 ] || usage
LAST_ZKEY="$1"; BEACON="$2"; ITERS="${3:-10}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# snarkjs is a setup-time tool only — the kit itself does not depend on it (the LSP verifies proofs
# with @noble/curves). Pinned so a contribution is reproducible against a known implementation.
SNARK="npx --yes snarkjs@0.7.6"
BUILD="$(dirname "$LAST_ZKEY")"
R1CS="$BUILD/dual_sha256_linkage.r1cs"
PTAU="$BUILD/powersOfTau28_hez_final_16.ptau"
FINAL="$BUILD/dual_sha256_linkage_final.zkey"
VK="$BUILD/verification_key.json"

command -v npx >/dev/null || { echo "npx not found — install Node.js" >&2; exit 1; }
for f in "$LAST_ZKEY" "$R1CS" "$PTAU"; do
  [ -f "$f" ] || { echo "missing: $f" >&2; exit 1; }
done
[[ "$BEACON" =~ ^[0-9a-fA-F]+$ ]] || { echo "beacon must be hex (no 0x prefix)" >&2; exit 1; }

echo "==> Applying beacon $BEACON (2^$ITERS iterations)"
$SNARK zkey beacon "$LAST_ZKEY" "$FINAL" "$BEACON" "$ITERS" -n="Final Beacon" >/dev/null

echo "==> Exporting verification key"
$SNARK zkey export verificationkey "$FINAL" "$VK" >/dev/null

echo "==> Verifying the final key against the circuit and the public ptau"
$SNARK zkey verify "$R1CS" "$PTAU" "$FINAL"

echo
echo "==> Publish these:"
echo "    circuit r1cs   sha256 $(sha256sum "$R1CS" | cut -d' ' -f1)"
echo "    ptau           sha256 $(sha256sum "$PTAU" | cut -d' ' -f1)"
echo "    final zkey     sha256 $(sha256sum "$FINAL" | cut -d' ' -f1)"
echo "    verification   sha256 $(sha256sum "$VK" | cut -d' ' -f1)"
echo "    beacon         $BEACON  (2^$ITERS iterations)"
echo
echo "Anyone can now re-run 'snarkjs zkey verify' on the published r1cs + ptau + final zkey."
