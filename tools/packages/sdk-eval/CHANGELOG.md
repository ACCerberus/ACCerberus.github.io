# Cerberus SDK changelog

The SDK version tracks the engine **minor** version. Engine builds ship to
players through the runtime updater; the SDK is not re-cut per build. An
integration built against 0.6.0 links against any 0.6.x runtime.

---

## 0.6.0 — 2026-09-06

Matches engine v0.6.x (kernel driver generation 2).

**Added**
- `cerberus_init_async` — initialisation no longer has to block your loading
  thread. Progress and the final `READY` event arrive through `onEvent` on your
  next `cerberus_session_pump`.
- `CerberusCallbacksV3` and `cerberus_set_callbacks` — a versioned callback
  block (`abiVersion = 3`) that can be installed before or after init and
  supersedes the callbacks in `CerberusConfig`. Existing config callbacks keep
  working; nothing needs to change.
- `CerberusEvent` / `CerberusEventType` — `READY`, `ATTEST_FAILED`,
  `DRIVER_UNAVAILABLE`, `SIGNATURE_SYNC`, `SHUTDOWN`.
- `CerberusAttestation`, and `CerberusConfig.attestationReport` to receive the
  boot-chain and hardware attestation summary produced at init.
- `CerberusBanInfo.appealReference` — the `CB-XXXXX-XXXXX-XXXXX` reference a
  player quotes at the appeal page. Surface it in your ban message.
- `cerberus_set_option` with `HW_SCAN`, `SCAN_INTERVAL`, `AI_SAMPLE_RATE`,
  `LOG_LEVEL` and `REQUIRE_IOMMU`.
- `CerberusConfig.requireIommu` — refuse to start sessions on platforms with no
  IOMMU rather than running Layer 3 degraded.
- `cerberus_start_session_ex` — attach a free-form session tag (playlist, map,
  build id) that appears next to any detection in the dashboard.
- `cerberus::ScopedSession`, an RAII session wrapper, for C++ callers.

**Changed**
- `CerberusResult` gained `CERBERUS_ERR_UNSUPPORTED_OS` (−13). Windows 10 21H2
  (build 19044) is now the floor.
- Default `scanInterval` is 2000 ms (was 1500 ms) — generation 2's EPT shadow
  scan does more per pass, so it runs less often for the same coverage.
- `cerberus_session_pump` returns the number of callbacks delivered instead of
  `void`, and takes `maxEvents` so you can bound per-frame work.

**Deprecated**
- The `head` spelling in payload fields is gone. Detection layers are
  `layer` / `layers_triggered` everywhere, matching Layers 1–4 in the docs.

**Removed**
- Nothing. 0.5.x source compiles against 0.6.0 unchanged.

---

## 0.5.1 — 2026-07-14

Matches engine v0.5.1.x.

**Added**
- `CerberusRegion` selection with `CERBERUS_REGION_AUTO`, picking one of the
  three operating regions by latency at init.
- `cerberus_is_evaluation_build`, so an evaluation build can be gated out of a
  shipping configuration at compile time and at runtime.

**Fixed**
- `cerberus_session_end` returned `CERBERUS_OK` for a session that had already
  ended; it now returns `CERBERUS_ERR_INVALID_SESSION`.
- The C# binding marshalled `confidence` as `double`; it is a 4-byte `float`.

---

## 0.4.2 — 2026-04-02

Matches engine v0.4.2.x. Superseded — archived, no longer published.

**Added**
- First public evaluation package: `cerberus_init`, `cerberus_shutdown`, the
  single-session convenience API and the C# binding.

**Known issues**
- No async init: `cerberus_init` blocked for the duration of driver load.
