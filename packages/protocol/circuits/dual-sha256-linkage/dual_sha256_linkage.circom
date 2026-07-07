pragma circom 2.0.0;

include "circomlib/circuits/sha256/sha256.circom";
include "circomlib/circuits/bitify.circom";

// Domain-separated dual-sha256 linkage (LSPS-Fiber JIT v1).
// Proves:
//   sha256("LSPS-FIBER/JIT/HOLD/v1\0" || S) = hold_hash
//   sha256("LSPS-FIBER/JIT/LEG/v1\0"  || S) = leg_hash
// S is a private 32-byte secret.

template DualSha256Linkage() {
    signal input secret[32];      // private bytes
    signal input hold_hash[256];  // public bits, big-endian hash order
    signal input leg_hash[256];   // public bits, big-endian hash order

    var HOLD_TAG[23] = [76, 83, 80, 83, 45, 70, 73, 66, 69, 82, 47, 74, 73, 84, 47, 72, 79, 76, 68, 47, 118, 49, 0];
    var LEG_TAG[22] = [76, 83, 80, 83, 45, 70, 73, 66, 69, 82, 47, 74, 73, 84, 47, 76, 69, 71, 47, 118, 49, 0];

    component secretBits[32];
    for (var s = 0; s < 32; s++) {
        secretBits[s] = Num2Bits(8);
        secretBits[s].in <== secret[s];
    }

    component holdSha = Sha256(440); // (23 + 32) bytes * 8 bits
    component legSha = Sha256(432);  // (22 + 32) bytes * 8 bits

    for (var hb = 0; hb < 23; hb++) {
        for (var hbit = 0; hbit < 8; hbit++) {
            holdSha.in[hb * 8 + hbit] <== (HOLD_TAG[hb] >> (7 - hbit)) & 1;
        }
    }

    for (var lb = 0; lb < 22; lb++) {
        for (var lbit = 0; lbit < 8; lbit++) {
            legSha.in[lb * 8 + lbit] <== (LEG_TAG[lb] >> (7 - lbit)) & 1;
        }
    }

    for (var i = 0; i < 32; i++) {
        for (var bit = 0; bit < 8; bit++) {
            holdSha.in[(23 + i) * 8 + bit] <== secretBits[i].out[7 - bit];
            legSha.in[(22 + i) * 8 + bit] <== secretBits[i].out[7 - bit];
        }
    }

    for (var h = 0; h < 256; h++) {
        hold_hash[h] * (hold_hash[h] - 1) === 0;
        holdSha.out[h] === hold_hash[h];
    }

    for (var l = 0; l < 256; l++) {
        leg_hash[l] * (leg_hash[l] - 1) === 0;
        legSha.out[l] === leg_hash[l];
    }
}

component main { public [hold_hash, leg_hash] } = DualSha256Linkage();
