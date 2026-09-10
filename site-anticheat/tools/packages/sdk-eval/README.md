# Cerberus Anti-Cheat SDK 0.6.0 — evaluation build

The complete public API of the Cerberus SDK, with a local implementation you can
compile, run and integrate against today. No account, no key, no driver.

Write your integration now; swap in the partner runtime when a key is issued.
Not a line of your code changes.

- Docs: <https://cerberusac.dev/docs/>
- SDK reference: <https://cerberusac.dev/sdk/>
- Downloads and checksums: <https://cerberusac.dev/downloads/>

---

## Why the version says 0.6.0

The SDK version tracks the engine **minor** version. Engine builds ship to
players through the runtime updater — the engine moves several builds a week —
and the SDK is not re-cut for each one. An integration built against 0.6.0 links
against any 0.6.x runtime. When the engine reaches 0.7, a new SDK follows.

`cerberus_version()` returns `"0.6.0-eval"` in this package and `"0.6.0"` in the
partner runtime.

---

## What is in this package

```
cerberus-sdk-eval-0.6.0/
├── CMakeLists.txt                    build for the library and both examples
├── README.md
├── CHANGELOG.md                      0.6.0 / 0.5.1 / 0.4.2
├── EVALUATION-LICENSE.txt
├── THIRD_PARTY_NOTICES.txt           (none — no dependencies)
├── package.json                      package id and version
├── include/
│   └── cerberus_sdk.h                the complete public API, C99 and C++17
├── src/
│   └── cerberus_eval_stub.cpp        the evaluation implementation
├── bindings/
│   └── csharp/Cerberus.cs            .NET 8 / Unity P/Invoke binding
└── examples/
    ├── cpp/minimal.cpp               smallest working integration
    ├── cpp/session_loop.cpp          async init, V3 callbacks, simulated ban
    ├── unreal/CerberusSubsystem.h    illustrative UE game-instance subsystem
    ├── unreal/CerberusSubsystem.cpp
    └── unity/CerberusManager.cs      illustrative Unity bootstrap component
```

## What is **not** in this package

Being blunt about this is more useful than a feature list:

- **No kernel driver.** Layer 1 does not load. There is nothing to sign, nothing
  installs, and no service is created.
- **No production `.lib` / `.dll` with detection in it.** The library you build
  here is the simulation, and nothing else.
- **No API connectivity.** No key is validated, no session reaches a region, no
  telemetry is sent. The package never opens a connection.
- **No hardware attestation.** `CerberusAttestation` is returned zeroed rather
  than filled with plausible-looking values.
- **No detection.** Detections are fabricated on a timer, and only when you ask
  for them.

`cerberus_is_evaluation_build()` returns `true` here and `false` in the partner
runtime. Gate anything that must not ship on it — and note that
`cerberus_eval_simulate()` returns `CERBERUS_ERR_EVALUATION_ONLY` in the partner
runtime, so a call left behind fails loudly instead of doing nothing.

The signed driver, the production libraries and an issued key arrive with the
**partner runtime**, delivered through the partner portal after key issuance.
They are never published on the website.

---

## Requirements

- Windows 10 21H2 (build 19044) or later, or Windows 11 — **x64 only**
- CMake 3.16+
- MSVC 2019 16.11+, or Clang 13+
- Optional, for the C# binding: .NET 8, or Unity 2021.3+

The header compiles as **C99** and as **C++17**. The evaluation implementation
is C++17.

Players running your title need rather more than a compiler — Secure Boot, a
TPM, memory integrity. Point them at the
[Readiness Check](https://cerberusac.dev/readiness/); it tells them in ten
seconds whether their PC qualifies, and what to change if not.

---

## Build and run

```
cmake -S . -B build
cmake --build build --config Release
```

Then:

```
build\Release\example_minimal.exe
```

```
set CERBERUS_EVAL_SIMULATE=ban
build\Release\example_session_loop.exe
```

(Single-config generators such as Ninja or MinGW Makefiles put the executables
directly in `build/`.)

`example_session_loop` with simulation on produces a flag at scan 3 and a ban at
scan 6, with a real `CB-XXXXX-XXXXX-XXXXX` appeal reference — the same shape a
player quotes at <https://cerberusac.dev/appeal/>.

### CMake options

| Option | Default | Effect |
|---|---|---|
| `CERBERUS_EVAL_SHARED` | `OFF` | Also build `cerberus_sdk` as a shared library (needed by the C# binding and Unity). |
| `CERBERUS_EVAL_EXAMPLES` | `ON` | Build `example_minimal` and `example_session_loop`. |

---

## Integrating

Five calls. That is the whole surface for a basic integration.

```c
#include "cerberus_sdk.h"
#include <string.h>

static void CERBERUS_CALL on_ban(const CerberusBanInfo* info, void* user) {
    /* Show info->appealReference in your ban message. */
    kick_player(info->playerId, info->appealReference);
}

CerberusConfig config;
memset(&config, 0, sizeof config);      /* every field: 0/NULL means "default" */
config.apiKey      = "crb_live_...";    /* issued with your partner agreement */
config.gameId      = "your-title";
config.region      = CERBERUS_REGION_AUTO;
config.enableAI    = true;              /* Layer 2 */
config.enableHW    = true;              /* Layer 3 */
config.enableNET   = true;              /* Layer 4 */
config.banCallback = on_ban;

cerberus_init(&config);                          /* once, at startup       */
cerberus_session_start(player_id, &session);     /* when the player joins  */
cerberus_session_pump(session, 0);               /* every frame            */
cerberus_session_end(session);                   /* when the player leaves */
cerberus_shutdown();                             /* once, at exit          */
```

Four rules worth knowing before you start:

1. **Pump from one thread.** Callbacks are delivered only from
   `cerberus_session_pump`, on the thread that calls it. Nothing is raised
   behind your back, so no locking is required in your handlers.
2. **Never block in a callback, and never call back into the SDK from one.**
3. **A flag is not a ban.** `CerberusFlagInfo` is a suspicion below the ban
   threshold, queued for human review. Log it; do not act on it client-side.
4. **Surface the appeal reference.** A player who cannot quote
   `CB-XXXXX-XXXXX-XXXXX` cannot be helped by support, and every false positive
   then becomes a support ticket you answer instead of us.

For async startup, versioned callbacks and bounded per-frame work, see
`examples/cpp/session_loop.cpp`.

C++ callers can use the thin wrappers in `namespace cerberus`, including
`cerberus::ScopedSession` (RAII).

---

## Support

- Integration questions: <https://cerberusac.dev/docs/>
- Request a key: <https://cerberusac.dev/access/>
- Ban appeals (players): <https://cerberusac.dev/appeal/>

Licence: `EVALUATION-LICENSE.txt`. This package may not be used to protect a
shipped title.
