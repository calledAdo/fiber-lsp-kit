pragma circom 2.0.0;

include "circomlib/circuits/sha256/sha256.circom";
include "circomlib/circuits/bitify.circom";

// Domain-separated dual-sha256 linkage (LSPS-Fiber JIT).
// Both invoice preimages are kept to 32 bytes so a live FNN node can settle them.
// Proves knowledge of a private 32-byte secret S such that:
//   leg_hash  = sha256(S)                             (merchant leg invoice; preimage is S)
//   hold_hash = sha256(sha256("LSPS-FIBER/JIT/HOLD\0" || S))
//                                                      (customer hold invoice; preimage is sha256(TAG||S))
// The TAG is essential: without it the hold preimage would be sha256(S) = the public leg_hash.

template DualSha256Linkage() {
    signal input secret[32];      // private bytes
    signal input hold_hash[256];  // public bits, big-endian hash order
    signal input leg_hash[256];   // public bits, big-endian hash order

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

    // hold_hash = sha256(hold preimage)  (the inner digest's 256 bits, big-endian)
    component holdOuter = Sha256(256);
    for (var k = 0; k < 256; k++) {
        holdOuter.in[k] <== holdInner.out[k];
    }

    for (var h = 0; h < 256; h++) {
        hold_hash[h] * (hold_hash[h] - 1) === 0;
        holdOuter.out[h] === hold_hash[h];
    }

    for (var l = 0; l < 256; l++) {
        leg_hash[l] * (leg_hash[l] - 1) === 0;
        legSha.out[l] === leg_hash[l];
    }
}

component main { public [hold_hash, leg_hash] } = DualSha256Linkage();
