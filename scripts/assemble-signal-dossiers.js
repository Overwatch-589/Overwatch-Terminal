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

const DATA_DIR    = path.join(__dirname, '..', 'data');
const CONFIG_DIR  = path.join(__dirname, '..', 'config');
const ALIAS_PATH  = path.join(CONFIG_DIR, 'signal-aliases.json');
const OUTPUT_PATH = path.join(DATA_DIR, 'signal-dossier-data.json');

// ─── Logging ────────────────────────────────────────────────────────────────

function log(area, msg)  { console.log(`[dossier:${area}] ${msg}`); }
function warn(area, msg) { console.warn(`[dossier:${area}] ⚠ ${msg}`); }
function err(area, msg)  { console.error(`[dossier:${area}] ✖ ${msg}`); }

// ─── Alias Dictionary ───────────────────────────────────────────────────────

/**
 * Load the signal alias dictionary and return keys sorted longest-first.
 * Longest-match-first prevents substring collisions:
 * "blackrock etf" matches before "blackrock" can steal it.
 */
function loadAliases() {
  try {
    if (!fs.existsSync(ALIAS_PATH)) {
      warn('aliases', 'No signal-aliases.json found — all signals will be orphans');
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
    // Sort by length descending — longest match wins
    keys.sort((a, b) => b.length - a.length);
    log('aliases', `Loaded ${keys.length} alias keys → ${new Set(keys.map(k => aliases[k].lineage_id)).size} lineage IDs`);
    return { aliases, sortedKeys: keys };
  } catch (e) {
    err('aliases', `Failed to load aliases: ${e.message}`);
    return { aliases: {}, sortedKeys: [] };
  }
}

/**
 * Match a signal title to a lineage using the alias dictionary.
 * Returns { lineage_id, canonical_name } or null if no match.
 */
function matchAlias(signalTitle, aliases, sortedKeys) {
  const lower = signalTitle.toLowerCase();
  for (const key of sortedKeys) {
    if (lower.includes(key)) {
      return aliases[key];
    }
  }
  return null;
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
  const { aliases, sortedKeys } = loadAliases();

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

  // Phase 3: Sort lineages by appearance count descending (most persistent first)
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
  log('cli', 'Signal Dossier Aggregator — AD #20 Phase 1');
  log('cli', 'Pure deterministic. No AI judgment.');

  const result = assembleSignalDossiers();

  // Print summary
  console.log('\n=== SIGNAL DOSSIER SUMMARY ===');
  console.log(`Traces processed: ${result._trace_count}`);
  console.log(`Total signals: ${result._total_signals}`);
  console.log(`Alias matches: ${result._alias_matches} (${(result._alias_matches / result._total_signals * 100).toFixed(1)}%)`);
  console.log(`Orphans: ${result._orphan_signals}`);
  console.log(`Lineages: ${result._lineage_count}`);

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
