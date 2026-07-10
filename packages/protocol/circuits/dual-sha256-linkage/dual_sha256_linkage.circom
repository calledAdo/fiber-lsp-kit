pragma circom 2.0.0;

include "circomlib/circuits/sha256/sha256.circom";
include "circomlib/circuits/bitify.circom";

// Domain-separated dual-sha256 linkage (LSPS-Fiber JIT).
// Both invoice preimages are kept to 32 bytes so a live FNN node can settle them.
// Proves knowledge of a private 32-byte secret S such that:
//   leg_hash  = sha256(S)                             (leg invoice; preimage is S)
//   hold_hash = sha256(sha256("LSPS-FIBER/JIT/HOLD\0" || S))
//                                                      (customer hold invoice; preimage is sha256(TAG||S))
// The TAG is essential: without it the hold preimage would be sha256(S) = the public leg_hash.
//
// Each 256-bit hash is exposed as two 128-bit big-endian limbs rather than 256 bit signals. That keeps
// nPublic at 4 instead of 512, which shrinks the verification key (its IC has nPublic+1 group elements)
// and makes verification a 5-point multi-scalar multiplication instead of a 513-point one.

template DualSha256Linkage() {
    signal input secret[32];  // private bytes

    // public: big-endian 128-bit limbs. hi = bytes 0..15, lo = bytes 16..31.
    signal input hold_hi;
    signal input hold_lo;
    signal input leg_hi;
    signal input leg_lo;

    var HOLD_TAG[20] = [76, 83, 80, 83, 45, 70, 73, 66, 69, 82, 47, 74, 73, 84, 47, 72, 79, 76, 68, 0];

    component secretBits[32];
    for (var s = 0; s < 32; s++) {
        secretBits[s] = Num2Bits(8);
        secretBits[s].in <== secret[s];
    }

    // leg_hash = sha256(S)  (32-byte preimage)
    component legSha = Sha256(256);
    for (var i = 0; i < 32; i++) {
        for (var bit = 0; bit < 8; bit++) {
            legSha.in[i * 8 + bit] <== secretBits[i].out[7 - bit];
        }
    }

    // hold inner: sha256(TAG_HOLD || S)  ((20 + 32) bytes = 416 bits) -> 32-byte hold preimage
    component holdInner = Sha256(416);
    for (var hb = 0; hb < 20; hb++) {
        for (var hbit = 0; hbit < 8; hbit++) {
            holdInner.in[hb * 8 + hbit] <== (HOLD_TAG[hb] >> (7 - hbit)) & 1;
        }
    }
    for (var i = 0; i < 32; i++) {
        for (var bit = 0; bit < 8; bit++) {
            holdInner.in[(20 + i) * 8 + bit] <== secretBits[i].out[7 - bit];
        }
    }

    // hold_hash = sha256(hold preimage)
    component holdOuter = Sha256(256);
    for (var k = 0; k < 256; k++) {
        holdOuter.in[k] <== holdInner.out[k];
    }

    // Pack each digest into two 128-bit big-endian limbs. Sha256.out[0] is the MSB of byte 0, while
    // Bits2Num.in[k] carries weight 2^k, so the bits are fed in reverse.
    component holdHi = Bits2Num(128);
    component holdLo = Bits2Num(128);
    component legHi = Bits2Num(128);
    component legLo = Bits2Num(128);
    for (var b = 0; b < 128; b++) {
        holdHi.in[b] <== holdOuter.out[127 - b];
        holdLo.in[b] <== holdOuter.out[255 - b];
        legHi.in[b] <== legSha.out[127 - b];
        legLo.in[b] <== legSha.out[255 - b];
    }

    hold_hi === holdHi.out;
    hold_lo === holdLo.out;
    leg_hi === legHi.out;
    leg_lo === legLo.out;
}

component main { public [hold_hi, hold_lo, leg_hi, leg_lo] } = DualSha256Linkage();
