#!/usr/bin/env node
'use strict';

/**
 * x402 Cognitive Bandwidth Pattern Detectors — AD #17
 *
 * Four deterministic detectors that identify cognitive acquisition patterns.
 * These are Layer A triggers — they wake the Blind Auditor (Gemini)
 * to make the judgment call. They do not make decisions.
 *
 * Each detector returns a finding object or null.
 * The wrapper aggregates all findings for the auditor.
 *
 * Domain-agnostic. Pure deterministic code. No AI calls.
 * The Integrity Protocol (Patent Pending) — Timothy Joseph Wrenn
 */

const path = require('path');
const fs   = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) { /* silent */ }
  return null;
}

/**
 * Build a finding object matching the Blind Auditor's mismatch format.
 */
function finding(type, severity, detail) {
  return { type, severity, detail, source: 'AD17_COGNITIVE_DETECTOR', timestamp: new Date().toISOString() };
}

// ─── Detector 1: Inquiry Scope Creep ──────────────────────────────────────────

/**
 * Average token_budget_allocated consistently near the cap while
 * outcome distribution skews toward NO_CHANGE. The system is
 * formulating questions at maximum complexity without producing
 * analytical value.
 *
 * Requires: acquisition outcomes with token_budget_allocated and outcome fields.
 *
 * @param {object} outcomesData — { outcomes: [...] }
 * @param {object} domainConfig — Domain config with acquisition_token_cap_per_request
 * @returns {object|null} Finding or null
 */
function detectInquiryScopeCreep(outcomesData, domainConfig) {
  if (!outcomesData || !Array.isArray(outcomesData.outcomes)) return null;

  const tokenCap = domainConfig.acquisition_token_cap_per_request || 2000;
  const recent = outcomesData.outcomes.slice(-20); // Last 20 outcomes
  if (recent.length < 5) return null; // Need minimum sample

  // Check: average token budget >= 90% of cap
  const avgBudget = recent.reduce((sum, o) => sum + (o.token_budget_allocated || 0), 0) / recent.length;
  const budgetRatio = avgBudget / tokenCap;
  if (budgetRatio < 0.9) return null;

  // Check: NO_CHANGE outcomes >= 50%
  const noChangeCount = recent.filter(o => o.outcome === 'NO_CHANGE').length;
  const noChangeRatio = noChangeCount / recent.length;
  if (noChangeRatio < 0.5) return null;

  return finding(
    'INQUIRY_SCOPE_CREEP',
    'MEDIUM',
    `Token budget averaging ${Math.round(budgetRatio * 100)}% of cap (${Math.round(avgBudget)}/${tokenCap}) while ${Math.round(noChangeRatio * 100)}% of outcomes are NO_CHANGE. System may be formulating overly complex questions without analytical value.`
  );
}

// ─── Detector 2: Structural Gap Neglect ───────────────────────────────────────

/**
 * Multiple promotable_if conditions may have changed but no escalations
 * occurred. The system is ignoring signals that its blind spots may
 * have become observable.
 *
 * Detection: structural gaps exist with promotable_if fields, but
 * zero probing records in recent outcomes with source_channel
 * STRUCTURAL_GAP_PROBE. Requires multiple Sunday audits to have passed.
 *
 * @param {object} outcomesData — { outcomes: [...] }
 * @param {object} layer4Output — Has structural_gaps[]
 * @param {number} runCount — Number of runs in history (to check if enough Sundays passed)
 * @returns {object|null} Finding or null
 */
function detectStructuralGapNeglect(outcomesData, layer4Output, runCount) {
  if (!layer4Output) return null;

  const gaps = layer4Output.structural_gaps || [];
  const probableGaps = gaps.filter(g => g.promotable_if && g.promotable_if.trim() !== '');
  if (probableGaps.length === 0) return null;

  // Need at least 14 runs (~1 week, 2 Sundays) before flagging neglect
  if (runCount < 14) return null;

  // Check outcomes for any STRUCTURAL_GAP_PROBE records
  const outcomes = (outcomesData && Array.isArray(outcomesData.outcomes)) ? outcomesData.outcomes : [];
  const probeOutcomes = outcomes.filter(o => o.source_channel === 'STRUCTURAL_GAP_PROBE');

  if (probeOutcomes.length > 0) return null; // Probing has happened

  return finding(
    'STRUCTURAL_GAP_NEGLECT',
    'LOW',
    `${probableGaps.length} structural gap(s) have promotable_if conditions but zero probing records exist after ${runCount} runs. System may be ignoring opportunities to resolve observability limitations.`
  );
}

// ─── Detector 3: Question Recycling ───────────────────────────────────────────

/**
 * Acquisition requests targeting the same target_id across N+ consecutive
 * cycles without the underlying tension or gap status changing. Detection
 * is based on target_id matching, not string comparison of question text.
 *
 * @param {object} paperTradeLog — { requests: [...] } with target linkages
 * @param {object} domainConfig — Has question_recycling_threshold
 * @returns {object|null} Finding or null
 */
function detectQuestionRecycling(paperTradeLog, domainConfig) {
  if (!paperTradeLog || !Array.isArray(paperTradeLog.requests)) return null;

  const threshold = domainConfig.question_recycling_threshold || 3;
  const approved = paperTradeLog.requests.filter(r => r.disposition === 'APPROVED');
  if (approved.length < threshold) return null;

  // Group by target_id (tension_id or structural_gap_id)
  const targetCounts = new Map();
  for (const req of approved) {
    const targetId = req.tension_id || req.structural_gap_id || null;
    if (!targetId) continue;
    targetCounts.set(targetId, (targetCounts.get(targetId) || 0) + 1);
  }

  // Find targets exceeding threshold
  const recycled = [];
  for (const [targetId, count] of targetCounts) {
    if (count >= threshold) {
      recycled.push({ targetId, count });
    }
  }

  if (recycled.length === 0) return null;

  const details = recycled.map(r => `${r.targetId} (${r.count}x)`).join(', ');
  return finding(
    'QUESTION_RECYCLING',
    'MEDIUM',
    `Acquisition requests targeting the same ID across ${threshold}+ cycles without status change: ${details}. System may be stuck in an acquisition loop — escalate to a new angle or close the tension.`
  );
}

// ─── Detector 4: Acquisition Dormancy ─────────────────────────────────────────

/**
 * Zero approved acquisition requests for N+ consecutive cycles. In a
 * dynamic environment, there are always gaps. If the system stops
 * asking questions entirely, it usually means the materiality threshold
 * is set too high or the system has become overly confident.
 *
 * Dormancy is a pathological state, not a healthy equilibrium.
 * Fires a mandatory Blind Auditor review.
 *
 * @param {object} paperTradeLog — { requests: [...] }
 * @param {object} domainConfig — Has acquisition_dormancy_threshold
 * @returns {object|null} Finding or null
 */
function detectAcquisitionDormancy(paperTradeLog, domainConfig) {
  if (!paperTradeLog || !Array.isArray(paperTradeLog.requests)) return null;

  const threshold = domainConfig.acquisition_dormancy_threshold || 4;

  // Count consecutive recent cycles with zero approved requests
  // Requests are appended chronologically. Walk backwards counting
  // consecutive non-APPROVED entries until we hit an APPROVED one.
  const requests = paperTradeLog.requests;
  if (requests.length === 0) return null;

  // Group requests by their run timestamp (approximate by request_id prefix)
  // Request IDs: ACQ-L[layer]-[timestamp]-[seq]
  const runTimestamps = new Set();
  const approvedTimestamps = new Set();

  for (const req of requests) {
    // Extract timestamp from request_id: ACQ-L2-2026-03-22T22-56-34-963Z-001
    const parts = (req.request_id || '').split('-');
    // Timestamp starts at index 2, ends before the last element (seq)
    if (parts.length >= 4) {
      const ts = parts.slice(2, -1).join('-');
      runTimestamps.add(ts);
      if (req.disposition === 'APPROVED') {
        approvedTimestamps.add(ts);
      }
    }
  }

  // Convert to sorted arrays (newest last)
  const allRuns = Array.from(runTimestamps).sort();

  // Count consecutive runs from the end with zero approved
  let dormantRuns = 0;
  for (let i = allRuns.length - 1; i >= 0; i--) {
    if (approvedTimestamps.has(allRuns[i])) break;
    dormantRuns++;
  }

  if (dormantRuns < threshold) return null;

  return finding(
    'ACQUISITION_DORMANCY',
    'HIGH',
    `Zero approved acquisition requests for ${dormantRuns} consecutive cycles (threshold: ${threshold}). System may have become overly confident in existing information or materiality threshold may be too high. Mandatory review.`
  );
}

// ─── Wrapper ──────────────────────────────────────────────────────────────────

/**
 * Run all four cognitive bandwidth detectors.
 * Returns array of findings (may be empty).
 *
 * @param {object} paperTradeLog — Paper trade log
 * @param {object} layer4Output — Latest Layer 4 output
 * @param {object} domainConfig — Domain configuration
 * @param {number} runCount — Number of runs in history
 * @returns {Array} Array of finding objects
 */
function detectCognitiveBehavior(paperTradeLog, layer4Output, domainConfig, runCount) {
  const outcomesPath = path.join(DATA_DIR, 'acquisition-outcomes.json');
  const outcomesData = loadJSON(outcomesPath);

  const findings = [
    detectInquiryScopeCreep(outcomesData, domainConfig),
    detectStructuralGapNeglect(outcomesData, layer4Output, runCount || 0),
    detectQuestionRecycling(paperTradeLog, domainConfig),
    detectAcquisitionDormancy(paperTradeLog, domainConfig)
  ].filter(Boolean);

  return findings;
}

module.exports = { detectCognitiveBehavior };
