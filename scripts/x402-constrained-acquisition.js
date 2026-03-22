#!/usr/bin/env node
'use strict';

/**
 * Constrained Knowledge Acquisition Engine — AD #17
 *
 * Epistemological restraint on inquiry. Constrains HOW the system
 * acts on approved acquisition requests. Does not override Layer 4's
 * judgment about WHAT matters — that judgment was already made.
 *
 * Two exported functions:
 *   constrainRequests — Filters approved paper trades through cognitive
 *                       bandwidth constraints. Applies materiality threshold,
 *                       token cap, per-cycle limit, priority ranking.
 *                       Classifies source channel. Produces constrained
 *                       acquisition request records.
 *
 *   recordOutcomes    — Maps trace blind-tagging results to acquisition
 *                       outcome classifications. Writes to acquisition-outcomes.json.
 *                       Enforces retention cap.
 *
 * Pipeline integration point:
 *   L3 → paper trade logger → L4 → disposition writeback →
 *   ** constrained acquisition engine ** → x402 agent
 *
 * Two cost dimensions (independent):
 *   Economic cost:   x402 drops (existing, inherited)
 *   Cognitive cost:  token cap per request (new, AD #17)
 *
 * The Integrity Protocol (Patent Pending) — Timothy Joseph Wrenn
 */

const path = require('path');
const fs   = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTCOMES_PATH = path.join(DATA_DIR, 'acquisition-outcomes.json');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(label, msg) { console.log(`[acq-${label}] ${msg}`); }
function warn(label, msg) { console.warn(`[acq-${label}] ⚠️ ${msg}`); }

/**
 * Load acquisition outcomes from disk.
 * Returns { _version, outcomes: [] } or a fresh structure if missing/corrupt.
 */
function loadOutcomes(outcomesPath) {
  const p = outcomesPath || OUTCOMES_PATH;
  try {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (data && Array.isArray(data.outcomes)) return data;
    }
  } catch (e) {
    warn('io', `Failed to load outcomes: ${e.message}. Starting fresh.`);
  }
  return { _version: '1.0', _description: 'AD #17: Constrained Knowledge Acquisition outcome tracking.', outcomes: [] };
}

/**
 * Save acquisition outcomes to disk.
 */
function saveOutcomes(data, outcomesPath) {
  const p = outcomesPath || OUTCOMES_PATH;
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

/**
 * Classify source channel from paper trade request fields.
 *
 * Channel A: TENSION_WATCH_FOR — request linked to an active tension
 * Channel B: STRUCTURAL_GAP_PROBE — request linked to a structural gap
 * Channel C: KNOWLEDGE_GAP — Layer 2/3 knowledge gap (including compound index data_gaps)
 */
function classifySourceChannel(request) {
  if (request.tension_id && request.tension_id !== null) {
    return 'TENSION_WATCH_FOR';
  }
  if (request.structural_gap_id && request.structural_gap_id !== null) {
    return 'STRUCTURAL_GAP_PROBE';
  }
  return 'KNOWLEDGE_GAP';
}

/**
 * Derive target_id from the paper trade request.
 * Uses tension_id, structural_gap_id, or falls back to request_id.
 */
function deriveTargetId(request) {
  if (request.tension_id && request.tension_id !== null) return request.tension_id;
  if (request.structural_gap_id && request.structural_gap_id !== null) return request.structural_gap_id;
  // Fallback: use request_id itself as target (Layer 2/3 knowledge gaps
  // without explicit tension/gap linkage)
  return request.request_id || 'UNKNOWN';
}

/**
 * Compute priority rank for an approved request.
 * Higher impact_score + more urgent = lower rank number (higher priority).
 *
 * Urgency multiplier: IMMEDIATE = 2, NEXT_CYCLE = 1.
 * Score: impact_score * urgency_multiplier.
 * Ties broken by original request order (stable sort).
 */
function computePriorityScore(request) {
  const impact = request.expected_impact_score || 1;
  const urgencyMultiplier = (request.urgency === 'IMMEDIATE') ? 2 : 1;
  return impact * urgencyMultiplier;
}

// ─── constrainRequests ────────────────────────────────────────────────────────

/**
 * Filters approved paper trade requests through cognitive bandwidth constraints.
 *
 * @param {object} paperTradeLog   — Full paper trade log ({ requests: [...] })
 * @param {object} domainConfig    — Domain configuration with AD #17 fields
 * @param {object} [opts]          — Optional overrides
 * @param {string} [opts.outcomesPath] — Custom outcomes path (for evolution isolation)
 * @param {string} [opts.runTimestamp] — Pipeline run timestamp
 * @returns {object} { constrained_requests: [...], total_approved: N, total_constrained: N, rejected_by_materiality: N, rejected_by_cap: N }
 */
function constrainRequests(paperTradeLog, domainConfig, opts = {}) {
  const result = {
    constrained_requests: [],
    total_approved: 0,
    total_constrained: 0,
    rejected_by_materiality: 0,
    rejected_by_cap: 0,
    _constrained_at: new Date().toISOString()
  };

  if (!paperTradeLog || !Array.isArray(paperTradeLog.requests)) {
    warn('constrain', 'No paper trade log or empty requests array. Nothing to constrain.');
    return result;
  }

  // Read config with defaults
  const tokenCap = domainConfig.acquisition_token_cap_per_request || 2000;
  const maxPerCycle = domainConfig.acquisition_max_requests_per_cycle || 5;
  const materialityThreshold = domainConfig.acquisition_materiality_threshold || 3;

  // Step 1: Filter to APPROVED requests only
  const approved = paperTradeLog.requests.filter(r => r.disposition === 'APPROVED');
  result.total_approved = approved.length;

  if (approved.length === 0) {
    log('constrain', 'No APPROVED acquisition requests this cycle.');
    return result;
  }

  log('constrain', `${approved.length} APPROVED request(s) to constrain.`);

  // Step 2: Apply materiality threshold
  // Channel A (tensions) use expected_impact_score directly.
  // Channel B (structural gaps) will use blocks_assessment in Phase 3.
  // Channel C (knowledge gaps) use expected_impact_score.
  const materialFiltered = [];
  for (const req of approved) {
    const impact = req.expected_impact_score || 0;
    if (impact >= materialityThreshold) {
      materialFiltered.push(req);
    } else {
      result.rejected_by_materiality++;
      log('constrain', `Rejected ${req.request_id}: impact ${impact} < threshold ${materialityThreshold}`);
    }
  }

  if (materialFiltered.length === 0) {
    log('constrain', 'All approved requests below materiality threshold.');
    return result;
  }

  // Step 3: Priority rank by impact_score × urgency
  const ranked = materialFiltered
    .map((req, idx) => ({ req, score: computePriorityScore(req), originalIdx: idx }))
    .sort((a, b) => b.score - a.score || a.originalIdx - b.originalIdx);

  // Step 4: Apply per-cycle cap
  const capped = ranked.slice(0, maxPerCycle);
  result.rejected_by_cap = ranked.length - capped.length;

  if (result.rejected_by_cap > 0) {
    log('constrain', `Per-cycle cap (${maxPerCycle}): ${result.rejected_by_cap} request(s) deferred.`);
  }

  // Step 5: Build constrained acquisition request records
  for (let i = 0; i < capped.length; i++) {
    const { req } = capped[i];
    const sourceChannel = classifySourceChannel(req);
    const targetId = deriveTargetId(req);

    const constrainedRequest = {
      request_id: req.request_id,
      source_channel: sourceChannel,
      target_id: targetId,
      // falsifiable_question: not generated here — this is the deterministic
      // constraint engine. The question formulation happens when the x402 agent
      // actually executes (or during the Sunday audit for structural gap probes).
      // For now, we record what the request asked for.
      description: req.description || req.request_type || '',
      intended_epistemic_vector: req.intended_epistemic_vector || 'INFORM',
      token_budget_allocated: tokenCap,
      priority_rank: i + 1,
      economic_cost_approved: req.approved_cost_drops || 0,
      signal_ids: req.signal_ids || [],
      outcome: null,
      outcome_evidence: null,
      _constrained_at: opts.runTimestamp || new Date().toISOString()
    };

    result.constrained_requests.push(constrainedRequest);
  }

  result.total_constrained = result.constrained_requests.length;
  log('constrain', `Constrained ${result.total_constrained} request(s). Priority 1: ${result.constrained_requests[0]?.request_id || 'none'}`);

  return result;
}

// ─── recordOutcomes ───────────────────────────────────────────────────────────

/**
 * Maps trace blind-tagging results to acquisition outcome classifications.
 * Writes updated outcomes to acquisition-outcomes.json.
 *
 * Outcome classifications (AD #17):
 *   SURVIVED           — Signal passed all four layers, influenced assessment
 *   STRIPPED            — Removed by burden of proof at Layer 4
 *   TRANSFORMED        — Survived but reweighted significantly
 *   TENSION_RESOLVED   — Acquisition directly resolved targeted tension
 *   GAP_PROMOTED       — Structural gap probing found promotable_if met
 *   NO_CHANGE          — Processed within budget, no measurable impact
 *
 * @param {Array} constrainedRequests — Output from constrainRequests
 * @param {object} traceOutput        — Cognitive trace output ({ signals: [...] })
 * @param {object} layer4Output       — Layer 4 reconcile result (for tension dispositions)
 * @param {object} domainConfig       — Domain configuration
 * @param {object} [opts]             — Optional overrides
 * @param {string} [opts.outcomesPath] — Custom outcomes path (for evolution isolation)
 * @returns {object} { outcomes_recorded: N, outcome_summary: { ... } }
 */
function recordOutcomes(constrainedRequests, traceOutput, layer4Output, domainConfig, opts = {}) {
  const outcomesPath = opts.outcomesPath || OUTCOMES_PATH;
  const result = { outcomes_recorded: 0, outcome_summary: {} };

  if (!constrainedRequests || constrainedRequests.length === 0) {
    log('outcomes', 'No constrained requests to record outcomes for.');
    return result;
  }

  const data = loadOutcomes(outcomesPath);
  const retentionCap = domainConfig.acquisition_outcome_retention || 200;

  // Build lookup: signal_id → trace entry outcome
  const traceOutcomes = new Map();
  if (traceOutput && Array.isArray(traceOutput.signals)) {
    for (const sig of traceOutput.signals) {
      if (Array.isArray(sig.signal_ids)) {
        for (const sid of sig.signal_ids) {
          traceOutcomes.set(sid, {
            outcome: sig.outcome,
            acquisition_survival: sig.acquisition_survival || null
          });
        }
      }
    }
  }

  // Build lookup: tension_id → disposition from Layer 4
  const tensionDispositions = new Map();
  if (layer4Output) {
    const prevDispositions = layer4Output.previous_tension_dispositions || [];
    for (const d of prevDispositions) {
      if (d.tension_id && d.disposition) {
        tensionDispositions.set(d.tension_id, d.disposition);
      }
    }
  }

  // Classify each constrained request's outcome
  for (const req of constrainedRequests) {
    let outcomeClass = 'NO_CHANGE';

    // Check if any of the request's signals appear in the trace
    const signalOutcomes = [];
    for (const sid of (req.signal_ids || [])) {
      const traceEntry = traceOutcomes.get(sid);
      if (traceEntry) signalOutcomes.push(traceEntry);
    }

    if (signalOutcomes.length > 0) {
      // Use the trace's acquisition_survival classification as primary signal
      const survivals = signalOutcomes.map(s => s.acquisition_survival).filter(Boolean);
      const pipelineOutcomes = signalOutcomes.map(s => s.outcome).filter(Boolean);

      if (survivals.includes('survived') || pipelineOutcomes.includes('SURVIVED') || pipelineOutcomes.includes('FLAGGED')) {
        outcomeClass = 'SURVIVED';
      } else if (survivals.includes('stripped') || pipelineOutcomes.includes('STRIPPED')) {
        outcomeClass = 'STRIPPED';
      } else if (survivals.includes('rejected') || pipelineOutcomes.includes('REJECTED')) {
        outcomeClass = 'STRIPPED';  // Rejected maps to STRIPPED for AD #17 purposes
      } else if (survivals.includes('pruned') || pipelineOutcomes.includes('PRUNED')) {
        outcomeClass = 'NO_CHANGE';  // Pruned = below severity threshold = no impact
      }
    }

    // Check for TENSION_RESOLVED: if this request targeted a tension that
    // received RESOLVE disposition this cycle
    if (req.source_channel === 'TENSION_WATCH_FOR' && req.target_id) {
      const disposition = tensionDispositions.get(req.target_id);
      if (disposition === 'RESOLVE') {
        outcomeClass = 'TENSION_RESOLVED';
      }
    }

    // Note: GAP_PROMOTED is set by Phase 3 (structural gap probing).
    // TRANSFORMED requires comparing Layer 2 score vs Layer 4 weight —
    // deferred to Phase 4 when trace integration is deeper.

    // Build outcome record
    const outcomeRecord = {
      request_id: req.request_id,
      source_channel: req.source_channel,
      target_id: req.target_id,
      intended_epistemic_vector: req.intended_epistemic_vector,
      token_budget_allocated: req.token_budget_allocated,
      priority_rank: req.priority_rank,
      economic_cost_approved: req.economic_cost_approved,
      outcome: outcomeClass,
      outcome_evidence: outcomeClass === 'TENSION_RESOLVED'
        ? `Tension ${req.target_id} received RESOLVE disposition`
        : outcomeClass === 'NO_CHANGE'
          ? 'No measurable impact on assessment'
          : `Signal pipeline outcome: ${outcomeClass}`,
      _recorded_at: new Date().toISOString()
    };

    data.outcomes.push(outcomeRecord);
    result.outcomes_recorded++;

    // Tally summary
    result.outcome_summary[outcomeClass] = (result.outcome_summary[outcomeClass] || 0) + 1;
  }

  // Enforce retention cap: keep newest
  if (data.outcomes.length > retentionCap) {
    const excess = data.outcomes.length - retentionCap;
    data.outcomes = data.outcomes.slice(excess);
    log('outcomes', `Retention cap (${retentionCap}): trimmed ${excess} oldest record(s).`);
  }

  // Write
  saveOutcomes(data, outcomesPath);
  log('outcomes', `Recorded ${result.outcomes_recorded} outcome(s): ${JSON.stringify(result.outcome_summary)}`);

  return result;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { constrainRequests, recordOutcomes };
