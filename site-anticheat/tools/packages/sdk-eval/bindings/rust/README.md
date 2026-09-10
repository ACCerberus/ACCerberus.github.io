# Cerberus SDK — Rust bindings (evaluation)

A thin wrapper over the C API. The struct layout in `src/lib.rs` mirrors
`CerberusConfig` in `include/cerberus_sdk.h` field for field, so the two must be
changed together.

## Building

Build the C library first, as a shared library so Cargo can link it:

```sh
cmake -S ../.. -B ../../build -DCERBERUS_EVAL_SHARED=ON
cmake --build ../../build
CERBERUS_LIB_DIR=../../build cargo build
```

## Using it

```rust
use cerberus_sdk::CerberusConfig;

fn main() {
    let config = CerberusConfig::new("crb_live_xxxxxxxxxxxx", "CRB-0117");

    cerberus_sdk::init(&config).expect("cerberus init");
    cerberus_sdk::start_session("player-1001").expect("session start");
    // ... game loop ...
    cerberus_sdk::end_session().ok();
    cerberus_sdk::shutdown().ok();
}
```

This is the evaluation runtime: no kernel driver is loaded, nothing is sent
anywhere, and any detection you see is simulated. The production library and the
signed driver are issued with a partner key.
