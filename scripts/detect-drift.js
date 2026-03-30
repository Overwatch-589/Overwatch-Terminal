#!/usr/bin/env node
'use strict';

/**
 * Reasoning Drift Detector — AD #20 Phase 2
 *
 * Pure deterministic code. No AI judgment. Same inputs = same findings.
 *
 * Reads signal-dossier-data.json and flags unexplained assessment changes.
 * For each lineage with 2+ appearances, compares adjacent runs:
 *
 *   SEVERITY_DRIFT:   weighted_severity delta > threshold
 *                     AND no corrections fired
 *                     AND evidence unchanged
 *
 *   CONFIDENCE_DRIFT: confidence level changed
 *                     AND no corrections fired
 *                     AND gate violation profile unchanged
 *
 *   LANGUAGE_DRIFT:   L2 reasoning substantially changed
 *                     AND evidence unchanged
 *                     (reasoning_diff already pre-computed by signal dossier aggregator)
 *
 * Core formula: Drift = Δ Assessment − (Δ Evidence + Δ Corrections)
 * If assessment changed but neither evidence nor corrections explain it,
 * the residual is unexplained drift.
 *
 * The detector does NOT explain drift. It does NOT ask the LLM why.
 * It flags and records. The human investigates.
 *
 * Input:
 *   data/signal-dossier-data.json
 *   config/domain.json              (optional — threshold overrides)
 *
 * Output:
 *   data/drift-findings.json
 *
 * Design doc: ARCHITECTURE-DECISION-20-REASONING-DRIFT-DETECTION.docx
 *
 * The Integrity Protocol (Patent Pending) — Timothy Joseph Wrenn
 */

const path = require('path');
const fs   = require('fs');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const CONFIG_DIR  = path.join(__dirname, '..', 'config');
const DOSSIER_PATH = path.join(DATA_DIR, 'signal-dossier-data.json');
const DOMAIN_PATH  = path.join(CONFIG_DIR, 'domain.json');
const OUTPUT_PATH  = path.join(DATA_DIR, 'drift-findings.json');

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_SEVERITY_THRESHOLD = 1.5;
const DEFAULT_LANGUAGE_THRESHOLD = 0.4; // ratio of changed words to total words
const DEFAULT_MIN_APPEARANCES = 2;

// ─── Logging ────────────────────────────────────────────────────────────────

function log(label, msg) { console.log(`[drift:${label}] ${msg}`); }
function warn(label, msg) { console.warn(`[drift:${label}] ⚠️  ${msg}`); }

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
 * Compare gate violation profiles between two appearances.
 * Returns true if the violation counts per layer are identical.
 */
function gateProfileUnchanged(prev, curr) {
  const prevGates = prev.gate_violations_by_layer || {};
  const currGates = curr.gate_violations_by_layer || {};
  const allLayers = new Set([...Object.keys(prevGates), ...Object.keys(currGates)]);
  for (const layer of allLayers) {
    if ((prevGates[layer] || 0) !== (currGates[layer] || 0)) return false;
  }
  return true;
}

/**
 * Compute language drift ratio from pre-computed reasoning_diff.
 * Returns ratio of changed words to total words (0.0 = identical, 1.0 = completely different).
 */
function computeLanguageDriftRatio(reasoningDiff) {
  if (!reasoningDiff || !Array.isArray(reasoningDiff)) return 0;

  let totalWords = 0;
  let changedWords = 0;

  for (const part of reasoningDiff) {
    const wordCount = (part.value || '').split(/\s+/).filter(Boolean).length;
    totalWords += wordCount;
    if (part.added || part.removed) {
      changedWords += wordCount;
    }
  }

  if (totalWords === 0) return 0;
  return changedWords / totalWords;
}

/**
 * Check if corrections fired between two adjacent appearances.
 * Returns true if the current appearance has corrections that weren't
 * present in the previous appearance.
 */
function newCorrectionsFired(prev, curr) {
  const prevCorrections = new Set(prev.corrections_applied || []);
  const currCorrections = curr.corrections_applied || [];
  for (const c of currCorrections) {
    if (!prevCorrections.has(c)) return true;
  }
  return false;
}

// ─── Drift Detection ────────────────────────────────────────────────────────

function detectDrift(dossierData, config) {
  const severityThreshold = (config && config.drift_severity_threshold) || DEFAULT_SEVERITY_THRESHOLD;
  const languageThreshold = (config && config.drift_language_threshold) || DEFAULT_LANGUAGE_THRESHOLD;
  const minAppearances = (config && config.drift_min_appearances) || DEFAULT_MIN_APPEARANCES;

  const findings = [];
  const lineages = dossierData.lineages || [];
  let lineagesScanned = 0;
  let pairsCompared = 0;

  for (const lineage of lineages) {
    const appearances = lineage.appearances || [];
    if (appearances.length < minAppearances) continue;

    lineagesScanned++;

    // Compare adjacent appearances (already sorted chronologically by dossier aggregator)
    for (let i = 1; i < appearances.length; i++) {
      const prev = appearances[i - 1];
      const curr = appearances[i];
      pairsCompared++;

      const evidenceChanged = curr.evidence_changed === true;
      const correctionsFired = newCorrectionsFired(prev, curr);

      // ── SEVERITY_DRIFT ──────────────────────────────────────────────
      if (prev.weighted_severity != null && curr.weighted_severity != null) {
        const delta = Math.abs(curr.weighted_severity - prev.weighted_severity);
        if (delta > severityThreshold && !correctionsFired && !evidenceChanged) {
          findings.push({
            finding_id: `DRIFT-SEV-${lineage.lineage_id}-${curr.run_timestamp.slice(0, 19).replace(/[^0-9]/g, '')}`,
            drift_type: 'SEVERITY_DRIFT',
            lineage_id: lineage.lineage_id,
            canonical_name: lineage.canonical_name || null,
            category: lineage.category || null,
            run_pair: {
              previous: prev.run_timestamp,
              current: curr.run_timestamp
            },
            magnitude: Math.round(delta * 100) / 100,
            direction: curr.weighted_severity > prev.weighted_severity ? 'ESCALATED' : 'SOFTENED',
            previous_value: prev.weighted_severity,
            current_value: curr.weighted_severity,
            evidence_changed: false,
            corrections_fired: false,
            threshold_used: severityThreshold
          });
        }
      }

      // ── CONFIDENCE_DRIFT ────────────────────────────────────────────
      if (prev.confidence && curr.confidence && prev.confidence !== curr.confidence) {
        const gateUnchanged = gateProfileUnchanged(prev, curr);
        if (!correctionsFired && gateUnchanged) {
          findings.push({
            finding_id: `DRIFT-CONF-${lineage.lineage_id}-${curr.run_timestamp.slice(0, 19).replace(/[^0-9]/g, '')}`,
            drift_type: 'CONFIDENCE_DRIFT',
            lineage_id: lineage.lineage_id,
            canonical_name: lineage.canonical_name || null,
            category: lineage.category || null,
            run_pair: {
              previous: prev.run_timestamp,
              current: curr.run_timestamp
            },
            magnitude: null,
            direction: null,
            previous_value: prev.confidence,
            current_value: curr.confidence,
            evidence_changed: evidenceChanged,
            corrections_fired: false,
            gate_profile_changed: false,
            threshold_used: null
          });
        }
      }

      // ── LANGUAGE_DRIFT ──────────────────────────────────────────────
      if (!evidenceChanged && curr.reasoning_diff) {
        const ratio = computeLanguageDriftRatio(curr.reasoning_diff);
        if (ratio > languageThreshold) {
          findings.push({
            finding_id: `DRIFT-LANG-${lineage.lineage_id}-${curr.run_timestamp.slice(0, 19).replace(/[^0-9]/g, '')}`,
            drift_type: 'LANGUAGE_DRIFT',
            lineage_id: lineage.lineage_id,
            canonical_name: lineage.canonical_name || null,
            category: lineage.category || null,
            run_pair: {
              previous: prev.run_timestamp,
              current: curr.run_timestamp
            },
            magnitude: Math.round(ratio * 100) / 100,
            direction: null,
            previous_value: (prev.l2_reasoning || '').slice(0, 200),
            current_value: (curr.l2_reasoning || '').slice(0, 200),
            evidence_changed: false,
            corrections_fired: correctionsFired,
            threshold_used: languageThreshold
          });
        }
      }
    }
  }

  // Sort findings by run_pair.current descending (most recent first)
  findings.sort((a, b) => (b.run_pair.current || '').localeCompare(a.run_pair.current || ''));

  return {
    findings,
    lineagesScanned,
    pairsCompared
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

function runDriftDetector() {
  log('start', 'Running reasoning drift detector (AD #20 Phase 2)...');

  // Load signal dossier data
  const dossierData = loadJSON(DOSSIER_PATH, null);
  if (!dossierData || !dossierData.lineages) {
    warn('input', 'No signal dossier data found. Run assemble-signal-dossiers.js first.');
    return null;
  }

  // Load domain config for threshold overrides
  const domainConfig = loadJSON(DOMAIN_PATH, {});

  log('input', `${dossierData._lineage_count || dossierData.lineages.length} lineages from ${dossierData._trace_count || '?'} traces`);

  // Detect drift
  const result = detectDrift(dossierData, domainConfig);

  log('scan', `Scanned ${result.lineagesScanned} lineages, compared ${result.pairsCompared} adjacent pairs`);

  // Tally by type
  const bySeverity = result.findings.filter(f => f.drift_type === 'SEVERITY_DRIFT').length;
  const byConfidence = result.findings.filter(f => f.drift_type === 'CONFIDENCE_DRIFT').length;
  const byLanguage = result.findings.filter(f => f.drift_type === 'LANGUAGE_DRIFT').length;

  log('findings', `${result.findings.length} total: ${bySeverity} severity, ${byConfidence} confidence, ${byLanguage} language`);

  // Build output
  const output = {
    _version: '1.0',
    _description: 'AD #20 Phase 2 — Reasoning Drift Findings',
    _detected_at: new Date().toISOString(),
    _dossier_assembled_at: dossierData._assembled_at || null,
    _trace_count: dossierData._trace_count || null,
    _scan_stats: {
      lineages_scanned: result.lineagesScanned,
      pairs_compared: result.pairsCompared,
      findings_count: result.findings.length,
      by_type: {
        severity_drift: bySeverity,
        confidence_drift: byConfidence,
        language_drift: byLanguage
      }
    },
    _thresholds: {
      severity: (domainConfig && domainConfig.drift_severity_threshold) || DEFAULT_SEVERITY_THRESHOLD,
      language: (domainConfig && domainConfig.drift_language_threshold) || DEFAULT_LANGUAGE_THRESHOLD,
      min_appearances: (domainConfig && domainConfig.drift_min_appearances) || DEFAULT_MIN_APPEARANCES
    },
    findings: result.findings
  };

  // Write output
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  log('done', `Wrote ${result.findings.length} findings to ${path.basename(OUTPUT_PATH)}`);

  return output;
}

// ─── CLI or Module ──────────────────────────────────────────────────────────

if (require.main === module) {
  const result = runDriftDetector();

  if (result && result.findings.length > 0) {
    console.log('\n=== DRIFT FINDINGS SUMMARY ===');
    console.log(`Total: ${result.findings.length}`);
    console.log(`  SEVERITY_DRIFT:   ${result._scan_stats.by_type.severity_drift}`);
    console.log(`  CONFIDENCE_DRIFT: ${result._scan_stats.by_type.confidence_drift}`);
    console.log(`  LANGUAGE_DRIFT:   ${result._scan_stats.by_type.language_drift}`);

    // Show top findings
    console.log('\n--- Most Recent Findings ---');
    for (const f of result.findings.slice(0, 10)) {
      const dir = f.direction ? ` (${f.direction})` : '';
      const mag = f.magnitude != null ? ` mag=${f.magnitude}` : '';
      console.log(`  ${f.drift_type}: ${f.canonical_name || f.lineage_id}${dir}${mag}`);
      console.log(`    ${f.run_pair.previous.slice(0, 19)} → ${f.run_pair.current.slice(0, 19)}`);
      console.log(`    prev=${JSON.stringify(f.previous_value).slice(0, 60)} → curr=${JSON.stringify(f.current_value).slice(0, 60)}`);
    }

    // Show most drift-prone lineages
    const lineageCounts = {};
    for (const f of result.findings) {
      const key = f.canonical_name || f.lineage_id;
      lineageCounts[key] = (lineageCounts[key] || 0) + 1;
    }
    const sorted = Object.entries(lineageCounts).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0) {
      console.log('\n--- Most Drift-Prone Signals ---');
      for (const [name, count] of sorted.slice(0, 5)) {
        console.log(`  ${name}: ${count} drift finding(s)`);
      }
    }
  } else if (result) {
    console.log('\n=== NO DRIFT FINDINGS ===');
    console.log('All assessment changes were explained by evidence changes or corrections.');
  }
}

module.exports = { runDriftDetector, detectDrift };
