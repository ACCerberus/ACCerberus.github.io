// CerberusSubsystem.h - illustrative Unreal Engine integration.
//
// ILLUSTRATIVE ONLY. This file is not compiled by the SDK's CMake project and
// is not a drop-in plugin: it shows where each SDK call belongs in an Unreal
// game module. The partner package ships a real UE plugin with a .uplugin,
// build rules and precompiled binaries.
//
// Place it in your game module, add the SDK include directory, and link
// cerberus_eval (evaluation) or cerberus_sdk (partner runtime) in Build.cs.

#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "Tickable.h"
#include "CerberusSubsystem.generated.h"

struct CerberusSession;

DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FCerberusBanSignature,
                                               const FString&, PlayerId,
                                               const FString&, AppealReference,
                                               float,          Confidence);

/**
 * Owns the Cerberus runtime for the lifetime of the game instance.
 *
 * Initialise once at startup, start a session when the player enters a
 * protected context, pump every tick, end the session when they leave.
 */
UCLASS()
class UCerberusSubsystem : public UGameInstanceSubsystem, public FTickableGameObject
{
    GENERATED_BODY()

public:
    // UGameInstanceSubsystem
    virtual void Initialize(FSubsystemCollectionBase& Collection) override;
    virtual void Deinitialize() override;

    // FTickableGameObject
    virtual void    Tick(float DeltaTime) override;
    virtual TStatId GetStatId() const override;
    virtual bool    IsTickable() const override { return bInitialized; }

    /** Start a protected session for the local player. */
    UFUNCTION(BlueprintCallable, Category = "Cerberus")
    bool StartSession(const FString& PlayerId);

    /** End the current session. Safe to call when none is open. */
    UFUNCTION(BlueprintCallable, Category = "Cerberus")
    void EndSession();

    /** True when running against the evaluation build - gate shipping logic on this. */
    UFUNCTION(BlueprintPure, Category = "Cerberus")
    bool IsEvaluationBuild() const;

    UFUNCTION(BlueprintPure, Category = "Cerberus")
    FString GetSdkVersion() const;

    /** Raised on the game thread from Tick when a detection is confirmed. */
    UPROPERTY(BlueprintAssignable, Category = "Cerberus")
    FCerberusBanSignature OnPlayerBanned;

private:
    CerberusSession* Session = nullptr;
    bool             bInitialized = false;
    float            HeartbeatAccumulator = 0.0f;
};
