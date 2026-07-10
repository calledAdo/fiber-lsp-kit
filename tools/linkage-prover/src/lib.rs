//! Groth16 proving core for the JIT linkage circuit, over BN254, on arkworks.
//!
//! The proving logic works on **bytes**, so the same code serves two front ends:
//!   - `main.rs` — the native CLI (rapidsnark-compatible: `<key> <wtns> <proof.json> <public.json>`).
//!   - `prove_wasm` below — an in-process entry compiled to `wasm32` via `wasm-bindgen`, so `@fiberlsp/prover-linked`
//!     can prove with no native binary to download and no subprocess to spawn.
//!
//! Loading a circom `.zkey` validates every curve point, which dominates the run. A `convert` step (CLI only)
//! writes arkworks' native serialization behind a magic header so a later run can skip revalidation; it is a
//! **local cache, never a distributable artifact** (no other prover reads it, and it carries no cross-version
//! guarantee).
mod zkey;

use ark_bn254::{Bn254, Fq, Fq2, Fr};
use ark_ff::{PrimeField, UniformRand};
use zkey::{read_zkey, CircomReduction};
use ark_groth16::{Groth16, Proof, ProvingKey};
use ark_relations::utils::matrix::Matrix;
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize, Compress, Validate};
use ark_std::rand::{rngs::StdRng, SeedableRng};
use std::io::{Cursor, Read, Write};

pub type Err = Box<dyn std::error::Error>;

/// Magic + format tag for a converted key. Bump `CACHE_FORMAT` whenever the arkworks serialization changes.
pub const CACHE_MAGIC: &[u8; 8] = b"FLSPARK\0";
pub const CACHE_FORMAT: u32 = 1;

/// A converted key: the proving key plus the A and B constraint matrices. Circom's `.zkey` stores no C matrix
/// (`CircomReduction` derives it), so none is carried here either.
pub type Converted = (usize, usize, Matrix<Fr>, Matrix<Fr>);

/// The result of a proof: the circom Groth16 JSON object and the decimal public signals.
pub struct ProveOutput {
    pub proof: serde_json::Value,
    pub public: Vec<String>,
}

/// Convert a circom `.zkey` (given as bytes) into the prover's native cached form (returned as bytes).
///
/// `read_zkey` validates every curve point. That check happens HERE, once, so the cache can be loaded later
/// without repeating it.
pub fn convert_bytes(zkey: &[u8]) -> Result<Vec<u8>, Err> {
    let (pk, m) = read_zkey(&mut Cursor::new(zkey))?;
    let mut out = Vec::new();
    out.write_all(CACHE_MAGIC)?;
    out.write_all(&CACHE_FORMAT.to_le_bytes())?;
    pk.serialize_uncompressed(&mut out)?;
    (m.num_instance_variables, m.num_constraints, m.a, m.b).serialize_uncompressed(&mut out)?;
    Ok(out)
}

/// Load either a circom `.zkey` (validated) or a previously converted key (trusted, we wrote it), from bytes.
/// The two are told apart by the converted key's magic header — a real `.zkey` starts with its own `zkey` magic.
pub fn load_key_from_bytes(bytes: &[u8]) -> Result<(ProvingKey<Bn254>, Converted), Err> {
    if bytes.len() >= 12 && &bytes[0..8] == CACHE_MAGIC {
        if u32::from_le_bytes(bytes[8..12].try_into().unwrap()) != CACHE_FORMAT {
            return Err("converted key is from an incompatible build; delete it and re-convert".into());
        }
        // Points were validated when this cache was written from the .zkey; skipping revalidation is the win.
        let mut cur = Cursor::new(&bytes[12..]);
        let pk = ProvingKey::<Bn254>::deserialize_with_mode(&mut cur, Compress::No, Validate::No)?;
        let rest = Converted::deserialize_with_mode(&mut cur, Compress::No, Validate::No)?;
        return Ok((pk, rest));
    }
    let (pk, m) = read_zkey(&mut Cursor::new(bytes))?;
    Ok((pk, (m.num_instance_variables, m.num_constraints, m.a, m.b)))
}

/// Prove from a proving key (`.zkey` or converted) and a circom `.wtns`, both as bytes.
pub fn prove_bytes(key: &[u8], wtns: &[u8]) -> Result<ProveOutput, Err> {
    let (pk, (n_inputs, n_constraints, a, b)) = load_key_from_bytes(key)?;
    let full = parse_wtns(wtns)?;
    if full.len() < n_inputs {
        return Err(format!("witness has {} values, expected at least {n_inputs}", full.len()).into());
    }

    // r and s blind the proof; they must be unpredictable, so seed from the OS CSPRNG (crypto.getRandomValues
    // under wasm via getrandom's `js` backend).
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).map_err(|e| format!("no OS entropy: {e}"))?;
    let mut rng = StdRng::from_seed(seed);
    let proof = Groth16::<Bn254, CircomReduction>::create_proof_with_reduction_and_matrices(
        &pk,
        Fr::rand(&mut rng),
        Fr::rand(&mut rng),
        &[a, b, vec![]],
        n_inputs,
        n_constraints,
        &full,
    )?;

    // full[0] is the constant 1; the public signals follow.
    let public: Vec<String> = full[1..n_inputs].iter().map(|x| x.into_bigint().to_string()).collect();
    Ok(ProveOutput { proof: proof_json(&proof), public })
}

/// circom Groth16 JSON: G1 as `[x, y, "1"]`, G2 as `[[x.c0, x.c1], [y.c0, y.c1], ["1", "0"]]`.
fn proof_json(p: &Proof<Bn254>) -> serde_json::Value {
    let g1 = |q: &ark_bn254::G1Affine| {
        serde_json::json!([q.x.into_bigint().to_string(), q.y.into_bigint().to_string(), "1"])
    };
    let f2 = |v: &Fq2| vec![fq(&v.c0), fq(&v.c1)];
    serde_json::json!({
        "pi_a": g1(&p.a),
        "pi_b": [f2(&p.b.x), f2(&p.b.y), ["1", "0"]],
        "pi_c": g1(&p.c),
        "protocol": "groth16",
        "curve": "bn128",
    })
}

fn fq(v: &Fq) -> String {
    v.into_bigint().to_string()
}

/// Minimal circom `.wtns` reader: section 1 carries `n8` and the count; section 2 is the field elements, LE.
pub fn parse_wtns(buf: &[u8]) -> Result<Vec<Fr>, Err> {
    if buf.len() < 12 || &buf[0..4] != b"wtns" {
        return Err("not a .wtns file".into());
    }
    let u32at = |p: usize| -> Result<usize, Err> {
        buf.get(p..p + 4)
            .ok_or_else(|| Err::from("truncated .wtns"))
            .map(|s| u32::from_le_bytes(s.try_into().unwrap()) as usize)
    };
    let u64at = |p: usize| -> Result<usize, Err> {
        buf.get(p..p + 8)
            .ok_or_else(|| Err::from("truncated .wtns"))
            .map(|s| u64::from_le_bytes(s.try_into().unwrap()) as usize)
    };

    let sections = u32at(8)?;
    let (mut n8, mut count, mut data) = (0usize, 0usize, 0usize);
    let mut p = 12usize;
    for _ in 0..sections {
        let ty = u32at(p)?;
        let len = u64at(p + 4)?;
        let body = p + 12;
        match ty {
            1 => {
                n8 = u32at(body)?;
                count = u32at(body + 4 + n8)?;
            }
            2 => data = body,
            _ => {}
        }
        p = body + len;
    }
    if n8 == 0 || data == 0 {
        return Err("`.wtns` is missing its header or witness section".into());
    }
    let end = data + count * n8;
    if end > buf.len() {
        return Err("`.wtns` witness section is truncated".into());
    }
    Ok((0..count)
        .map(|i| Fr::from_le_bytes_mod_order(&buf[data + i * n8..data + (i + 1) * n8]))
        .collect())
}

/// Read helper kept for the CLI's file paths (unused on wasm). Silences the dead-code lint off-wasm.
#[allow(dead_code)]
pub fn read_all(path: &str) -> Result<Vec<u8>, Err> {
    let mut buf = Vec::new();
    std::fs::File::open(path)?.read_to_end(&mut buf)?;
    Ok(buf)
}

/// wasm entry: prove from `.zkey`/converted-key bytes and `.wtns` bytes, returning
/// `{"proof": …, "publicSignals": […]}` as a JSON string. In-process; no subprocess, no native binary.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn prove_wasm(zkey: &[u8], wtns: &[u8]) -> Result<String, wasm_bindgen::JsValue> {
    console_error_panic_hook::set_once();
    let out = prove_bytes(zkey, wtns).map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))?;
    let v = serde_json::json!({ "proof": out.proof, "publicSignals": out.public });
    serde_json::to_string(&v).map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))
}
