#!/usr/bin/env node
'use strict';

/**
 * Signal Dossier Aggregator — AD #20 Phase 1
 *
 * Pure deterministic code. No AI judgment. Same inputs = same dossiers.
 *
 * Reads all cognitive trace files and builds longitudinal signal dossiers.
 * Groups signals by analytical subject using a human-maintained alias
 * dictionary with longest-match-first substring matching.
 *
 * For each recurring signal, assembles the complete assessment history:
 * severity, confidence, corrections, violations, reasoning text, outcomes,
 * and pre-computed text diffs between adjacent appearances.
 *
 * Input:
 *   data/cognitive-trace-*.json         — per-run signal traces
 *   config/signal-aliases.json          — human-maintained alias dictionary
 *
 * Output:
 *   data/signal-dossier-data.json       — longitudinal signal dossiers
 *
 * Design doc: ARCHITECTURE-DECISION-20-REASONING-DRIFT-DETECTION.docx
 * Gemini cross-validation: longest-match-first, chronological sort, evidence_changed
 *
 * The Integrity Protocol (Patent Pending) — Timothy Joseph Wrenn
 */

const path = require('path');
const fs   = require('fs');
const { diffWords } = require('diff');
const { loadAliases, matchAlias } = require('./utils/signal-matching');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const CONFIG_DIR  = path.join(__dirname, '..', 'config');
const ALIAS_PATH  = path.join(CONFIG_DIR, 'signal-aliases.json');
const OUTPUT_PATH = path.join(DATA_DIR, 'signal-dossier-data.json');

// ─── Logging ────────────────────────────────────────────────────────────────

function log(area, msg)  { console.log(`[dossier:${area}] ${msg}`); }
function warn(area, msg) { console.warn(`[dossier:${area}] ⚠ ${msg}`); }
function err(area, msg)  { console.error(`[dossier:${area}] ✖ ${msg}`); }

/**
 * Compute standard deviation of a numeric array.
 * Used for severity range compression detection (AD #21 overcorrection test).
 */
function computeStdDev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  return Math.round(Math.sqrt(variance) * 100) / 100;
}

/**
 * Generate a fallback lineage ID for unmatched signals.
 * Uses category + simplified title to create a deterministic ID.
 */
function generateFallbackLineage(category, signalTitle) {
  // Strip numbers, dollar signs, percentages, dates, punctuation
  const normalized = signalTitle.toLowerCase()
    .replace(/\$[\d,.]+/g, '')
    .replace(/[\d,.]+%/g, '')
    .replace(/\d{4}-\d{2}-\d{2}/g, '')
    .replace(/\d+/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

  // Simple hash for deterministic ID
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash) + normalized.charCodeAt(i);
    hash |= 0;
  }
  const hexHash = Math.abs(hash).toString(16).slice(0, 8).toUpperCase();

  const catPrefix = (category || 'unknown').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10);
  return {
    lineage_id: `${catPrefix}-ORPHAN-${hexHash}`,
    canonical_name: signalTitle.slice(0, 80)
  };
}

// ─── Trace File Discovery ───────────────────────────────────────────────────

/**
 * Find all cognitive trace files, sorted chronologically by filename timestamp.
 */
function discoverTraceFiles(dataDir) {
  const files = fs.readdirSync(dataDir)
    .filter(f => f.startsWith('cognitive-trace-') && f.endsWith('.json'))
    .sort(); // Filenames contain ISO timestamps, so alpha sort = chrono sort
  log('io', `Found ${files.length} cognitive trace files`);
  return files.map(f => path.join(dataDir, f));
}

// ─── Signal Extraction ──────────────────────────────────────────────────────

/**
 * Extract the fields we need from a single signal in a trace.
 */
function extractAppearance(signal, runTimestamp, injectedCalibration) {
  const perception = signal.perception || {};
  const scored = (signal.contextualization || {}).scored || {};
  const judgment = signal.judgment || {};
  const finalMatrix = judgment.final_signal_matrix || {};

  // Gate violation counts per layer
  const gateViolationsByLayer = {
    L1: ((signal.perception_gate || {}).violations || []).length,
    L2: ((signal.contextualization_gate || {}).violations || []).length,
    L3: ((signal.inference_gate || {}).violations || []).length,
    L4: ((signal.judgment_gate || {}).violations || []).length
  };

  // Corrections applied — extract just the IDs
  const corrections = (signal.corrections_applied || []).map(c => c.correction_id).filter(Boolean);

  return {
    run_timestamp: runTimestamp,
    signal_ids: signal.signal_ids || [],

    // L1 perception (raw evidence — needed for Δ Evidence)
    l1_evidence: [perception.evidence || '', perception.description || ''].filter(Boolean).join(' | '),
    l1_direction: perception.direction || null,
    l1_severity: perception.severity || null,
    l1_confidence: perception.confidence || null,
    l1_category: perception.category || null,

    // L2 contextualization (scored assessment)
    weighted_severity: scored.weighted_severity != null ? scored.weighted_severity : null,
    severity: scored.severity != null ? scored.severity : null,
    confidence: scored.confidence || null,
    source_tier: scored.source_tier || null,
    knowledge_verified: scored.knowledge_verified || null,
    l2_reasoning: scored.reasoning || null,

    // L4 judgment
    final_composite: finalMatrix.final_composite != null ? finalMatrix.final_composite : null,
    l4_confidence: finalMatrix.confidence || null,
    l4_adjustment_direction: finalMatrix.adjustment_direction || null,
    rejected: signal.judgment.rejection != null,

    // Cross-layer metadata
    corrections_applied: corrections,
    gate_violations_by_layer: gateViolationsByLayer,
    outcome: signal.outcome || null,
    acquisition_source: signal.acquisition_source || null,
    acquisition_survival: signal.acquisition_survival || null,
    injected_calibration: injectedCalibration || null,

    // These get computed after chronological sort within lineage
    evidence_changed: null,
    reasoning_diff: null
  };
}

// ─── Main Assembly ──────────────────────────────────────────────────────────

/**
 * Assemble signal dossiers from all cognitive trace files.
 *
 * @param {object} options — optional overrides for paths
 * @returns {object} — the assembled dossier data
 */
function assembleSignalDossiers(options) {
  const opts = options || {};
  const dataDir = opts.dataDir || DATA_DIR;
  const aliasPath = opts.aliasPath || ALIAS_PATH;
  const outputPath = opts.outputPath || OUTPUT_PATH;

  // Load alias dictionary
  const { aliases, sortedKeys } = loadAliases(ALIAS_PATH, log);

  // Discover trace files (already in chronological order)
  const traceFiles = discoverTraceFiles(dataDir);
  if (traceFiles.length === 0) {
    warn('assembly', 'No cognitive trace files found — nothing to assemble');
    return { lineages: [], _assembled_at: new Date().toISOString(), _trace_count: 0 };
  }

  // Phase 1: Read all traces, extract signals, assign to lineages
  const lineageMap = {}; // lineage_id → { canonical_name, category, appearances[] }
  let totalSignals = 0;
  let aliasMatches = 0;
  let orphans = 0;

  for (const traceFile of traceFiles) {
    let trace;
    try {
      trace = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
    } catch (e) {
      warn('io', `Failed to parse ${path.basename(traceFile)}: ${e.message}`);
      continue;
    }

    const runTimestamp = trace._run_timestamp || path.basename(traceFile).replace('cognitive-trace-', '').replace('.json', '');
    const injectedCalibration = trace._injected_calibration || null;
    const signals = trace.signals || [];

    for (const signal of signals) {
      totalSignals++;
      const perception = signal.perception || {};
      const signalTitle = perception.signal || 'UNKNOWN';
      const category = perception.category || 'unknown';

      // Match to lineage
      let lineageInfo = matchAlias(signalTitle, aliases, sortedKeys);
      if (lineageInfo) {
        aliasMatches++;
      } else {
        lineageInfo = generateFallbackLineage(category, signalTitle);
        orphans++;
      }

      const { lineage_id, canonical_name } = lineageInfo;

      // Initialize lineage if new
      if (!lineageMap[lineage_id]) {
        lineageMap[lineage_id] = {
          lineage_id,
          canonical_name,
          category,
          first_seen: runTimestamp,
          last_seen: runTimestamp,
          appearances: []
        };
      }

      // Update last_seen
      lineageMap[lineage_id].last_seen = runTimestamp;

      // Extract and store appearance
      const appearance = extractAppearance(signal, runTimestamp, injectedCalibration);
      lineageMap[lineage_id].appearances.push(appearance);
    }
  }

  log('assembly', `Processed ${totalSignals} signals from ${traceFiles.length} traces`);
  log('assembly', `Alias matches: ${aliasMatches}, Orphans: ${orphans}`);
  log('assembly', `Lineages: ${Object.keys(lineageMap).length}`);

  // Phase 2: Sort appearances chronologically within each lineage,
  // then compute evidence_changed and reasoning_diff
  const lineages = Object.values(lineageMap);

  for (const lineage of lineages) {
    // Sort by run_timestamp ascending (oldest first)
    lineage.appearances.sort((a, b) => a.run_timestamp.localeCompare(b.run_timestamp));
    lineage.appearance_count = lineage.appearances.length;

    for (let i = 0; i < lineage.appearances.length; i++) {
      const current = lineage.appearances[i];

      if (i === 0) {
        // First appearance — no previous to compare
        current.evidence_changed = null;
        current.reasoning_diff = null;
        continue;
      }

      const prev = lineage.appearances[i - 1];

      // evidence_changed: did the raw L1 evidence text change?
      current.evidence_changed = current.l1_evidence !== prev.l1_evidence;

      // reasoning_diff: pre-computed diffWords between adjacent L2 reasoning
      if (prev.l2_reasoning && current.l2_reasoning) {
        try {
          const diff = diffWords(prev.l2_reasoning, current.l2_reasoning);
          // Store as array of { value, added?, removed? } — same format diff package outputs
          current.reasoning_diff = diff.map(part => {
            const entry = { value: part.value };
            if (part.added) entry.added = true;
            if (part.removed) entry.removed = true;
            return entry;
          });
        } catch (e) {
          warn('diff', `diffWords failed for lineage ${lineage.lineage_id} at ${current.run_timestamp}: ${e.message}`);
          current.reasoning_diff = null;
        }
      } else {
        current.reasoning_diff = null;
      }
    }
  }

  // Phase 3: AD #21 — Compute per-lineage track records (earned signal confidence)
  // Pure deterministic math on historical data. No AI judgment.
  // Four metrics per lineage: survival_rate, average_drift, correction_frequency, confidence_accuracy
  for (const lineage of lineages) {
    const apps = lineage.appearances;
    if (apps.length < 2) {
      lineage.track_record = null; // Not enough history to compute
      continue;
    }

    // survival_rate: % of appearances that were NOT rejected by Layer 4
    const withJudgment = apps.filter(a => a.rejected != null);
    const survived = withJudgment.filter(a => a.rejected === false);
    const survivalRate = withJudgment.length > 0
      ? Math.round((survived.length / withJudgment.length) * 100) / 100
      : null;

    // average_drift: mean of (weighted_severity - final_composite) across appearances
    // Positive = L2 overscores relative to L4. Negative = L2 underscores.
    const driftPairs = apps.filter(a => a.weighted_severity != null && a.final_composite != null);
    let averageDrift = null;
    if (driftPairs.length > 0) {
      const totalDrift = driftPairs.reduce((sum, a) => sum + (a.weighted_severity - a.final_composite), 0);
      averageDrift = Math.round((totalDrift / driftPairs.length) * 100) / 100;
    }

    // correction_frequency: % of appearances where at least one correction fired
    const withCorrections = apps.filter(a => (a.corrections_applied || []).length > 0);
    const correctionFrequency = Math.round((withCorrections.length / apps.length) * 100) / 100;

    // Most common corrections (for telemetry)
    // Count appearances where each correction fired (not total firings)
    const correctionAppearances = {};
    for (const a of apps) {
      const uniqueInApp = new Set(a.corrections_applied || []);
      for (const cid of uniqueInApp) {
        correctionAppearances[cid] = (correctionAppearances[cid] || 0) + 1;
      }
    }
    const topCorrections = Object.entries(correctionAppearances)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, count]) => ({ id, count, frequency: Math.round((count / apps.length) * 100) / 100 }));

    // confidence_accuracy: how often stated confidence aligned with actual outcome
    // HIGH confidence + survived = ACCURATE
    // HIGH confidence + rejected = OVERCONFIDENT
    // LOW confidence + survived = UNDERCONFIDENT
    // LOW confidence + rejected = ACCURATE (correctly uncertain)
    // MEDIUM is neutral — not counted as mismatch either way
    let confAccurate = 0;
    let confTotal = 0;
    let overconfidentCount = 0;
    let underconfidentCount = 0;
    for (const a of apps) {
      if (!a.confidence || a.rejected == null) continue;
      const conf = (a.confidence || '').toUpperCase();
      if (conf === 'HIGH') {
        confTotal++;
        if (a.rejected === false) confAccurate++;
        else overconfidentCount++;
      } else if (conf === 'LOW') {
        confTotal++;
        if (a.rejected === true) confAccurate++;
        else underconfidentCount++;
      }
      // MEDIUM is not counted — it's the neutral zone
    }
    const confidenceAccuracy = confTotal > 0
      ? Math.round((confAccurate / confTotal) * 100) / 100
      : null;

    // Severity range (for overcorrection monitoring — AD #21 bias test)
    const severities = apps.map(a => a.weighted_severity).filter(s => s != null);
    const severityRange = severities.length > 1
      ? { min: Math.min(...severities), max: Math.max(...severities), std: computeStdDev(severities) }
      : null;

    lineage.track_record = {
      appearance_count: apps.length,
      survival_rate: survivalRate,
      average_drift: averageDrift,
      correction_frequency: correctionFrequency,
      confidence_accuracy: confidenceAccuracy,
      overconfident_count: overconfidentCount,
      underconfident_count: underconfidentCount,
      top_corrections: topCorrections,
      severity_range: severityRange
    };
  }

  // Phase 4: Sort lineages by appearance count descending (most persistent first)
  lineages.sort((a, b) => b.appearance_count - a.appearance_count);

  // Build output
  const output = {
    _assembled_at: new Date().toISOString(),
    _trace_count: traceFiles.length,
    _total_signals: totalSignals,
    _alias_matches: aliasMatches,
    _orphan_signals: orphans,
    _lineage_count: lineages.length,
    lineages
  };

  // Write output
  try {
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    log('io', `Wrote ${lineages.length} lineages to ${path.basename(outputPath)}`);
  } catch (e) {
    err('io', `Failed to write output: ${e.message}`);
  }

  return output;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  log('cli', 'Signal Dossier Aggregator — AD #20 Phase 1 + AD #21 Phase 1');
  log('cli', 'Pure deterministic. No AI judgment.');

  const result = assembleSignalDossiers();

  // Print summary
  console.log('\n=== SIGNAL DOSSIER SUMMARY ===');
  console.log(`Traces processed: ${result._trace_count}`);
  console.log(`Total signals: ${result._total_signals}`);
  console.log(`Alias matches: ${result._alias_matches} (${(result._alias_matches / result._total_signals * 100).toFixed(1)}%)`);
  console.log(`Orphans: ${result._orphan_signals}`);
  console.log(`Lineages: ${result._lineage_count}`);

  // Track record summary (AD #21)
  const withTrackRecord = (result.lineages || []).filter(l => l.track_record);
  console.log(`\n=== AD #21 TRACK RECORDS (${withTrackRecord.length} lineages) ===`);
  if (withTrackRecord.length > 0) {
    // Show lineages with lowest survival rates (most overscored)
    const bySurvival = withTrackRecord
      .filter(l => l.track_record.survival_rate != null)
      .sort((a, b) => a.track_record.survival_rate - b.track_record.survival_rate);
    if (bySurvival.length > 0) {
      console.log('Lowest survival rates (L2 overscoring):');
      bySurvival.slice(0, 5).forEach(l => {
        const tr = l.track_record;
        console.log(`  ${l.canonical_name}: ${(tr.survival_rate * 100).toFixed(0)}% survival, drift=${tr.average_drift}, corr=${(tr.correction_frequency * 100).toFixed(0)}%`);
      });
    }
    // Show lineages with confidence accuracy issues
    const overconfident = withTrackRecord.filter(l => l.track_record.overconfident_count > 0);
    const underconfident = withTrackRecord.filter(l => l.track_record.underconfident_count > 0);
    if (overconfident.length > 0 || underconfident.length > 0) {
      console.log(`Confidence mismatches: ${overconfident.length} overconfident, ${underconfident.length} underconfident`);
    }
  }

  // Top 10 lineages by appearance count
  console.log('\n=== TOP 10 LINEAGES ===');
  (result.lineages || []).slice(0, 10).forEach((l, i) => {
    console.log(`  ${i + 1}. ${l.canonical_name} (${l.appearance_count} appearances, ${l.category})`);
  });

  // Orphan lineages
  const orphanLineages = (result.lineages || []).filter(l => l.lineage_id.includes('-ORPHAN-'));
  if (orphanLineages.length > 0) {
    console.log(`\n=== ORPHAN LINEAGES (${orphanLineages.length}) — review for alias dictionary ===`);
    orphanLineages.slice(0, 15).forEach(l => {
      console.log(`  ${l.lineage_id}: "${l.canonical_name}" (${l.appearance_count}x)`);
    });
    if (orphanLineages.length > 15) {
      console.log(`  ... and ${orphanLineages.length - 15} more`);
    }
  }
}

module.exports = { assembleSignalDossiers };
