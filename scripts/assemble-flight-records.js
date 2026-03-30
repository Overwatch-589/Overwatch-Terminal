#!/usr/bin/env node
'use strict';

/**
 * Unified Flight Recorder Aggregator
 *
 * Pure deterministic code. No AI judgment. Same inputs = same chains.
 *
 * Builds learning event chains from four data sources:
 *   1. Corrections Ledger  → CORRECTION chains (error → rule → mitigation)
 *   2. Behavioral Calibration → CALIBRATION chains (pattern → entry → injection)
 *   3. Acquisition Outcomes → ACQUISITION chains (gap → payment → outcome)
 *   4. Gate Review Ledger   → GATE_PATTERN chains (violation accumulation → promotion)
 *
 * Universal node schema: CATALYST → SYNTHESIS → RESOLUTION → OBSERVATION
 * All chain types render through the same UI components.
 *
 * Constraints (Gemini cross-validation):
 *   - Acquisition chains join outcome records with x402 payment data for financial telemetry
 *   - All nodes strictly sorted chronologically within their chain
 *   - Correction RESOLUTION nodes carry the exact trace_id proving the mitigation fired
 *
 * Input:
 *   data/corrections-ledger.json
 *   data/behavioral-calibration.json
 *   data/acquisition-outcomes.json
 *   data/gate-review-ledger.json
 *   data/cognitive-trace-*.json    (for trace context enrichment)
 *   dashboard-data.json            (for XRPL x402 tx hashes)
 *
 * Output:
 *   data/flight-recorder-data.json
 *
 * The Integrity Protocol (Patent Pending) — Timothy Joseph Wrenn
 */

const path = require('path');
const fs   = require('fs');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const ROOT_DIR    = path.join(__dirname, '..');
const OUTPUT_PATH = path.join(DATA_DIR, 'flight-recorder-data.json');

// ─── Logging ────────────────────────────────────────────────────────────────

function log(label, msg) { console.log(`[flight-rec:${label}] ${msg}`); }
function warn(label, msg) { console.warn(`[flight-rec:${label}] ⚠️  ${msg}`); }

// ─── File Loaders ───────────────────────────────────────────────────────────

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

function loadTraceFiles() {
  const traces = [];
  try {
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => f.startsWith('cognitive-trace-') && f.endsWith('.json'))
      .sort(); // chronological by filename
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        traces.push(data);
      } catch (e) {
        warn('trace', `Failed to parse ${f}: ${e.message}`);
      }
    }
  } catch (e) {
    warn('trace', `Failed to read data directory: ${e.message}`);
  }
  return traces;
}

// ─── Trace Index ────────────────────────────────────────────────────────────
// Pre-build lookup: correction_id → [trace timestamps where it fired]

function buildCorrectionTraceIndex(traces) {
  const index = {}; // correction_id → [{ trace_id, layer, signal_ids }]
  for (const trace of traces) {
    const traceId = trace._run_timestamp || trace._assembled_at || '';
    if (!traceId || !Array.isArray(trace.signals)) continue;
    for (const sig of trace.signals) {
      const corrections = sig.corrections_applied || [];
      for (const c of corrections) {
        const cid = c.correction_id || c.id;
        if (!cid) continue;
        if (!index[cid]) index[cid] = [];
        index[cid].push({
          trace_id: traceId,
          layer: c.layer,
          signal_ids: sig.signal_ids || []
        });
      }
    }
  }
  return index;
}

// Pre-build lookup: rule_id → [{ trace_id, layer, finding, severity }]
function buildGateViolationIndex(gateReviewLedger) {
  const index = {}; // rule_id → [{ timestamp, layer, finding, severity }]
  for (const entry of gateReviewLedger) {
    const ts = entry.timestamp || '';
    const layer = entry.layer;
    const violations = (entry.gate_result && entry.gate_result.violations) || [];
    for (const v of violations) {
      const rule = v.rule_violated;
      if (!rule) continue;
      if (!index[rule]) index[rule] = [];
      index[rule].push({
        timestamp: ts,
        layer: layer,
        finding: (v.finding || '').slice(0, 200),
        severity: v.severity || 'UNKNOWN'
      });
    }
  }
  return index;
}

// ─── Chain Builders ─────────────────────────────────────────────────────────

function buildCorrectionChains(correctionsLedger, correctionTraceIndex) {
  const chains = [];

  for (const entry of correctionsLedger) {
    if (!entry.id) continue;

    const chain = {
      chain_id: `CHAIN-CORR-${entry.id.replace('CL-', '')}`,
      chain_type: 'CORRECTION',
      subject: `${entry.id}: ${(entry.lesson || '').slice(0, 80)}`,
      status: entry.status || 'ACTIVE',
      first_seen: entry.date_of_error || entry.date_identified || '',
      last_updated: entry.date_identified || '',
      linked_chains: [],
      source_data_file: 'corrections-ledger.json',
      nodes: []
    };

    // CATALYST — the error
    chain.nodes.push({
      node_id: `${entry.id}-CATALYST`,
      node_type: 'CATALYST',
      timestamp: entry.date_of_error || entry.date_identified || '',
      trace_id: null,
      summary: `Error identified: ${(entry.belief || '').slice(0, 120)}`,
      detail: entry.reality || '',
      telemetry: {
        cl_id: entry.id,
        root_cause_type: entry.root_cause_type || null,
        lesson_type: entry.lesson_type || null,
        belief: entry.belief || '',
        reality: entry.reality || '',
        identified_by: entry.identified_by || null
      }
    });

    // SYNTHESIS — the correction written
    chain.nodes.push({
      node_id: `${entry.id}-SYNTHESIS`,
      node_type: 'SYNTHESIS',
      timestamp: entry.date_identified || '',
      trace_id: null,
      summary: `Correction authored: ${(entry.lesson || '').slice(0, 120)}`,
      detail: entry.prevention || '',
      telemetry: {
        cl_id: entry.id,
        lesson: entry.lesson || '',
        trigger: entry.trigger || '',
        prevention: entry.prevention || '',
        confidence_in_lesson: entry.confidence_in_lesson || null
      }
    });

    // RESOLUTION nodes — each trace where this correction fired
    const firings = correctionTraceIndex[entry.id] || [];
    if (firings.length > 0) {
      // Deduplicate by trace_id (a correction can fire on multiple signals in one run)
      const uniqueTraces = new Map();
      for (const f of firings) {
        if (!uniqueTraces.has(f.trace_id)) {
          uniqueTraces.set(f.trace_id, f);
        }
      }

      const sortedFireings = Array.from(uniqueTraces.values())
        .sort((a, b) => a.trace_id.localeCompare(b.trace_id));

      // First firing is the RESOLUTION (proves mitigation works)
      const first = sortedFireings[0];
      chain.nodes.push({
        node_id: `${entry.id}-RESOLUTION`,
        node_type: 'RESOLUTION',
        timestamp: first.trace_id,
        trace_id: first.trace_id,
        summary: `${entry.id} fired in pipeline — mitigation confirmed (Layer ${first.layer})`,
        detail: `Applied in ${sortedFireings.length} run(s). Total times_applied: ${entry.times_applied || 0}`,
        telemetry: {
          cl_id: entry.id,
          times_applied: entry.times_applied || 0,
          first_fired_trace: first.trace_id,
          total_runs_fired: sortedFireings.length,
          fired_in_layers: [...new Set(firings.map(f => f.layer))].sort()
        }
      });

      // Update chain last_updated
      const lastFiring = sortedFireings[sortedFireings.length - 1];
      if (lastFiring.trace_id > chain.last_updated) {
        chain.last_updated = lastFiring.trace_id;
      }

      // Additional firings as OBSERVATION nodes (cap at 5 most recent)
      for (const f of sortedFireings.slice(1, 6)) {
        chain.nodes.push({
          node_id: `${entry.id}-OBS-${f.trace_id.slice(0, 19).replace(/[^0-9]/g, '')}`,
          node_type: 'OBSERVATION',
          timestamp: f.trace_id,
          trace_id: f.trace_id,
          summary: `${entry.id} fired again (Layer ${f.layer})`,
          detail: `Continued enforcement in subsequent run`,
          telemetry: {
            cl_id: entry.id,
            layer: f.layer
          }
        });
      }
    }

    // Strict chronological sort within chain
    chain.nodes.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

    chains.push(chain);
  }

  return chains;
}

function buildCalibrationChains(behavioralCalibration) {
  const chains = [];

  for (const entry of behavioralCalibration) {
    if (!entry.id) continue;

    const chain = {
      chain_id: `CHAIN-CAL-${entry.id.replace('BC-', '')}`,
      chain_type: 'CALIBRATION',
      subject: `${entry.id}: ${(entry.documented_tendency || '').slice(0, 80)}`,
      status: entry.status || 'CANDIDATE',
      first_seen: entry.created || '',
      last_updated: entry.last_updated || entry.created || '',
      linked_chains: [`CHAIN-GATE-${entry.source_rule || 'UNKNOWN'}`],
      source_data_file: 'behavioral-calibration.json',
      nodes: []
    };

    // CATALYST — pattern detection
    chain.nodes.push({
      node_id: `${entry.id}-CATALYST`,
      node_type: 'CATALYST',
      timestamp: entry.created || '',
      trace_id: null,
      summary: `Pattern detected: ${entry.source_rule || 'unknown rule'} — ${entry.frequency || '?'} runs`,
      detail: entry.documented_tendency || '',
      telemetry: {
        bc_id: entry.id,
        source_rule: entry.source_rule || null,
        target_layers: entry.target_layers || [],
        frequency: entry.frequency || null,
        magnitude: entry.magnitude || null,
        measurement_window: entry.measurement_window || null,
        signal_categories: entry.signal_categories || []
      }
    });

    // SYNTHESIS — entry created with directional guidance
    if (entry.directional_guidance) {
      chain.nodes.push({
        node_id: `${entry.id}-SYNTHESIS`,
        node_type: 'SYNTHESIS',
        timestamp: entry.created || '',
        trace_id: null,
        summary: `Calibration entry authored — directional guidance written`,
        detail: entry.directional_guidance || '',
        telemetry: {
          bc_id: entry.id,
          directional_guidance: entry.directional_guidance || '',
          overcorrection_metric: entry.overcorrection_metric || null,
          overcorrection_metric_layer: entry.overcorrection_metric_layer || null,
          overcorrection_watch: entry.overcorrection_watch || null
        }
      });
    }

    // RESOLUTION or OBSERVATION depending on status
    if (entry.status === 'ACTIVE') {
      chain.nodes.push({
        node_id: `${entry.id}-RESOLUTION`,
        node_type: 'RESOLUTION',
        timestamp: entry.last_updated || entry.created || '',
        trace_id: null,
        summary: `Promoted to ACTIVE — injecting into ${(entry.target_layers || []).join(', ')}`,
        detail: `Overcorrection watch: ${entry.overcorrection_metric || 'none'} at ${entry.overcorrection_metric_layer || '?'}`,
        telemetry: {
          bc_id: entry.id,
          status: 'ACTIVE',
          target_layers: entry.target_layers || [],
          overcorrection_metric: entry.overcorrection_metric || null,
          confidence: entry.confidence || null
        }
      });
    } else {
      chain.nodes.push({
        node_id: `${entry.id}-OBSERVATION`,
        node_type: 'OBSERVATION',
        timestamp: entry.last_updated || entry.created || '',
        trace_id: null,
        summary: `Status: ${entry.status} — awaiting promotion`,
        detail: entry.status === 'CANDIDATE'
          ? 'Requires Sunday audit review for promotion to ACTIVE'
          : `Current status: ${entry.status}`,
        telemetry: {
          bc_id: entry.id,
          status: entry.status || 'CANDIDATE',
          confidence: entry.confidence || null
        }
      });
    }

    // Strict chronological sort
    chain.nodes.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

    chains.push(chain);
  }

  return chains;
}

function buildAcquisitionChains(acquisitionOutcomes, dashboardData) {
  const chains = [];

  // Build XRPL tx lookup from dashboard-data.json
  const xrplTxLookup = {};
  try {
    const x402Agent = (dashboardData && dashboardData.x402_agent) || {};
    const transactions = x402Agent.transactions || [];
    for (const tx of transactions) {
      if (tx.tx_hash && tx.label) {
        xrplTxLookup[tx.label] = tx;
      }
    }
  } catch (e) {
    warn('xrpl', `Failed to build XRPL tx lookup: ${e.message}`);
  }

  const outcomes = (acquisitionOutcomes && acquisitionOutcomes.outcomes) || [];

  for (const outcome of outcomes) {
    if (!outcome.request_id) continue;

    const chain = {
      chain_id: `CHAIN-ACQ-${outcome.request_id}`,
      chain_type: 'ACQUISITION',
      subject: `${outcome.request_id}: ${outcome.source_channel || 'unknown'} → ${outcome.channel_id || 'unrouted'}`,
      status: outcome.outcome || 'PENDING',
      first_seen: outcome._constrained_at || outcome._recorded_at || '',
      last_updated: outcome._recorded_at || '',
      linked_chains: [],
      source_data_file: 'acquisition-outcomes.json',
      nodes: []
    };

    // CATALYST — gap or tension identified
    chain.nodes.push({
      node_id: `${outcome.request_id}-CATALYST`,
      node_type: 'CATALYST',
      timestamp: outcome._constrained_at || outcome._recorded_at || '',
      trace_id: null,
      summary: `${outcome.source_channel || 'Unknown source'}: ${outcome.target_id || 'no target'}`,
      detail: `Epistemic vector: ${outcome.intended_epistemic_vector || 'INFORM'}. Priority rank: ${outcome.priority_rank || '?'}`,
      telemetry: {
        request_id: outcome.request_id,
        source_channel: outcome.source_channel || null,
        target_id: outcome.target_id || null,
        intended_epistemic_vector: outcome.intended_epistemic_vector || null,
        token_budget_allocated: outcome.token_budget_allocated || null,
        priority_rank: outcome.priority_rank || null
      }
    });

    // SYNTHESIS — payment executed
    // Join with x402 payment data for financial telemetry
    const xrplTx = xrplTxLookup[outcome.channel_id] || null;
    const txHash = outcome.tx_hash || (xrplTx && xrplTx.tx_hash) || null;
    const actualCost = outcome.cost_usd_actual || outcome.economic_cost_approved || 0;
    const paymentMethod = outcome.payment_method || (xrplTx ? 'XRPL_MAINNET' : null);

    chain.nodes.push({
      node_id: `${outcome.request_id}-SYNTHESIS`,
      node_type: 'SYNTHESIS',
      timestamp: outcome._recorded_at || '',
      trace_id: null,
      summary: `${outcome.channel_id || 'unrouted'} — $${actualCost} ${outcome.settlement_network || 'unknown network'}`,
      detail: txHash ? `tx: ${txHash}` : 'No transaction hash recorded',
      telemetry: {
        request_id: outcome.request_id,
        channel_id: outcome.channel_id || null,
        settlement_network: outcome.settlement_network || null,
        cost_usd: actualCost,
        tx_hash: txHash,
        payment_method: paymentMethod,
        economic_cost_approved: outcome.economic_cost_approved || 0
      }
    });

    // RESOLUTION — outcome classified
    chain.nodes.push({
      node_id: `${outcome.request_id}-RESOLUTION`,
      node_type: 'RESOLUTION',
      timestamp: outcome._recorded_at || '',
      trace_id: null,
      summary: `Outcome: ${outcome.outcome || 'PENDING'}`,
      detail: outcome.outcome_evidence || '',
      telemetry: {
        request_id: outcome.request_id,
        outcome: outcome.outcome || null,
        outcome_evidence: outcome.outcome_evidence || null
      }
    });

    // Strict chronological sort
    chain.nodes.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

    chains.push(chain);
  }

  return chains;
}

function buildGatePatternChains(gateViolationIndex, behavioralCalibration) {
  const chains = [];

  // Build BC lookup: source_rule → BC entry
  const bcByRule = {};
  for (const bc of behavioralCalibration) {
    if (bc.source_rule) {
      bcByRule[bc.source_rule] = bc;
    }
  }

  // Only build chains for rules with significant violation counts
  const MINIMUM_VIOLATIONS = 10;

  for (const [ruleId, violations] of Object.entries(gateViolationIndex)) {
    if (violations.length < MINIMUM_VIOLATIONS) continue;

    const sorted = violations.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];

    // Count by layer
    const byLayer = {};
    for (const v of violations) {
      const lKey = `L${v.layer}`;
      byLayer[lKey] = (byLayer[lKey] || 0) + 1;
    }

    const promotedTo = bcByRule[ruleId] || null;

    const chain = {
      chain_id: `CHAIN-GATE-${ruleId}`,
      chain_type: 'GATE_PATTERN',
      subject: `${ruleId}: ${violations.length} violations across ${Object.keys(byLayer).join(', ')}`,
      status: promotedTo ? `PROMOTED → ${promotedTo.id}` : 'ACCUMULATING',
      first_seen: first.timestamp || '',
      last_updated: last.timestamp || '',
      linked_chains: promotedTo ? [`CHAIN-CAL-${promotedTo.id.replace('BC-', '')}`] : [],
      source_data_file: 'gate-review-ledger.json',
      nodes: []
    };

    // CATALYST — first violation instance
    chain.nodes.push({
      node_id: `${ruleId}-CATALYST`,
      node_type: 'CATALYST',
      timestamp: first.timestamp || '',
      trace_id: first.timestamp || null,
      summary: `First ${ruleId} violation detected (Layer ${first.layer})`,
      detail: first.finding || '',
      telemetry: {
        rule_id: ruleId,
        layer: first.layer,
        severity: first.severity || null,
        finding: first.finding || ''
      }
    });

    // OBSERVATION — accumulation summary
    chain.nodes.push({
      node_id: `${ruleId}-OBSERVATION`,
      node_type: 'OBSERVATION',
      timestamp: last.timestamp || '',
      trace_id: null,
      summary: `${violations.length} total violations accumulated`,
      detail: `By layer: ${Object.entries(byLayer).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
      telemetry: {
        rule_id: ruleId,
        total_violations: violations.length,
        by_layer: byLayer,
        first_seen: first.timestamp || '',
        last_seen: last.timestamp || '',
        unique_runs: new Set(violations.map(v => (v.timestamp || '').slice(0, 19))).size
      }
    });

    // RESOLUTION — if promoted to calibration entry
    if (promotedTo) {
      chain.nodes.push({
        node_id: `${ruleId}-RESOLUTION`,
        node_type: 'RESOLUTION',
        timestamp: promotedTo.created || '',
        trace_id: null,
        summary: `Promoted to calibration entry ${promotedTo.id} (${promotedTo.status})`,
        detail: promotedTo.documented_tendency || '',
        telemetry: {
          rule_id: ruleId,
          promoted_to: promotedTo.id,
          calibration_status: promotedTo.status || null,
          target_layers: promotedTo.target_layers || [],
          directional_guidance: promotedTo.directional_guidance || null
        }
      });
    }

    // Strict chronological sort
    chain.nodes.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

    chains.push(chain);
  }

  return chains;
}

// ─── Main Assembly ──────────────────────────────────────────────────────────

function assembleFlightRecords() {
  log('start', 'Assembling unified flight recorder data...');

  // Load all data sources
  const correctionsLedger = loadJSON(path.join(DATA_DIR, 'corrections-ledger.json'), []);
  const behavioralCalibration = loadJSON(path.join(DATA_DIR, 'behavioral-calibration.json'), []);
  const acquisitionOutcomes = loadJSON(path.join(DATA_DIR, 'acquisition-outcomes.json'), { outcomes: [] });
  const gateReviewLedger = loadJSON(path.join(DATA_DIR, 'gate-review-ledger.json'), []);
  const dashboardData = loadJSON(path.join(ROOT_DIR, 'dashboard-data.json'), {});

  log('load', `Corrections: ${correctionsLedger.length}, Calibrations: ${behavioralCalibration.length}, Outcomes: ${(acquisitionOutcomes.outcomes || []).length}, Gate entries: ${gateReviewLedger.length}`);

  // Load trace files for correction enrichment
  const traces = loadTraceFiles();
  log('load', `Loaded ${traces.length} cognitive trace files`);

  // Build indices
  const correctionTraceIndex = buildCorrectionTraceIndex(traces);
  const gateViolationIndex = buildGateViolationIndex(gateReviewLedger);
  log('index', `Correction firings indexed for ${Object.keys(correctionTraceIndex).length} entries. Gate violations indexed for ${Object.keys(gateViolationIndex).length} rules.`);

  // Build chains
  const correctionChains = buildCorrectionChains(correctionsLedger, correctionTraceIndex);
  const calibrationChains = buildCalibrationChains(behavioralCalibration);
  const acquisitionChains = buildAcquisitionChains(acquisitionOutcomes, dashboardData);
  const gatePatternChains = buildGatePatternChains(gateViolationIndex, behavioralCalibration);

  log('build', `Chains: ${correctionChains.length} correction, ${calibrationChains.length} calibration, ${acquisitionChains.length} acquisition, ${gatePatternChains.length} gate pattern`);

  // Assemble output
  const allChains = [
    ...correctionChains,
    ...calibrationChains,
    ...acquisitionChains,
    ...gatePatternChains
  ];

  // Sort chains by last_updated descending (most recent activity first)
  allChains.sort((a, b) => (b.last_updated || '').localeCompare(a.last_updated || ''));

  const output = {
    _version: '1.0',
    _description: 'Unified Flight Recorder — Learning event chains across all four loops',
    _assembled_at: new Date().toISOString(),
    _chain_counts: {
      correction: correctionChains.length,
      calibration: calibrationChains.length,
      acquisition: acquisitionChains.length,
      gate_pattern: gatePatternChains.length,
      total: allChains.length
    },
    chains: allChains
  };

  // Write output
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  log('done', `Wrote ${allChains.length} chains to ${path.basename(OUTPUT_PATH)} (${(fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1)} KB)`);

  return output;
}

// ─── CLI or Module ──────────────────────────────────────────────────────────

if (require.main === module) {
  const result = assembleFlightRecords();

  // Summary
  console.log('\n=== FLIGHT RECORDER SUMMARY ===');
  console.log(`Total chains: ${result._chain_counts.total}`);
  console.log(`  CORRECTION:   ${result._chain_counts.correction}`);
  console.log(`  CALIBRATION:  ${result._chain_counts.calibration}`);
  console.log(`  ACQUISITION:  ${result._chain_counts.acquisition}`);
  console.log(`  GATE_PATTERN: ${result._chain_counts.gate_pattern}`);

  // Show chains with RESOLUTION nodes (proven mitigations)
  const resolved = result.chains.filter(c => c.nodes.some(n => n.node_type === 'RESOLUTION'));
  console.log(`\nChains with RESOLUTION (proven mitigation): ${resolved.length}`);
  for (const c of resolved.slice(0, 10)) {
    const res = c.nodes.find(n => n.node_type === 'RESOLUTION');
    console.log(`  ${c.chain_id}: ${res.summary.slice(0, 80)}`);
  }
}

module.exports = { assembleFlightRecords };
