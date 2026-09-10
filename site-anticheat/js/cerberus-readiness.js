/*!
 * cerberus-readiness.js — Readiness Code encoder/decoder (CRC1)
 *
 * Shared contract between the Cerberus Readiness Check PowerShell tool
 * (tools/packages/readiness-check/Cerberus-ReadinessCheck.ps1) and the
 * /readiness/ decode widget. The PowerShell encoder and this decoder MUST
 * stay bit-for-bit identical — tools/test-readiness-code.js enforces that.
 *
 * Code layout — 60 bits, MSB first, rendered as 12 Crockford base32 symbols
 * in the form CRC1-XXXX-XXXX-XXXX:
 *
 *   bits 59..56  version (1)
 *   bits 55..28  fourteen 2-bit statuses (00 PASS, 01 WARN, 10 FAIL, 11 SKIP)
 *                check 0 occupies the top pair (bits 55..54)
 *   bits 27..24  RAM bucket
 *   bits 23..21  disk bucket
 *   bits 20..17  third-party driver count, clamped 0..15
 *   bits 16..15  TPM (0 none/unknown, 1 = 1.2, 2 = 2.0)
 *   bits 14..12  OS class
 *   bits 11..8   reserved (0)
 *   bits  7..0   checksum over the 13 nibbles of bits 59..8
 *
 * No network access, no telemetry: the code is decoded entirely in the page.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CerberusReadiness = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 1;
  var ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  var PREFIX = 'CRC1';
  var STATUS_NAMES = ['PASS', 'WARN', 'FAIL', 'SKIP'];

  var CHECKS = [
    {
      index: 0,
      id: 'OS_VERSION',
      label: 'Windows version',
      layer: 1,
      why: 'The kernel layer loads a signed driver that is only built and tested against Windows 10 21H2 (build 19044) and later, and Windows 11. Older builds are missing the code-integrity primitives the driver relies on.',
      guidance: {
        WARN: 'Windows Server SKUs are not a supported player platform. Cerberus runs, but the kernel layer is unvalidated there — use a Windows 10 21H2+ or Windows 11 client build for evaluation.',
        FAIL: 'Update Windows to build 19044 (21H2) or later: Settings → Windows Update → Check for updates. If the machine is stuck on an older feature update, use the Windows Update Assistant from Microsoft.',
        SKIP: 'The build number could not be read from the registry. This usually means a hardened or heavily locked-down image; check winver manually.'
      }
    },
    {
      index: 1,
      id: 'ARCH_X64',
      label: '64-bit x64 processor',
      layer: 1,
      why: 'Cerberus ships x64 binaries only. The kernel driver, the behavioural model runtime and the SDK are all built for AMD64.',
      guidance: {
        WARN: '',
        FAIL: 'ARM64 and 32-bit Windows are not supported. An x64 emulation layer does not help — the kernel driver cannot load. Evaluate on an x64 machine.',
        SKIP: 'The processor architecture could not be determined.'
      }
    },
    {
      index: 2,
      id: 'SECURE_BOOT',
      label: 'Secure Boot enabled',
      layer: 3,
      why: 'Boot-chain attestation compares the measured boot path against a known-good chain. Without Secure Boot there is no root of trust, so an attacker can load an unsigned bootkit before Cerberus ever starts.',
      guidance: {
        WARN: '',
        FAIL: 'Enter firmware setup (usually Del, F2, F10 or F12 during boot, or Settings → System → Recovery → Advanced startup → UEFI Firmware Settings). Set the boot mode to UEFI, disable CSM / Legacy Boot, then enable Secure Boot and save. If Windows was installed in legacy BIOS mode the disk must be converted from MBR to GPT first (mbr2gpt) — back up before converting.',
        SKIP: 'The Secure Boot state key is absent. On most machines that means a legacy BIOS install rather than a UEFI one; check the firmware setup screen.'
      }
    },
    {
      index: 3,
      id: 'TPM_PRESENT',
      label: 'TPM present',
      layer: 3,
      why: 'The hardware layer binds a session to a stable, attestable device identity. A TPM gives that identity a hardware root instead of a set of software-readable strings a spoofer can rewrite.',
      guidance: {
        WARN: 'A TPM is present but is not reporting ready. Open tpm.msc and clear/initialise it, or enable and re-provision the firmware TPM in firmware setup. Clearing a TPM can invalidate BitLocker keys — suspend BitLocker first.',
        FAIL: 'Enable the firmware TPM in firmware setup: Intel platforms call it PTT (Platform Trust Technology), AMD platforms call it fTPM or "AMD firmware TPM". On desktops with a header, a discrete TPM module also works. TPM is optional for evaluation but required for full hardware attestation.',
        SKIP: 'No TPM source could be queried on this machine.'
      }
    },
    {
      index: 4,
      id: 'TPM_20',
      label: 'TPM 2.0',
      layer: 3,
      why: 'Attestation uses TPM 2.0 quote and PCR semantics. A 1.2 module cannot produce the attestation blob the hardware layer verifies.',
      guidance: {
        WARN: 'This machine reports TPM 1.2. Hardware attestation is skipped and the session falls back to the software fingerprint. Some platforms can switch the firmware TPM to 2.0 in firmware setup; otherwise this is a hardware limit and is not a blocker for evaluation.',
        FAIL: '',
        SKIP: 'The TPM specification version is unknown because no TPM was detected.'
      }
    },
    {
      index: 5,
      id: 'VBS_RUNNING',
      label: 'Virtualization-based security running',
      layer: 1,
      why: 'The kernel layer uses hypervisor-assisted memory isolation. With VBS running, protected structures live behind an EPT boundary that a ring-0 cheat cannot quietly rewrite.',
      guidance: {
        WARN: 'VBS is enabled but not running (or is disabled). Open Windows Security → Device security → Core isolation and turn on Memory integrity, then reboot. VBS also needs virtualization enabled in firmware (Intel VT-x / AMD-V).',
        FAIL: '',
        SKIP: 'The Device Guard WMI class could not be queried on this machine.'
      }
    },
    {
      index: 6,
      id: 'HVCI',
      label: 'Memory integrity (HVCI)',
      layer: 1,
      why: 'Hypervisor-enforced code integrity is the single most effective defence against BYOVD — bring-your-own-vulnerable-driver — attacks, which are the most common route to ring-0 for modern cheats.',
      guidance: {
        WARN: 'Turn on Windows Security → Device security → Core isolation → Memory integrity and reboot. If the toggle is greyed out, Windows names the incompatible driver in that panel; update or remove it (often an old audio, RGB or overlay driver) and try again.',
        FAIL: '',
        SKIP: 'Code-integrity state could not be read.'
      }
    },
    {
      index: 7,
      id: 'DMA_PROTECTION',
      label: 'Kernel DMA protection available',
      layer: 3,
      why: 'DMA attack hardware reads game memory over PCIe without any code running on the machine. IOMMU-backed DMA protection is what makes that traffic visible and blockable.',
      guidance: {
        WARN: 'Kernel DMA protection is not reported as available. Enable VT-d (Intel) or AMD-Vi / IOMMU in firmware setup, and make sure the platform is booting in UEFI mode with Secure Boot on. Older boards without IOMMU support cannot provide this. This reports platform availability, not per-device enforcement.',
        FAIL: '',
        SKIP: 'DMA protection availability could not be read.'
      }
    },
    {
      index: 8,
      id: 'VIRTUALIZATION_FW',
      label: 'Virtualization enabled in firmware',
      layer: 1,
      why: 'Everything hypervisor-assisted — VBS, memory integrity, EPT shadow scanning — depends on hardware virtualization being switched on in firmware.',
      guidance: {
        WARN: 'Enable Intel VT-x ("Intel Virtualization Technology") or AMD-V ("SVM Mode") in firmware setup. It is often on a CPU or Advanced page and is off by default on some OEM boards.',
        FAIL: '',
        SKIP: 'Virtualization firmware state could not be read.'
      }
    },
    {
      index: 9,
      id: 'NOT_VIRTUAL_MACHINE',
      label: 'Not a virtual machine',
      layer: 3,
      why: 'The hardware layer measures real PCIe topology, IOMMU behaviour and DMA timing. A virtual machine presents synthetic hardware, so those measurements are meaningless and the layer cannot run.',
      guidance: {
        WARN: '',
        FAIL: 'Virtual machines are not a supported player environment: the hardware layer has nothing real to measure and the kernel layer refuses to attest. Run the check on physical hardware. This is expected inside VMware, VirtualBox, Hyper-V, QEMU/KVM, Xen or Parallels.',
        SKIP: 'Platform identification strings could not be read.'
      }
    },
    {
      index: 10,
      id: 'TEST_SIGNING',
      label: 'Test signing / integrity checks off',
      layer: 1,
      why: 'With test signing or integrity checks disabled, Windows will load any self-signed driver. That is a wide-open door to ring-0 and the kernel layer treats it as an untrusted boot configuration.',
      guidance: {
        WARN: '',
        FAIL: 'Open an elevated Command Prompt and run: bcdedit /set testsigning off  and  bcdedit /set nointegritychecks off  then reboot. Both must be off for the kernel layer to attest.',
        SKIP: 'Boot configuration can only be read with administrator rights. Re-run the check as administrator for full coverage — this does not affect the verdict.'
      }
    },
    {
      index: 11,
      id: 'THIRD_PARTY_DRIVERS',
      label: 'Third-party kernel drivers',
      layer: 1,
      why: 'Every running third-party kernel driver widens the surface the kernel layer has to reason about, and unsigned or outdated ones are the usual BYOVD candidates. This is a count only — no driver names are collected.',
      guidance: {
        WARN: 'More than five third-party kernel drivers are running. That is common on gaming machines (RGB suites, overlays, virtual audio, controller stacks) and is not a blocker, but each one is extra attack surface. Remove software you no longer use and keep the rest updated.',
        FAIL: '',
        SKIP: 'The running driver list could not be enumerated.'
      }
    },
    {
      index: 12,
      id: 'DISK_FREE',
      label: 'Free disk space',
      layer: null,
      why: 'Signature sets, the local session journal and crash artefacts are written to the system drive. Under half a gigabyte the runtime cannot stage a signature update.',
      guidance: {
        WARN: 'Under 2 GB free on the system drive. Free some space before installing a protected title — Settings → System → Storage → Cleanup recommendations is the quickest route.',
        FAIL: 'Under 500 MB free on the system drive. Signature updates and the session journal will fail. Free at least 2 GB.',
        SKIP: 'System drive free space could not be read.'
      }
    },
    {
      index: 13,
      id: 'RAM',
      label: 'Installed memory',
      layer: null,
      why: 'The behavioural layer keeps a rolling window of input telemetry in memory alongside the game. Under 4 GB total, sampling is reduced and detection quality drops.',
      guidance: {
        WARN: 'Between 4 and 8 GB installed. Cerberus runs, but the behavioural layer reduces its sampling window on memory-constrained machines. 8 GB or more is recommended.',
        FAIL: 'Under 4 GB installed. This is below the supported floor for any protected title.',
        SKIP: 'Installed memory could not be read.'
      }
    }
  ];

  var RAM_BUCKETS = [
    'unknown', 'under 4 GB', '4-7 GB', '8-11 GB', '12-15 GB',
    '16-23 GB', '24-31 GB', '32-63 GB', '64 GB or more'
  ];
  var DISK_BUCKETS = [
    'unknown', 'under 0.5 GB', '0.5-2 GB', '2-10 GB', '10-50 GB', '50 GB or more'
  ];
  var TPM_LABELS = ['none or unknown', 'TPM 1.2', 'TPM 2.0'];
  var OS_CLASSES = [
    'unknown',
    'Windows 10 (below build 19044)',
    'Windows 10 21H2/22H2',
    'Windows 11 21H2 (22000)',
    'Windows 11 22H2/23H2',
    'Windows 11 24H2 or later',
    'Windows Server'
  ];

  function clampInt(value, lo, hi) {
    var n = Math.floor(Number(value));
    if (!isFinite(n)) { n = 0; }
    if (n < lo) { n = lo; }
    if (n > hi) { n = hi; }
    return n;
  }

  function statusToCode(status) {
    if (typeof status === 'number') { return clampInt(status, 0, 3); }
    var idx = STATUS_NAMES.indexOf(String(status || '').toUpperCase());
    return idx < 0 ? 3 : idx;
  }

  /* Checksum over the 13 nibbles N[0..12] carrying bits 59..8. */
  function checksum(nibbles) {
    var chk = 0x1F;
    for (var i = 0; i < nibbles.length; i++) {
      chk = (((chk ^ (nibbles[i] & 0x0F)) * 31) + i) & 0xFF;
    }
    return chk;
  }

  function pushBits(bits, value, width) {
    for (var i = width - 1; i >= 0; i--) {
      bits.push((Math.floor(value / Math.pow(2, i))) & 1);
    }
  }

  function bitsToNibbles(bits, start, count) {
    var out = [];
    for (var n = 0; n < count; n++) {
      var v = 0;
      for (var i = 0; i < 4; i++) {
        v = (v * 2) + bits[start + (n * 4) + i];
      }
      out.push(v);
    }
    return out;
  }

  /**
   * encode({statuses, ramBucket, diskBucket, driverCount, tpm, osClass})
   * statuses: 14 entries, each 'PASS'|'WARN'|'FAIL'|'SKIP' or 0..3.
   */
  function encode(fields) {
    fields = fields || {};
    var statuses = fields.statuses || fields.status || [];
    var bits = [];

    pushBits(bits, VERSION, 4);
    for (var i = 0; i < 14; i++) {
      pushBits(bits, statusToCode(statuses[i]), 2);
    }
    pushBits(bits, clampInt(fields.ramBucket, 0, 15), 4);
    pushBits(bits, clampInt(fields.diskBucket, 0, 7), 3);
    pushBits(bits, clampInt(fields.driverCount, 0, 15), 4);
    pushBits(bits, clampInt(fields.tpm, 0, 3), 2);
    pushBits(bits, clampInt(fields.osClass, 0, 7), 3);
    pushBits(bits, 0, 4);

    var chk = checksum(bitsToNibbles(bits, 0, 13));
    pushBits(bits, chk, 8);

    var out = '';
    for (var s = 0; s < 12; s++) {
      var v = 0;
      for (var b = 0; b < 5; b++) {
        v = (v * 2) + bits[(s * 5) + b];
      }
      out += ALPHABET.charAt(v);
    }
    return PREFIX + '-' + out.slice(0, 4) + '-' + out.slice(4, 8) + '-' + out.slice(8, 12);
  }

  /** Uppercase, strip separators and the CRC1 prefix, fold O->0 and I/L->1. */
  function normalize(code) {
    var s = String(code == null ? '' : code).toUpperCase();
    s = s.replace(/[\s\-_.]/g, '');
    /* Strip the literal CRC1 prefix. A full code is 16 characters once the
     * separators are gone; at exactly 12 the string is already a bare body
     * (whose first four symbols could legitimately spell CRC1), so leave it. */
    if (s.length !== 12 && s.slice(0, 4) === PREFIX) {
      s = s.slice(4);
    }
    s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
    return s;
  }

  /* `reason` is an alias of `message` — the /readiness/ decode widget reads
   * res.reason, the build tooling reads res.message. Keep both. */
  function fail(error, message) {
    return { ok: false, valid: false, error: error, message: message, reason: message };
  }

  function decode(code) {
    var s = normalize(code);
    if (!s) { return fail('EMPTY', 'Enter a readiness code.'); }
    if (s.length !== 12) {
      return fail('LENGTH', 'A readiness code has 12 symbols after the CRC1 prefix — this one has ' + s.length + '.');
    }

    var bits = [];
    for (var i = 0; i < 12; i++) {
      var v = ALPHABET.indexOf(s.charAt(i));
      if (v < 0) {
        return fail('SYMBOL', 'Unexpected character "' + s.charAt(i) + '" in the readiness code.');
      }
      pushBits(bits, v, 5);
    }

    var version = 0;
    for (var b = 0; b < 4; b++) { version = (version * 2) + bits[b]; }
    if (version !== VERSION) {
      return fail('VERSION', 'This code was produced by a different version of the Readiness Check (format v' + version + ').');
    }

    var stored = 0;
    for (var c = 52; c < 60; c++) { stored = (stored * 2) + bits[c]; }
    var expected = checksum(bitsToNibbles(bits, 0, 13));
    if (stored !== expected) {
      return fail('CHECKSUM', 'Checksum mismatch — the code looks mistyped. Copy it straight from the console or the JSON report.');
    }

    function take(start, width) {
      var v = 0;
      for (var k = 0; k < width; k++) { v = (v * 2) + bits[start + k]; }
      return v;
    }

    var checks = [];
    var anyFail = false;
    var anyWarn = false;
    for (var n = 0; n < 14; n++) {
      var code2 = take(4 + (n * 2), 2);
      var status = STATUS_NAMES[code2];
      if (status === 'FAIL') { anyFail = true; }
      if (status === 'WARN') { anyWarn = true; }
      var meta = CHECKS[n];
      checks.push({
        index: meta.index,
        id: meta.id,
        label: meta.label,
        layer: meta.layer,
        why: meta.why,
        status: status,
        guidance: status === 'PASS' ? '' : (meta.guidance[status] || '')
      });
    }

    var ramBucket = take(32, 4);
    var diskBucket = take(36, 3);
    var driverCount = take(39, 4);
    var tpm = take(43, 2);
    var osClass = take(45, 3);
    var reserved = take(48, 4);

    return {
      ok: true,
      valid: true,
      version: version,
      code: PREFIX + '-' + s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12),
      verdict: anyFail ? 'NOT_READY' : (anyWarn ? 'READY_WITH_WARNINGS' : 'READY'),
      counts: {
        PASS: checks.filter(function (x) { return x.status === 'PASS'; }).length,
        WARN: checks.filter(function (x) { return x.status === 'WARN'; }).length,
        FAIL: checks.filter(function (x) { return x.status === 'FAIL'; }).length,
        SKIP: checks.filter(function (x) { return x.status === 'SKIP'; }).length
      },
      statuses: checks.map(function (x) { return x.status; }),
      checks: checks,
      system: {
        ramBucket: ramBucket,
        ram: RAM_BUCKETS[ramBucket] || 'unknown',
        diskBucket: diskBucket,
        disk: DISK_BUCKETS[diskBucket] || 'unknown',
        driverCount: driverCount,
        driverCountText: driverCount >= 15 ? '15 or more' : String(driverCount),
        tpm: tpm,
        tpmText: TPM_LABELS[tpm] || 'none or unknown',
        osClass: osClass,
        osClassText: OS_CLASSES[osClass] || 'unknown'
      },

      /* Flat aliases for the /readiness/ decode widget's system-summary chips.
       * Same values as `system` above, one level up. */
      ramLabel: RAM_BUCKETS[ramBucket] || 'unknown',
      diskLabel: DISK_BUCKETS[diskBucket] || 'unknown',
      tpmLabel: TPM_LABELS[tpm] || 'none or unknown',
      osLabel: OS_CLASSES[osClass] || 'unknown',
      driverCount: driverCount,

      reserved: reserved
    };
  }

  function verdictOf(statuses) {
    var anyFail = false, anyWarn = false;
    for (var i = 0; i < statuses.length; i++) {
      var s = String(statuses[i]).toUpperCase();
      if (s === 'FAIL') { anyFail = true; }
      if (s === 'WARN') { anyWarn = true; }
    }
    return anyFail ? 'NOT_READY' : (anyWarn ? 'READY_WITH_WARNINGS' : 'READY');
  }

  return {
    VERSION: VERSION,
    ALPHABET: ALPHABET,
    PREFIX: PREFIX,
    STATUS_NAMES: STATUS_NAMES,
    CHECKS: CHECKS,
    RAM_BUCKETS: RAM_BUCKETS,
    DISK_BUCKETS: DISK_BUCKETS,
    TPM_LABELS: TPM_LABELS,
    OS_CLASSES: OS_CLASSES,
    encode: encode,
    decode: decode,
    normalize: normalize,
    checksum: checksum,
    verdictOf: verdictOf
  };
});
