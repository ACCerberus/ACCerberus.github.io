// CerberusManager.cs - illustrative Unity integration.
//
// ILLUSTRATIVE ONLY. This is not a Unity package; it shows where each SDK call
// belongs in a Unity project. The partner package ships a real UPM package with
// the native plugin, platform settings and an editor inspector.
//
// To try it:
//   1. Build the shared library from the SDK root:
//        cmake -S . -B build -DCERBERUS_EVAL_SHARED=ON
//        cmake --build build --config Release
//   2. Copy cerberus_sdk.dll to Assets/Plugins/x86_64/.
//   3. Copy bindings/csharp/Cerberus.cs and this file into Assets/Scripts/.
//   4. Drop CerberusManager on a bootstrap GameObject in your first scene.
//
// Windows 10 21H2 (build 19044) or later, or Windows 11, x64.

using System;
using Cerberus.SDK;
using UnityEngine;

namespace Cerberus.Unity
{
    /// <summary>
    /// Owns the Cerberus runtime for the lifetime of the player session.
    ///
    /// One instance, marked DontDestroyOnLoad. Init in Awake, pump in Update,
    /// shut down in OnDestroy.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class CerberusManager : MonoBehaviour
    {
        public static CerberusManager Instance { get; private set; }

        [Header("Credentials")]
        [Tooltip("Never commit a live key. Read it from a build-time secret or a remote config.")]
        [SerializeField] private string apiKey = "crb_eval_0000000000000000";

        [Tooltip("Your title's stable identifier, as issued with the key.")]
        [SerializeField] private string gameId = "your-title";

        [Header("Detection layers")]
        [SerializeField] private bool enableBehavioralAI = true;   // Layer 2
        [SerializeField] private bool enableHardware     = true;   // Layer 3
        [SerializeField] private bool enableNetwork      = true;   // Layer 4

        [Header("Tuning")]
        [Tooltip("Milliseconds between scans. Minimum 500. 0 uses the default of 2000.")]
        [SerializeField] private uint scanIntervalMs = 0;

        [Tooltip("Callbacks delivered per frame. 0 drains the whole queue.")]
        [SerializeField] private int maxEventsPerFrame = 8;

        /// <summary>Raised on the main thread when a detection is confirmed.</summary>
        public event Action<BanEvent> PlayerBanned;

        private bool  _initialized;
        private bool  _sessionOpen;
        private float _heartbeatTimer;

        private void Awake()
        {
            if (Instance != null && Instance != this)
            {
                Destroy(gameObject);
                return;
            }
            Instance = this;
            DontDestroyOnLoad(gameObject);

            CerberusSDK.OnBan   += HandleBan;
            CerberusSDK.OnFlag  += HandleFlag;
            CerberusSDK.OnEvent += HandleLifecycle;

            var config = new CerberusConfig
            {
                ApiKey       = apiKey,
                GameId       = gameId,
                Region       = CerberusRegion.Auto,   // one of three regions, by latency
                EnableAI     = enableBehavioralAI,
                EnableHW     = enableHardware,
                EnableNET    = enableNetwork,
                ScanInterval = scanIntervalMs,
                LogLevel     = Debug.isDebugBuild ? CerberusLogLevel.Debug : CerberusLogLevel.Warn
            };

            CerberusResult result = CerberusSDK.Init(config);
            if (result != CerberusResult.Ok)
            {
                Debug.LogError($"[Cerberus] init failed: {CerberusSDK.ErrorString(result)} ({(int)result})");
                return;
            }

            _initialized = true;
            Debug.Log($"[Cerberus] SDK {CerberusSDK.Version()} initialised" +
                      (CerberusSDK.IsEvaluationBuild()
                          ? " - EVALUATION BUILD: detections are simulated, no protection."
                          : "."));
        }

        /// <summary>Call when the player enters a protected context (match start, lobby join).</summary>
        public bool StartSession(string playerId)
        {
            if (!_initialized || _sessionOpen)
            {
                return false;
            }

            CerberusResult result = CerberusSDK.StartSession(playerId);
            if (result != CerberusResult.Ok)
            {
                Debug.LogError($"[Cerberus] session start failed: {CerberusSDK.ErrorString(result)}");
                return false;
            }

            _sessionOpen    = true;
            _heartbeatTimer = 0f;
            return true;
        }

        /// <summary>Call when the player leaves the protected context.</summary>
        public void EndSession()
        {
            if (!_sessionOpen)
            {
                return;
            }
            CerberusSDK.EndSession();
            _sessionOpen = false;
        }

        private void Update()
        {
            if (!_initialized)
            {
                return;
            }

            // Pump every frame. It never blocks; callbacks are raised here, on
            // the main thread, so touching Unity objects from them is safe.
            int delivered = CerberusSDK.Pump(maxEventsPerFrame);
            if (delivered < 0)
            {
                Debug.LogError($"[Cerberus] pump failed: {CerberusSDK.ErrorString((CerberusResult)delivered)}");
                return;
            }

            if (!_sessionOpen)
            {
                return;
            }

            _heartbeatTimer += Time.unscaledDeltaTime;
            if (_heartbeatTimer >= 10f)
            {
                _heartbeatTimer = 0f;
                CerberusSDK.Heartbeat();
            }
        }

        private void OnDestroy()
        {
            CerberusSDK.OnBan   -= HandleBan;
            CerberusSDK.OnFlag  -= HandleFlag;
            CerberusSDK.OnEvent -= HandleLifecycle;

            if (_initialized)
            {
                EndSession();
                CerberusSDK.Shutdown();
                _initialized = false;
            }

            if (Instance == this)
            {
                Instance = null;
            }
        }

        private void HandleBan(BanEvent ban)
        {
            // Show the appeal reference in your ban message. A player who cannot
            // quote it cannot be helped by support.
            Debug.LogWarning($"[Cerberus] {ban.PlayerId} banned - {ban.Reason} " +
                             $"(confidence {ban.Confidence:0.00}). Appeal reference {ban.AppealReference}.");
            PlayerBanned?.Invoke(ban);
        }

        private void HandleFlag(FlagEvent flag)
        {
            // Flags are below the ban threshold and are queued for review.
            // Never act on a flag client-side.
            Debug.Log($"[Cerberus] flag for {flag.PlayerId} - {flag.Reason} " +
                      $"(confidence {flag.Confidence:0.00}).");
        }

        private void HandleLifecycle(LifecycleEvent ev)
        {
            Debug.Log($"[Cerberus] {ev.Type}: {ev.Message}");
        }
    }
}
