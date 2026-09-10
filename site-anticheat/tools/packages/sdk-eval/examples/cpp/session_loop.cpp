/*
 * session_loop.cpp - async init, versioned callbacks, and the simulated
 * detection timeline.
 *
 * Shows the shape of a real integration:
 *   - cerberus_init_async so startup never blocks the main thread
 *   - a CerberusCallbacksV3 block instead of the config callbacks
 *   - one pump per tick, with lifecycle events arriving on the same thread
 *   - a heartbeat every few seconds
 *
 * The evaluation build fabricates a flag at scan 3 and a ban at scan 6 when
 * simulation is on. Turn it on either way:
 *
 *   set CERBERUS_EVAL_SIMULATE=ban        (cmd)
 *   $env:CERBERUS_EVAL_SIMULATE='ban'     (PowerShell)
 *   CERBERUS_EVAL_SIMULATE=ban ./example_session_loop   (bash)
 *
 * or call cerberus_eval_simulate(2) before init. Values: flag (1), ban (2).
 */

#include "cerberus_sdk.h"

#include <chrono>
#include <cstdio>
#include <cstring>
#include <thread>

namespace {

struct AppContext {
    bool ready;
    bool banned;
    int  flags;
};

const char* eventName(CerberusEventType type) {
    switch (type) {
        case CERBERUS_EVENT_READY:              return "READY";
        case CERBERUS_EVENT_ATTEST_FAILED:      return "ATTEST_FAILED";
        case CERBERUS_EVENT_DRIVER_UNAVAILABLE: return "DRIVER_UNAVAILABLE";
        case CERBERUS_EVENT_SIGNATURE_SYNC:     return "SIGNATURE_SYNC";
        case CERBERUS_EVENT_SHUTDOWN:           return "SHUTDOWN";
        default:                                return "UNKNOWN";
    }
}

const char* reasonName(CerberusBanReason reason) {
    switch (reason) {
        case CERBERUS_BAN_AIMBOT:          return "Aimbot";
        case CERBERUS_BAN_WALLHACK_ESP:    return "Wallhack / ESP";
        case CERBERUS_BAN_DMA_EXTERNAL:    return "DMA external";
        case CERBERUS_BAN_KERNEL_DRIVER:   return "Kernel driver";
        case CERBERUS_BAN_SPEED_HACK:      return "Speed";
        case CERBERUS_BAN_HWID_SPOOF:      return "HWID spoof";
        case CERBERUS_BAN_INPUT_INJECTION: return "Input injection";
        case CERBERUS_BAN_MEMORY_TAMPER:   return "Memory tamper";
        case CERBERUS_BAN_SIGNATURE_MATCH: return "Signature match";
        case CERBERUS_BAN_MANUAL_REVIEW:   return "Manual review";
        default:                           return "Unknown";
    }
}

const char* layerName(uint32_t layer) {
    if (layer & CERBERUS_LAYER_KERNEL)     { return "Layer 1 (kernel integrity)"; }
    if (layer & CERBERUS_LAYER_BEHAVIORAL) { return "Layer 2 (behavioural AI)"; }
    if (layer & CERBERUS_LAYER_HARDWARE)   { return "Layer 3 (hardware fingerprinting)"; }
    if (layer & CERBERUS_LAYER_NETWORK)    { return "Layer 4 (network sentinel)"; }
    return "runtime";
}

void CERBERUS_CALL onEvent(const CerberusEvent* ev, void* userData) {
    AppContext* app = static_cast<AppContext*>(userData);
    std::printf("  [event] %-18s %-34s %s\n", eventName(ev->type), layerName(ev->layer), ev->message);
    if (ev->type == CERBERUS_EVENT_READY && app != NULL) {
        app->ready = true;
    }
}

void CERBERUS_CALL onFlag(const CerberusFlagInfo* info, void* userData) {
    AppContext* app = static_cast<AppContext*>(userData);
    if (app != NULL) {
        app->flags += 1;
    }
    std::printf("  [flag]  %s  %s  confidence %.2f\n",
                info->playerId, reasonName(info->reason),
                static_cast<double>(info->confidence));
    std::printf("          %s\n", info->details);
    std::printf("          queued for review - flags are never auto-enforced.\n");
}

void CERBERUS_CALL onBan(const CerberusBanInfo* info, void* userData) {
    AppContext* app = static_cast<AppContext*>(userData);
    if (app != NULL) {
        app->banned = true;
    }
    std::printf("  [ban]   %s  %s  confidence %.2f\n",
                info->playerId, reasonName(info->reason),
                static_cast<double>(info->confidence));
    std::printf("          detection id     %s\n", info->id);
    std::printf("          appeal reference %s\n", info->appealReference);
    std::printf("          %s (%s)\n", info->details, layerName(info->layer));
}

} /* namespace */

int main(void) {
    std::printf("Cerberus SDK %s\n\n", cerberus_version());

    AppContext app;
    app.ready  = false;
    app.banned = false;
    app.flags  = 0;

    CerberusConfig config;
    std::memset(&config, 0, sizeof config);
    config.apiKey       = "crb_eval_0000000000000000";
    config.gameId       = "example-title";
    config.region       = CERBERUS_REGION_EU_WEST;
    config.enableAI     = true;
    config.enableHW     = true;
    config.enableNET    = true;
    config.scanInterval = 500;   /* ms, the documented minimum - keeps the demo short */
    config.aiSampleRate = 250;   /* ms */
    config.logLevel     = CERBERUS_LOG_INFO;

    CerberusResult r = cerberus_init_async(&config, &onEvent, &app);
    if (r != CERBERUS_OK) {
        std::printf("init_async failed: %s (%d)\n", cerberus_error_string(r), static_cast<int>(r));
        return 1;
    }

    CerberusCallbacksV3 callbacks;
    std::memset(&callbacks, 0, sizeof callbacks);
    callbacks.abiVersion = CERBERUS_CALLBACK_ABI;
    callbacks.onBan      = &onBan;
    callbacks.onFlag     = &onFlag;
    callbacks.onEvent    = &onEvent;
    callbacks.userData   = &app;

    r = cerberus_set_callbacks(&callbacks);
    if (r != CERBERUS_OK) {
        std::printf("set_callbacks failed: %s\n", cerberus_error_string(r));
        cerberus_shutdown();
        return 1;
    }

    CerberusSession* session = NULL;
    r = cerberus_session_start("player-4417", &session);
    if (r != CERBERUS_OK) {
        std::printf("session_start failed: %s\n", cerberus_error_string(r));
        cerberus_shutdown();
        return 1;
    }
    std::printf("Session started for player-4417. Pumping...\n\n");

    /* Stand-in for a 60 Hz tick loop, sped up. Gives the simulated timeline
     * time to reach scan 6 (6 x 500 ms) without waiting forever if simulation
     * is off. */
    const int   kMaxTicks       = 400;
    const int   kHeartbeatEvery = 60;
    int         ticks           = 0;
    int         ticksAfterBan   = 0;

    while (ticks < kMaxTicks) {
        int32_t delivered = cerberus_session_pump(session, 0);
        if (delivered < 0) {
            std::printf("pump failed: %s\n",
                        cerberus_error_string(static_cast<CerberusResult>(delivered)));
            break;
        }
        if (ticks > 0 && (ticks % kHeartbeatEvery) == 0) {
            cerberus_session_heartbeat(session);
        }
        if (app.banned) {
            ticksAfterBan += 1;
            if (ticksAfterBan > 5) {
                break;
            }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(16));
        ticks += 1;
    }

    std::printf("\nLoop finished after %d ticks: %d flag(s), %s.\n",
                ticks, app.flags, app.banned ? "1 ban" : "no ban");
    if (!app.banned && app.flags == 0) {
        std::printf("Nothing was simulated. Set CERBERUS_EVAL_SIMULATE=ban and run again.\n");
    }

    cerberus_session_end(session);
    cerberus_shutdown();
    return 0;
}
