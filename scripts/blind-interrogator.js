#!/usr/bin/env node
'use strict';

/**
 * Blind Interrogator — AD #21 Phase 3
 *
 * Pure deterministic code. No AI judgment. Same inputs = same findings.
 *
 * Post-Layer-2 check: compares each signal's stated confidence level
 * against its historical track record (survival rate, confidence accuracy).
 * Flags CONFIDENCE_MISMATCH when the model's self-assessment diverges
 * from its documented performance.
 *
 * The interrogator does NOT ask the LLM to explain itself.
 * It does NOT modify the assessment.
 * It flags and records. Advisory only.
 *
 * Over time, persistent CONFIDENCE_MISMATCH patterns become behavioral
 * calibration candidates (feeding Loop 3 / AD #16).
 *
 * Input:
 *   data/cognitive-trace-*.json         — most recent run's signal data
 *   data/signal-dossier-data.json       — previous cycle's track records
 *   config/signal-aliases.json          — alias dictionary for matching
 *   config/domain.json                  — optional threshold overrides
 *
 * Output:
 *   data/confidence-interrogation.json  — mismatch findings
 *
 * Design doc: ARCHITECTURE-DECISION-21-EARNED-SIGNAL-CONFIDENCE.docx
 *
 * The Integrity Protocol (Patent Pending) — Timothy Joseph Wrenn
 */

const path = require('path');
const fs   = require('fs');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const CONFIG_DIR  = path.join(__dirname, '..', 'config');
const DOSSIER_PATH = path.join(DATA_DIR, 'signal-dossier-data.json');
const DOMAIN_PATH  = path.join(CONFIG_DIR, 'domain.json');
const ALIAS_PATH   = path.join(CONFIG_DIR, 'signal-aliases.json');
const OUTPUT_PATH  = path.join(DATA_DIR, 'confidence-interrogation.json');

// ─── Defaults ───────────────────────────────────────────────────────────────

// If stated HIGH and survival rate is below this, flag OVERCONFIDENT
const DEFAULT_HIGH_SURVIVAL_FLOOR = 0.50;
// If stated HIGH and survival rate is below this, flag SEVERE OVERCONFIDENT
const DEFAULT_SEVERE_SURVIVAL_FLOOR = 0.30;
// If stated LOW and survival rate is above this, flag UNDERCONFIDENT
const DEFAULT_LOW_SURVIVAL_CEILING = 0.70;
// If stated LOW and survival rate is above this, flag SEVERE UNDERCONFIDENT
const DEFAULT_SEVERE_LOW_SURVIVAL_CEILING = 0.85;
// If confidence_accuracy is below this, flag POOR_CALIBRATION regardless
const DEFAULT_POOR_CALIBRATION_FLOOR = 0.30;
// Minimum appearances before track record is considered reliable
const DEFAULT_MIN_TRACK_RECORD_APPEARANCES = 3;

// ─── Logging ────────────────────────────────────────────────────────────────

function log(label, msg)  { console.log(`[interrogator:${label}] ${msg}`); }
function warn(label, msg) { console.warn(`[interrogator:${label}] ⚠ ${msg}`); }

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadJSON(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    warn('io', `Failed to load ${path.basename(filePath)}: ${e.message}`);
  }
  return fallback;
}

/**
 * Load alias dictionary — same logic as signal-matching module.
 * We import directly to use the single source of truth.
 */
function loadAliases() {
  try {
    const aliasModule = require('./utils/signal-matching');
    return aliasModule.loadAliases(ALIAS_PATH);
  } catch (e) {
    // Fallback: load directly if module path differs
    warn('aliases', `Could not load signal-matching module: ${e.message}. Loading directly.`);
    try {
      if (!fs.existsSync(ALIAS_PATH)) {
        return { aliases: {}, sortedKeys: [] };
      }
      const raw = JSON.parse(fs.readFileSync(ALIAS_PATH, 'utf8'));
      const aliases = {};
      const keys = [];
      for (const [key, value] of Object.entries(raw)) {
        if (key === '_comment') continue;
        aliases[key] = value;
        keys.push(key);
      }
      keys.sort((a, b) => b.length - a.length);
      return { aliases, sortedKeys: keys };
    } catch (e2) {
      warn('aliases', `Direct alias load failed: ${e2.message}`);
      return { aliases: {}, sortedKeys: [] };
    }
  }
}

/**
 * Match a signal title to a lineage using the alias dictionary.
 */
function matchAlias(signalTitle, aliases, sortedKeys) {
  try {
    const aliasModule = require('./utils/signal-matching');
    return aliasModule.matchAlias(signalTitle, aliases, sortedKeys);
  } catch (e) {
    // Fallback: inline matching
    const lower = signalTitle.toLowerCase();
    for (const key of sortedKeys) {
      if (lower.includes(key)) {
        return aliases[key];
      }
    }
    return null;
  }
}

/**
 * Find the most recent cognitive trace file.
 */
function findLatestTrace(dataDir) {
  const files = fs.readdirSync(dataDir)
    .filter(f => f.startsWith('cognitive-trace-') && f.endsWith('.json'))
    .sort();
  if (files.length === 0) return null;
  return path.join(dataDir, files[files.length - 1]);
}

// ─── Interrogation Logic ────────────────────────────────────────────────────

/**
 * Run the Blind Interrogator against the most recent pipeline run.
 *
 * For each scored signal in the cognitive trace:
 *   1. Match to a lineage via alias dictionary
 *   2. Look up track record from signal dossier
 *   3. Compare stated confidence vs. historical performance
 *   4. Flag mismatches
 *
 * Returns findings array + metadata.
 */
function interrogate(options) {
  const opts = options || {};
  const dataDir = opts.dataDir || DATA_DIR;
  const outputPath = opts.outputPath || OUTPUT_PATH;

  // Load thresholds from domain config
  const domainConfig = loadJSON(opts.domainPath || DOMAIN_PATH, {});
  const thresholds = {
    high_survival_floor: domainConfig.interrogator_high_survival_floor || DEFAULT_HIGH_SURVIVAL_FLOOR,
    severe_survival_floor: domainConfig.interrogator_severe_survival_floor || DEFAULT_SEVERE_SURVIVAL_FLOOR,
    low_survival_ceiling: domainConfig.interrogator_low_survival_ceiling || DEFAULT_LOW_SURVIVAL_CEILING,
    severe_low_survival_ceiling: domainConfig.interrogator_severe_low_survival_ceiling || DEFAULT_SEVERE_LOW_SURVIVAL_CEILING,
    poor_calibration_floor: domainConfig.interrogator_poor_calibration_floor || DEFAULT_POOR_CALIBRATION_FLOOR,
    min_appearances: domainConfig.interrogator_min_appearances || DEFAULT_MIN_TRACK_RECORD_APPEARANCES
  };

  // Load signal dossier data (previous cycle's track records)
  const dossierData = loadJSON(opts.dossierPath || DOSSIER_PATH, null);
  if (!dossierData || !dossierData.lineages) {
    warn('input', 'No signal dossier data found. Run assemble-signal-dossiers.js first.');
    return writeEmptyOutput(outputPath, 'No dossier data');
  }

  // Build lineage lookup: lineage_id → track_record
  const trackRecordMap = {};
  for (const lineage of dossierData.lineages) {
    if (lineage.track_record && lineage.track_record.appearance_count >= thresholds.min_appearances) {
      trackRecordMap[lineage.lineage_id] = {
        track_record: lineage.track_record,
        canonical_name: lineage.canonical_name,
        category: lineage.category
      };
    }
  }
  log('input', `${Object.keys(trackRecordMap).length} lineages with qualifying track records (${thresholds.min_appearances}+ appearances)`);

  // Find most recent cognitive trace
  const latestTracePath = findLatestTrace(dataDir);
  if (!latestTracePath) {
    warn('input', 'No cognitive trace files found.');
    return writeEmptyOutput(outputPath, 'No trace files');
  }

  const trace = loadJSON(latestTracePath, null);
  if (!trace || !trace.signals) {
    warn('input', `Could not parse trace: ${path.basename(latestTracePath)}`);
    return writeEmptyOutput(outputPath, 'Trace parse failure');
  }

  const runTimestamp = trace._run_timestamp || path.basename(latestTracePath).replace('cognitive-trace-', '').replace('.json', '');
  log('input', `Interrogating trace: ${path.basename(latestTracePath)} (${(trace.signals || []).length} signals)`);

  // Load alias dictionary
  const { aliases, sortedKeys } = loadAliases();

  // ── Interrogate each scored signal ──────────────────────────────────────

  const findings = [];
  let signalsChecked = 0;
  let signalsWithTrackRecord = 0;
  let signalsWithoutTrackRecord = 0;
  let signalsNoMatch = 0;

  for (const signal of trace.signals) {
    const perception = signal.perception || {};
    const scored = (signal.contextualization || {}).scored || {};
    const signalTitle = perception.signal || 'UNKNOWN';
    const statedConfidence = (scored.confidence || '').toUpperCase();

    // Skip signals without a confidence assessment
    if (!statedConfidence || !['HIGH', 'MEDIUM', 'LOW'].includes(statedConfidence)) {
      continue;
    }

    signalsChecked++;

    // Match to lineage
    const lineageInfo = matchAlias(signalTitle, aliases, sortedKeys);
    if (!lineageInfo) {
      signalsNoMatch++;
      continue;
    }

    const lineageId = lineageInfo.lineage_id;
    const lookup = trackRecordMap[lineageId];

    if (!lookup) {
      signalsWithoutTrackRecord++;
      continue;
    }

    signalsWithTrackRecord++;
    const tr = lookup.track_record;

    // ── Check 1: HIGH confidence vs. low survival rate ────────────────
    if (statedConfidence === 'HIGH' && tr.survival_rate != null) {
      if (tr.survival_rate < thresholds.severe_survival_floor) {
        findings.push(buildFinding({
          type: 'SEVERE_OVERCONFIDENT_MISMATCH',
          signalTitle,
          lineageId,
          canonicalName: lookup.canonical_name,
          category: lookup.category,
          runTimestamp,
          statedConfidence,
          survivalRate: tr.survival_rate,
          confidenceAccuracy: tr.confidence_accuracy,
          overconfidentCount: tr.overconfident_count,
          appearanceCount: tr.appearance_count,
          detail: `HIGH confidence stated on signal with ${(tr.survival_rate * 100).toFixed(0)}% survival rate (below ${(thresholds.severe_survival_floor * 100).toFixed(0)}% severe threshold). ${tr.overconfident_count || 0} previous overconfident calls documented.`
        }));
      } else if (tr.survival_rate < thresholds.high_survival_floor) {
        findings.push(buildFinding({
          type: 'OVERCONFIDENT_MISMATCH',
          signalTitle,
          lineageId,
          canonicalName: lookup.canonical_name,
          category: lookup.category,
          runTimestamp,
          statedConfidence,
          survivalRate: tr.survival_rate,
          confidenceAccuracy: tr.confidence_accuracy,
          overconfidentCount: tr.overconfident_count,
          appearanceCount: tr.appearance_count,
          detail: `HIGH confidence stated on signal with ${(tr.survival_rate * 100).toFixed(0)}% survival rate (below ${(thresholds.high_survival_floor * 100).toFixed(0)}% threshold). ${tr.overconfident_count || 0} previous overconfident calls documented.`
        }));
      }
    }

    // ── Check 2: LOW confidence vs. high survival rate ────────────────
    if (statedConfidence === 'LOW' && tr.survival_rate != null) {
      if (tr.survival_rate > thresholds.severe_low_survival_ceiling) {
        findings.push(buildFinding({
          type: 'SEVERE_UNDERCONFIDENT_MISMATCH',
          signalTitle,
          lineageId,
          canonicalName: lookup.canonical_name,
          category: lookup.category,
          runTimestamp,
          statedConfidence,
          survivalRate: tr.survival_rate,
          confidenceAccuracy: tr.confidence_accuracy,
          underconfidentCount: tr.underconfident_count,
          appearanceCount: tr.appearance_count,
          detail: `LOW confidence stated on signal with ${(tr.survival_rate * 100).toFixed(0)}% survival rate (above ${(thresholds.severe_low_survival_ceiling * 100).toFixed(0)}% severe threshold). This signal almost always survives all four layers. ${tr.underconfident_count || 0} previous underconfident calls documented.`
        }));
      } else if (tr.survival_rate > thresholds.low_survival_ceiling) {
        findings.push(buildFinding({
          type: 'UNDERCONFIDENT_MISMATCH',
          signalTitle,
          lineageId,
          canonicalName: lookup.canonical_name,
          category: lookup.category,
          runTimestamp,
          statedConfidence,
          survivalRate: tr.survival_rate,
          confidenceAccuracy: tr.confidence_accuracy,
          underconfidentCount: tr.underconfident_count,
          appearanceCount: tr.appearance_count,
          detail: `LOW confidence stated on signal with ${(tr.survival_rate * 100).toFixed(0)}% survival rate (above ${(thresholds.low_survival_ceiling * 100).toFixed(0)}% threshold). ${tr.underconfident_count || 0} previous underconfident calls documented.`
        }));
      }
    }

    // ── Check 3: Poor overall calibration on this signal category ─────
    if (tr.confidence_accuracy != null && tr.confidence_accuracy < thresholds.poor_calibration_floor) {
      // Only flag if HIGH or LOW — MEDIUM is the neutral zone
      if (statedConfidence === 'HIGH' || statedConfidence === 'LOW') {
        // Don't double-count if already flagged by Check 1 or 2
        const alreadyFlagged = findings.some(f =>
          f.lineage_id === lineageId &&
          f.run_timestamp === runTimestamp &&
          (f.finding_type === 'OVERCONFIDENT_MISMATCH' ||
           f.finding_type === 'SEVERE_OVERCONFIDENT_MISMATCH' ||
           f.finding_type === 'UNDERCONFIDENT_MISMATCH' ||
           f.finding_type === 'SEVERE_UNDERCONFIDENT_MISMATCH')
        );

        if (!alreadyFlagged) {
          findings.push(buildFinding({
            type: 'POOR_CALIBRATION',
            signalTitle,
            lineageId,
            canonicalName: lookup.canonical_name,
            category: lookup.category,
            runTimestamp,
            statedConfidence,
            survivalRate: tr.survival_rate,
            confidenceAccuracy: tr.confidence_accuracy,
            overconfidentCount: tr.overconfident_count,
            underconfidentCount: tr.underconfident_count,
            appearanceCount: tr.appearance_count,
            detail: `${statedConfidence} confidence stated but historical confidence accuracy is ${(tr.confidence_accuracy * 100).toFixed(0)}% (below ${(thresholds.poor_calibration_floor * 100).toFixed(0)}% threshold). This signal category has poor overall confidence calibration.`
          }));
        }
      }
    }
  }

  log('scan', `Checked ${signalsChecked} signals: ${signalsWithTrackRecord} with track records, ${signalsWithoutTrackRecord} without qualifying records, ${signalsNoMatch} unmatched`);
  log('findings', `${findings.length} CONFIDENCE_MISMATCH findings`);

  // ── Build output ────────────────────────────────────────────────────────

  const output = {
    _version: '1.0',
    _description: 'AD #21 Phase 3 — Blind Interrogator: Confidence Mismatch Detection',
    _interrogated_at: new Date().toISOString(),
    _trace_file: path.basename(latestTracePath),
    _run_timestamp: runTimestamp,
    _dossier_assembled_at: dossierData._assembled_at || null,
    _scan_stats: {
      signals_checked: signalsChecked,
      signals_with_track_record: signalsWithTrackRecord,
      signals_without_track_record: signalsWithoutTrackRecord,
      signals_no_alias_match: signalsNoMatch,
      findings_count: findings.length,
      by_type: {
        severe_overconfident: findings.filter(f => f.finding_type === 'SEVERE_OVERCONFIDENT_MISMATCH').length,
        overconfident: findings.filter(f => f.finding_type === 'OVERCONFIDENT_MISMATCH').length,
        underconfident: findings.filter(f => f.finding_type === 'UNDERCONFIDENT_MISMATCH').length,
        severe_underconfident: findings.filter(f => f.finding_type === 'SEVERE_UNDERCONFIDENT_MISMATCH').length,
        poor_calibration: findings.filter(f => f.finding_type === 'POOR_CALIBRATION').length
      }
    },
    _thresholds: thresholds,
    findings
  };

  // Write output
  try {
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    log('done', `Wrote ${findings.length} findings to ${path.basename(outputPath)}`);
  } catch (e) {
    warn('io', `Failed to write output: ${e.message}`);
  }

  return output;
}

// ─── Finding Builder ────────────────────────────────────────────────────────

function buildFinding(params) {
  return {
    finding_id: `INTERROG-${params.type.slice(0, 4)}-${params.lineageId}-${(params.runTimestamp || '').slice(0, 19).replace(/[^0-9]/g, '')}`,
    finding_type: params.type,
    lineage_id: params.lineageId,
    canonical_name: params.canonicalName || null,
    category: params.category || null,
    signal_title: params.signalTitle,
    run_timestamp: params.runTimestamp,
    stated_confidence: params.statedConfidence,
    track_record: {
      survival_rate: params.survivalRate != null ? params.survivalRate : null,
      confidence_accuracy: params.confidenceAccuracy != null ? params.confidenceAccuracy : null,
      overconfident_count: params.overconfidentCount || 0,
      underconfident_count: params.underconfidentCount || 0,
      appearance_count: params.appearanceCount || 0
    },
    detail: params.detail,
    advisory: true  // Explicit: this finding does NOT modify the assessment
  };
}

// ─── Empty Output Helper ────────────────────────────────────────────────────

function writeEmptyOutput(outputPath, reason) {
  const output = {
    _version: '1.0',
    _description: 'AD #21 Phase 3 — Blind Interrogator: Confidence Mismatch Detection',
    _interrogated_at: new Date().toISOString(),
    _trace_file: null,
    _run_timestamp: null,
    _scan_stats: {
      signals_checked: 0,
      signals_with_track_record: 0,
      signals_without_track_record: 0,
      signals_no_alias_match: 0,
      findings_count: 0,
      by_type: { severe_overconfident: 0, overconfident: 0, underconfident: 0, severe_underconfident: 0, poor_calibration: 0 }
    },
    _skip_reason: reason,
    findings: []
  };
  try {
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  } catch (e) {
    warn('io', `Failed to write empty output: ${e.message}`);
  }
  return output;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  log('start', 'Blind Interrogator — AD #21 Phase 3');
  log('start', 'Pure deterministic. No AI judgment. Advisory only.');

  const result = interrogate();

  if (result && result.findings.length > 0) {
    console.log('\n=== CONFIDENCE INTERROGATION SUMMARY ===');
    console.log(`Signals checked: ${result._scan_stats.signals_checked}`);
    console.log(`With track records: ${result._scan_stats.signals_with_track_record}`);
    console.log(`Findings: ${result._scan_stats.findings_count}`);
    console.log(`  SEVERE_OVERCONFIDENT: ${result._scan_stats.by_type.severe_overconfident}`);
    console.log(`  OVERCONFIDENT:        ${result._scan_stats.by_type.overconfident}`);
    console.log(`  UNDERCONFIDENT:       ${result._scan_stats.by_type.underconfident}`);
    console.log(`  SEVERE_UNDERCONFIDENT:${result._scan_stats.by_type.severe_underconfident}`);
    console.log(`  POOR_CALIBRATION:     ${result._scan_stats.by_type.poor_calibration}`);

    console.log('\n--- Findings ---');
    for (const f of result.findings) {
      console.log(`  ${f.finding_type}: ${f.canonical_name || f.signal_title}`);
      console.log(`    Stated: ${f.stated_confidence} | Survival: ${f.track_record.survival_rate != null ? (f.track_record.survival_rate * 100).toFixed(0) + '%' : 'N/A'} | Conf Accuracy: ${f.track_record.confidence_accuracy != null ? (f.track_record.confidence_accuracy * 100).toFixed(0) + '%' : 'N/A'}`);
      console.log(`    ${f.detail}`);
    }
  } else if (result) {
    console.log('\n=== NO CONFIDENCE MISMATCHES ===');
    console.log(`Signals checked: ${result._scan_stats.signals_checked}`);
    console.log(`With track records: ${result._scan_stats.signals_with_track_record}`);
    if (result._skip_reason) {
      console.log(`Skip reason: ${result._skip_reason}`);
    }
    console.log('All stated confidence levels are consistent with historical track records.');
  }
}

module.exports = { interrogate };
