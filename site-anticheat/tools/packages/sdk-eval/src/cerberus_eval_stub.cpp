/*
 * cerberus_eval_stub.cpp - evaluation implementation of the Cerberus SDK.
 *
 * This is a local simulation. It loads no driver, opens no connection and
 * inspects nothing about the machine it runs on. Every entry point in
 * cerberus_sdk.h is implemented with the same argument validation, the same
 * result codes and the same event ordering as the partner runtime, so an
 * integration written against this build compiles and behaves identically when
 * the real runtime is dropped in.
 *
 * Detections are fabricated on a timer. Nothing here detects anything.
 *
 * Threading: single-threaded by design. Callbacks are delivered only from
 * cerberus_session_pump, on the thread that calls it.
 */

#include "cerberus_sdk.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <ctime>
#include <chrono>
#include <deque>
#include <string>

/* -------------------------------------------------------------------------
 * Session handle
 * ---------------------------------------------------------------------- */

struct CerberusSession {
    uint32_t    magic;
    std::string playerId;
    std::string tag;
    bool        active;
    bool        implicit;
};

namespace {

const uint32_t kSessionMagic = 0x43425253u; /* 'CBRS' */

const char* const kBanner =
    "[cerberus-eval] Cerberus SDK " CERBERUS_SDK_VERSION_STRING
    "-eval - evaluation build: kernel layer not loaded, no driver, no network."
    " Detections are simulated.";

enum QueuedKind { QK_EVENT = 0, QK_FLAG = 1, QK_BAN = 2 };

struct Queued {
    QueuedKind       kind;
    CerberusEvent    ev;
    CerberusFlagInfo flag;
    CerberusBanInfo  ban;
    std::string      playerId;   /* backing storage for the const char* fields */
    std::string      details;
};

struct EvalState {
    bool                 initialized;
    bool                 bannerLogged;
    CerberusLogLevel     logLevel;

    std::string          apiKey;
    std::string          gameId;
    CerberusRegion       region;
    bool                 enableAI;
    bool                 enableHW;
    bool                 enableNET;
    bool                 requireIommu;
    bool                 zeroFootprint;

    uint32_t             scanInterval;
    uint32_t             aiSampleRate;

    CerberusBanFn        cfgBan;
    CerberusFlagFn       cfgFlag;
    void*                cfgUserData;

    bool                 haveV3;
    CerberusCallbacksV3  v3;

    CerberusEventFn      asyncEvent;
    void*                asyncUserData;

    std::deque<Queued>   queue;

    int                  simulate;      /* 0 off, 1 flag, 2 flag + ban */
    int                  scanCount;
    bool                 flagEmitted;
    bool                 banEmitted;
    std::chrono::steady_clock::time_point lastScan;

    CerberusSession*     implicitSession;

    EvalState()
        : initialized(false), bannerLogged(false), logLevel(CERBERUS_LOG_INFO),
          region(CERBERUS_REGION_AUTO), enableAI(false), enableHW(false),
          enableNET(false), requireIommu(false), zeroFootprint(false),
          scanInterval(2000), aiSampleRate(1000),
          cfgBan(NULL), cfgFlag(NULL), cfgUserData(NULL),
          haveV3(false), asyncEvent(NULL), asyncUserData(NULL),
          simulate(0), scanCount(0), flagEmitted(false), banEmitted(false),
          implicitSession(NULL) {
        std::memset(&v3, 0, sizeof v3);
    }
};

EvalState& state() {
    static EvalState s;
    return s;
}

/* --- logging ---------------------------------------------------------- */

void logAt(CerberusLogLevel level, const char* text) {
    if (state().logLevel == CERBERUS_LOG_OFF || level > state().logLevel) {
        return;
    }
    std::fprintf(stdout, "%s\n", text);
    std::fflush(stdout);
}

void logBannerOnce() {
    if (state().bannerLogged) {
        return;
    }
    state().bannerLogged = true;
    /* The banner ignores logLevel: an evaluation build must always say so. */
    std::fprintf(stdout, "%s\n", kBanner);
    std::fflush(stdout);
}

int64_t nowUnix() {
    return static_cast<int64_t>(std::time(NULL));
}

/* --- deterministic filler --------------------------------------------- */

uint32_t hashString(const char* s, uint32_t seed) {
    uint32_t h = seed ? seed : 2166136261u;
    if (s == NULL) {
        return h;
    }
    for (const unsigned char* p = reinterpret_cast<const unsigned char*>(s); *p; ++p) {
        h ^= static_cast<uint32_t>(*p);
        h *= 16777619u;
    }
    return h;
}

uint32_t nextRandom(uint32_t& s) {
    /* xorshift32 - deterministic, so the same run produces the same ids. */
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return s;
}

/* "CB-XXXXX-XXXXX-XXXXX" - the reference a player quotes at /appeal/. */
void makeAppealReference(char out[21], uint32_t seed) {
    static const char kAlphabet[] = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    uint32_t s = seed ? seed : 1u;
    out[0] = 'C';
    out[1] = 'B';
    out[2] = '-';
    int w = 3;
    for (int group = 0; group < 3; ++group) {
        if (group > 0) {
            out[w++] = '-';
        }
        for (int i = 0; i < 5; ++i) {
            out[w++] = kAlphabet[nextRandom(s) % 32u];
        }
    }
    out[20] = '\0';
}

void makeDetectionId(char out[32], const char* prefix, uint32_t seed) {
    static const char kHex[] = "0123456789abcdef";
    uint32_t s = seed ? seed : 1u;
    std::size_t w = 0;
    std::size_t plen = std::strlen(prefix);
    for (std::size_t i = 0; i < plen && w < 31; ++i) {
        out[w++] = prefix[i];
    }
    while (w < 31) {
        out[w++] = kHex[nextRandom(s) % 16u];
    }
    out[31] = '\0';
}

/* --- queueing --------------------------------------------------------- */

void queueEvent(CerberusEventType type, CerberusResult result, uint32_t layer, const char* message) {
    Queued q;
    std::memset(&q.ev, 0, sizeof q.ev);
    std::memset(&q.flag, 0, sizeof q.flag);
    std::memset(&q.ban, 0, sizeof q.ban);
    q.kind         = QK_EVENT;
    q.ev.type      = type;
    q.ev.result    = result;
    q.ev.layer     = layer;
    q.ev.timestamp = nowUnix();
    std::snprintf(q.ev.message, sizeof q.ev.message, "%s", message ? message : "");
    state().queue.push_back(q);
}

void queueFlag(const std::string& playerId, int scan) {
    uint32_t seed = hashString(playerId.c_str(), 0x9E3779B9u) ^ static_cast<uint32_t>(scan * 2654435761u);

    Queued q;
    std::memset(&q.ev, 0, sizeof q.ev);
    std::memset(&q.flag, 0, sizeof q.flag);
    std::memset(&q.ban, 0, sizeof q.ban);
    q.kind     = QK_FLAG;
    q.playerId = playerId;
    q.details  = "Simulated: micro-movement entropy below the human floor across 3 engagements.";

    makeDetectionId(q.flag.id, "flg_", seed);
    q.flag.layer      = CERBERUS_LAYER_BEHAVIORAL;
    q.flag.reason     = CERBERUS_BAN_AIMBOT;
    q.flag.confidence = 0.71f;
    q.flag.timestamp  = nowUnix();
    state().queue.push_back(q);
}

void queueBan(const std::string& playerId, int scan) {
    uint32_t seed = hashString(playerId.c_str(), 0x85EBCA6Bu) ^ static_cast<uint32_t>(scan * 40503u);

    Queued q;
    std::memset(&q.ev, 0, sizeof q.ev);
    std::memset(&q.flag, 0, sizeof q.flag);
    std::memset(&q.ban, 0, sizeof q.ban);
    q.kind     = QK_BAN;
    q.playerId = playerId;
    q.details  = "Simulated: aim trajectory matched a known humanisation profile in 6 of 6 windows.";

    makeDetectionId(q.ban.id, "det_", seed);
    makeAppealReference(q.ban.appealReference, seed ^ 0xC2B2AE35u);
    q.ban.layer      = CERBERUS_LAYER_BEHAVIORAL;
    q.ban.reason     = CERBERUS_BAN_AIMBOT;
    q.ban.confidence = 0.94f;
    q.ban.timestamp  = nowUnix();
    /* No driver and no TPM access in the evaluation build, so the attestation
     * block is zeroed rather than fabricated. */
    std::memset(&q.ban.attestation, 0, sizeof q.ban.attestation);
    state().queue.push_back(q);
}

/* --- delivery --------------------------------------------------------- */

void deliver(Queued& q) {
    EvalState& st = state();

    CerberusBanFn   banFn   = st.haveV3 ? st.v3.onBan  : st.cfgBan;
    CerberusFlagFn  flagFn  = st.haveV3 ? st.v3.onFlag : st.cfgFlag;
    CerberusEventFn eventFn = st.haveV3 ? st.v3.onEvent : st.asyncEvent;
    void*           user    = st.haveV3 ? st.v3.userData
                                        : (q.kind == QK_EVENT ? st.asyncUserData : st.cfgUserData);

    if (st.haveV3 && eventFn == NULL) {
        eventFn = st.asyncEvent;
    }

    switch (q.kind) {
        case QK_EVENT:
            if (eventFn != NULL) {
                eventFn(&q.ev, user);
            }
            break;
        case QK_FLAG:
            q.flag.playerId = q.playerId.c_str();
            q.flag.details  = q.details.c_str();
            if (flagFn != NULL) {
                flagFn(&q.flag, user);
            }
            break;
        case QK_BAN:
            q.ban.playerId = q.playerId.c_str();
            q.ban.details  = q.details.c_str();
            if (banFn != NULL) {
                banFn(&q.ban, user);
            }
            break;
        default:
            break;
    }
}

/* --- simulated scan timeline ------------------------------------------ */

void advanceScans(CerberusSession* session) {
    EvalState& st = state();
    if (st.scanInterval == 0) {
        st.scanInterval = 2000;
    }

    std::chrono::steady_clock::time_point now = std::chrono::steady_clock::now();
    std::chrono::milliseconds interval(static_cast<long long>(st.scanInterval));

    while (now - st.lastScan >= interval) {
        st.lastScan += interval;
        st.scanCount += 1;

        const std::string player = (session != NULL) ? session->playerId : std::string("");

        if (st.simulate >= 1 && st.scanCount == 3 && !st.flagEmitted && !player.empty()) {
            st.flagEmitted = true;
            queueFlag(player, st.scanCount);
        }
        if (st.simulate >= 2 && st.scanCount == 6 && !st.banEmitted && !player.empty()) {
            st.banEmitted = true;
            queueBan(player, st.scanCount);
        }
        if (st.scanCount % 10 == 0) {
            queueEvent(CERBERUS_EVENT_SIGNATURE_SYNC, CERBERUS_OK, CERBERUS_LAYER_NONE,
                       "Simulated signature set refresh (evaluation build: no network).");
        }
    }
}

int readSimulateEnv() {
#if defined(_MSC_VER)
    /* getenv is flagged by MSVC's secure-CRT warnings; _dupenv_s is the
     * sanctioned replacement. */
    char*  buf = NULL;
    size_t len = 0;
    if (_dupenv_s(&buf, &len, "CERBERUS_EVAL_SIMULATE") != 0 || buf == NULL) {
        return 0;
    }
    std::string value(buf);
    std::free(buf);
    if (value == "ban" || value == "2") {
        return 2;
    }
    if (value == "flag" || value == "1") {
        return 1;
    }
    return 0;
#else
    const char* v = std::getenv("CERBERUS_EVAL_SIMULATE");
    if (v == NULL) {
        return 0;
    }
    if (std::strcmp(v, "ban") == 0 || std::strcmp(v, "2") == 0) {
        return 2;
    }
    if (std::strcmp(v, "flag") == 0 || std::strcmp(v, "1") == 0) {
        return 1;
    }
    return 0;
#endif
}

CerberusResult validateAndApply(const CerberusConfig* config) {
    if (config == NULL) {
        return CERBERUS_ERR_INVALID_CONFIG;
    }
    if (config->apiKey == NULL || std::strncmp(config->apiKey, "crb_", 4) != 0) {
        return CERBERUS_ERR_INVALID_KEY;
    }
    if (config->gameId == NULL || config->gameId[0] == '\0') {
        return CERBERUS_ERR_INVALID_CONFIG;
    }
    if (config->scanInterval != 0 && config->scanInterval < 500) {
        return CERBERUS_ERR_INVALID_CONFIG;
    }
    if (config->aiSampleRate != 0 && (config->aiSampleRate < 250 || config->aiSampleRate > 2000)) {
        return CERBERUS_ERR_INVALID_CONFIG;
    }
    for (int i = 0; i < 4; ++i) {
        if (config->reserved[i] != 0) {
            return CERBERUS_ERR_INVALID_CONFIG;
        }
    }
    if (config->region < CERBERUS_REGION_AUTO || config->region > CERBERUS_REGION_AP_SOUTHEAST) {
        return CERBERUS_ERR_INVALID_CONFIG;
    }

    EvalState& st = state();
    st.apiKey        = config->apiKey;
    st.gameId        = config->gameId;
    st.region        = config->region;
    st.enableAI      = config->enableAI;
    st.enableHW      = config->enableHW;
    st.enableNET     = config->enableNET;
    st.requireIommu  = config->requireIommu;
    st.zeroFootprint = config->zeroFootprint;
    st.scanInterval  = config->scanInterval != 0 ? config->scanInterval : 2000u;
    st.aiSampleRate  = config->aiSampleRate != 0 ? config->aiSampleRate : 1000u;
    st.cfgBan        = config->banCallback;
    st.cfgFlag       = config->flagCallback;
    st.cfgUserData   = config->userData;
    st.logLevel      = config->logLevel;
    st.scanCount     = 0;
    st.flagEmitted   = false;
    st.banEmitted    = false;
    st.lastScan      = std::chrono::steady_clock::now();

    if (st.simulate == 0) {
        st.simulate = readSimulateEnv();
    }

    /* The evaluation build cannot attest, so any attestation out-param is
     * zeroed rather than filled with plausible-looking values. */
    if (config->attestationReport != NULL) {
        std::memset(config->attestationReport, 0, sizeof(CerberusAttestation));
    }
    return CERBERUS_OK;
}

CerberusSession* resolveSession(CerberusSession* session) {
    if (session != NULL) {
        return session;
    }
    return state().implicitSession;
}

} /* anonymous namespace */

/* =========================================================================
 * Public API
 * ====================================================================== */

extern "C" {

CERBERUS_API CerberusResult CERBERUS_CALL cerberus_init(const CerberusConfig* config) {
    EvalState& st = state();
    if (st.initialized) {
        return CERBERUS_ERR_ALREADY_INIT;
    }

    CerberusResult r = validateAndApply(config);
    if (r != CERBERUS_OK) {
        return r;
    }

    logBannerOnce();
    st.initialized = true;
    st.asyncEvent  = NULL;

    logAt(CERBERUS_LOG_INFO,
          "[cerberus-eval] Layer 1 (kernel integrity): unavailable - no driver in the evaluation build.");
    logAt(CERBERUS_LOG_INFO,
          "[cerberus-eval] Layer 2 (behavioural AI): simulated.");
    logAt(CERBERUS_LOG_INFO,
          "[cerberus-eval] Layer 3 (hardware fingerprinting): unavailable - no attestation.");
    logAt(CERBERUS_LOG_INFO,
          "[cerberus-eval] Layer 4 (network sentinel): unavailable - no network in the evaluation build.");
    logAt(CERBERUS_LOG_INFO, "[cerberus-eval] Ready.");
    return CERBERUS_OK;
}

CERBERUS_API CerberusResult CERBERUS_CALL cerberus_init_async(const CerberusConfig* config,
                                                              CerberusEventFn onEvent,
                                                              void* userData) {
    EvalState& st = state();
    if (st.initialized) {
        return CERBERUS_ERR_ALREADY_INIT;
    }

    CerberusResult r = validateAndApply(config);
    if (r != CERBERUS_OK) {
        return r;
    }

    logBannerOnce();
    st.initialized    = true;
    st.asyncEvent     = onEvent;
    st.asyncUserData  = userData;

    /* Same ordering as the partner runtime: the kernel layer reports first,
     * then the runtime reports overall readiness. */
    queueEvent(CERBERUS_EVENT_DRIVER_UNAVAILABLE, CERBERUS_ERR_EVALUATION_ONLY,
               CERBERUS_LAYER_KERNEL,
               "Kernel layer not loaded: this is the evaluation build.");
    queueEvent(CERBERUS_EVENT_READY, CERBERUS_OK, CERBERUS_LAYER_BEHAVIORAL,
               "Runtime ready (Layer 2 simulated; Layers 1, 3 and 4 unavailable).");
    return CERBERUS_OK;
}

CERBERUS_API CerberusResult CERBERUS_CALL cerberus_set_callbacks(const CerberusCallbacksV3* callbacks) {
    EvalState& st = state();
    if (callbacks == NULL) {
        st.haveV3 = false;
        std::memset(&st.v3, 0, sizeof st.v3);
        return CERBERUS_OK;
    }
    if (callbacks->abiVersion != CERBERUS_CALLBACK_ABI) {
        return CERBERUS_ERR_INVALID_CONFIG;
    }
    st.v3     = *callbacks;
    st.haveV3 = true;
    return CERBERUS_OK;
}

CERBERUS_API CerberusResult CERBERUS_CALL cerberus_set_option(CerberusOption option, int32_t value) {
    EvalState& st = state();
    if (!st.initialized) {
        return CERBERUS_ERR_NOT_INITIALIZED;
    }
    switch (option) {
        case CERBERUS_OPT_HW_SCAN:
            if (value != 0 && value != 1) { return CERBERUS_ERR_INVALID_CONFIG; }
            st.enableHW = (value != 0);
            return CERBERUS_OK;
        case CERBERUS_OPT_SCAN_INTERVAL:
            if (value < 500) { return CERBERUS_ERR_INVALID_CONFIG; }
            st.scanInterval = static_cast<uint32_t>(value);
            return CERBERUS_OK;
        case CERBERUS_OPT_AI_SAMPLE_RATE:
            if (value < 250 || value > 2000) { return CERBERUS_ERR_INVALID_CONFIG; }
            st.aiSampleRate = static_cast<uint32_t>(value);
            return CERBERUS_OK;
        case CERBERUS_OPT_LOG_LEVEL:
            if (value < CERBERUS_LOG_OFF || value > CERBERUS_LOG_TRACE) {
                return CERBERUS_ERR_INVALID_CONFIG;
            }
            st.logLevel = static_cast<CerberusLogLevel>(value);
            return CERBERUS_OK;
        case CERBERUS_OPT_REQUIRE_IOMMU:
            if (value != 0 && value != 1) { return CERBERUS_ERR_INVALID_CONFIG; }
            st.requireIommu = (value != 0);
            return CERBERUS_OK;
        default:
            return CERBERUS_ERR_INVALID_CONFIG;
    }
}

CERBERUS_API CerberusResult CERBERUS_CALL cerberus_shutdown(void) {
    EvalState& st = state();
    if (!st.initialized) {
        return CERBERUS_ERR_NOT_INITIALIZED;
    }

    if (st.implicitSession != NULL) {
        st.implicitSession->active = false;
        delete st.implicitSession;
        st.implicitSession = NULL;
    }

    queueEvent(CERBERUS_EVENT_SHUTDOWN, CERBERUS_OK, CERBERUS_LAYER_NONE,
               "Runtime shutting down.");

    /* Flush anything still queued so no detection is silently dropped. */
    while (!st.queue.empty()) {
        Queued q = st.queue.front();
        st.queue.pop_front();
        deliver(q);
    }

    st.initialized   = false;
    st.asyncEvent    = NULL;
    st.asyncUserData = NULL;
    st.haveV3        = false;
    std::memset(&st.v3, 0, sizeof st.v3);
    st.cfgBan        = NULL;
    st.cfgFlag       = NULL;
    st.cfgUserData   = NULL;
    st.scanCount     = 0;
    st.flagEmitted   = false;
    st.banEmitted    = false;

    logAt(CERBERUS_LOG_INFO, "[cerberus-eval] Shutdown complete.");
    return CERBERUS_OK;
}

CERBERUS_API const char* CERBERUS_CALL cerberus_version(void) {
    return CERBERUS_SDK_VERSION_STRING "-eval";
}

CERBERUS_API const char* CERBERUS_CALL cerberus_error_string(CerberusResult result) {
    switch (result) {
        case CERBERUS_OK:                     return "OK";
        case CERBERUS_ERR_INVALID_KEY:        return "Invalid or missing API key (keys begin \"crb_\")";
        case CERBERUS_ERR_INVALID_CONFIG:     return "Invalid configuration";
        case CERBERUS_ERR_ALREADY_INIT:       return "Runtime is already initialised";
        case CERBERUS_ERR_NOT_INITIALIZED:    return "Runtime is not initialised";
        case CERBERUS_ERR_DRIVER_UNAVAILABLE: return "Kernel layer driver unavailable";
        case CERBERUS_ERR_ATTESTATION_FAILED: return "Attestation failed";
        case CERBERUS_ERR_NETWORK:            return "Sentinel endpoint unreachable";
        case CERBERUS_ERR_SESSION_LIMIT:      return "Concurrent session limit reached for this key";
        case CERBERUS_ERR_INVALID_SESSION:    return "Unknown or already-ended session";
        case CERBERUS_ERR_PERMISSION_DENIED:  return "Permission denied";
        case CERBERUS_ERR_TIMEOUT:            return "Operation timed out";
        case CERBERUS_ERR_BUFFER_TOO_SMALL:   return "Caller buffer too small";
        case CERBERUS_ERR_UNSUPPORTED_OS:     return "Unsupported OS (Windows 10 21H2+ or 11, x64)";
        case CERBERUS_ERR_EVALUATION_ONLY:    return "Not available in the evaluation build";
        case CERBERUS_ERR_INTERNAL:           return "Internal error";
        default:                              return "Unknown result code";
    }
}

CERBERUS_API bool CERBERUS_CALL cerberus_is_evaluation_build(void) {
    return true;
}

CERBERUS_API CerberusResult CERBERUS_CALL cerberus_session_start(const char* playerId,
                                                                 CerberusSession** outSession) {
    EvalState& st = state();
    if (!st.initialized) {
        return CERBERUS_ERR_NOT_INITIALIZED;
    }
    if (playerId == NULL || playerId[0] == '\0' || outSession == NULL) {
        return CERBERUS_ERR_INVALID_CONFIG;
    }

    CerberusSession* s = new CerberusSession();
    s->magic    = kSessionMagic;
    s->playerId = playerId;
    s->active   = true;
    s->implicit = false;

    st.scanCount   = 0;
    st.flagEmitted = false;
    st.banEmitted  = false;
    st.lastScan    = std::chrono::steady_clock::now();

    *outSession = s;
    return CERBERUS_OK;
}

CERBERUS_API CerberusResult CERBERUS_CALL cerberus_session_heartbeat(CerberusSession* session) {
    if (!state().initialized) {
        return CERBERUS_ERR_NOT_INITIALIZED;
    }
    CerberusSession* s = resolveSession(session);
    if (s == NULL || s->magic != kSessionMagic || !s->active) {
        return CERBERUS_ERR_INVALID_SESSION;
    }
    return CERBERUS_OK;
}

CERBERUS_API CerberusResult CERBERUS_CALL cerberus_session_end(CerberusSession* session) {
    EvalState& st = state();
    if (!st.initialized) {
        return CERBERUS_ERR_NOT_INITIALIZED;
    }
    if (session == NULL || session->magic != kSessionMagic || !session->active) {
        return CERBERUS_ERR_INVALID_SESSION;
    }

    session->active = false;
    if (session == st.implicitSession) {
        st.implicitSession = NULL;
    }
    session->magic = 0;
    delete session;
    return CERBERUS_OK;
}

CERBERUS_API int32_t CERBERUS_CALL cerberus_session_pump(CerberusSession* session, int32_t maxEvents) {
    EvalState& st = state();
    if (!st.initialized) {
        return static_cast<int32_t>(CERBERUS_ERR_NOT_INITIALIZED);
    }
    if (maxEvents < 0) {
        return static_cast<int32_t>(CERBERUS_ERR_INVALID_CONFIG);
    }

    CerberusSession* s = resolveSession(session);
    if (s != NULL && s->magic != kSessionMagic) {
        return static_cast<int32_t>(CERBERUS_ERR_INVALID_SESSION);
    }

    advanceScans(s);

    int32_t delivered = 0;
    while (!st.queue.empty() && (maxEvents == 0 || delivered < maxEvents)) {
        Queued q = st.queue.front();
        st.queue.pop_front();
        deliver(q);
        delivered += 1;
    }
    return delivered;
}

CERBERUS_API CerberusResult CERBERUS_CALL cerberus_start_session(const char* playerId) {
    return cerberus_start_session_ex(playerId, NULL);
}

CERBERUS_API CerberusResult CERBERUS_CALL cerberus_start_session_ex(const char* playerId,
                                                                    const char* sessionTag) {
    EvalState& st = state();
    if (!st.initialized) {
        return CERBERUS_ERR_NOT_INITIALIZED;
    }
    if (st.implicitSession != NULL) {
        return CERBERUS_ERR_SESSION_LIMIT;
    }

    CerberusSession* s = NULL;
    CerberusResult r = cerberus_session_start(playerId, &s);
    if (r != CERBERUS_OK) {
        return r;
    }

    s->implicit = true;
    if (sessionTag != NULL) {
        s->tag = sessionTag;
    }
    st.implicitSession = s;
    return CERBERUS_OK;
}

CERBERUS_API CerberusResult CERBERUS_CALL cerberus_end_session(void) {
    EvalState& st = state();
    if (!st.initialized) {
        return CERBERUS_ERR_NOT_INITIALIZED;
    }
    if (st.implicitSession == NULL) {
        return CERBERUS_ERR_INVALID_SESSION;
    }
    return cerberus_session_end(st.implicitSession);
}

CERBERUS_API CerberusResult CERBERUS_CALL cerberus_eval_simulate(int32_t mode) {
    if (mode < 0 || mode > 2) {
        return CERBERUS_ERR_INVALID_CONFIG;
    }
    EvalState& st = state();
    st.simulate    = static_cast<int>(mode);
    st.flagEmitted = false;
    st.banEmitted  = false;
    return CERBERUS_OK;
}

} /* extern "C" */
