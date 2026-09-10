/*
 * cerberus_sdk.h - Cerberus Anti-Cheat SDK, public C API
 *
 * SDK 0.6.0 (evaluation build)
 * https://cerberusac.dev/sdk/
 *
 * The SDK version tracks the engine MINOR version (0.6.x), not the daily
 * engine build. Engine builds ship to players through the runtime updater;
 * the SDK is not re-cut per build. An SDK built against 0.6.0 links against
 * any 0.6.x runtime.
 *
 * This header is the same header shipped in the partner runtime package. The
 * evaluation build implements it against a local simulation: there is no
 * kernel driver, no hardware attestation and no network. Every entry point
 * behaves, returns and logs the way the production runtime does, so you can
 * write and review your integration end to end before a key is issued.
 *
 * Compiles as C99 and as C++17 under MSVC and Clang.
 *
 * Platform: Windows 10 21H2 (build 19044) or later, or Windows 11, x64.
 */

#ifndef CERBERUS_SDK_H
#define CERBERUS_SDK_H

#include <stdint.h>
#include <stddef.h>

#if !defined(__cplusplus)
#  include <stdbool.h>
#endif

/* -------------------------------------------------------------------------
 * Version
 * ---------------------------------------------------------------------- */

#define CERBERUS_SDK_VERSION_MAJOR   0
#define CERBERUS_SDK_VERSION_MINOR   6
#define CERBERUS_SDK_VERSION_PATCH   0
#define CERBERUS_SDK_VERSION_STRING  "0.6.0"

/* Callback struct ABI understood by this header. */
#define CERBERUS_CALLBACK_ABI        3

/* -------------------------------------------------------------------------
 * Linkage
 * ---------------------------------------------------------------------- */

#if defined(_WIN32)
#  if defined(CERBERUS_BUILD_SHARED)
#    define CERBERUS_API __declspec(dllexport)
#  elif defined(CERBERUS_USE_SHARED)
#    define CERBERUS_API __declspec(dllimport)
#  else
#    define CERBERUS_API
#  endif
#else
#  define CERBERUS_API
#endif

/* All callbacks and entry points use the platform default (cdecl on x64). */
#define CERBERUS_CALL

#ifdef __cplusplus
extern "C" {
#endif

/* -------------------------------------------------------------------------
 * Result codes
 * ---------------------------------------------------------------------- */

typedef enum CerberusResult {
    CERBERUS_OK                     = 0,

    CERBERUS_ERR_INVALID_KEY        = -1,   /* apiKey missing or malformed        */
    CERBERUS_ERR_INVALID_CONFIG     = -2,   /* a required config field is unusable */
    CERBERUS_ERR_ALREADY_INIT       = -3,   /* cerberus_init called twice          */
    CERBERUS_ERR_NOT_INITIALIZED    = -4,   /* call before a successful init       */
    CERBERUS_ERR_DRIVER_UNAVAILABLE = -5,   /* kernel layer could not be loaded    */
    CERBERUS_ERR_ATTESTATION_FAILED = -6,   /* boot chain or hardware attestation  */
    CERBERUS_ERR_NETWORK            = -7,   /* sentinel endpoint unreachable       */
    CERBERUS_ERR_SESSION_LIMIT      = -8,   /* concurrent session cap for this key */
    CERBERUS_ERR_INVALID_SESSION    = -9,   /* unknown or already-ended session    */
    CERBERUS_ERR_PERMISSION_DENIED  = -10,  /* insufficient rights for this action */
    CERBERUS_ERR_TIMEOUT            = -11,  /* operation did not complete in time  */
    CERBERUS_ERR_BUFFER_TOO_SMALL   = -12,  /* caller buffer too small             */
    CERBERUS_ERR_UNSUPPORTED_OS     = -13,  /* below Windows 10 21H2, or not x64   */

    CERBERUS_ERR_EVALUATION_ONLY    = -90,  /* not available in the eval build     */
    CERBERUS_ERR_INTERNAL           = -100  /* unexpected internal failure         */
} CerberusResult;

/* -------------------------------------------------------------------------
 * Regions
 *
 * Cerberus operates three regions. AUTO selects by latency at init.
 * ---------------------------------------------------------------------- */

typedef enum CerberusRegion {
    CERBERUS_REGION_AUTO         = 0,
    CERBERUS_REGION_US_EAST      = 1,
    CERBERUS_REGION_EU_WEST      = 2,
    CERBERUS_REGION_AP_SOUTHEAST = 3
} CerberusRegion;

/* -------------------------------------------------------------------------
 * Detection layers (bit flags)
 *
 * Layer 1 kernel integrity, Layer 2 behavioural AI, Layer 3 hardware
 * fingerprinting, Layer 4 network sentinel.
 * ---------------------------------------------------------------------- */

#define CERBERUS_LAYER_NONE        0x00u
#define CERBERUS_LAYER_KERNEL      0x01u   /* Layer 1 */
#define CERBERUS_LAYER_BEHAVIORAL  0x02u   /* Layer 2 */
#define CERBERUS_LAYER_AI          CERBERUS_LAYER_BEHAVIORAL
#define CERBERUS_LAYER_HARDWARE    0x04u   /* Layer 3 */
#define CERBERUS_LAYER_NETWORK     0x08u   /* Layer 4 */
#define CERBERUS_LAYER_ALL         0x0Fu

/* -------------------------------------------------------------------------
 * Logging
 * ---------------------------------------------------------------------- */

typedef enum CerberusLogLevel {
    CERBERUS_LOG_OFF   = 0,
    CERBERUS_LOG_ERROR = 1,
    CERBERUS_LOG_WARN  = 2,
    CERBERUS_LOG_INFO  = 3,
    CERBERUS_LOG_DEBUG = 4,
    CERBERUS_LOG_TRACE = 5
} CerberusLogLevel;

/* -------------------------------------------------------------------------
 * Ban reasons - mirrors the engine detection categories shown in the
 * dashboard and returned by the REST API.
 * ---------------------------------------------------------------------- */

typedef enum CerberusBanReason {
    CERBERUS_BAN_UNKNOWN          = 0,
    CERBERUS_BAN_AIMBOT           = 1,
    CERBERUS_BAN_WALLHACK_ESP     = 2,
    CERBERUS_BAN_DMA_EXTERNAL     = 3,
    CERBERUS_BAN_KERNEL_DRIVER    = 4,
    CERBERUS_BAN_SPEED_HACK       = 5,
    CERBERUS_BAN_HWID_SPOOF       = 6,
    CERBERUS_BAN_INPUT_INJECTION  = 7,
    CERBERUS_BAN_MEMORY_TAMPER    = 8,
    CERBERUS_BAN_SIGNATURE_MATCH  = 9,
    CERBERUS_BAN_MANUAL_REVIEW    = 10
} CerberusBanReason;

/* -------------------------------------------------------------------------
 * Lifecycle events
 * ---------------------------------------------------------------------- */

typedef enum CerberusEventType {
    CERBERUS_EVENT_READY              = 0,  /* initialisation complete          */
    CERBERUS_EVENT_ATTEST_FAILED      = 1,  /* attestation could not be produced */
    CERBERUS_EVENT_DRIVER_UNAVAILABLE = 2,  /* kernel layer is not loaded        */
    CERBERUS_EVENT_SIGNATURE_SYNC     = 3,  /* signature set updated             */
    CERBERUS_EVENT_SHUTDOWN           = 4   /* runtime is shutting down          */
} CerberusEventType;

/* -------------------------------------------------------------------------
 * Runtime options (cerberus_set_option)
 * ---------------------------------------------------------------------- */

typedef enum CerberusOption {
    CERBERUS_OPT_HW_SCAN        = 1,  /* 0/1 - enable the hardware layer scan   */
    CERBERUS_OPT_SCAN_INTERVAL  = 2,  /* milliseconds, minimum 500              */
    CERBERUS_OPT_AI_SAMPLE_RATE = 3,  /* milliseconds, 250 - 2000               */
    CERBERUS_OPT_LOG_LEVEL      = 4,  /* CerberusLogLevel                       */
    CERBERUS_OPT_REQUIRE_IOMMU  = 5   /* 0/1 - refuse sessions without IOMMU    */
} CerberusOption;

/* -------------------------------------------------------------------------
 * Structures
 * ---------------------------------------------------------------------- */

/* Boot chain and hardware attestation summary. */
typedef struct CerberusAttestation {
    bool     secureBoot;        /* Secure Boot reported enabled                 */
    bool     hvci;              /* hypervisor-enforced code integrity running   */
    bool     iommu;             /* IOMMU / VT-d available to the platform       */
    bool     tpmPresent;        /* a TPM was found                              */
    uint16_t tpmSpecMajor;      /* 2 for TPM 2.0, 1 for TPM 1.2, 0 unknown      */
    uint16_t tpmSpecMinor;      /* 0 for TPM 2.0, 2 for TPM 1.2                 */
    uint32_t bootChainScore;    /* 0-100; below 60 the kernel layer degrades    */
    char     digest[65];        /* hex SHA-256 of the measured chain, NUL-term. */
} CerberusAttestation;

/* Lifecycle event delivered through cerberus_session_pump. */
typedef struct CerberusEvent {
    CerberusEventType type;
    CerberusResult    result;      /* CERBERUS_OK unless the event is a failure */
    uint32_t          layer;       /* CERBERUS_LAYER_* bit, or LAYER_NONE       */
    int64_t           timestamp;   /* Unix seconds, UTC                         */
    char              message[192];
} CerberusEvent;

/* A confirmed detection. Delivered on the ban callback. */
typedef struct CerberusBanInfo {
    char              id[32];              /* opaque detection id, NUL-terminated  */
    char              appealReference[21]; /* "CB-XXXXX-XXXXX-XXXXX", NUL-term.    */
    const char*       playerId;            /* the id you passed to session start   */
    uint32_t          layer;               /* layer that produced the verdict      */
    CerberusBanReason reason;
    float             confidence;          /* 0.0 - 1.0                            */
    const char*       details;             /* short human-readable summary         */
    CerberusAttestation attestation;
    int64_t           timestamp;           /* Unix seconds, UTC                    */
} CerberusBanInfo;

/* A suspicion below the ban threshold. Queued for review, never auto-enforced. */
typedef struct CerberusFlagInfo {
    char              id[32];
    const char*       playerId;
    uint32_t          layer;
    CerberusBanReason reason;
    float             confidence;          /* 0.0 - 1.0                            */
    const char*       details;
    int64_t           timestamp;
} CerberusFlagInfo;

/* Names used by the REST API documentation for the same payloads. */
typedef CerberusBanInfo  CerberusBanEvent;
typedef CerberusFlagInfo CerberusFlagEvent;

/* -------------------------------------------------------------------------
 * Callbacks
 *
 * Callbacks are invoked on the thread that calls cerberus_session_pump.
 * They must not block and must not call back into the SDK.
 * ---------------------------------------------------------------------- */

typedef void (CERBERUS_CALL *CerberusBanFn)(const CerberusBanInfo* info, void* userData);
typedef void (CERBERUS_CALL *CerberusFlagFn)(const CerberusFlagInfo* info, void* userData);
typedef void (CERBERUS_CALL *CerberusEventFn)(const CerberusEvent* ev, void* userData);

/* Versioned callback block. Set abiVersion to CERBERUS_CALLBACK_ABI.
 * If a V3 block is installed it takes precedence over the callbacks in
 * CerberusConfig. */
typedef struct CerberusCallbacksV3 {
    uint32_t        abiVersion;
    CerberusBanFn   onBan;
    CerberusFlagFn  onFlag;
    CerberusEventFn onEvent;
    void*           userData;
} CerberusCallbacksV3;

/* -------------------------------------------------------------------------
 * Configuration
 *
 * Zero the struct first; every field accepts 0 / NULL to mean "default".
 *
 *   CerberusConfig config;
 *   memset(&config, 0, sizeof config);
 *   config.apiKey = "crb_live_...";
 *   config.gameId = "your-title";
 * ---------------------------------------------------------------------- */

typedef struct CerberusConfig {
    const char*      apiKey;        /* required, begins "crb_"                  */
    const char*      gameId;        /* required, your title's stable identifier */
    CerberusRegion   region;        /* default CERBERUS_REGION_AUTO             */

    bool             enableAI;      /* Layer 2                                  */
    bool             enableHW;      /* Layer 3                                  */
    bool             enableNET;     /* Layer 4                                  */

    uint32_t         scanInterval;  /* ms, minimum 500, 0 = default 2000        */
    uint32_t         aiSampleRate;  /* ms, 250 - 2000, 0 = default 1000         */

    CerberusBanFn    banCallback;   /* optional; superseded by CerberusCallbacksV3  */
    CerberusFlagFn   flagCallback;  /* optional; superseded by CerberusCallbacksV3  */

    CerberusLogLevel logLevel;      /* default CERBERUS_LOG_INFO                */
    bool             requireIommu;  /* refuse sessions on platforms without IOMMU */
    bool             zeroFootprint; /* do not write a local session journal     */

    CerberusAttestation* attestationReport; /* optional out-param, filled at init */
    void*            userData;      /* passed back to config callbacks          */
    uint32_t         reserved[4];   /* must be zero                             */
} CerberusConfig;

/* Opaque per-player session handle. */
typedef struct CerberusSession CerberusSession;

/* -------------------------------------------------------------------------
 * Lifecycle
 * ---------------------------------------------------------------------- */

/* Initialise the runtime. Blocking. */
CERBERUS_API CerberusResult CERBERUS_CALL cerberus_init(const CerberusConfig* config);

/* Initialise without blocking the calling thread. Progress and the final
 * READY (or failure) event are delivered through onEvent when you next call
 * cerberus_session_pump. */
CERBERUS_API CerberusResult CERBERUS_CALL cerberus_init_async(const CerberusConfig* config,
                                                              CerberusEventFn onEvent,
                                                              void* userData);

/* Install or replace the versioned callback block. May be called before or
 * after init. Pass NULL to clear. */
CERBERUS_API CerberusResult CERBERUS_CALL cerberus_set_callbacks(const CerberusCallbacksV3* callbacks);

/* Change a runtime option. Valid after init. */
CERBERUS_API CerberusResult CERBERUS_CALL cerberus_set_option(CerberusOption option, int32_t value);

/* Shut the runtime down. Ends any open sessions and flushes queued events. */
CERBERUS_API CerberusResult CERBERUS_CALL cerberus_shutdown(void);

/* -------------------------------------------------------------------------
 * Introspection
 * ---------------------------------------------------------------------- */

/* "0.6.0" for the partner runtime, "0.6.0-eval" for this build. Never NULL. */
CERBERUS_API const char* CERBERUS_CALL cerberus_version(void);

/* Human-readable text for a result code. Never NULL. */
CERBERUS_API const char* CERBERUS_CALL cerberus_error_string(CerberusResult result);

/* true in the evaluation build, false in the partner runtime. Gate anything
 * that must not ship enabled on this. */
CERBERUS_API bool CERBERUS_CALL cerberus_is_evaluation_build(void);

/* -------------------------------------------------------------------------
 * Sessions
 *
 * One session per player, per match. Start it when the player enters a
 * protected context, pump it from your frame or tick loop, end it when they
 * leave.
 * ---------------------------------------------------------------------- */

CERBERUS_API CerberusResult CERBERUS_CALL cerberus_session_start(const char* playerId,
                                                                 CerberusSession** outSession);

/* Tell the runtime the player is still active. Call at least every 30 s. */
CERBERUS_API CerberusResult CERBERUS_CALL cerberus_session_heartbeat(CerberusSession* session);

CERBERUS_API CerberusResult CERBERUS_CALL cerberus_session_end(CerberusSession* session);

/* Deliver up to maxEvents queued callbacks on the calling thread.
 * Pass 0 for maxEvents to drain the queue. Returns the number delivered, or a
 * negative CerberusResult on error. */
CERBERUS_API int32_t CERBERUS_CALL cerberus_session_pump(CerberusSession* session, int32_t maxEvents);

/* -------------------------------------------------------------------------
 * Single-session convenience API
 *
 * For titles with exactly one local player. Wraps one implicit session; the
 * handle is managed for you.
 * ---------------------------------------------------------------------- */

CERBERUS_API CerberusResult CERBERUS_CALL cerberus_start_session(const char* playerId);

/* As above, plus a free-form tag recorded with the session (playlist, map,
 * build id - anything you want to see next to a detection in the dashboard). */
CERBERUS_API CerberusResult CERBERUS_CALL cerberus_start_session_ex(const char* playerId,
                                                                    const char* sessionTag);

CERBERUS_API CerberusResult CERBERUS_CALL cerberus_end_session(void);

/* -------------------------------------------------------------------------
 * Evaluation-only entry point
 *
 * Drives the simulated detection timeline. Returns CERBERUS_ERR_EVALUATION_ONLY
 * in the partner runtime, so a call left in shipping code fails loudly instead
 * of silently doing nothing.
 *   0 = off, 1 = emit a flag, 2 = emit a flag and then a ban.
 * Equivalent to setting CERBERUS_EVAL_SIMULATE=flag|ban in the environment.
 * ---------------------------------------------------------------------- */
CERBERUS_API CerberusResult CERBERUS_CALL cerberus_eval_simulate(int32_t mode);

/* -------------------------------------------------------------------------
 * PascalCase aliases
 *
 * The documentation quick start and the older integration guides use these
 * spellings. They are macros over the canonical names above - there is no
 * second implementation and no overhead.
 * ---------------------------------------------------------------------- */

#define Cerberus_Init              cerberus_init
#define Cerberus_InitAsync         cerberus_init_async
#define Cerberus_SetCallbacks      cerberus_set_callbacks
#define Cerberus_SetOption         cerberus_set_option
#define Cerberus_Shutdown          cerberus_shutdown
#define Cerberus_Version           cerberus_version
#define Cerberus_ErrorString       cerberus_error_string
#define Cerberus_IsEvaluationBuild cerberus_is_evaluation_build
#define Cerberus_SessionStart      cerberus_session_start
#define Cerberus_SessionHeartbeat  cerberus_session_heartbeat
#define Cerberus_SessionEnd        cerberus_session_end
#define Cerberus_SessionPump       cerberus_session_pump
#define Cerberus_StartSession      cerberus_start_session
#define Cerberus_StartSessionEx    cerberus_start_session_ex
#define Cerberus_EndSession        cerberus_end_session

#ifdef __cplusplus
} /* extern "C" */
#endif

/* -------------------------------------------------------------------------
 * C++ convenience wrappers
 * ---------------------------------------------------------------------- */

#ifdef __cplusplus

#include <cstring>
#include <string>

namespace cerberus {

using Result      = ::CerberusResult;
using Region      = ::CerberusRegion;
using LogLevel    = ::CerberusLogLevel;
using BanReason   = ::CerberusBanReason;
using EventType   = ::CerberusEventType;
using Option      = ::CerberusOption;
using Config      = ::CerberusConfig;
using BanInfo     = ::CerberusBanInfo;
using FlagInfo    = ::CerberusFlagInfo;
using Event       = ::CerberusEvent;
using Attestation = ::CerberusAttestation;
using Session     = ::CerberusSession;
using CallbacksV3 = ::CerberusCallbacksV3;

/* A zeroed config with the documented defaults left at 0 ("use default"). */
inline Config make_config(const char* apiKey, const char* gameId) {
    Config c;
    std::memset(&c, 0, sizeof c);
    c.apiKey = apiKey;
    c.gameId = gameId;
    return c;
}

inline Result init(const Config& config) { return ::cerberus_init(&config); }

inline Result init_async(const Config& config, ::CerberusEventFn onEvent, void* userData = nullptr) {
    return ::cerberus_init_async(&config, onEvent, userData);
}

inline Result set_callbacks(const CallbacksV3& callbacks) {
    return ::cerberus_set_callbacks(&callbacks);
}

inline Result set_option(Option option, int32_t value) {
    return ::cerberus_set_option(option, value);
}

inline Result shutdown() { return ::cerberus_shutdown(); }

inline std::string version() { return std::string(::cerberus_version()); }

inline std::string error_string(Result r) { return std::string(::cerberus_error_string(r)); }

inline bool is_evaluation_build() { return ::cerberus_is_evaluation_build(); }

inline Result session_start(const char* playerId, Session** out) {
    return ::cerberus_session_start(playerId, out);
}

inline Result session_heartbeat(Session* s) { return ::cerberus_session_heartbeat(s); }

inline Result session_end(Session* s) { return ::cerberus_session_end(s); }

inline int32_t session_pump(Session* s, int32_t maxEvents = 0) {
    return ::cerberus_session_pump(s, maxEvents);
}

inline Result start_session(const char* playerId) { return ::cerberus_start_session(playerId); }

inline Result start_session(const char* playerId, const char* sessionTag) {
    return ::cerberus_start_session_ex(playerId, sessionTag);
}

inline Result end_session() { return ::cerberus_end_session(); }

/* RAII wrapper: starts a session on construction, ends it on destruction. */
class ScopedSession {
public:
    explicit ScopedSession(const char* playerId)
        : session_(nullptr), result_(::cerberus_session_start(playerId, &session_)) {}

    ~ScopedSession() {
        if (session_ != nullptr) {
            ::cerberus_session_end(session_);
            session_ = nullptr;
        }
    }

    ScopedSession(const ScopedSession&) = delete;
    ScopedSession& operator=(const ScopedSession&) = delete;

    bool     ok() const     { return result_ == CERBERUS_OK && session_ != nullptr; }
    Result   result() const { return result_; }
    Session* get() const    { return session_; }

    int32_t pump(int32_t maxEvents = 0) {
        return session_ != nullptr ? ::cerberus_session_pump(session_, maxEvents) : 0;
    }

    Result heartbeat() {
        return session_ != nullptr ? ::cerberus_session_heartbeat(session_)
                                   : CERBERUS_ERR_INVALID_SESSION;
    }

private:
    Session* session_;
    Result   result_;
};

} /* namespace cerberus */

#endif /* __cplusplus */

#endif /* CERBERUS_SDK_H */
