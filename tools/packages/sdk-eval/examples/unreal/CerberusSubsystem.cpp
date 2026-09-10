// CerberusSubsystem.cpp - illustrative Unreal Engine integration.
//
// ILLUSTRATIVE ONLY. See CerberusSubsystem.h.

#include "CerberusSubsystem.h"

#include "cerberus_sdk.h"

DEFINE_LOG_CATEGORY_STATIC(LogCerberus, Log, All);

namespace
{
    // The subsystem is a game-instance singleton, so a file-static pointer is
    // enough to route the C callbacks back to it. Callbacks arrive on the
    // thread that calls cerberus_session_pump - here, the game thread.
    UCerberusSubsystem* GCerberusSubsystem = nullptr;

    void CERBERUS_CALL HandleBan(const CerberusBanInfo* Info, void* /*UserData*/)
    {
        if (GCerberusSubsystem == nullptr || Info == nullptr)
        {
            return;
        }

        const FString PlayerId(UTF8_TO_TCHAR(Info->playerId));
        const FString Appeal(UTF8_TO_TCHAR(Info->appealReference));

        UE_LOG(LogCerberus, Warning,
               TEXT("Detection confirmed for %s (confidence %.2f). Appeal reference %s."),
               *PlayerId, Info->confidence, *Appeal);

        // Show the appeal reference in your ban message - a player who cannot
        // quote it cannot be helped by support.
        GCerberusSubsystem->OnPlayerBanned.Broadcast(PlayerId, Appeal, Info->confidence);
    }

    void CERBERUS_CALL HandleFlag(const CerberusFlagInfo* Info, void* /*UserData*/)
    {
        if (Info == nullptr)
        {
            return;
        }
        // Flags are suspicions below the ban threshold. They are queued for
        // review and must never be enforced client-side.
        UE_LOG(LogCerberus, Verbose, TEXT("Flag for %s (confidence %.2f): %s"),
               UTF8_TO_TCHAR(Info->playerId), Info->confidence, UTF8_TO_TCHAR(Info->details));
    }

    void CERBERUS_CALL HandleEvent(const CerberusEvent* Event, void* /*UserData*/)
    {
        if (Event == nullptr)
        {
            return;
        }
        UE_LOG(LogCerberus, Log, TEXT("[%d] %s"), static_cast<int32>(Event->type),
               UTF8_TO_TCHAR(Event->message));
    }
}

void UCerberusSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
    Super::Initialize(Collection);
    GCerberusSubsystem = this;

    CerberusConfig Config;
    FMemory::Memzero(&Config, sizeof(Config));

    // Never hard-code a live key. Read it from an encrypted ini section, a
    // build-time define, or your platform secret store.
    Config.apiKey    = "crb_eval_0000000000000000";
    Config.gameId    = "your-title";
    Config.region    = CERBERUS_REGION_AUTO;
    Config.enableAI  = true;   // Layer 2
    Config.enableHW  = true;   // Layer 3
    Config.enableNET = true;   // Layer 4
    Config.logLevel  = CERBERUS_LOG_INFO;

    // Async init keeps the loading thread free; READY arrives on the first Tick.
    const CerberusResult Result = cerberus_init_async(&Config, &HandleEvent, nullptr);
    if (Result != CERBERUS_OK)
    {
        UE_LOG(LogCerberus, Error, TEXT("Cerberus init failed: %s"),
               UTF8_TO_TCHAR(cerberus_error_string(Result)));
        return;
    }

    CerberusCallbacksV3 Callbacks;
    FMemory::Memzero(&Callbacks, sizeof(Callbacks));
    Callbacks.abiVersion = CERBERUS_CALLBACK_ABI;
    Callbacks.onBan      = &HandleBan;
    Callbacks.onFlag     = &HandleFlag;
    Callbacks.onEvent    = &HandleEvent;
    cerberus_set_callbacks(&Callbacks);

    bInitialized = true;
    UE_LOG(LogCerberus, Log, TEXT("Cerberus SDK %s initialised."),
           UTF8_TO_TCHAR(cerberus_version()));
}

void UCerberusSubsystem::Deinitialize()
{
    EndSession();
    if (bInitialized)
    {
        cerberus_shutdown();
        bInitialized = false;
    }
    GCerberusSubsystem = nullptr;
    Super::Deinitialize();
}

void UCerberusSubsystem::Tick(float DeltaTime)
{
    if (!bInitialized || Session == nullptr)
    {
        return;
    }

    // Bounded per-frame work: at most 8 callbacks per tick.
    const int32 Delivered = cerberus_session_pump(Session, 8);
    if (Delivered < 0)
    {
        UE_LOG(LogCerberus, Error, TEXT("Cerberus pump failed: %s"),
               UTF8_TO_TCHAR(cerberus_error_string(static_cast<CerberusResult>(Delivered))));
        return;
    }

    HeartbeatAccumulator += DeltaTime;
    if (HeartbeatAccumulator >= 10.0f)
    {
        HeartbeatAccumulator = 0.0f;
        cerberus_session_heartbeat(Session);
    }
}

TStatId UCerberusSubsystem::GetStatId() const
{
    RETURN_QUICK_DECLARE_CYCLE_STAT(UCerberusSubsystem, STATGROUP_Tickables);
}

bool UCerberusSubsystem::StartSession(const FString& PlayerId)
{
    if (!bInitialized || Session != nullptr)
    {
        return false;
    }

    const FTCHARToUTF8 Converted(*PlayerId);
    const CerberusResult Result = cerberus_session_start(Converted.Get(), &Session);
    if (Result != CERBERUS_OK)
    {
        UE_LOG(LogCerberus, Error, TEXT("Cerberus session start failed: %s"),
               UTF8_TO_TCHAR(cerberus_error_string(Result)));
        Session = nullptr;
        return false;
    }

    HeartbeatAccumulator = 0.0f;
    return true;
}

void UCerberusSubsystem::EndSession()
{
    if (Session != nullptr)
    {
        cerberus_session_end(Session);
        Session = nullptr;
    }
}

bool UCerberusSubsystem::IsEvaluationBuild() const
{
    return cerberus_is_evaluation_build();
}

FString UCerberusSubsystem::GetSdkVersion() const
{
    return FString(UTF8_TO_TCHAR(cerberus_version()));
}
