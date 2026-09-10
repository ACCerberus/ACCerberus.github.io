//! Cerberus SDK — Rust bindings (evaluation build).
//!
//! A thin, safe-ish wrapper over the C API in `include/cerberus_sdk.h`. The
//! layout of [`CerberusConfigRaw`] mirrors the C `CerberusConfig` field for
//! field; changing the header without changing this file will break the ABI.
//!
//! Link against the library CMake produces:
//!
//! ```text
//! cmake -S . -B build -DCERBERUS_EVAL_SHARED=ON
//! cmake --build build
//! CERBERUS_LIB_DIR=build cargo build
//! ```
//!
//! As with every part of the evaluation package, no kernel driver is loaded
//! and no network call is made — detections are simulated.

#![allow(non_snake_case)]

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};

pub const SDK_VERSION: &str = "0.6.0-eval";
pub const CALLBACK_ABI_VERSION: u32 = 3;

/// Mirrors `CerberusResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    InvalidArgument,
    AlreadyInitialised,
    NotInitialised,
    InvalidKey,
    UnsupportedOs,
    EvaluationOnly,
    Other(i32),
}

impl Error {
    fn from_code(code: i32) -> Option<Error> {
        match code {
            0 => None,
            -1 => Some(Error::InvalidKey),
            -3 => Some(Error::AlreadyInitialised),
            -4 => Some(Error::NotInitialised),
            -12 => Some(Error::InvalidArgument),
            -13 => Some(Error::UnsupportedOs),
            -90 => Some(Error::EvaluationOnly),
            other => Some(Error::Other(other)),
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

/// Detection regions. `Auto` lets the runtime pick the nearest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum Region {
    UsEast = 0,
    EuWest = 1,
    ApSoutheast = 2,
    Auto = 99,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum LogLevel {
    None = 0,
    Error = 1,
    Warn = 2,
    Info = 3,
    Debug = 4,
}

/// The C `CerberusConfig`. Field order and types must match the header.
#[repr(C)]
struct CerberusConfigRaw {
    api_key: *const c_char,
    game_id: *const c_char,
    region: i32,
    enable_ai: bool,
    enable_hw: bool,
    enable_net: bool,
    scan_interval: u32,
    ai_sample_rate: u32,
    ban_callback: *const c_void,
    flag_callback: *const c_void,
    log_level: i32,
    require_iommu: bool,
    zero_footprint: bool,
    attestation_report: *mut c_void,
    user_data: *mut c_void,
    reserved: [u32; 4],
}

/// Owns the strings the C struct points at, so they outlive the call.
pub struct CerberusConfig {
    api_key: CString,
    game_id: CString,
    pub region: Region,
    pub enable_ai: bool,
    pub enable_hw: bool,
    pub enable_net: bool,
    pub scan_interval_ms: u32,
    pub ai_sample_rate_ms: u32,
    pub log_level: LogLevel,
    pub require_iommu: bool,
    pub zero_footprint: bool,
}

impl CerberusConfig {
    /// `api_key` must begin with `crb_`; `game_id` is your title's stable id.
    pub fn new(api_key: &str, game_id: &str) -> CerberusConfig {
        CerberusConfig {
            api_key: CString::new(api_key).expect("api key contains a NUL byte"),
            game_id: CString::new(game_id).expect("game id contains a NUL byte"),
            region: Region::Auto,
            enable_ai: true,
            enable_hw: true,
            enable_net: true,
            scan_interval_ms: 0,
            ai_sample_rate_ms: 0,
            log_level: LogLevel::Info,
            require_iommu: false,
            zero_footprint: false,
        }
    }

    pub fn region(mut self, region: Region) -> Self {
        self.region = region;
        self
    }

    /// Milliseconds between kernel scans. Minimum 500; 0 keeps the default 2000.
    pub fn scan_interval_ms(mut self, ms: u32) -> Self {
        self.scan_interval_ms = ms;
        self
    }

    pub fn log_level(mut self, level: LogLevel) -> Self {
        self.log_level = level;
        self
    }

    fn as_raw(&self) -> CerberusConfigRaw {
        CerberusConfigRaw {
            api_key: self.api_key.as_ptr(),
            game_id: self.game_id.as_ptr(),
            region: self.region as i32,
            enable_ai: self.enable_ai,
            enable_hw: self.enable_hw,
            enable_net: self.enable_net,
            scan_interval: self.scan_interval_ms,
            ai_sample_rate: self.ai_sample_rate_ms,
            ban_callback: std::ptr::null(),
            flag_callback: std::ptr::null(),
            log_level: self.log_level as i32,
            require_iommu: self.require_iommu,
            zero_footprint: self.zero_footprint,
            attestation_report: std::ptr::null_mut(),
            user_data: std::ptr::null_mut(),
            reserved: [0; 4],
        }
    }
}

#[link(name = "cerberus_sdk")]
extern "C" {
    fn cerberus_init(config: *const CerberusConfigRaw) -> c_int;
    fn cerberus_shutdown() -> c_int;
    fn cerberus_start_session(player_id: *const c_char) -> c_int;
    fn cerberus_end_session() -> c_int;
    fn cerberus_version() -> *const c_char;
    fn cerberus_is_evaluation_build() -> bool;
}

fn check(code: c_int) -> Result<()> {
    match Error::from_code(code as i32) {
        None => Ok(()),
        Some(e) => Err(e),
    }
}

/// Initialise the runtime. Call once, before any session.
pub fn init(config: &CerberusConfig) -> Result<()> {
    let raw = config.as_raw();
    check(unsafe { cerberus_init(&raw) })
}

/// Begin protecting a player. One session at a time on this entry point.
pub fn start_session(player_id: &str) -> Result<()> {
    let id = CString::new(player_id).map_err(|_| Error::InvalidArgument)?;
    check(unsafe { cerberus_start_session(id.as_ptr()) })
}

pub fn end_session() -> Result<()> {
    check(unsafe { cerberus_end_session() })
}

pub fn shutdown() -> Result<()> {
    check(unsafe { cerberus_shutdown() })
}

/// Version string reported by the linked runtime, e.g. `0.6.0-eval`.
pub fn version() -> String {
    unsafe { CStr::from_ptr(cerberus_version()) }
        .to_string_lossy()
        .into_owned()
}

/// True when linked against the evaluation runtime (no driver, no network).
pub fn is_evaluation_build() -> bool {
    unsafe { cerberus_is_evaluation_build() }
}
