#!/usr/bin/env bash
#
# Phase-2 ceremony: add one contribution to the linkage proving key.
#
# Run by an *independent contributor*. You take the previous contributor's zkey, mix in entropy only you
# know, destroy that entropy, and publish the resulting zkey plus its hash. The key is sound as long as at
# least ONE contributor in the chain did this honestly — so you need not trust any other participant.
#
#   ./contribute.sh <in.zkey> <out.zkey> "<your name>"
#
# See docs/CEREMONY.md.
set -euo pipefail

usage() { echo "usage: contribute.sh <in.zkey> <out.zkey> '<your name>'" >&2; exit 1; }
[ $# -eq 3 ] || usage
IN_ZKEY="$1"; OUT_ZKEY="$2"; NAME="$3"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# snarkjs is a setup-time tool only — the kit itself does not depend on it (the LSP verifies proofs
# with @noble/curves). Pinned so a contribution is reproducible against a known implementation.
SNARK="npx --yes snarkjs@0.7.6"
command -v npx >/dev/null || { echo "npx not found — install Node.js" >&2; exit 1; }
[ -f "$IN_ZKEY" ] || { echo "input zkey not found: $IN_ZKEY" >&2; exit 1; }

echo "==> Contributor: $NAME"
echo "==> Input:  $IN_ZKEY"
echo "    sha256: $(sha256sum "$IN_ZKEY" | cut -d' ' -f1)"
echo
echo "Verify that hash against the one the coordinator published before continuing."
echo
echo "snarkjs will now prompt you for random text. It is read from your terminal — it is never echoed,"
echo "never written to disk, and never appears in the process table or your shell history."
echo "This takes a few minutes."
echo

# No -e flag: snarkjs prompts and reads the entropy directly, so it never lands in argv.
$SNARK zkey contribute "$IN_ZKEY" "$OUT_ZKEY" --name="$NAME"

echo
echo "==> Output: $OUT_ZKEY"
echo "    sha256: $(sha256sum "$OUT_ZKEY" | cut -d' ' -f1)"
echo
echo "==> NOW DESTROY THE ENTROPY."
echo "    It only ever lived in this process's memory. Close this terminal."
echo "    If you ran this on a throwaway VM, destroy the VM; on a live machine, reboot."
echo
echo "==> Publish, verbatim:"
echo "      contributor: $NAME"
echo "      input  zkey sha256: $(sha256sum "$IN_ZKEY" | cut -d' ' -f1)"
echo "      output zkey sha256: $(sha256sum "$OUT_ZKEY" | cut -d' ' -f1)"
echo "      statement: I generated entropy that no one else saw and destroyed it after contributing."
echo
echo "Then hand $OUT_ZKEY to the next contributor."
