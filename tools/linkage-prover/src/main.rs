//! Groth16 prover for the JIT linkage circuit, over BN254, on arkworks.
//!
//! Deliberately CLI-compatible with rapidsnark, so `@fiberlsp/prover-linked` can drive either:
//!
//!     linkage-prover <circuit.zkey> <witness.wtns> <proof.json> <public.json>
//!
//! It emits the standard circom Groth16 JSON, which `verifyGroth16Bn254` in `@fiberlsp/protocol` accepts.
//!
//! Loading a circom `.zkey` validates every curve point, which dominates the run (~4.5 s for the shipped
//! circuit against ~0.12 s of proving). Convert it once and the load drops to ~0.9 s:
//!
//!     linkage-prover convert <circuit.zkey> <circuit.ark>
//!     linkage-prover <circuit.ark> <witness.wtns> <proof.json> <public.json>
//!
//! The converted key is arkworks' own serialization: it is a local cache, not a distributable artifact, and it
//! is not interchangeable across arkworks versions. Ship the `.zkey`.
use ark_bn254::{Bn254, Fq, Fq2, Fr};
use ark_circom::{read_zkey, CircomReduction};
use ark_ff::{BigInteger, PrimeField, UniformRand};
use ark_groth16::{Groth16, Proof, ProvingKey};
use ark_relations::utils::matrix::Matrix;
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize, Compress, Validate};
use ark_std::rand::{rngs::StdRng, SeedableRng};
use std::{fs::File, io::Read, process::ExitCode};

type Err = Box<dyn std::error::Error>;

/// A converted key: the proving key plus the A and B constraint matrices. Circom's `.zkey` stores no C matrix
/// (`CircomReduction` derives it), so none is carried here either.
type Converted = (usize, usize, Matrix<Fr>, Matrix<Fr>);

fn usage() -> ExitCode {
    eprintln!("usage: linkage-prover <circuit.zkey|.ark> <witness.wtns> <proof.json> <public.json>");
    eprintln!("       linkage-prover convert <circuit.zkey> <circuit.ark>");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.as_slice() {
        [c, zkey, out] if c == "convert" => convert(zkey, out),
        [key, wtns, proof, public] => prove(key, wtns, proof, public),
        _ => return usage(),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("linkage-prover: {e}");
            ExitCode::FAILURE
        }
    }
}

fn convert(zkey: &str, out: &str) -> Result<(), Err> {
    let mut f = File::open(zkey)?;
    let (pk, m) = read_zkey(&mut f)?;
    let mut w = File::create(out)?;
    pk.serialize_uncompressed(&mut w)?;
    (m.num_instance_variables, m.num_constraints, m.a, m.b).serialize_uncompressed(&mut w)?;
    Ok(())
}

/// Load either a circom `.zkey` (validated) or a previously converted key (trusted, we wrote it).
fn load_key(path: &str) -> Result<(ProvingKey<Bn254>, Converted), Err> {
    if path.ends_with(".zkey") {
        let mut f = File::open(path)?;
        let (pk, m) = read_zkey(&mut f)?;
        return Ok((pk, (m.num_instance_variables, m.num_constraints, m.a, m.b)));
    }
    let mut f = File::open(path)?;
    let pk = ProvingKey::<Bn254>::deserialize_with_mode(&mut f, Compress::No, Validate::No)?;
    let rest = Converted::deserialize_with_mode(&mut f, Compress::No, Validate::No)?;
    Ok((pk, rest))
}

fn prove(key: &str, wtns: &str, proof_out: &str, public_out: &str) -> Result<(), Err> {
    let (pk, (n_inputs, n_constraints, a, b)) = load_key(key)?;
    let full = read_wtns(wtns)?;
    if full.len() < n_inputs {
        return Err(format!("witness has {} values, expected at least {n_inputs}", full.len()).into());
    }

    // r and s blind the proof; they must be unpredictable, so seed from the OS CSPRNG.
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
    std::fs::write(proof_out, serde_json::to_string_pretty(&proof_json(&proof))?)?;
    std::fs::write(public_out, serde_json::to_string_pretty(&public)?)?;
    Ok(())
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
fn read_wtns(path: &str) -> Result<Vec<Fr>, Err> {
    let mut buf = Vec::new();
    File::open(path)?.read_to_end(&mut buf)?;
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
