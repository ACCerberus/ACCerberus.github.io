#Requires -Version 5.1
<#
.SYNOPSIS
    Cerberus Readiness Check - tells you whether this PC can run a title
    protected by the Cerberus anti-cheat engine, and what to change if not.

.DESCRIPTION
    Runs 14 local checks against the platform security features the four
    Cerberus detection layers depend on, prints a table and a verdict, and
    emits a short "readiness code" you can decode (or paste to support)
    without sending anything anywhere.

    This script is entirely offline. It reads the registry, WMI/CIM and the
    Plug and Play device list. It does not talk to anything outside this PC,
    it collects no machine name, user name, serial number, address or driver
    name, and it installs nothing.

.PARAMETER NoReport
    Do not write the JSON report file.

.PARAMETER Json
    Print only the JSON report to standard output (no table, no colour).

.PARAMETER NoColor
    Print the table without ANSI/console colours.

.PARAMETER OutDir
    Directory for cerberus-readiness-report.json. Defaults to the current
    directory.

.EXAMPLE
    .\Cerberus-ReadinessCheck.ps1

.EXAMPLE
    .\Cerberus-ReadinessCheck.ps1 -Json -NoReport

.NOTES
    Cerberus Readiness Check 1.0.0 - https://cerberusac.dev/readiness/
    Exit codes: 0 READY, 1 READY_WITH_WARNINGS, 2 NOT_READY, 3 script error.
#>
[CmdletBinding()]
param(
    [switch]$NoReport,
    [switch]$Json,
    [switch]$NoColor,
    [string]$OutDir
)

$ToolVersion = '1.0.0'
$ToolName    = 'Cerberus Readiness Check'
$DecodeUrl   = 'https://cerberusac.dev/readiness/'

# ---------------------------------------------------------------------------
# Readiness code encoder - keep bit-for-bit identical to js/cerberus-readiness.js
# ---------------------------------------------------------------------------

$script:Alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
$script:StatusCodes = @{ 'PASS' = 0; 'WARN' = 1; 'FAIL' = 2; 'SKIP' = 3 }

function Add-CodeBits {
    param(
        [System.Collections.ArrayList]$Bits,
        [int]$Value,
        [int]$Width
    )
    for ($i = $Width - 1; $i -ge 0; $i--) {
        [void]$Bits.Add((($Value -shr $i) -band 1))
    }
}

function Get-CodeChecksum {
    param([int[]]$Nibbles)
    $chk = 0x1F
    for ($i = 0; $i -lt $Nibbles.Count; $i++) {
        $chk = (((($chk -bxor ($Nibbles[$i] -band 0x0F)) * 31) + $i) -band 0xFF)
    }
    return $chk
}

function Get-BitsAsNibbles {
    param([int[]]$Bits, [int]$Start, [int]$Count)
    $out = New-Object 'System.Collections.Generic.List[int]'
    for ($n = 0; $n -lt $Count; $n++) {
        $v = 0
        for ($i = 0; $i -lt 4; $i++) {
            $v = ($v * 2) + $Bits[$Start + ($n * 4) + $i]
        }
        $out.Add([int]$v)
    }
    return $out.ToArray()
}

function Get-ReadinessCode {
    param(
        [string[]]$Statuses,
        [int]$RamBucket,
        [int]$DiskBucket,
        [int]$DriverCount,
        [int]$TpmCode,
        [int]$OsClass
    )

    $bits = New-Object System.Collections.ArrayList

    Add-CodeBits -Bits $bits -Value 1 -Width 4
    for ($i = 0; $i -lt 14; $i++) {
        $s = 3
        if ($i -lt $Statuses.Count -and $script:StatusCodes.ContainsKey($Statuses[$i])) {
            $s = [int]$script:StatusCodes[$Statuses[$i]]
        }
        Add-CodeBits -Bits $bits -Value $s -Width 2
    }
    Add-CodeBits -Bits $bits -Value ([Math]::Max(0, [Math]::Min(15, $RamBucket)))   -Width 4
    Add-CodeBits -Bits $bits -Value ([Math]::Max(0, [Math]::Min(7,  $DiskBucket)))  -Width 3
    Add-CodeBits -Bits $bits -Value ([Math]::Max(0, [Math]::Min(15, $DriverCount))) -Width 4
    Add-CodeBits -Bits $bits -Value ([Math]::Max(0, [Math]::Min(3,  $TpmCode)))     -Width 2
    Add-CodeBits -Bits $bits -Value ([Math]::Max(0, [Math]::Min(7,  $OsClass)))     -Width 3
    Add-CodeBits -Bits $bits -Value 0 -Width 4

    $arr = @()
    foreach ($b in $bits) { $arr += [int]$b }
    $chk = Get-CodeChecksum -Nibbles (Get-BitsAsNibbles -Bits $arr -Start 0 -Count 13)
    Add-CodeBits -Bits $bits -Value $chk -Width 8

    $arr = @()
    foreach ($b in $bits) { $arr += [int]$b }

    $text = ''
    for ($s = 0; $s -lt 12; $s++) {
        $v = 0
        for ($b = 0; $b -lt 5; $b++) {
            $v = ($v * 2) + $arr[($s * 5) + $b]
        }
        $text += $script:Alphabet.Substring($v, 1)
    }
    return 'CRC1-' + $text.Substring(0, 4) + '-' + $text.Substring(4, 4) + '-' + $text.Substring(8, 4)
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Test-IsElevated {
    try {
        $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return [bool]$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Try-Cim {
    param(
        [string]$Class,
        [string]$Namespace = 'root\cimv2',
        [string]$Filter
    )
    try {
        $args1 = @{ ClassName = $Class; Namespace = $Namespace; ErrorAction = 'Stop' }
        if ($Filter) { $args1['Filter'] = $Filter }
        return (Get-CimInstance @args1)
    } catch {
        try {
            $args2 = @{ Class = $Class; Namespace = $Namespace; ErrorAction = 'Stop' }
            if ($Filter) { $args2['Filter'] = $Filter }
            return (Get-WmiObject @args2)
        } catch {
            return $null
        }
    }
}

function Try-RegValue {
    param([string]$Path, [string]$Name)
    try {
        $item = Get-ItemProperty -Path $Path -Name $Name -ErrorAction Stop
        return $item.$Name
    } catch {
        return $null
    }
}

function New-Check {
    param(
        [int]$Index,
        [string]$Id,
        [string]$Label,
        $Layer,
        [string]$Status,
        [string]$Detail
    )
    $g = ''
    if ($Status -ne 'PASS' -and $script:Guidance.ContainsKey($Id)) {
        $table = $script:Guidance[$Id]
        if ($table.ContainsKey($Status)) { $g = [string]$table[$Status] }
    }
    return [PSCustomObject]@{
        index    = $Index
        id       = $Id
        label    = $Label
        layer    = $Layer
        status   = $Status
        detail   = $Detail
        guidance = $g
    }
}

# Fix-it text, deliberately OEM-generic. Mirrors js/cerberus-readiness.js.
$script:Guidance = @{
    'OS_VERSION' = @{
        'WARN' = 'Windows Server SKUs are not a supported player platform. Cerberus runs, but the kernel layer is unvalidated there - use a Windows 10 21H2+ or Windows 11 client build for evaluation.'
        'FAIL' = 'Update Windows to build 19044 (21H2) or later: Settings > Windows Update > Check for updates. If the machine is stuck on an older feature update, use the Windows Update Assistant from Microsoft.'
        'SKIP' = 'The build number could not be read from the registry. Check winver manually.'
    }
    'ARCH_X64' = @{
        'FAIL' = 'ARM64 and 32-bit Windows are not supported. An x64 emulation layer does not help - the kernel driver cannot load. Evaluate on an x64 machine.'
        'SKIP' = 'The processor architecture could not be determined.'
    }
    'SECURE_BOOT' = @{
        'FAIL' = 'Enter firmware setup (usually Del, F2, F10 or F12 during boot, or Settings > System > Recovery > Advanced startup > UEFI Firmware Settings). Set the boot mode to UEFI, disable CSM / Legacy Boot, then enable Secure Boot and save. If Windows was installed in legacy BIOS mode the disk must be converted from MBR to GPT first (mbr2gpt) - back up before converting.'
        'SKIP' = 'The Secure Boot state key is absent. On most machines that means a legacy BIOS install rather than a UEFI one; check the firmware setup screen.'
    }
    'TPM_PRESENT' = @{
        'WARN' = 'A TPM is present but is not reporting ready. Open tpm.msc and clear/initialise it, or re-provision the firmware TPM in firmware setup. Clearing a TPM can invalidate BitLocker keys - suspend BitLocker first.'
        'FAIL' = 'Enable the firmware TPM in firmware setup: Intel platforms call it PTT (Platform Trust Technology), AMD platforms call it fTPM. On desktops with a header, a discrete TPM module also works. TPM is optional for evaluation but required for full hardware attestation.'
        'SKIP' = 'No TPM source could be queried on this machine.'
    }
    'TPM_20' = @{
        'WARN' = 'This machine reports TPM 1.2. Hardware attestation is skipped and the session falls back to the software fingerprint. Some platforms can switch the firmware TPM to 2.0 in firmware setup; otherwise this is a hardware limit and is not a blocker for evaluation.'
        'SKIP' = 'The TPM specification version is unknown because no TPM was detected.'
    }
    'VBS_RUNNING' = @{
        'WARN' = 'VBS is enabled but not running (or is disabled). Open Windows Security > Device security > Core isolation and turn on Memory integrity, then reboot. VBS also needs virtualization enabled in firmware (Intel VT-x / AMD-V).'
        'SKIP' = 'The Device Guard information class could not be queried on this machine.'
    }
    'HVCI' = @{
        'WARN' = 'Turn on Windows Security > Device security > Core isolation > Memory integrity and reboot. If the toggle is greyed out, Windows names the incompatible driver in that panel; update or remove it (often an old audio, RGB or overlay driver) and try again.'
        'SKIP' = 'Code-integrity state could not be read.'
    }
    'DMA_PROTECTION' = @{
        'WARN' = 'Kernel DMA protection is not reported as available. Enable VT-d (Intel) or AMD-Vi / IOMMU in firmware setup, and make sure the platform is booting in UEFI mode with Secure Boot on. Older boards without IOMMU support cannot provide this. This reports platform availability, not per-device enforcement.'
        'SKIP' = 'DMA protection availability could not be read.'
    }
    'VIRTUALIZATION_FW' = @{
        'WARN' = 'Enable Intel VT-x ("Intel Virtualization Technology") or AMD-V ("SVM Mode") in firmware setup. It is often on a CPU or Advanced page and is off by default on some OEM boards.'
        'SKIP' = 'Virtualization firmware state could not be read.'
    }
    'NOT_VIRTUAL_MACHINE' = @{
        'FAIL' = 'Virtual machines are not a supported player environment: the hardware layer has nothing real to measure and the kernel layer refuses to attest. Run the check on physical hardware.'
        'SKIP' = 'Platform identification strings could not be read.'
    }
    'TEST_SIGNING' = @{
        'FAIL' = 'Open an elevated Command Prompt and run: bcdedit /set testsigning off  and  bcdedit /set nointegritychecks off  then reboot. Both must be off for the kernel layer to attest.'
        'SKIP' = 'Boot configuration can only be read with administrator rights. Re-run the check as administrator for full coverage - this does not affect the verdict.'
    }
    'THIRD_PARTY_DRIVERS' = @{
        'WARN' = 'More than five third-party kernel drivers are running. That is common on gaming machines (RGB suites, overlays, virtual audio, controller stacks) and is not a blocker, but each one is extra attack surface. Remove software you no longer use and keep the rest updated.'
        'SKIP' = 'The running driver list could not be enumerated.'
    }
    'DISK_FREE' = @{
        'WARN' = 'Under 2 GB free on the system drive. Free some space before installing a protected title - Settings > System > Storage > Cleanup recommendations is the quickest route.'
        'FAIL' = 'Under 500 MB free on the system drive. Signature updates and the session journal will fail. Free at least 2 GB.'
        'SKIP' = 'System drive free space could not be read.'
    }
    'RAM' = @{
        'WARN' = 'Between 4 and 8 GB installed. Cerberus runs, but the behavioural layer reduces its sampling window on memory-constrained machines. 8 GB or more is recommended.'
        'FAIL' = 'Under 4 GB installed. This is below the supported floor for any protected title.'
        'SKIP' = 'Installed memory could not be read.'
    }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

try {

$elevated = Test-IsElevated
$checks   = New-Object System.Collections.ArrayList

$sys = [ordered]@{
    osCaption               = $null
    osBuild                 = $null
    displayVersion          = $null
    osClass                 = 0
    arch                    = $null
    ramGB                   = $null
    freeDiskGB              = $null
    tpmSpec                 = $null
    vbsStatus               = $null
    hvciRunning             = $null
    dmaProtectionAvailable  = $null
    hypervisorPresent       = $null
    thirdPartyDriverCount   = $null
    codeIntegrityPolicy     = $null
}

# --- shared sources -------------------------------------------------------
$os      = Try-Cim -Class 'Win32_OperatingSystem'
$cs      = Try-Cim -Class 'Win32_ComputerSystem'
$cpu     = @(Try-Cim -Class 'Win32_Processor')
$dg      = Try-Cim -Class 'Win32_DeviceGuard' -Namespace 'root\Microsoft\Windows\DeviceGuard'
$regPath = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'

# --- 0. OS_VERSION --------------------------------------------------------
$build       = 0
$ubr         = $null
$displayVer  = Try-RegValue -Path $regPath -Name 'DisplayVersion'
$curBuild    = Try-RegValue -Path $regPath -Name 'CurrentBuild'
$ubr         = Try-RegValue -Path $regPath -Name 'UBR'
$productType = 1
if ($os -and $os.ProductType) { $productType = [int]$os.ProductType }
if ($curBuild) { $build = [int]$curBuild }
elseif ($os -and $os.BuildNumber) { $build = [int]$os.BuildNumber }

$sys.osCaption      = if ($os) { [string]$os.Caption } else { $null }
$sys.displayVersion = if ($displayVer) { [string]$displayVer } else { $null }
if ($build -gt 0) {
    if ($ubr -ne $null) { $sys.osBuild = "$build.$ubr" } else { $sys.osBuild = "$build" }
}

if ($build -le 0) {
    [void]$checks.Add((New-Check 0 'OS_VERSION' 'Windows version' 1 'SKIP' 'Windows build number could not be read.'))
} elseif ($productType -ne 1) {
    [void]$checks.Add((New-Check 0 'OS_VERSION' 'Windows version' 1 'WARN' "Windows Server SKU detected (build $build). Not a supported player platform."))
} elseif ($build -ge 19044) {
    $d = "Build $build"
    if ($displayVer) { $d = "$d ($displayVer)" }
    [void]$checks.Add((New-Check 0 'OS_VERSION' 'Windows version' 1 'PASS' "$d - supported."))
} else {
    [void]$checks.Add((New-Check 0 'OS_VERSION' 'Windows version' 1 'FAIL' "Build $build is below the supported floor of 19044 (Windows 10 21H2)."))
}

if ($build -le 0)          { $sys.osClass = 0 }
elseif ($productType -ne 1) { $sys.osClass = 6 }
elseif ($build -ge 26100)   { $sys.osClass = 5 }
elseif ($build -ge 22621)   { $sys.osClass = 4 }
elseif ($build -ge 22000)   { $sys.osClass = 3 }
elseif ($build -ge 19044)   { $sys.osClass = 2 }
else                        { $sys.osClass = 1 }

# --- 1. ARCH_X64 ----------------------------------------------------------
$is64 = $false
try { $is64 = [Environment]::Is64BitOperatingSystem } catch { $is64 = $false }
$cpuArch = $null
if ($cpu -and $cpu.Count -gt 0 -and $cpu[0].Architecture -ne $null) { $cpuArch = [int]$cpu[0].Architecture }

if ($cpuArch -eq 12) {
    $sys.arch = 'ARM64'
    [void]$checks.Add((New-Check 1 'ARCH_X64' '64-bit x64 processor' 1 'FAIL' 'ARM64 platform detected. Cerberus ships x64 binaries only.'))
} elseif ($cpuArch -eq 9 -and $is64) {
    $sys.arch = 'x64'
    [void]$checks.Add((New-Check 1 'ARCH_X64' '64-bit x64 processor' 1 'PASS' 'x64 processor with a 64-bit Windows install.'))
} elseif ($is64) {
    $sys.arch = 'x64'
    [void]$checks.Add((New-Check 1 'ARCH_X64' '64-bit x64 processor' 1 'PASS' '64-bit Windows install.'))
} elseif ($cpuArch -eq $null) {
    [void]$checks.Add((New-Check 1 'ARCH_X64' '64-bit x64 processor' 1 'SKIP' 'Processor architecture could not be determined.'))
} else {
    $sys.arch = 'x86'
    [void]$checks.Add((New-Check 1 'ARCH_X64' '64-bit x64 processor' 1 'FAIL' '32-bit Windows install. An x64 install is required.'))
}

# --- 2. SECURE_BOOT -------------------------------------------------------
$sbKey = Try-RegValue -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecureBoot\State' -Name 'UEFISecureBootEnabled'
$sbDetail = ''
$sbStatus = 'SKIP'
if ($sbKey -ne $null) {
    if ([int]$sbKey -eq 1) {
        $sbStatus = 'PASS'; $sbDetail = 'Secure Boot is enabled.'
    } else {
        $sbStatus = 'FAIL'; $sbDetail = 'Secure Boot is supported by this platform but is turned off.'
    }
} else {
    $sbStatus = 'SKIP'; $sbDetail = 'Secure Boot state key not present (typically a legacy BIOS install).'
}
if ($elevated) {
    try {
        $confirmed = Confirm-SecureBootUEFI -ErrorAction Stop
        if ($confirmed) { $sbStatus = 'PASS'; $sbDetail = 'Secure Boot is enabled (confirmed by firmware).' }
        else { $sbStatus = 'FAIL'; $sbDetail = 'Firmware reports Secure Boot is off.' }
    } catch {
        if ($_.Exception.Message -match 'not supported|PlatformNotSupported') {
            $sbStatus = 'FAIL'; $sbDetail = 'Legacy BIOS boot - Secure Boot is not available on this boot path.'
        }
    }
}
[void]$checks.Add((New-Check 2 'SECURE_BOOT' 'Secure Boot enabled' 3 $sbStatus $sbDetail))

# --- 3. TPM_PRESENT / 4. TPM_20 ------------------------------------------
$tpmSpec    = $null
$tpmPresent = $false
$tpmReady   = $null
$tpmSourced = $false

try {
    $pnp = @(Get-PnpDevice -Class SecurityDevices -PresentOnly -ErrorAction Stop)
    $tpmSourced = $true
    foreach ($d in $pnp) {
        $name = [string]$d.FriendlyName
        if ($name -match 'Trusted Platform Module\s+(\d\.\d)') {
            $tpmPresent = $true
            $tpmSpec = $Matches[1]
        } elseif ($name -match 'Trusted Platform Module') {
            $tpmPresent = $true
        }
    }
} catch {
    $pnp = $null
}

if ($elevated) {
    try {
        $t = Get-Tpm -ErrorAction Stop
        $tpmSourced = $true
        if ($t.TpmPresent) { $tpmPresent = $true }
        $tpmReady = [bool]$t.TpmReady
    } catch { }
    try {
        $wt = Try-Cim -Class 'Win32_Tpm' -Namespace 'root\CIMV2\Security\MicrosoftTpm'
        if ($wt) {
            $tpmSourced = $true
            $tpmPresent = $true
            $sv = [string]$wt.SpecVersion
            if ($sv -match '(\d\.\d)') { $tpmSpec = $Matches[1] }
        }
    } catch { }
}

$sys.tpmSpec = $tpmSpec
if (-not $tpmSourced) {
    [void]$checks.Add((New-Check 3 'TPM_PRESENT' 'TPM present' 3 'SKIP' 'No TPM source could be queried.'))
} elseif (-not $tpmPresent) {
    [void]$checks.Add((New-Check 3 'TPM_PRESENT' 'TPM present' 3 'FAIL' 'No Trusted Platform Module is present or enabled.'))
} elseif ($tpmReady -eq $false) {
    [void]$checks.Add((New-Check 3 'TPM_PRESENT' 'TPM present' 3 'WARN' 'A TPM is present but is not reporting ready.'))
} else {
    $d = 'Trusted Platform Module present'
    if ($tpmSpec) { $d = "Trusted Platform Module $tpmSpec present" }
    [void]$checks.Add((New-Check 3 'TPM_PRESENT' 'TPM present' 3 'PASS' "$d."))
}

$tpmCode = 0
if ($tpmSpec -eq '2.0') {
    $tpmCode = 2
    [void]$checks.Add((New-Check 4 'TPM_20' 'TPM 2.0' 3 'PASS' 'TPM specification 2.0 - full hardware attestation available.'))
} elseif ($tpmSpec -eq '1.2') {
    $tpmCode = 1
    [void]$checks.Add((New-Check 4 'TPM_20' 'TPM 2.0' 3 'WARN' 'TPM specification 1.2 - attestation falls back to the software fingerprint.'))
} else {
    [void]$checks.Add((New-Check 4 'TPM_20' 'TPM 2.0' 3 'SKIP' 'TPM specification version is unknown.'))
}

# --- 5. VBS_RUNNING / 6. HVCI / 7. DMA_PROTECTION -------------------------
$svcRunning    = @()
$svcConfigured = @()
$secProps      = @()
if ($dg) {
    if ($dg.SecurityServicesRunning)      { $svcRunning    = @($dg.SecurityServicesRunning) }
    if ($dg.SecurityServicesConfigured)   { $svcConfigured = @($dg.SecurityServicesConfigured) }
    if ($dg.AvailableSecurityProperties)  { $secProps      = @($dg.AvailableSecurityProperties) }
}

if (-not $dg -or $dg.VirtualizationBasedSecurityStatus -eq $null) {
    [void]$checks.Add((New-Check 5 'VBS_RUNNING' 'Virtualization-based security running' 1 'SKIP' 'Device Guard information class was unavailable.'))
} else {
    $vbs = [int]$dg.VirtualizationBasedSecurityStatus
    $sys.vbsStatus = $vbs
    if ($vbs -eq 2) {
        [void]$checks.Add((New-Check 5 'VBS_RUNNING' 'Virtualization-based security running' 1 'PASS' 'VBS is enabled and running.'))
    } elseif ($vbs -eq 1) {
        [void]$checks.Add((New-Check 5 'VBS_RUNNING' 'Virtualization-based security running' 1 'WARN' 'VBS is enabled but not running.'))
    } else {
        [void]$checks.Add((New-Check 5 'VBS_RUNNING' 'Virtualization-based security running' 1 'WARN' 'VBS is disabled.'))
    }
}

if (-not $dg) {
    [void]$checks.Add((New-Check 6 'HVCI' 'Memory integrity (HVCI)' 1 'SKIP' 'Code-integrity state was unavailable.'))
} elseif ($svcRunning -contains 2) {
    $sys.hvciRunning = $true
    $sys.codeIntegrityPolicy = 'HVCI running'
    [void]$checks.Add((New-Check 6 'HVCI' 'Memory integrity (HVCI)' 1 'PASS' 'Hypervisor-enforced code integrity is running.'))
} elseif ($svcConfigured -contains 2) {
    $sys.hvciRunning = $false
    $sys.codeIntegrityPolicy = 'HVCI configured, not running'
    [void]$checks.Add((New-Check 6 'HVCI' 'Memory integrity (HVCI)' 1 'WARN' 'Memory integrity is configured but not running - a reboot or an incompatible driver is usually the cause.'))
} else {
    $sys.hvciRunning = $false
    $sys.codeIntegrityPolicy = 'HVCI off'
    [void]$checks.Add((New-Check 6 'HVCI' 'Memory integrity (HVCI)' 1 'WARN' 'Memory integrity (HVCI) is off.'))
}

if (-not $dg) {
    [void]$checks.Add((New-Check 7 'DMA_PROTECTION' 'Kernel DMA protection available' 3 'SKIP' 'DMA protection availability was unavailable.'))
} elseif ($secProps -contains 3) {
    $sys.dmaProtectionAvailable = $true
    [void]$checks.Add((New-Check 7 'DMA_PROTECTION' 'Kernel DMA protection available' 3 'PASS' 'Platform reports DMA protection available (availability, not per-device enforcement).'))
} else {
    $sys.dmaProtectionAvailable = $false
    [void]$checks.Add((New-Check 7 'DMA_PROTECTION' 'Kernel DMA protection available' 3 'WARN' 'Platform does not report DMA protection as available.'))
}

# --- 8. VIRTUALIZATION_FW -------------------------------------------------
$hyperv = $null
if ($cs -and $cs.HypervisorPresent -ne $null) { $hyperv = [bool]$cs.HypervisorPresent }
$virtFw = $null
if ($cpu -and $cpu.Count -gt 0 -and $cpu[0].VirtualizationFirmwareEnabled -ne $null) {
    $virtFw = [bool]$cpu[0].VirtualizationFirmwareEnabled
}
$sys.hypervisorPresent = $hyperv

if ($hyperv -eq $null -and $virtFw -eq $null) {
    [void]$checks.Add((New-Check 8 'VIRTUALIZATION_FW' 'Virtualization enabled in firmware' 1 'SKIP' 'Virtualization firmware state could not be read.'))
} elseif ($hyperv -eq $true -or $virtFw -eq $true) {
    $d = 'Hardware virtualization is enabled.'
    if ($hyperv -eq $true) { $d = 'Hardware virtualization is enabled (a hypervisor is present).' }
    [void]$checks.Add((New-Check 8 'VIRTUALIZATION_FW' 'Virtualization enabled in firmware' 1 'PASS' $d))
} else {
    [void]$checks.Add((New-Check 8 'VIRTUALIZATION_FW' 'Virtualization enabled in firmware' 1 'WARN' 'Hardware virtualization appears to be disabled in firmware.'))
}

# --- 9. NOT_VIRTUAL_MACHINE ----------------------------------------------
$vmPattern = 'VMware|VirtualBox|innotek|QEMU|KVM|Xen|Parallels|Virtual Machine|Hyper-V'
$bios  = Try-Cim -Class 'Win32_BIOS'
$board = Try-Cim -Class 'Win32_BaseBoard'
$idStrings = @()
if ($cs)    { $idStrings += @([string]$cs.Manufacturer, [string]$cs.Model) }
if ($bios)  { $idStrings += @([string]$bios.Manufacturer, [string]$bios.Version, [string]$bios.SMBIOSBIOSVersion) }
if ($board) { $idStrings += @([string]$board.Manufacturer, [string]$board.Product) }
$idStrings = @($idStrings | Where-Object { $_ -and $_.Trim() -ne '' })

if ($idStrings.Count -eq 0) {
    [void]$checks.Add((New-Check 9 'NOT_VIRTUAL_MACHINE' 'Not a virtual machine' 3 'SKIP' 'Platform identification strings could not be read.'))
} else {
    $hit = $null
    foreach ($s in $idStrings) {
        if ($s -match $vmPattern) { $hit = $Matches[0]; break }
    }
    if ($hit) {
        [void]$checks.Add((New-Check 9 'NOT_VIRTUAL_MACHINE' 'Not a virtual machine' 3 'FAIL' "Virtual platform detected ($hit)."))
    } else {
        [void]$checks.Add((New-Check 9 'NOT_VIRTUAL_MACHINE' 'Not a virtual machine' 3 'PASS' 'Physical hardware - no virtual platform signature found.'))
    }
}

# --- 10. TEST_SIGNING -----------------------------------------------------
if (-not $elevated) {
    [void]$checks.Add((New-Check 10 'TEST_SIGNING' 'Test signing / integrity checks off' 1 'SKIP' 'Requires administrator rights - re-run elevated for full coverage.'))
} else {
    $bcdOut = $null
    try {
        $exe = Join-Path $env:SystemRoot 'System32\bcdedit.exe'
        $bcdOut = (& $exe '/enum' '{current}' 2>&1 | Out-String)
    } catch {
        $bcdOut = $null
    }
    if (-not $bcdOut) {
        [void]$checks.Add((New-Check 10 'TEST_SIGNING' 'Test signing / integrity checks off' 1 'SKIP' 'Boot configuration could not be read.'))
    } else {
        $ts = ($bcdOut -match '(?im)^\s*testsigning\s+Yes')
        $ni = ($bcdOut -match '(?im)^\s*nointegritychecks\s+Yes')
        if ($ts -or $ni) {
            $which = @()
            if ($ts) { $which += 'testsigning' }
            if ($ni) { $which += 'nointegritychecks' }
            [void]$checks.Add((New-Check 10 'TEST_SIGNING' 'Test signing / integrity checks off' 1 'FAIL' ('Boot configuration has ' + ($which -join ' and ') + ' enabled.')))
        } else {
            [void]$checks.Add((New-Check 10 'TEST_SIGNING' 'Test signing / integrity checks off' 1 'PASS' 'Test signing and integrity-check bypass are both off.'))
        }
    }
}

# --- 11. THIRD_PARTY_DRIVERS ---------------------------------------------
# Count only. Driver names are never recorded or reported.
$drvCount = $null
$drivers = Try-Cim -Class 'Win32_SystemDriver' -Filter "State='Running'"
if ($drivers) {
    $n = 0
    foreach ($d in @($drivers)) {
        $p = [string]$d.PathName
        if (-not $p) { continue }
        $p = $p.ToLowerInvariant()
        $p = $p -replace '^\\\?\?\\', ''
        $p = $p -replace '^\\systemroot', ($env:SystemRoot.ToLowerInvariant())
        $p = $p -replace '^system32', ($env:SystemRoot.ToLowerInvariant() + '\system32')
        if ($p -notmatch '\\windows\\') { $n++ }
    }
    $drvCount = $n
}
if ($drvCount -eq $null) {
    [void]$checks.Add((New-Check 11 'THIRD_PARTY_DRIVERS' 'Third-party kernel drivers' 1 'SKIP' 'The running driver list could not be enumerated.'))
} else {
    $sys.thirdPartyDriverCount = $drvCount
    if ($drvCount -le 5) {
        [void]$checks.Add((New-Check 11 'THIRD_PARTY_DRIVERS' 'Third-party kernel drivers' 1 'PASS' "$drvCount third-party kernel driver(s) running."))
    } else {
        [void]$checks.Add((New-Check 11 'THIRD_PARTY_DRIVERS' 'Third-party kernel drivers' 1 'WARN' "$drvCount third-party kernel drivers running - each one is extra kernel attack surface."))
    }
}

# --- 12. DISK_FREE --------------------------------------------------------
$freeGB = $null
$sysDrive = $env:SystemDrive
if (-not $sysDrive) { $sysDrive = 'C:' }
$disk = Try-Cim -Class 'Win32_LogicalDisk' -Filter ("DeviceID='" + $sysDrive + "'")
if ($disk) {
    $d0 = @($disk)[0]
    if ($d0.FreeSpace -ne $null) {
        $freeGB = [Math]::Round(([double]$d0.FreeSpace / 1GB), 1)
    }
}
if ($freeGB -eq $null) {
    [void]$checks.Add((New-Check 12 'DISK_FREE' 'Free disk space' $null 'SKIP' 'System drive free space could not be read.'))
} else {
    $sys.freeDiskGB = $freeGB
    if ($freeGB -ge 2) {
        [void]$checks.Add((New-Check 12 'DISK_FREE' 'Free disk space' $null 'PASS' "$freeGB GB free on $sysDrive"))
    } elseif ($freeGB -ge 0.5) {
        [void]$checks.Add((New-Check 12 'DISK_FREE' 'Free disk space' $null 'WARN' "$freeGB GB free on $sysDrive - low."))
    } else {
        [void]$checks.Add((New-Check 12 'DISK_FREE' 'Free disk space' $null 'FAIL' "$freeGB GB free on $sysDrive - too low for signature staging."))
    }
}

# --- 13. RAM --------------------------------------------------------------
$ramGB = $null
if ($cs -and $cs.TotalPhysicalMemory -ne $null) {
    $ramGB = [Math]::Round(([double]$cs.TotalPhysicalMemory / 1GB), 1)
} elseif ($os -and $os.TotalVisibleMemorySize -ne $null) {
    $ramGB = [Math]::Round(([double]$os.TotalVisibleMemorySize / 1MB), 1)
}
if ($ramGB -eq $null) {
    [void]$checks.Add((New-Check 13 'RAM' 'Installed memory' $null 'SKIP' 'Installed memory could not be read.'))
} else {
    $sys.ramGB = $ramGB
    if ($ramGB -ge 8) {
        [void]$checks.Add((New-Check 13 'RAM' 'Installed memory' $null 'PASS' "$ramGB GB installed."))
    } elseif ($ramGB -ge 4) {
        [void]$checks.Add((New-Check 13 'RAM' 'Installed memory' $null 'WARN' "$ramGB GB installed - 8 GB or more recommended."))
    } else {
        [void]$checks.Add((New-Check 13 'RAM' 'Installed memory' $null 'FAIL' "$ramGB GB installed - below the supported floor."))
    }
}

# ---------------------------------------------------------------------------
# Verdict, buckets, code
# ---------------------------------------------------------------------------

$ordered  = @($checks | Sort-Object index)
$statuses = @()
foreach ($c in $ordered) { $statuses += [string]$c.status }

$verdict = 'READY'
if ($statuses -contains 'FAIL') { $verdict = 'NOT_READY' }
elseif ($statuses -contains 'WARN') { $verdict = 'READY_WITH_WARNINGS' }

$ramBucket = 0
if ($ramGB -ne $null) {
    if     ($ramGB -ge 64) { $ramBucket = 8 }
    elseif ($ramGB -ge 32) { $ramBucket = 7 }
    elseif ($ramGB -ge 24) { $ramBucket = 6 }
    elseif ($ramGB -ge 16) { $ramBucket = 5 }
    elseif ($ramGB -ge 12) { $ramBucket = 4 }
    elseif ($ramGB -ge 8)  { $ramBucket = 3 }
    elseif ($ramGB -ge 4)  { $ramBucket = 2 }
    else                   { $ramBucket = 1 }
}

$diskBucket = 0
if ($freeGB -ne $null) {
    if     ($freeGB -ge 50)  { $diskBucket = 5 }
    elseif ($freeGB -ge 10)  { $diskBucket = 4 }
    elseif ($freeGB -ge 2)   { $diskBucket = 3 }
    elseif ($freeGB -ge 0.5) { $diskBucket = 2 }
    else                     { $diskBucket = 1 }
}

$driverField = 0
if ($drvCount -ne $null) { $driverField = [Math]::Min(15, [int]$drvCount) }

$code = Get-ReadinessCode -Statuses $statuses -RamBucket $ramBucket -DiskBucket $diskBucket `
                          -DriverCount $driverField -TpmCode $tpmCode -OsClass ([int]$sys.osClass)

$report = [ordered]@{
    schema        = 'cerberus-readiness-report/1'
    tool          = [ordered]@{ name = $ToolName; version = $ToolVersion }
    generatedAt   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    elevated      = [bool]$elevated
    verdict       = $verdict
    readinessCode = $code
    system        = $sys
    checks        = $ordered
}

$reportPath = $null
if (-not $NoReport) {
    try {
        $dir = $OutDir
        if (-not $dir) { $dir = (Get-Location).Path }
        if (-not (Test-Path -LiteralPath $dir)) {
            [void](New-Item -ItemType Directory -Path $dir -Force -ErrorAction Stop)
        }
        $reportPath = Join-Path $dir 'cerberus-readiness-report.json'
        $reportJson = ($report | ConvertTo-Json -Depth 6)
        # UTF-8 with no byte order mark: Set-Content -Encoding UTF8 emits a BOM
        # on Windows PowerShell 5.1, and a leading BOM makes the file fail
        # strict JSON parsers.
        $utf8NoBom = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
        [System.IO.File]::WriteAllText($reportPath, $reportJson, $utf8NoBom)
    } catch {
        $reportPath = $null
    }
}

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

if ($Json) {
    ($report | ConvertTo-Json -Depth 6)
} else {

    function Write-Line {
        param([string]$Text, [string]$Color)
        if ($NoColor -or -not $Color) { Write-Host $Text }
        else { Write-Host $Text -ForegroundColor $Color }
    }
    function Write-Part {
        param([string]$Text, [string]$Color)
        if ($NoColor -or -not $Color) { Write-Host $Text -NoNewline }
        else { Write-Host $Text -NoNewline -ForegroundColor $Color }
    }

    $statusColor = @{ 'PASS' = 'Green'; 'WARN' = 'Yellow'; 'FAIL' = 'Red'; 'SKIP' = 'DarkGray' }

    Write-Host ''
    Write-Line ('  CERBERUS READINESS CHECK  ' + $ToolVersion) 'Cyan'
    Write-Line '  Local only: nothing is sent anywhere, no telemetry, nothing installed.' 'DarkGray'
    Write-Line '  No machine name, user name, serial number, address or driver name is collected.' 'DarkGray'
    Write-Host ''

    $osLine = $sys.osCaption
    if (-not $osLine) { $osLine = 'Windows' }
    if ($sys.osBuild) { $osLine = "$osLine (build $($sys.osBuild))" }
    $elevText = 'standard user'
    if ($elevated) { $elevText = 'administrator' }
    Write-Line ("  $osLine - running as $elevText") 'Gray'
    Write-Host ''

    $sep = '  ' + ('-' * 96)
    Write-Line ('  {0,-3} {1,-38} {2,-6} {3}' -f '#', 'CHECK', 'STATUS', 'DETAIL') 'White'
    Write-Line $sep 'DarkGray'

    # Trim on a word boundary so a clipped line does not end mid-word; the full
    # text is always in the JSON report and in the guidance block below.
    function Clip([string]$text, [int]$width) {
        if ($text.Length -le $width) { return $text }
        $cut = $text.Substring(0, $width - 3)
        $sp = $cut.LastIndexOf(' ')
        if ($sp -gt [int]($width * 0.5)) { $cut = $cut.Substring(0, $sp) }
        return $cut.TrimEnd(' ', ',', ';', ':', '-', '.') + '...'
    }

    foreach ($c in $ordered) {
        $lbl = Clip ([string]$c.label) 38
        $det = Clip ([string]$c.detail) 47
        Write-Part ('  {0,-3} {1,-38} ' -f $c.index, $lbl) 'Gray'
        Write-Part ('{0,-6} ' -f $c.status) $statusColor[[string]$c.status]
        Write-Line $det 'DarkGray'
    }
    Write-Line $sep 'DarkGray'
    Write-Host ''

    $vColor = 'Green'
    $vText  = 'READY - this PC meets every requirement.'
    if ($verdict -eq 'READY_WITH_WARNINGS') {
        $vColor = 'Yellow'
        $vText  = 'READY WITH WARNINGS - playable, but some layers run degraded.'
    } elseif ($verdict -eq 'NOT_READY') {
        $vColor = 'Red'
        $vText  = 'NOT READY - at least one requirement is not met.'
    }
    Write-Line ('  VERDICT: ' + $vText) $vColor
    Write-Host ''

    $actionable = @($ordered | Where-Object { $_.status -eq 'FAIL' -or $_.status -eq 'WARN' })
    if ($actionable.Count -gt 0) {
        Write-Line '  What to do:' 'White'
        foreach ($c in $actionable) {
            Write-Part ('   [' + $c.status + '] ') $statusColor[[string]$c.status]
            Write-Line ($c.label + ' - ' + $c.guidance) 'Gray'
        }
        Write-Host ''
    }

    if (-not $elevated) {
        Write-Line '  Some checks need administrator rights. Re-run as administrator for full coverage' 'DarkGray'
        Write-Line '  (this does not change the verdict - skipped checks never count against you).' 'DarkGray'
        Write-Host ''
    }

    Write-Part '  Readiness code: ' 'White'
    Write-Line $code 'Cyan'
    Write-Line ('  Decode: ' + $DecodeUrl + '#code=' + $code) 'DarkGray'
    if ($reportPath) {
        Write-Line ('  JSON report: ' + $reportPath) 'DarkGray'
    }
    Write-Host ''
}

if ($verdict -eq 'READY') { $script:ExitCode = 0 }
elseif ($verdict -eq 'READY_WITH_WARNINGS') { $script:ExitCode = 1 }
else { $script:ExitCode = 2 }

} catch {
    if ($Json) {
        (@{ schema = 'cerberus-readiness-report/1'; error = [string]$_.Exception.Message } | ConvertTo-Json)
    } else {
        Write-Host ''
        Write-Host ('  Cerberus Readiness Check failed: ' + $_.Exception.Message) -ForegroundColor Red
        Write-Host ''
    }
    $script:ExitCode = 3
}

exit $script:ExitCode
