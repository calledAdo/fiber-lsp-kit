//! Native CLI for the JIT linkage prover. Deliberately rapidsnark-compatible so `@fiberlsp/prover-linked` can
//! drive either:
//!
//!     linkage-prover <circuit.zkey|.ark> <witness.wtns> <proof.json> <public.json>
//!     linkage-prover convert <circuit.zkey> <circuit.ark>
//!
//! All proving logic lives in the crate lib (`prove_bytes` / `convert_bytes`), shared with the wasm entry point.
use linkage_prover::{convert_bytes, prove_bytes, read_all, Err};
use std::process::ExitCode;

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
    std::fs::write(out, convert_bytes(&read_all(zkey)?)?)?;
    Ok(())
}

fn prove(key: &str, wtns: &str, proof_out: &str, public_out: &str) -> Result<(), Err> {
    let out = prove_bytes(&read_all(key)?, &read_all(wtns)?)?;
    std::fs::write(proof_out, serde_json::to_string_pretty(&out.proof)?)?;
    std::fs::write(public_out, serde_json::to_string_pretty(&out.public)?)?;
    Ok(())
}
