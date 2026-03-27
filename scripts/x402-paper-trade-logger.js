#!/usr/bin/env node
'use strict';

/**
 * x402 Paper Trade Logger — Acquisition Request Tracking
 *
 * Extracts structured acquisition requests from Layer 2 (knowledge gaps)
 * and Layer 3 (intelligence gaps), assigns deterministic request_ids,
 * and appends to data/x402-paper-trades.json.
 *
 * Also handles post-Layer-4 disposition writeback — Layer 4 declares
 * APPROVED/DENIED/DEFERRED for each request, this module writes those
 * dispositions back to the log.
 *
 * Pure deterministic code. No AI calls. Domain-agnostic.
 * The Integrity Protocol (Patent Pending) — Timothy Joseph Wrenn
 */

const path = require('path');
const fs   = require('fs');

const PAPER_TRADE_PATH = path.join(__dirname, '..', 'data', 'x402-paper-trades.json');

function log(msg)  { console.log(`[x402-logger] ${msg}`); }
function warn(msg) { console.warn(`[x402-logger] WARN: ${msg}`); }

// ─── Log Initialization ────────────────────────────────────────────────────

/**
 * Initialize or load the paper trade log.
 * Budget values come from domainConfig, not hardcoded.
 *
 * @param {object} domainConfig — domain.json contents
 * @param {string} [logPath]   — override path for evolution isolation
 * @returns {object}
 */
function loadOrInitLog(domainConfig, logPath) {
  const p = logPath || PAPER_TRADE_PATH;
  const budget = (domainConfig && domainConfig.x402_budget) || {};

  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      warn(`Failed to parse ${p}: ${e.message}. Initializing fresh.`);
    }
  }

  return {
    _version: '1.0',
    _last_updated: new Date().toISOString(),
    budget: {
      cycle_limit_drops: budget.cycle_limit_drops || 5000,
      weekly_limit_drops: budget.weekly_limit_drops || 25000,
      cycle_spent_drops: 0,
      weekly_spent_drops: 0,
      cycle_start: new Date().toISOString(),
      week_start: new Date().toISOString(),
    },
    requests: [],
    vendor_confidence: {},
  };
}

// ─── Request ID Generation ─────────────────────────────────────────────────

/**
 * Generate a deterministic request_id.
 * Format: ACQ-L[layer]-[timestamp]-[sequence]
 * Code assigns this, not the LLM. Same principle as signal_ids.
 *
 * @param {number} layer     — 2 or 3
 * @param {string} timestamp — ISO run timestamp
 * @param {number} sequence  — 1-based index within this layer's requests
 * @returns {string}
 */
function generateRequestId(layer, timestamp, sequence) {
  const ts = timestamp.replace(/[:.]/g, '-');
  return `ACQ-L${layer}-${ts}-${String(sequence).padStart(3, '0')}`;
}

// ─── Request Extraction ────────────────────────────────────────────────────

/**
 * Extract acquisition requests from Layer 2 unscored_signals.
 * Layer 2 identifies KNOWLEDGE gaps — "I don't understand the thesis
 * well enough to score this signal."
 *
 * @param {object} layer2Output — _layer2_raw from the pipeline
 * @param {string} runTimestamp — ISO timestamp of the current run
 * @returns {Array}
 */
function extractLayer2Requests(layer2Output, runTimestamp) {
  const requests = [];
  const unscored = (layer2Output && layer2Output.unscored_signals) || [];

  for (let i = 0; i < unscored.length; i++) {
    const u = unscored[i];
    requests.push({
      request_id: generateRequestId(2, runTimestamp, i + 1),
      requesting_layer: 2,
      request_type: 'KNOWLEDGE_GAP',
      signal_ids: Array.isArray(u.signal_ids) ? u.signal_ids : [],
      tension_id: null,
      structural_gap_id: null,
      description: u.knowledge_needed || u.reason || u.signal || 'Unspecified knowledge gap',
      intended_epistemic_vector: u.intended_epistemic_vector || 'INFORM',
      expected_impact_score: Number.isInteger(u.expected_impact_score) ? u.expected_impact_score : 3,
      urgency: u.urgency || 'NEXT_CYCLE',
      source_category: u.source_category || 'unknown',
      preferred_vendor: null,
      estimated_cost_drops: 0,
      timestamp: runTimestamp,
      disposition: null,
      disposition_reasoning: null,
      dispositioned_by: null,
      dispositioned_at: null,
      purchase_executed: false,
      purchase_result: null,
      channel_id: null,
      settlement_network: null,
    });
  }

  return requests;
}

/**
 * Extract acquisition requests from Layer 3 x402_paper_trades.
 * Layer 3 identifies INTELLIGENCE gaps — "I understand the thesis
 * but need data to complete this inference."
 *
 * @param {object} layer3Output — _layer3_raw from the pipeline
 * @param {string} runTimestamp — ISO timestamp of the current run
 * @returns {Array}
 */
function extractLayer3Requests(layer3Output, runTimestamp) {
  const requests = [];
  const trades = (layer3Output && layer3Output.x402_paper_trades) || [];

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    requests.push({
      request_id: generateRequestId(3, runTimestamp, i + 1),
      requesting_layer: 3,
      request_type: 'INTELLIGENCE_GAP',
      signal_ids: Array.isArray(t.signal_ids) ? t.signal_ids : [],
      tension_id: null,
      structural_gap_id: null,
      description: t.question || 'Unspecified intelligence gap',
      intended_epistemic_vector: t.intended_epistemic_vector || 'INFORM',
      expected_impact_score: Number.isInteger(t.expected_impact_score) ? t.expected_impact_score : 3,
      urgency: t.urgency || 'NEXT_CYCLE',
      source_category: t.source_category || 'unknown',
      preferred_vendor: t.data_source || null,
      estimated_cost_drops: 0,
      timestamp: runTimestamp,
      _l3_impact_on_analysis: t.impact_on_analysis || null,
      _l3_confidence_data_exists: t.confidence_data_exists || null,
      _l3_estimated_value: t.estimated_value || null,
      disposition: null,
      disposition_reasoning: null,
      dispositioned_by: null,
      dispositioned_at: null,
      purchase_executed: false,
      purchase_result: null,
      channel_id: null,
      settlement_network: null,
    });
  }

  return requests;
}

// ─── Paper Trade Logging (Post-Layer-3) ────────────────────────────────────

/**
 * Log acquisition requests from a pipeline run.
 * Called AFTER Layer 3 completes, BEFORE Layer 4.
 * Layer 4 needs to see these requests to disposition them.
 *
 * @param {object} layer2Output — _layer2_raw from the pipeline
 * @param {object} layer3Output — _layer3_raw from the pipeline
 * @param {string} runTimestamp — ISO timestamp of the current run
 * @param {object} domainConfig — domain.json contents
 * @param {string} [logPath]   — override path for evolution isolation
 * @returns {object} { requests_logged, request_ids, log_path }
 */
function logPaperTrades(layer2Output, layer3Output, runTimestamp, domainConfig, logPath) {
  const p = logPath || PAPER_TRADE_PATH;

  log('=== x402 PAPER TRADE LOGGER ===');

  const tradeLog = loadOrInitLog(domainConfig, p);
  const l2Requests = extractLayer2Requests(layer2Output, runTimestamp);
  const l3Requests = extractLayer3Requests(layer3Output, runTimestamp);
  const allRequests = [...l2Requests, ...l3Requests];

  if (allRequests.length === 0) {
    log('No acquisition requests this run.');
    return { requests_logged: 0, request_ids: [], log_path: p };
  }

  tradeLog.requests.push(...allRequests);
  tradeLog._last_updated = new Date().toISOString();

  // Retention cap from config
  const retention = (domainConfig && domainConfig.x402_paper_trade_retention) || 200;
  if (tradeLog.requests.length > retention) {
    tradeLog.requests = tradeLog.requests.slice(-retention);
  }

  fs.writeFileSync(p, JSON.stringify(tradeLog, null, 2));

  const requestIds = allRequests.map(r => r.request_id);
  log(`Logged ${l2Requests.length} Layer 2 (knowledge) + ${l3Requests.length} Layer 3 (intelligence) = ${allRequests.length} requests.`);

  return { requests_logged: allRequests.length, request_ids: requestIds, log_path: p };
}

// ─── Disposition Writeback (Post-Layer-4) ──────────────────────────────────

/**
 * Apply Layer 4's acquisition dispositions back to the paper trade log.
 * Called AFTER Layer 4 completes.
 *
 * Layer 4 produces an acquisition_dispositions array in its output:
 *   [{ request_id, disposition, reasoning, tension_id?, structural_gap_id? }]
 *
 * This function matches request_ids and writes the disposition,
 * reasoning, and lifecycle linkages back to the log entries.
 *
 * @param {object} layer4Output — _layer4_raw from the pipeline
 * @param {object} domainConfig — domain.json contents
 * @param {string} [logPath]   — override path for evolution isolation
 * @returns {object} { dispositions_applied }
 */
function applyDispositions(layer4Output, domainConfig, logPath) {
  const p = logPath || PAPER_TRADE_PATH;

  const dispositions = (layer4Output && layer4Output.acquisition_dispositions) || [];
  if (dispositions.length === 0) {
    log('No acquisition dispositions from Layer 4.');
    return { dispositions_applied: 0 };
  }

  if (!fs.existsSync(p)) {
    warn('Paper trade log not found — cannot apply dispositions.');
    return { dispositions_applied: 0 };
  }

  const tradeLog = JSON.parse(fs.readFileSync(p, 'utf8'));
  let applied = 0;

  for (const d of dispositions) {
    if (!d.request_id) continue;

    const entry = tradeLog.requests.find(r => r.request_id === d.request_id);
    if (!entry) {
      warn(`Disposition for ${d.request_id} — request not found in log.`);
      continue;
    }

    if (entry.disposition !== null) {
      warn(`Disposition for ${d.request_id} — already dispositioned as ${entry.disposition}. Skipping.`);
      continue;
    }

    entry.disposition = d.disposition || 'DENIED';
    entry.disposition_reasoning = d.reasoning || null;
    entry.dispositioned_by = 'layer_4';
    entry.dispositioned_at = new Date().toISOString();

    // Layer 4 links the request to the tension lifecycle
    if (d.tension_id) entry.tension_id = d.tension_id;
    if (d.structural_gap_id) entry.structural_gap_id = d.structural_gap_id;

    applied++;
  }

  tradeLog._last_updated = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(tradeLog, null, 2));

  log(`Applied ${applied}/${dispositions.length} dispositions to paper trade log.`);
  return { dispositions_applied: applied };
}

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = { logPaperTrades, applyDispositions, loadOrInitLog };
