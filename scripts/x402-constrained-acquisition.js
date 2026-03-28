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

/**
 * Route an acquisition request to the best matching channel.
 * Matches request source_category against channel capabilities.
 * Returns the channel with the most specific capability match,
 * or null if no channel can serve the request.
 *
 * @param {object} request       — Paper trade request with source_category
 * @param {Array}  channels      — acquisition_channels from domain config
 * @returns {object|null} matched channel, or null
 */
function routeToChannel(request, channels) {
  if (!channels || channels.length === 0) return null;

  const category = (request.source_category || '').toLowerCase();
  if (!category || category === 'unknown') return null;

  // Filter to enabled channels only
  const enabled = channels.filter(c => c.enabled !== false);
  if (enabled.length === 0) return null;

  // Score each channel: count how many of its capabilities match the request category
  let bestChannel = null;
  let bestScore = 0;

  for (const ch of enabled) {
    const caps = (ch.capabilities || []).map(c => c.toLowerCase());
    // Direct match: category appears in capabilities
    if (caps.includes(category)) {
      // Prefer direct match with highest specificity
      const score = 2;
      if (score > bestScore) { bestScore = score; bestChannel = ch; }
    }
    // Partial match: category contains a capability keyword or vice versa
    for (const cap of caps) {
      if (category.includes(cap) || cap.includes(category)) {
        const score = 1;
        if (score > bestScore) { bestScore = score; bestChannel = ch; }
      }
    }
  }

  return bestChannel;
}

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

  // Step 1: Filter to APPROVED requests that haven't been fulfilled yet
  const approved = paperTradeLog.requests.filter(r => r.disposition === 'APPROVED' && r.purchase_executed !== true);
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
      // AD #19: Multi-chain routing
      channel_id: null,
      settlement_network: null,
      cost_usd: 0,
      signal_ids: req.signal_ids || [],
      outcome: null,
      outcome_evidence: null,
      _constrained_at: opts.runTimestamp || new Date().toISOString()
    };

    // AD #19: Route to acquisition channel
    const channels = (domainConfig.acquisition_channels) || [];
    const matchedChannel = routeToChannel(req, channels);
    if (matchedChannel) {
      constrainedRequest.channel_id = matchedChannel.id;
      constrainedRequest.settlement_network = matchedChannel.network;
      constrainedRequest.cost_usd = matchedChannel.cost_per_request_usd || 0;
    }

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

  // Build lookups: tension_id → disposition and score from Layer 4
  const tensionDispositions = new Map();
  const tensionScores = new Map();
  if (layer4Output) {
    const prevDispositions = layer4Output.previous_tension_dispositions || [];
    for (const d of prevDispositions) {
      if (d.tension_id && d.disposition) {
        tensionDispositions.set(d.tension_id, d.disposition);
      }
      if (d.tension_id && d.new_impact_score !== undefined) {
        tensionScores.set(d.tension_id, d.new_impact_score);
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

    // Tension-targeted outcome classification (deterministic)
    // Uses Layer 4 disposition data instead of stale cross-run signal_id matching
    if (req.source_channel === 'TENSION_WATCH_FOR' && req.target_id) {
      const disposition = tensionDispositions.get(req.target_id);
      const currentScore = tensionScores.get(req.target_id);

      if (disposition === 'RESOLVE') {
        outcomeClass = 'TENSION_RESOLVED';
      } else if (disposition === 'ESCALATE') {
        outcomeClass = 'SURVIVED';
      } else if (disposition === 'MAINTAIN') {
        if (currentScore !== undefined && req.previous_impact_score !== undefined
            && currentScore !== req.previous_impact_score) {
          outcomeClass = 'SURVIVED';
        } else {
          outcomeClass = 'CONFIRMED';
        }
      } else if (!disposition) {
        outcomeClass = 'GENERATED';
      }
    }

    // Note: GAP_PROMOTED is set by Phase 3 (structural gap probing).
    // TRANSFORMED requires comparing Layer 2 score vs Layer 4 weight —
    // deferred to Phase 4 when trace integration is deeper.

    // Build outcome record
    const outcomeRecord = {
      request_id: req.request_id,
      run_trace_id: opts.runTimestamp || new Date().toISOString(),
      source_channel: req.source_channel,
      target_id: req.target_id,
      intended_epistemic_vector: req.intended_epistemic_vector,
      token_budget_allocated: req.token_budget_allocated,
      priority_rank: req.priority_rank,
      economic_cost_approved: req.economic_cost_approved,
      channel_id: req.channel_id || null,
      settlement_network: req.settlement_network || null,
      outcome: outcomeClass,
      outcome_evidence: outcomeClass === 'TENSION_RESOLVED'
        ? `Tension ${req.target_id} received RESOLVE disposition`
        : outcomeClass === 'SURVIVED'
          ? `Tension ${req.target_id} disposition: ${tensionDispositions.get(req.target_id) || 'SCORE_DELTA'}`
          : outcomeClass === 'CONFIRMED'
            ? `Tension ${req.target_id} maintained — baseline verified by acquisition`
            : outcomeClass === 'GENERATED'
              ? `Tension ${req.target_id} not in current cycle — new analytical output may have been generated`
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

  // Mark processed requests as fulfilled in the paper trade log
  const ptPath = opts.paperTradePath || path.join(DATA_DIR, 'x402-paper-trades.json');
  try {
    if (fs.existsSync(ptPath)) {
      const ptLog = JSON.parse(fs.readFileSync(ptPath, 'utf8'));
      const outcomeMap = new Map();
      for (const req of constrainedRequests) {
        const recorded = data.outcomes.find(o => o.request_id === req.request_id && o._recorded_at);
        outcomeMap.set(req.request_id, recorded ? recorded.outcome : 'NO_CHANGE');
      }
      let fulfilled = 0;
      for (const req of ptLog.requests) {
        if (outcomeMap.has(req.request_id) && !req.purchase_executed) {
          req.purchase_executed = true;
          req.purchase_result = outcomeMap.get(req.request_id);
          fulfilled++;
        }
      }
      if (fulfilled > 0) {
        fs.writeFileSync(ptPath, JSON.stringify(ptLog, null, 2));
        log('outcomes', `Marked ${fulfilled} request(s) as purchase_executed in paper trade log.`);
      }
    }
  } catch (ptErr) {
    warn('outcomes', `Paper trade log writeback failed (non-fatal): ${ptErr.message}`);
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

// ─── probeStructuralGaps ───────────────────────────────────────────────────────

/**
 * Active probing of structural data gaps. Converts promotable_if conditions
 * into testable hypotheses at configured cadence.
 *
 * Default cadence: sunday_audit (configured in domain.json).
 * Individual gaps can be escalated to next_cycle when external signals
 * suggest the promotable_if condition may have been met.
 *
 * NOT_OBSERVABLE gaps (data_availability) are excluded from probing.
 * Gaps without promotable_if are excluded (nothing to test).
 * Gaps with empty blocks_assessment (when present) receive zero probing
 * bandwidth — orphaned unobservables.
 *
 * @param {object} layer4Output    — Layer 4 reconcile result (has structural_gaps[])
 * @param {object} domainConfig    — Domain configuration
 * @param {object} [opts]          — Optional overrides
 * @param {boolean} [opts.isSundayAudit] — Force Sunday audit cadence check
 * @param {Array}   [opts.escalatedGapIds] — Gap IDs escalated to next_cycle
 * @returns {object} { probing_records: [...], total_gaps: N, eligible: N, probed: N, excluded_reasons: {} }
 */
function probeStructuralGaps(layer4Output, domainConfig, opts = {}) {
  const result = {
    probing_records: [],
    total_gaps: 0,
    eligible: 0,
    probed: 0,
    excluded_reasons: {},
    _probed_at: new Date().toISOString()
  };

  // Get structural gaps from Layer 4 output
  const gaps = (layer4Output && layer4Output.structural_gaps) || [];
  result.total_gaps = gaps.length;

  if (gaps.length === 0) {
    log('probe', 'No structural gaps in Layer 4 output.');
    return result;
  }

  // Determine cadence
  const configCadence = domainConfig.structural_gap_probe_cadence || 'sunday_audit';
  const isSunday = opts.isSundayAudit !== undefined
    ? opts.isSundayAudit
    : new Date().getUTCDay() === 0;
  const escalatedIds = new Set(opts.escalatedGapIds || []);

  // Track exclusion reasons
  function exclude(reason) {
    result.excluded_reasons[reason] = (result.excluded_reasons[reason] || 0) + 1;
  }

  for (const gap of gaps) {
    // Exclusion: no promotable_if — nothing to test
    if (!gap.promotable_if || gap.promotable_if.trim() === '') {
      exclude('no_promotable_if');
      continue;
    }

    // Exclusion: NOT_OBSERVABLE data_availability (if field exists)
    if (gap.data_availability === 'NOT_OBSERVABLE') {
      exclude('not_observable');
      continue;
    }

    // Exclusion: empty blocks_assessment array (if field exists)
    // When blocks_assessment is present and empty, the gap is an orphaned
    // unobservable that blocks no downstream index. Zero probing bandwidth.
    if (Array.isArray(gap.blocks_assessment) && gap.blocks_assessment.length === 0) {
      exclude('orphaned_unobservable');
      continue;
    }

    // Cadence check: sunday_audit default, or escalated to next_cycle
    const isEscalated = escalatedIds.has(gap.gap_id);
    if (configCadence === 'sunday_audit' && !isSunday && !isEscalated) {
      exclude('cadence_not_met');
      continue;
    }

    // Gap is eligible for probing
    result.eligible++;

    // Build probing record
    const probingRecord = {
      gap_id: gap.gap_id,
      description: gap.description || '',
      promotable_if: gap.promotable_if,
      source_channel: 'STRUCTURAL_GAP_PROBE',
      // Convert promotable_if into a falsifiable question
      falsifiable_question: `Has the following condition been met: ${gap.promotable_if}`,
      intended_epistemic_vector: 'INFORM',
      cadence: isEscalated ? 'next_cycle' : configCadence,
      escalated: isEscalated,
      // blocks_assessment pass-through for downstream priority ordering
      blocks_assessment: gap.blocks_assessment || null,
      _probed_at: new Date().toISOString()
    };

    result.probing_records.push(probingRecord);
    result.probed++;
  }

  if (result.probed > 0) {
    log('probe', `Probed ${result.probed} of ${result.total_gaps} structural gaps (${result.eligible} eligible). Exclusions: ${JSON.stringify(result.excluded_reasons)}`);
  } else {
    log('probe', `No gaps eligible for probing this cycle. ${result.total_gaps} total gaps. Exclusions: ${JSON.stringify(result.excluded_reasons)}`);
  }

  return result;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { constrainRequests, recordOutcomes, probeStructuralGaps };
