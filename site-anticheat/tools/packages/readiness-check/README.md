# Cerberus Readiness Check 1.0.0

A single PowerShell script that tells you whether this PC can run a title
protected by the Cerberus anti-cheat engine — and, where it can't, exactly what
to change.

No account. No installer. No network access. It takes about ten seconds.

---

## How to run it

**The easy way** — unblock the folder first, then double-click:

1. Right-click the downloaded `.zip` → **Properties** → tick **Unblock** → OK.
2. Extract it anywhere (Desktop is fine).
3. Double-click **`Run-ReadinessCheck.cmd`**.

**From PowerShell:**

```powershell
cd path\to\cerberus-readiness-check-1.0.0
powershell -NoProfile -ExecutionPolicy Bypass -File .\Cerberus-ReadinessCheck.ps1
```

**For full coverage**, run it as administrator. Two checks (boot configuration
and the TPM readiness state) can only be read with administrator rights, and are
reported as `SKIP` otherwise. Skipped checks never count against your verdict —
running as a standard user gives you a correct result, just a slightly less
complete one.

### Options

| Option | Effect |
|---|---|
| `-Json` | Print only the JSON report to standard output. Nothing else is written to the console. |
| `-NoReport` | Do not write `cerberus-readiness-report.json`. |
| `-NoColor` | Plain console output, no colours (useful for logs and CI). |
| `-OutDir <path>` | Where to write the JSON report. Defaults to the current directory. |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | `READY` — every check passed. |
| `1` | `READY_WITH_WARNINGS` — playable, but one or more layers run degraded. |
| `2` | `NOT_READY` — at least one requirement is not met. |
| `3` | The script itself failed (an unexpected error; the message is printed). |

---

## What it checks

Fourteen checks, in a fixed order. The order matters: it is part of the
readiness code.

| # | Check | Layer | Why it matters |
|---|---|---|---|
| 0 | Windows version | 1 | The kernel driver is built and tested against Windows 10 21H2 (build 19044) and later, and Windows 11. |
| 1 | 64-bit x64 processor | 1 | Cerberus ships x64 binaries only. |
| 2 | Secure Boot enabled | 3 | Boot-chain attestation needs a root of trust to measure against. |
| 3 | TPM present | 3 | Gives device identity a hardware root instead of software-readable strings. |
| 4 | TPM 2.0 | 3 | Attestation uses TPM 2.0 quote and PCR semantics. A 1.2 module downgrades to the software fingerprint. |
| 5 | Virtualization-based security running | 1 | Hypervisor-assisted memory isolation for protected structures. |
| 6 | Memory integrity (HVCI) | 1 | The most effective defence against bring-your-own-vulnerable-driver attacks. |
| 7 | Kernel DMA protection available | 3 | IOMMU-backed protection is what makes DMA cheat hardware visible. |
| 8 | Virtualization enabled in firmware | 1 | Everything hypervisor-assisted depends on VT-x / AMD-V being on. |
| 9 | Not a virtual machine | 3 | The hardware layer measures real PCIe topology; a VM has nothing real to measure. |
| 10 | Test signing / integrity checks off | 1 | With these on, Windows loads any self-signed driver. |
| 11 | Third-party kernel drivers | 1 | A count only — never names. Each running third-party driver is extra kernel attack surface. |
| 12 | Free disk space | — | Signature staging and the session journal need room on the system drive. |
| 13 | Installed memory | — | Under 4 GB the behavioural layer reduces its sampling window. |

Layer numbers refer to the Cerberus detection layers: Layer 1 is kernel
integrity, Layer 3 is hardware fingerprinting. Checks 12 and 13 are runtime
resources rather than a detection layer.

**Verdict rule:** any `FAIL` → `NOT_READY`; otherwise any `WARN` →
`READY_WITH_WARNINGS`; otherwise `READY`. A `SKIP` never affects the verdict.

Full requirement notes: <https://cerberusac.dev/docs/#requirements>

---

## Privacy

This script is offline by design, and you should not have to take that on faith.

**What it reads:** the Windows version keys under
`HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion`, the Secure Boot state key,
the Plug and Play security-device list, the Device Guard information class
(VBS / HVCI / DMA protection availability), processor and platform identification
strings, the running kernel driver list, system drive free space and installed
memory. When run elevated it additionally reads the boot configuration and the
TPM readiness state.

**What it does not do:** it does not open a connection of any kind, download
anything, install anything, launch another program, modify any setting, or write
anywhere except the JSON report file you asked for.

**What the report contains:** version and build numbers, coarse buckets for RAM
and disk, a *count* of third-party kernel drivers, and the fourteen check
results. It contains **no** machine name, user name, serial number, hardware ID,
network address, or driver name.

### Verify that for yourself

The script is plain text — read it. If you would rather have a one-liner, this
searches it for every network-capable construct in Windows PowerShell and should
print **nothing at all**:

```powershell
Select-String -Path .\Cerberus-ReadinessCheck.ps1 -Pattern 'Invoke-WebRequest|Invoke-RestMethod|System\.Net|WebClient|HttpClient|Sockets|Start-Process|ComputerName|Test-Connection'
```

The same pattern is enforced by our release build: a package that matches it
never gets published.

---

## The readiness code

Every run ends with a code like `CRC1-XXXX-XXXX-XXXX`. It packs the fourteen
check results plus coarse RAM, disk, driver-count, TPM and Windows-version
buckets into twelve characters. That is the whole content — there is nothing
else in it, and it is not an identifier: two identical PCs produce identical
codes.

Paste it into <https://cerberusac.dev/readiness/> to see the same table, with
fix-it steps, in your browser. Decoding happens entirely in the page; the code is
never uploaded. It is also the fastest way to give a studio's support team a
readable picture of your machine without sending them a log.

### Test vector

<!-- test-vector -->
A run where all fourteen checks pass on a machine with 32-63 GB RAM, 50 GB or more free on the system drive, 3 third-party kernel drivers, TPM 2.0 and Windows 11 24H2 or later encodes to:

```
CRC1-2000-003T-EM17
```
<!-- /test-vector -->

---

## Support

- Requirements and troubleshooting: <https://cerberusac.dev/docs/#requirements>
- Decode a code: <https://cerberusac.dev/readiness/>
- Ban appeals: <https://cerberusac.dev/appeal/>
- Downloads and checksums: <https://cerberusac.dev/downloads/>

Licence: see `LICENSE.txt`.
