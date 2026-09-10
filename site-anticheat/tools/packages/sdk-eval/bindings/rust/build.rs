// Point the linker at the library CMake produced. Set CERBERUS_LIB_DIR to the
// build directory (it defaults to ../../build, which is where the package's
// own CMakeLists puts it).
fn main() {
    let dir = std::env::var("CERBERUS_LIB_DIR").unwrap_or_else(|_| "../../build".to_string());
    println!("cargo:rustc-link-search=native={}", dir);
    println!("cargo:rerun-if-env-changed=CERBERUS_LIB_DIR");
}
