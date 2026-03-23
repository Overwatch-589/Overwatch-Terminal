#!/usr/bin/env node
'use strict';

/**
 * Calibration Suppression Detectors — AD #16 Phase 4
 *
 * Monitors active behavioral calibration entries for overcorrection.
 * Called by the Blind Auditor alongside spending pattern detectors.
 *
 * Three suppression failure modes (from AD #16 design):
 *   1. Signal suppression — rejection/flagged rate spikes post-calibration
 *   2. Confidence collapse — INSUFFICIENT_EVIDENCE spikes in calibrated categories
 *   3. Stat gaming — violation frequency drops but analysis quality degrades
 *
 * Each active calibration entry carries:
 *   overcorrection_metric — which telemetry gauge to watch
 *   overcorrection_metric_layer — which layer to measure
 *   overcorrection_threshold_override — entry-specific threshold (null = global default)
 *
 * The Integrity Protocol (Patent Pending) — Timothy Joseph Wrenn
 */

const path = require('path');
const fs   = require('fs');

function log(msg) { console.log(`[suppression] ${msg}`); }
function warn(msg) { console.warn(`[suppression] ⚠️ ${msg}`); }

// ─── Metric Computation from Trace Data ──────────────────────────────────────

/**
 * Compute overcorrection metrics from a cognitive trace.
 *
 * Returns: {
 *   L1: { SIGNAL_REJECTION_RATE: N, SIGNAL_FLAGGED_RATE: N, ... },
 *   L2: { ... }, L3: { ... }, L4: { ... },
 *   overall: { ... }
 * }
 */
function computeTraceMetrics(trace) {
  const metrics = {
    L1: {}, L2: {}, L3: {}, L4: {},
    overall: {}
  };

  if (!trace || !Array.isArray(trace.signals)) return metrics;

  const totalSignals = trace.signals.length;
  if (totalSignals === 0) return metrics;

  // Count outcomes
  const outcomes = trace._outcomes || {};
  metrics.overall.SIGNAL_REJECTION_RATE = (outcomes.REJECTED || 0) / totalSignals;
  metrics.overall.SIGNAL_STRIPPED_RATE = (outcomes.STRIPPED || 0) / totalSignals;
  metrics.overall.SIGNAL_FLAGGED_RATE = (outcomes.FLAGGED || 0) / totalSignals;

  // Count per-layer gate violations by rule
  const layerGateNames = {
    L1: 'perception_gate',
    L2: 'contextualization_gate',
    L3: 'inference_gate',
    L4: 'judgment_gate'
  };

  const violationsByRuleByLayer = {};

  for (const signal of trace.signals) {
    for (const [layer, gateName] of Object.entries(layerGateNames)) {
      const gate = signal[gateName];
      if (!gate || !Array.isArray(gate.violations)) continue;

      if (!violationsByRuleByLayer[layer]) violationsByRuleByLayer[layer] = {};

      for (const v of gate.violations) {
        const rule = v.rule_violated;
        if (!rule) continue;
        violationsByRuleByLayer[layer][rule] = (violationsByRuleByLayer[layer][rule] || 0) + 1;
      }
    }

    // Count INSUFFICIENT_EVIDENCE from Layer 2 contextualization
    if (signal.contextualization?.unscored?.gap_type ||
        signal.contextualization?.knowledge_audit?.gap_type) {
      metrics.L2.INSUFFICIENT_EVIDENCE_COUNT =
        (metrics.L2.INSUFFICIENT_EVIDENCE_COUNT || 0) + 1;
    }
  }

  // Store violation counts per layer
  for (const [layer, rules] of Object.entries(violationsByRuleByLayer)) {
    metrics[layer].violations_by_rule = rules;
    metrics[layer].total_violations = Object.values(rules).reduce((sum, c) => sum + c, 0);
  }

  // Compute INSUFFICIENT_EVIDENCE_RATE
  metrics.L2.INSUFFICIENT_EVIDENCE_RATE =
    (metrics.L2.INSUFFICIENT_EVIDENCE_COUNT || 0) / totalSignals;
  metrics.L3.INSUFFICIENT_EVIDENCE_RATE = metrics.L2.INSUFFICIENT_EVIDENCE_RATE;

  // Copy overall rates to each layer (some metrics are signal-level, not layer-level)
  for (const layer of ['L1', 'L2', 'L3', 'L4']) {
    metrics[layer].SIGNAL_REJECTION_RATE = metrics.overall.SIGNAL_REJECTION_RATE;
    metrics[layer].SIGNAL_STRIPPED_RATE = metrics.overall.SIGNAL_STRIPPED_RATE;
    metrics[layer].SIGNAL_FLAGGED_RATE = metrics.overall.SIGNAL_FLAGGED_RATE;
  }

  return metrics;
}

// ─── Baseline Management ─────────────────────────────────────────────────────

const BASELINE_PATH = path.join(__dirname, '..', 'data', 'calibration-baselines.json');

function loadBaselines() {
  try {
    if (fs.existsSync(BASELINE_PATH)) {
      return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    }
  } catch (e) {
    warn(`Baselines read failed: ${e.message}`);
  }
  return {};
}

function saveBaselines(baselines) {
  try {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baselines, null, 2));
  } catch (e) {
    warn(`Baselines write failed: ${e.message}`);
  }
}

// ─── Suppression Detection ───────────────────────────────────────────────────

/**
 * Detect calibration-induced suppression across all active entries.
 *
 * @param {Array} calibrationEntries — active entries from behavioral-calibration.json
 * @param {Object} latestTrace — most recent cognitive trace
 * @param {Object} domainConfig — domain.json config
 * @returns {Array} Findings for the Blind Auditor (same format as spending detectors)
 */
function detectCalibrationSuppression(calibrationEntries, latestTrace, domainConfig) {
  const findings = [];

  if (!calibrationEntries || calibrationEntries.length === 0) return findings;
  if (!latestTrace) return findings;

  const globalThreshold = (domainConfig && domainConfig.calibration_suppression_spike_threshold) || 0.3;
  const currentMetrics = computeTraceMetrics(latestTrace);
  const baselines = loadBaselines();
  let baselinesUpdated = false;

  for (const entry of calibrationEntries) {
    if (entry.status !== 'ACTIVE') continue;

    const metric = entry.overcorrection_metric;
    const metricLayer = entry.overcorrection_metric_layer;
    const threshold = entry.overcorrection_threshold_override || globalThreshold;

    if (!metric || !metricLayer) continue;

    const baselineKey = entry.id;

    // Get current metric value
    let currentValue = null;

    if (metric === 'VIOLATION_FREQUENCY') {
      // For violation frequency, we check if the source rule's violations dropped
      // but we need to compare against baseline — a DROP here is what we WANT,
      // but if it drops AND quality degrades, that's stat gaming.
      // For now, track the raw count for baseline establishment.
      const layerMetrics = currentMetrics[metricLayer];
      if (layerMetrics && layerMetrics.violations_by_rule) {
        currentValue = layerMetrics.violations_by_rule[entry.source_rule] || 0;
      }
    } else {
      // Rate-based metrics
      const layerMetrics = currentMetrics[metricLayer];
      if (layerMetrics) {
        currentValue = layerMetrics[metric];
      }
    }

    if (currentValue === null || currentValue === undefined) continue;

    // Check if baseline exists
    if (!baselines[baselineKey]) {
      // No baseline — record current metrics as baseline
      baselines[baselineKey] = {
        entry_id: entry.id,
        source_rule: entry.source_rule,
        metric,
        metric_layer: metricLayer,
        baseline_value: currentValue,
        recorded_at: new Date().toISOString(),
        note: 'Baseline established on first measurement after activation'
      };
      baselinesUpdated = true;
      log(`Baseline established for ${entry.id} (${metric}@${metricLayer}): ${currentValue}`);
      continue;
    }

    const baseline = baselines[baselineKey];
    const baselineValue = baseline.baseline_value;

    // Minimum volume floor: rate-based metrics are unreliable with few signals
    const signalCount = latestTrace._signal_count || (latestTrace.signals || []).length;
    const minVolumeFloor = 5;
    if (metric !== 'VIOLATION_FREQUENCY' && signalCount < minVolumeFloor) {
      log(`Volume too low (${signalCount} signals) to compute reliable metric delta for ${entry.id}. Skipping.`);
      continue;
    }

    // Compute delta
    let suppressed = false;
    let detail = '';

    if (metric === 'VIOLATION_FREQUENCY') {
      // Stat gaming: violations DROP but we need to check if quality improved
      // For now, flag if violations drop to near-zero suspiciously fast
      // (more sophisticated quality check comes when we have more trace history)
      if (baselineValue > 0 && currentValue === 0) {
        suppressed = true;
        detail = `${entry.source_rule} violations dropped from ${baselineValue} to 0 in ${metricLayer}. ` +
          `This could indicate the calibration is working OR the model is suppressing the ` +
          `reasoning pattern entirely. Review whether analytical quality improved or degraded.`;
      }
    } else {
      // Rate-based: check if rate increased beyond threshold
      const delta = currentValue - baselineValue;
      if (delta > threshold) {
        suppressed = true;
        detail = `${metric} in ${metricLayer} increased from ${(baselineValue * 100).toFixed(1)}% ` +
          `to ${(currentValue * 100).toFixed(1)}% (delta: ${(delta * 100).toFixed(1)}%, ` +
          `threshold: ${(threshold * 100).toFixed(1)}%). Calibration entry ${entry.id} ` +
          `(${entry.source_rule}) may be causing the model to suppress analysis rather than ` +
          `improve reasoning.`;
      }
    }

    if (suppressed) {
      findings.push({
        type: 'CALIBRATION_SUPPRESSION',
        severity: 'HIGH',
        detail,
        calibration_entry: entry.id,
        source_rule: entry.source_rule,
        metric,
        metric_layer: metricLayer,
        baseline_value: baselineValue,
        current_value: currentValue,
        threshold,
        recommendation: `Review ${entry.id} for overcorrection. Consider SUSPENDED status ` +
          `if the model is avoiding the reasoning rather than improving it. ` +
          `The overcorrection_watch text: "${entry.overcorrection_watch}"`
      });
    }
  }

  if (baselinesUpdated) {
    saveBaselines(baselines);
  }

  return findings;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  detectCalibrationSuppression,
  computeTraceMetrics,
  loadBaselines,
  saveBaselines
};
