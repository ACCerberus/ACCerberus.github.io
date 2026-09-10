// Cerberus.cs - C# binding for the Cerberus Anti-Cheat SDK 0.6.0
//
// Target: .NET 8 (or Unity 2021.3+ with the same P/Invoke surface).
// Native library: cerberus_sdk.dll, next to your executable.
//
// Build the shared library from the SDK root:
//     cmake -S . -B build -DCERBERUS_EVAL_SHARED=ON
//     cmake --build build --config Release
//
// This is the evaluation binding. It talks to the evaluation runtime, which
// simulates detections and loads no driver. The partner runtime exposes exactly
// this surface, so nothing here changes when you swap the DLL.

using System;
using System.Runtime.InteropServices;

namespace Cerberus.SDK
{
    public enum CerberusResult
    {
        Ok = 0,

        InvalidKey        = -1,
        InvalidConfig     = -2,
        AlreadyInit       = -3,
        NotInitialized    = -4,
        DriverUnavailable = -5,
        AttestationFailed = -6,
        Network           = -7,
        SessionLimit      = -8,
        InvalidSession    = -9,
        PermissionDenied  = -10,
        Timeout           = -11,
        BufferTooSmall    = -12,
        UnsupportedOs     = -13,

        EvaluationOnly    = -90,
        Internal          = -100
    }

    /// <summary>Cerberus operates three regions. Auto picks by latency at init.</summary>
    public enum CerberusRegion
    {
        Auto        = 0,
        UsEast      = 1,
        EuWest      = 2,
        ApSoutheast = 3
    }

    public enum CerberusLogLevel
    {
        Off   = 0,
        Error = 1,
        Warn  = 2,
        Info  = 3,
        Debug = 4,
        Trace = 5
    }

    /// <summary>Mirrors the detection categories shown in the dashboard.</summary>
    public enum CerberusBanReason
    {
        Unknown        = 0,
        Aimbot         = 1,
        WallhackEsp    = 2,
        DmaExternal    = 3,
        KernelDriver   = 4,
        SpeedHack      = 5,
        HwidSpoof      = 6,
        InputInjection = 7,
        MemoryTamper   = 8,
        SignatureMatch = 9,
        ManualReview   = 10
    }

    public enum CerberusEventType
    {
        Ready             = 0,
        AttestFailed      = 1,
        DriverUnavailable = 2,
        SignatureSync     = 3,
        Shutdown          = 4
    }

    public enum CerberusOption
    {
        HwScan       = 1,
        ScanInterval = 2,
        AiSampleRate = 3,
        LogLevel     = 4,
        RequireIommu = 5
    }

    /// <summary>Detection layer bit flags. Layer 1 kernel, 2 behavioural, 3 hardware, 4 network.</summary>
    [Flags]
    public enum CerberusLayer : uint
    {
        None       = 0x00,
        Kernel     = 0x01,
        Behavioral = 0x02,
        Hardware   = 0x04,
        Network    = 0x08,
        All        = 0x0F
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct CerberusAttestation
    {
        [MarshalAs(UnmanagedType.I1)] public bool SecureBoot;
        [MarshalAs(UnmanagedType.I1)] public bool Hvci;
        [MarshalAs(UnmanagedType.I1)] public bool Iommu;
        [MarshalAs(UnmanagedType.I1)] public bool TpmPresent;
        public ushort TpmSpecMajor;
        public ushort TpmSpecMinor;
        public uint   BootChainScore;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 65)] public string Digest;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct NativeEvent
    {
        public CerberusEventType Type;
        public CerberusResult    Result;
        public uint              Layer;
        public long              Timestamp;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 192)] public string Message;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct NativeBanInfo
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Id;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 21)] public string AppealReference;
        public IntPtr            PlayerId;
        public uint              Layer;
        public CerberusBanReason Reason;
        public float             Confidence;
        public IntPtr            Details;
        public CerberusAttestation Attestation;
        public long              Timestamp;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct NativeFlagInfo
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Id;
        public IntPtr            PlayerId;
        public uint              Layer;
        public CerberusBanReason Reason;
        public float             Confidence;
        public IntPtr            Details;
        public long              Timestamp;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct NativeConfig
    {
        public IntPtr           ApiKey;
        public IntPtr           GameId;
        public CerberusRegion   Region;
        [MarshalAs(UnmanagedType.I1)] public bool EnableAI;
        [MarshalAs(UnmanagedType.I1)] public bool EnableHW;
        [MarshalAs(UnmanagedType.I1)] public bool EnableNET;
        public uint             ScanInterval;
        public uint             AiSampleRate;
        public IntPtr           BanCallback;
        public IntPtr           FlagCallback;
        public CerberusLogLevel LogLevel;
        [MarshalAs(UnmanagedType.I1)] public bool RequireIommu;
        [MarshalAs(UnmanagedType.I1)] public bool ZeroFootprint;
        public IntPtr           AttestationReport;
        public IntPtr           UserData;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 4)] public uint[] Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct NativeCallbacksV3
    {
        public uint   AbiVersion;
        public IntPtr OnBan;
        public IntPtr OnFlag;
        public IntPtr OnEvent;
        public IntPtr UserData;
    }

    /// <summary>Managed configuration. Only ApiKey and GameId are required.</summary>
    public sealed class CerberusConfig
    {
        public string ApiKey { get; set; } = string.Empty;
        public string GameId { get; set; } = string.Empty;

        public CerberusRegion Region { get; set; } = CerberusRegion.Auto;

        public bool EnableAI  { get; set; } = true;   // Layer 2
        public bool EnableHW  { get; set; } = true;   // Layer 3
        public bool EnableNET { get; set; } = true;   // Layer 4

        /// <summary>Milliseconds. Minimum 500. 0 means the default of 2000.</summary>
        public uint ScanInterval { get; set; }

        /// <summary>Milliseconds, 250-2000. 0 means the default of 1000.</summary>
        public uint AiSampleRate { get; set; }

        public CerberusLogLevel LogLevel { get; set; } = CerberusLogLevel.Info;

        /// <summary>Refuse to start sessions on platforms without an IOMMU.</summary>
        public bool RequireIommu { get; set; }

        /// <summary>Do not write a local session journal.</summary>
        public bool ZeroFootprint { get; set; }
    }

    /// <summary>A confirmed detection.</summary>
    public sealed class BanEvent
    {
        public string            PlayerId        { get; init; } = string.Empty;
        public CerberusBanReason Reason          { get; init; }
        public float             Confidence      { get; init; }
        public string            AppealReference { get; init; } = string.Empty;
        public string            DetectionId     { get; init; } = string.Empty;
        public CerberusLayer     Layer           { get; init; }
        public string            Details         { get; init; } = string.Empty;
        public DateTimeOffset    Timestamp       { get; init; }
    }

    /// <summary>A suspicion below the ban threshold. Queued for review, never auto-enforced.</summary>
    public sealed class FlagEvent
    {
        public string            PlayerId    { get; init; } = string.Empty;
        public CerberusBanReason Reason      { get; init; }
        public float             Confidence  { get; init; }
        public string            DetectionId { get; init; } = string.Empty;
        public CerberusLayer     Layer       { get; init; }
        public string            Details     { get; init; } = string.Empty;
        public DateTimeOffset    Timestamp   { get; init; }
    }

    public sealed class LifecycleEvent
    {
        public CerberusEventType Type      { get; init; }
        public CerberusResult    Result    { get; init; }
        public CerberusLayer     Layer     { get; init; }
        public string            Message   { get; init; } = string.Empty;
        public DateTimeOffset    Timestamp { get; init; }
    }

    /// <summary>
    /// Managed entry point.
    ///
    ///   CerberusSDK.OnBan += b =&gt; Log($"{b.PlayerId} banned, appeal {b.AppealReference}");
    ///   CerberusSDK.Init(new CerberusConfig { ApiKey = key, GameId = "your-title" });
    ///   CerberusSDK.StartSession(playerId);
    ///   // every tick:
    ///   CerberusSDK.Pump();
    ///   // on exit:
    ///   CerberusSDK.EndSession();
    ///   CerberusSDK.Shutdown();
    ///
    /// Callbacks are raised on the thread that calls <see cref="Pump"/>.
    /// </summary>
    public static class CerberusSDK
    {
        private const string Lib = "cerberus_sdk";
        private const uint   CallbackAbi = 3;

        public static event Action<BanEvent>?       OnBan;
        public static event Action<FlagEvent>?      OnFlag;
        public static event Action<LifecycleEvent>? OnEvent;

        // Delegates are held in static fields so the GC cannot collect the
        // thunks while native code still holds their addresses.
        private delegate void BanThunk(ref NativeBanInfo info, IntPtr user);
        private delegate void FlagThunk(ref NativeFlagInfo info, IntPtr user);
        private delegate void EventThunk(ref NativeEvent ev, IntPtr user);

        private static readonly BanThunk   BanBridge   = HandleBan;
        private static readonly FlagThunk  FlagBridge  = HandleFlag;
        private static readonly EventThunk EventBridge = HandleEvent;

        private static IntPtr _session;
        private static bool   _initialized;

        public static bool IsInitialized => _initialized;

        public static string Version() => Marshal.PtrToStringAnsi(cerberus_version()) ?? "unknown";

        public static bool IsEvaluationBuild() => cerberus_is_evaluation_build();

        public static string ErrorString(CerberusResult result)
            => Marshal.PtrToStringAnsi(cerberus_error_string(result)) ?? "unknown";

        public static CerberusResult Init(CerberusConfig config)
        {
            if (config is null) throw new ArgumentNullException(nameof(config));

            IntPtr apiKey = Marshal.StringToHGlobalAnsi(config.ApiKey);
            IntPtr gameId = Marshal.StringToHGlobalAnsi(config.GameId);
            try
            {
                var native = new NativeConfig
                {
                    ApiKey       = apiKey,
                    GameId       = gameId,
                    Region       = config.Region,
                    EnableAI     = config.EnableAI,
                    EnableHW     = config.EnableHW,
                    EnableNET    = config.EnableNET,
                    ScanInterval = config.ScanInterval,
                    AiSampleRate = config.AiSampleRate,
                    LogLevel     = config.LogLevel,
                    RequireIommu = config.RequireIommu,
                    ZeroFootprint = config.ZeroFootprint,
                    Reserved     = new uint[4]
                };

                CerberusResult r = cerberus_init_async(ref native, Marshal.GetFunctionPointerForDelegate(EventBridge), IntPtr.Zero);
                if (r != CerberusResult.Ok) return r;

                var callbacks = new NativeCallbacksV3
                {
                    AbiVersion = CallbackAbi,
                    OnBan      = Marshal.GetFunctionPointerForDelegate(BanBridge),
                    OnFlag     = Marshal.GetFunctionPointerForDelegate(FlagBridge),
                    OnEvent    = Marshal.GetFunctionPointerForDelegate(EventBridge),
                    UserData   = IntPtr.Zero
                };
                r = cerberus_set_callbacks(ref callbacks);
                if (r != CerberusResult.Ok) return r;

                _initialized = true;
                return CerberusResult.Ok;
            }
            finally
            {
                Marshal.FreeHGlobal(apiKey);
                Marshal.FreeHGlobal(gameId);
            }
        }

        public static CerberusResult SetOption(CerberusOption option, int value)
            => cerberus_set_option(option, value);

        public static CerberusResult StartSession(string playerId)
        {
            if (_session != IntPtr.Zero) return CerberusResult.SessionLimit;
            CerberusResult r = cerberus_session_start(playerId, out IntPtr session);
            if (r == CerberusResult.Ok) _session = session;
            return r;
        }

        public static CerberusResult Heartbeat()
            => _session == IntPtr.Zero
                ? CerberusResult.InvalidSession
                : cerberus_session_heartbeat(_session);

        public static CerberusResult EndSession()
        {
            if (_session == IntPtr.Zero) return CerberusResult.InvalidSession;
            CerberusResult r = cerberus_session_end(_session);
            _session = IntPtr.Zero;
            return r;
        }

        /// <summary>Deliver queued callbacks. Call once per tick. Returns the number delivered.</summary>
        public static int Pump(int maxEvents = 0)
        {
            if (!_initialized) return (int)CerberusResult.NotInitialized;
            return cerberus_session_pump(_session, maxEvents);
        }

        public static CerberusResult Shutdown()
        {
            if (!_initialized) return CerberusResult.NotInitialized;
            if (_session != IntPtr.Zero) EndSession();
            CerberusResult r = cerberus_shutdown();
            _initialized = false;
            return r;
        }

        // --- native -> managed bridges ---------------------------------------

        private static DateTimeOffset FromUnix(long seconds)
            => DateTimeOffset.FromUnixTimeSeconds(seconds);

        private static string Str(IntPtr p) => Marshal.PtrToStringAnsi(p) ?? string.Empty;

        private static void HandleBan(ref NativeBanInfo info, IntPtr user)
        {
            OnBan?.Invoke(new BanEvent
            {
                PlayerId        = Str(info.PlayerId),
                Reason          = info.Reason,
                Confidence      = info.Confidence,
                AppealReference = info.AppealReference,
                DetectionId     = info.Id,
                Layer           = (CerberusLayer)info.Layer,
                Details         = Str(info.Details),
                Timestamp       = FromUnix(info.Timestamp)
            });
        }

        private static void HandleFlag(ref NativeFlagInfo info, IntPtr user)
        {
            OnFlag?.Invoke(new FlagEvent
            {
                PlayerId    = Str(info.PlayerId),
                Reason      = info.Reason,
                Confidence  = info.Confidence,
                DetectionId = info.Id,
                Layer       = (CerberusLayer)info.Layer,
                Details     = Str(info.Details),
                Timestamp   = FromUnix(info.Timestamp)
            });
        }

        private static void HandleEvent(ref NativeEvent ev, IntPtr user)
        {
            OnEvent?.Invoke(new LifecycleEvent
            {
                Type      = ev.Type,
                Result    = ev.Result,
                Layer     = (CerberusLayer)ev.Layer,
                Message   = ev.Message,
                Timestamp = FromUnix(ev.Timestamp)
            });
        }

        // --- P/Invoke ---------------------------------------------------------

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        private static extern CerberusResult cerberus_init_async(ref NativeConfig config, IntPtr onEvent, IntPtr userData);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        private static extern CerberusResult cerberus_set_callbacks(ref NativeCallbacksV3 callbacks);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        private static extern CerberusResult cerberus_set_option(CerberusOption option, int value);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        private static extern CerberusResult cerberus_shutdown();

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        private static extern IntPtr cerberus_version();

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        private static extern IntPtr cerberus_error_string(CerberusResult result);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        [return: MarshalAs(UnmanagedType.I1)]
        private static extern bool cerberus_is_evaluation_build();

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
        private static extern CerberusResult cerberus_session_start(string playerId, out IntPtr session);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        private static extern CerberusResult cerberus_session_heartbeat(IntPtr session);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        private static extern CerberusResult cerberus_session_end(IntPtr session);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
        private static extern int cerberus_session_pump(IntPtr session, int maxEvents);
    }
}
