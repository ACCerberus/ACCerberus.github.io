/**
 * cerberus-plans.js
 *
 * Single source of truth for plan tiers. Loaded by the homepage pricing
 * section and by /plans/ so the two can never drift apart.
 *
 * Tier names match the ones the partner records, the dashboard's layer
 * gating and the internal admin tool already use (Argus / Aegis / Cerberus
 * / Olympus) — renaming one here means renaming it in all of those.
 *
 * Prices are intended general-availability pricing. Every closed-beta
 * partner currently pays nothing; the site says so wherever prices appear.
 */
(function () {
  'use strict';

  var CCU_NOTE = 'Peak concurrent players across all protected titles on the account.';

  var PLANS = [
    {
      id: 'argus',
      name: 'Argus',
      tagline: 'Starter',
      price: '$0',
      priceNote: 'Closed beta — application reviewed manually',
      desc: 'Kernel-level protection for indie studios and early-access titles.',
      ccu: 2500,
      ccuLabel: 'up to 2,500 peak CCU',
      titles: '1 title',
      layers: ['kernel'],
      support: 'Community Discord',
      sla: 'Best effort',
      retention: '14 days',
      highlight: false
    },
    {
      id: 'aegis',
      name: 'Aegis',
      tagline: 'Professional',
      price: 'from $1,200',
      priceUnit: '/mo',
      priceNote: 'Billed monthly, annual available',
      desc: 'Adds behavioural detection for competitive titles with a live ladder.',
      ccu: 25000,
      ccuLabel: 'up to 25,000 peak CCU',
      titles: 'up to 3 titles',
      layers: ['kernel', 'behavioral'],
      support: 'Priority email',
      sla: '12-hour response',
      retention: '30 days',
      highlight: false
    },
    {
      id: 'cerberus',
      name: 'Cerberus',
      tagline: 'Complete',
      price: 'from $4,800',
      priceUnit: '/mo',
      priceNote: 'Billed monthly, annual available',
      desc: 'All four detection layers, including hardware and network analysis.',
      ccu: 100000,
      ccuLabel: 'up to 100,000 peak CCU',
      titles: 'up to 10 titles',
      layers: ['kernel', 'behavioral', 'hardware', 'network'],
      support: 'Shared Slack or Discord channel',
      sla: '4-hour response',
      retention: '90 days',
      highlight: true,
      highlightLabel: 'Most partners'
    },
    {
      id: 'olympus',
      name: 'Olympus',
      tagline: 'Enterprise',
      price: 'Custom',
      priceNote: 'Negotiated per title',
      desc: 'Custom-engineered protection for publishers running several live titles.',
      ccu: null,
      ccuLabel: 'no player cap',
      titles: 'unlimited titles',
      layers: ['kernel', 'behavioral', 'hardware', 'network', 'custom'],
      support: 'Named account engineer',
      sla: '4-hour response, 24/7 escalation',
      retention: '180 days',
      highlight: false
    }
  ];

  // Detection layers, in the site's canonical order. `custom` is deliberately
  // NOT called "Layer 5" — the product is four layers; custom rules are an
  // Olympus add-on that runs on top of them.
  var LAYERS = [
    { id: 'kernel', label: 'Layer 1 — Kernel Integrity', short: 'Kernel Integrity',
      desc: 'Ring-0 driver watching memory permissions, syscall tampering, mapped drivers and known-vulnerable driver loads.' },
    { id: 'behavioral', label: 'Layer 2 — Behavioural AI', short: 'Behavioural AI',
      desc: 'Aim analysis, input-cadence and micro-movement modelling against a per-player baseline.' },
    { id: 'hardware', label: 'Layer 3 — Hardware Fingerprinting', short: 'Hardware Fingerprinting',
      desc: 'PCIe topology, DMA timing analysis, IOMMU attestation and TPM 2.0 boot-chain checks.' },
    { id: 'network', label: 'Layer 4 — Network Sentinel', short: 'Network Sentinel',
      desc: 'Server-side packet integrity, cross-player correlation and cheat-ring clustering.' },
    { id: 'custom', label: 'Custom Rules Engine', short: 'Custom Rules Engine',
      desc: 'Studio-authored detection rules and custom telemetry hooks. Olympus add-on.', addon: true }
  ];

  // What each tier includes, grouped for the /plans/ tab sheets.
  // `since` marks a row that arrived in the current release (v0.6).
  function inclusions(planId) {
    var plan = byId(planId);
    if (!plan) return [];
    var has = function (l) { return plan.layers.indexOf(l) !== -1; };
    var groups = [];

    groups.push({
      title: 'Detection layers',
      items: LAYERS.map(function (layer) {
        return {
          label: layer.short,
          detail: layer.desc,
          included: has(layer.id),
          since: layer.id === 'kernel' ? 'v0.6' : (layer.id === 'hardware' ? 'v0.6' : null),
          sinceNote: layer.id === 'kernel'
            ? 'Kernel driver generation 2 — rewritten ring-0 core running in a VBS/HVCI-protected enclave, plus EPT shadow-page scanning.'
            : (layer.id === 'hardware' ? 'Boot-chain attestation with TPM 2.0 PCR quotes and IOMMU / VT-d enforcement policy.' : null)
        };
      })
    });

    groups.push({
      title: 'SDK and integration',
      items: [
        { label: 'Evaluation SDK', detail: 'Public download, no account required. Header, evaluation runtime, examples and engine plugins.', included: true },
        { label: 'Partner runtime', detail: 'EV code-signed kernel driver and production static library, issued with your API key.', included: true },
        { label: 'Unreal and Unity plugins', detail: 'Drop-in plugin plus C++ and C# bindings. Most partners finish integration in under two hours.', included: true },
        { label: 'Asynchronous initialisation', detail: 'Non-blocking init with an attestation callback, so a slow driver load never stalls your title’s startup.', included: true, since: 'v0.6', sinceNote: 'New callback ABI v3 — ban callbacks now receive a structured CerberusBanInfo.' },
        { label: 'Ban API and webhooks', detail: 'REST ban / unban / query endpoints and signed webhook delivery for detections and enforcement.', included: planId !== 'argus', detailIfMissing: 'Argus includes the standard ban API; webhooks start at Aegis.' },
        { label: 'Custom webhook and event schemas', detail: 'Event payloads shaped to your existing pipeline.', included: planId === 'olympus' }
      ]
    });

    groups.push({
      title: 'Dashboard and data',
      items: [
        { label: 'Partner dashboard', detail: 'Sessions, detections, bans and per-region health for every protected title.', included: true },
        { label: 'Detection history retention', detail: plan.retention + ' of queryable detection and session history.', included: true },
        { label: 'Appeal triage', detail: 'Player appeals arrive with the originating session, the triggering layer and its confidence score attached.', included: true, since: 'v0.6', sinceNote: 'The appeal pipeline shipped with v0.6 — every ban now carries a reference code the player can quote.' },
        { label: 'Manual review queue', detail: 'Mid-confidence detections routed to review instead of an automatic ban.', included: planId !== 'argus' },
        { label: 'Threat intelligence reports', detail: 'Monthly write-up of the cheat providers and hardware seen against your titles.', included: planId === 'cerberus' || planId === 'olympus' },
        { label: 'Dedicated threat analyst', detail: 'A named analyst reviewing your title’s detection quality and tuning thresholds with you.', included: planId === 'cerberus' || planId === 'olympus' }
      ]
    });

    groups.push({
      title: 'Support and availability',
      items: [
        { label: 'Support channel', detail: plan.support, included: true },
        { label: 'Response target', detail: plan.sla, included: true },
        { label: 'Availability commitment', detail: 'Backed by the published 97% monthly uptime commitment.', included: true },
        { label: 'Pre-launch cheat landscape audit', detail: 'We survey what is already being sold against your title before you ship.', included: planId === 'olympus' },
        { label: 'Red team penetration testing', detail: 'Our threat research team attacks your build the way a cheat developer would.', included: planId === 'olympus' }
      ]
    });

    groups.push({
      title: 'Limits',
      items: [
        { label: 'Peak concurrent players', detail: plan.ccuLabel + '. ' + CCU_NOTE, included: true },
        { label: 'Protected titles', detail: plan.titles, included: true },
        { label: 'Regions', detail: 'All three regions (US-East, EU-West, AP-Southeast) on every plan.', included: true },
        { label: 'Overage', detail: plan.ccu ? '$0.04 per peak CCU above the cap, billed monthly.' : 'No cap, so no overage.', included: true },
        { label: 'Platform', detail: 'Windows 10 21H2+ and Windows 11, x64. No console or mobile SDK yet.', included: true }
      ]
    });

    return groups;
  }

  function byId(id) {
    for (var i = 0; i < PLANS.length; i++) if (PLANS[i].id === id) return PLANS[i];
    return null;
  }

  var API = {
    PLANS: PLANS,
    LAYERS: LAYERS,
    byId: byId,
    inclusions: inclusions,
    // Copy that must read identically wherever prices are shown.
    betaNotice: 'Closed-beta pricing: every current partner pays nothing until public release. The prices below are our intended pricing at general availability and may change before then.',
    overageNote: '$0.04 per peak CCU above the plan cap, billed monthly.'
  };

  if (typeof window !== 'undefined') window.CerberusPlans = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
