pragma circom 2.0.0;

include "circomlib/circuits/sha256/sha256.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/poseidon.circom";

// Single-node JIT linkage (LSPS-Fiber).
// Both invoice preimages are kept to 32 bytes so a live FNN node can settle them.
// Proves knowledge of a private 32-byte secret S such that:
//   merchant_payment_hash = sha256(S)           (merchant invoice; preimage is S)
//   hold_hash = sha256(poseidon(S))              (hold invoice; preimage is poseidon(S))
//
// Only the two invoice hashes must be SHA-256 — FNN computes payment_hash that way. The derivation
// poseidon(S) is ours to choose and carries no security weight: reaching hold_preimage means inverting a
// SHA-256 (either hold_hash, or merchant_payment_hash to recover S). Poseidon costs about 250 constraints
// instead of ~30k for a SHA-256 block, which halves the FFT domain and the proving key. It only has to be
// deterministic and distinct from sha256(S), or hold_preimage would equal the public merchant_payment_hash.
//
// Each 256-bit hash is exposed as two 128-bit big-endian limbs rather than 256 bit signals, keeping nPublic
// at 4 instead of 512 (the verifying key's IC carries nPublic + 1 group elements).

template DualSha256Linkage() {
    signal input secret[32];  // private bytes

    // public: big-endian 128-bit limbs. hi = bytes 0..15, lo = bytes 16..31.
    signal input hold_hi;
    signal input hold_lo;
    signal input merchant_hash_hi;
    signal input merchant_hash_lo;

    component secretBits[32];
    for (var s = 0; s < 32; s++) {
        secretBits[s] = Num2Bits(8);
        secretBits[s].in <== secret[s];
    }

    // merchant_payment_hash = sha256(S)  (32-byte preimage)
    component merchantSha = Sha256(256);
    for (var i = 0; i < 32; i++) {
        for (var bit = 0; bit < 8; bit++) {
            merchantSha.in[i * 8 + bit] <== secretBits[i].out[7 - bit];
        }
    }

    // S as two 128-bit big-endian limbs (a 32-byte value exceeds the BN254 field).
    component sHi = Bits2Num(128);
    component sLo = Bits2Num(128);
    for (var b = 0; b < 128; b++) {
        sHi.in[b] <== secretBits[15 - (b \ 8)].out[b % 8];
        sLo.in[b] <== secretBits[31 - (b \ 8)].out[b % 8];
    }

    // hold_preimage = poseidon(S), encoded big-endian into 32 bytes (top two bits are zero: out < p < 2^254).
    component pos = Poseidon(2);
    pos.inputs[0] <== sHi.out;
    pos.inputs[1] <== sLo.out;

    component posBits = Num2Bits_strict();
    posBits.in <== pos.out;

    component holdOuter = Sha256(256);
    for (var j = 0; j < 256; j++) {
        if (j < 2) {
            holdOuter.in[j] <== 0;
        } else {
            holdOuter.in[j] <== posBits.out[255 - j];
        }
    }

    // Pack each digest into two 128-bit big-endian limbs. Sha256.out[0] is the MSB of byte 0, while
    // Bits2Num.in[k] carries weight 2^k, so the bits are fed in reverse.
    component holdHi = Bits2Num(128);
    component holdLo = Bits2Num(128);
    component merchantHashHi = Bits2Num(128);
    component merchantHashLo = Bits2Num(128);
    for (var b = 0; b < 128; b++) {
        holdHi.in[b] <== holdOuter.out[127 - b];
        holdLo.in[b] <== holdOuter.out[255 - b];
        merchantHashHi.in[b] <== merchantSha.out[127 - b];
        merchantHashLo.in[b] <== merchantSha.out[255 - b];
    }

    hold_hi === holdHi.out;
    hold_lo === holdLo.out;
    merchant_hash_hi === merchantHashHi.out;
    merchant_hash_lo === merchantHashLo.out;
}

component main { public [hold_hi, hold_lo, merchant_hash_hi, merchant_hash_lo] } = DualSha256Linkage();
