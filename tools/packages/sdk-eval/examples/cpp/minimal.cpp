/*
 * minimal.cpp - the smallest useful Cerberus integration.
 *
 * Initialise, start a session for the local player, pump the runtime from your
 * frame loop, end the session, shut down. That is the whole integration.
 *
 * Build (from the SDK root):
 *   cmake -S . -B build && cmake --build build --config Release
 * Run:
 *   build/example_minimal        (or build\Release\example_minimal.exe)
 */

#include "cerberus_sdk.h"

#include <cstdio>
#include <cstring>

static void CERBERUS_CALL onBan(const CerberusBanInfo* info, void* /*userData*/) {
    std::printf("  [ban]  player=%s reason=%d confidence=%.2f appeal=%s\n",
                info->playerId, static_cast<int>(info->reason),
                static_cast<double>(info->confidence), info->appealReference);
}

int main(void) {
    std::printf("Cerberus SDK %s (evaluation build: %s)\n\n",
                cerberus_version(),
                cerberus_is_evaluation_build() ? "yes" : "no");

    CerberusConfig config;
    std::memset(&config, 0, sizeof config);
    config.apiKey      = "crb_eval_0000000000000000";
    config.gameId      = "example-title";
    config.region      = CERBERUS_REGION_AUTO;   /* one of three regions, picked by latency */
    config.enableAI    = true;                   /* Layer 2 */
    config.enableHW    = true;                   /* Layer 3 */
    config.enableNET   = true;                   /* Layer 4 */
    config.banCallback = &onBan;
    config.logLevel    = CERBERUS_LOG_INFO;

    CerberusResult r = cerberus_init(&config);
    if (r != CERBERUS_OK) {
        std::printf("init failed: %s (%d)\n", cerberus_error_string(r), static_cast<int>(r));
        return 1;
    }

    CerberusSession* session = NULL;
    r = cerberus_session_start("player-1001", &session);
    if (r != CERBERUS_OK) {
        std::printf("session_start failed: %s\n", cerberus_error_string(r));
        cerberus_shutdown();
        return 1;
    }
    std::printf("\nSession started for player-1001.\n");

    /* Stand-in for your frame loop. Pump every frame; it never blocks. */
    for (int frame = 0; frame < 5; ++frame) {
        int32_t delivered = cerberus_session_pump(session, 0);
        if (delivered < 0) {
            std::printf("pump failed: %s\n",
                        cerberus_error_string(static_cast<CerberusResult>(delivered)));
            break;
        }
    }
    cerberus_session_heartbeat(session);

    cerberus_session_end(session);
    std::printf("Session ended.\n\n");

    cerberus_shutdown();
    return 0;
}
