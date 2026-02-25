# OVERWATCH 360 — Implementation Guide for Claude Code

## OVERVIEW

Replace the single-pass BEAR analysis in analyze-thesis.js with a two-pass 
360 system. The current approach evaluates a fixed checklist of competitors 
and risks. The new approach conducts an unstructured sweep first, then 
structures the findings into an actionable assessment.

Two-pass logic modeled on fireground incident command:
- Pass 1 (SWEEP): Walk the entire structure. Find what's NOT on the checklist.
- Pass 2 (ASSESS): Score, prioritize, identify compounding risks, recommend tactics.
- Pass 3 (BLIND SPOT AUDIT): Weekly meta-analysis of what the system itself can't see.

---

## PASS 1: SWEEP PROMPT

This is the first Claude API call. Feed it all available data. 
Give it NO categories and NO checklist. Let it find threats on its own.

```
You are a senior institutional analyst conducting a full counter-thesis sweep.
Your job is NOT to evaluate a pre-defined list of risks. Your job is to find 
threats the thesis holder may be blind to.

THESIS:
XRP/XRPL is positioned to become primary institutional settlement infrastructure 
for cross-border payments. Convergent catalysts include: Ripple institutional 
partnerships (BIS, IMF, central banks), RLUSD stablecoin growth toward $5B 
circulation, ODL volume expansion, Permissioned Domains enabling compliant 
institutional access, XRP ETF approval and sustained inflows, and Japanese 
institutional adoption via SBI Holdings.

CURRENT DATA:
${JSON.stringify(marketData)}

FALSIFICATION CRITERIA (existing kill switches):
- ODL Volume: Must show growth trajectory toward institutional-grade volume by Q3 2026
- RLUSD Circulation: Tracking toward $5B target
- PermissionedDEX: Institutional count must be verifiable  
- XRP ETF: Sustained outflows beyond 30 days triggers review
- Fear & Greed: Extended period below 20 signals structural risk

INSTRUCTIONS:

1. You are being paid to destroy this thesis. Find the fatal flaw.

2. Do NOT limit yourself to SWIFT, Visa B2B, or JPMorgan. Search across:
   - Emerging technologies not yet on the radar
   - Regulatory scenarios beyond current trajectory (regime changes, enforcement shifts)
   - Market structure changes (liquidity fragmentation, DEX evolution, L2 settlement)
   - Macro regime shifts that invalidate the setup (structural changes, not just recession)
   - Institutional behavior patterns — what are banks ACTUALLY building internally?
   - Geopolitical realignments that change corridor demand
   - Assumption decay — which core assumptions are oldest and least recently validated?
   - Adjacent disruptions (AI-native settlement, CBDC interop layers, stablecoin rails)
   - Narrative risk — what if "institutional adoption" is itself the trap?

3. Think laterally. The biggest risks are usually NOT the ones already being tracked.
   What would make a sophisticated institutional investor sell this position tomorrow?

4. Be specific. Name projects, cite developments, reference timelines.
   Vague warnings are useless. Concrete threats change tactics.

Respond with ONLY a JSON array. Each element:
{
  "threat": "Short name",
  "description": "What specifically is the threat and why it matters",
  "severity": "critical | high | moderate | low",
  "proximity": "immediate | near-term | medium-term | long-term",
  "confidence": "high | medium | low",
  "evidence": "What specific data or development supports this",
  "blind_spot": true/false,
  "category": "competing_infra | regulatory | macro | market_structure | narrative | technology | geopolitical | assumption_decay"
}

Find everything. No limit on count. Do not self-censor findings that 
challenge the thesis. That is the entire point.
```

---

## PASS 2: ASSESS PROMPT

This is the second Claude API call. Feed it the Pass 1 output plus current data.
This pass structures, scores, and produces the tactical recommendation.

```
You are reviewing a counter-thesis sweep report for the XRPL institutional 
settlement thesis. The sweep team has returned findings. Your job:

1. PRIORITIZE — Which findings change the tactical picture?
2. VALIDATE — Do any findings compound each other?
3. DECIDE — Do any findings trigger existing kill switches or warrant new ones?
4. REPORT — Produce a clear command report.

SWEEP FINDINGS:
${JSON.stringify(sweepResults)}

CURRENT MARKET DATA:
${JSON.stringify(marketData)}

PREVIOUS BEAR PRESSURE SCORE: ${previousScore}

EXISTING KILL SWITCHES:
- ODL Volume: Growth trajectory toward institutional-grade volume by Q3 2026
- RLUSD Circulation: Tracking toward $5B; currently needs ${rlusdPaceNeeded}/day
- PermissionedDEX: Institutional count must be verifiable
- XRP ETF: Sustained outflows beyond 30 days
- Fear & Greed: Extended period below 20

INSTRUCTIONS:

A) THREAT MATRIX — For each finding, calculate:
   - impact (1-10): How much damage if this materializes?
   - probability (1-10): How likely based on current evidence?
   - time_weight: immediate=10, near-term=7, medium-term=4, long-term=2
   - composite = (impact × probability × time_weight) / 10
   Sort by composite descending. Return top 8 max.

B) COMPOUNDING RISKS — Which threats amplify each other?
   Show the chain: A → B → C → [outcome]
   Explain why the combination is worse than individual threats.

C) BLIND SPOTS — Which findings were NOT previously tracked?
   For each:
   - Should it become a permanent monitoring item?
   - What data source would track it? 
   - Is there an x402 endpoint opportunity?

D) BIAS CHECK — Count indicators:
   - How many data points in the system support the bull case?
   - How many actively challenge it?
   - Ratio assessment and recommendation.

E) KILL SWITCH STATUS — For each existing kill switch:
   - Current status: safe | warning | danger | triggered | no_data
   - Supporting detail
   - Any new kill switches recommended?

F) TACTICAL RECOMMENDATION (one of):
   - HOLD_POSITION: No findings warrant tactical change
   - INCREASE_MONITORING: Specific areas need closer watch
   - REDUCE_EXPOSURE: Conditions suggest partial de-risk
   - EXIT_SIGNAL: Kill switch triggered or compounding threats critical

G) UPDATED BEAR PRESSURE SCORE (0-100):
   Weight composite threats against thesis strength.
   Explain any change from previous score.

H) COMMANDER SUMMARY:
   2-3 sentences. Plain language. Lead with the most important finding.
   State the tactical recommendation. No hedging.

Respond with ONLY JSON:
{
  "threat_matrix": [
    {
      "threat": "name",
      "description": "...",
      "impact": number,
      "probability": number,
      "time_weight": number,
      "composite": number,
      "severity": "critical|high|moderate|low",
      "proximity": "immediate|near-term|medium-term|long-term",
      "blind_spot": boolean,
      "is_new": boolean,
      "category": "string"
    }
  ],
  "compounding_risks": [
    {
      "chain": ["threat A", "threat B", "threat C"],
      "outcome": "what happens when these combine",
      "severity": "critical|high|moderate"
    }
  ],
  "blind_spots": [
    {
      "threat": "name",
      "importance": "critical|high|moderate",
      "suggested_source": "...",
      "x402_opportunity": boolean,
      "recommend_permanent_monitoring": boolean
    }
  ],
  "bias_check": {
    "bull_indicators": number,
    "bear_indicators": number,
    "ratio": "string",
    "assessment": "string",
    "recommended_additions": ["..."]
  },
  "kill_switches": [
    {
      "name": "...",
      "status": "safe|warning|danger|triggered|no_data",
      "detail": "..."
    }
  ],
  "new_kill_switches_recommended": [
    {
      "name": "...",
      "trigger": "...",
      "reasoning": "..."
    }
  ],
  "tactical_recommendation": "HOLD_POSITION|INCREASE_MONITORING|REDUCE_EXPOSURE|EXIT_SIGNAL",
  "recommendation_reasoning": "...",
  "bear_pressure_score": number,
  "score_delta": number,
  "score_reasoning": "...",
  "commander_summary": "..."
}
```

---

## PASS 3: BLIND SPOT AUDIT (Weekly — run Sundays)

Separate scheduled run. Not part of daily briefing.
This is meta-analysis: examining the system itself for gaps.

```
You are auditing an autonomous investment monitoring system called 
Overwatch Terminal. Your job is to identify what the system CANNOT see.

SYSTEM MONITORS:
- XRP price, market cap, volume, Fear & Greed index
- USD/JPY exchange rate (yen carry trade proxy)
- XRP ETF flows (weekly, limited quality)
- XRPL metrics (tx count, active accounts — when available)
- US 10Y and JGB 10Y yields
- 5 named competitors (SWIFT GPI, Visa B2B, JPMorgan Kinexys, BIS Nexus, Ethereum)
- Kill switches: ODL volume, RLUSD circulation, PermissionedDEX, ETF flows, F&G

SYSTEM CANNOT SEE:
- Direct ODL volume data
- Real-time CBDC development status
- Institutional sentiment beyond ETF flows
- Competitor progress metrics (only tracks names, not data)
- On-chain XRPL analytics (large wallets, DEX activity, institutional clustering)
- AI/agent settlement protocol development
- Central bank digital infrastructure procurement decisions

QUESTIONS:

1. ASSUMPTION AUDIT: List every core assumption the thesis relies on.
   For each: when last validated with NEW evidence? What invalidates it?
   Does ANY current data source test it?

2. DATA GAPS: What critical information has ZERO visibility?
   Rank by importance. Suggest sources (free and paid).
   Flag which gaps could be filled by x402 paid endpoints.

3. CONFIRMATION BIAS: Count bull vs bear data points the system tracks.
   Is monitoring weighted toward confirming the thesis?

4. STALE ASSUMPTIONS: Which beliefs are oldest? When was "Ripple works 
   with central banks" last confirmed with genuinely NEW evidence?

5. PREDICTED FAILURE MODE: If this thesis fails, what is the single 
   most likely cause that is NOT currently monitored?

Respond with ONLY JSON:
{
  "assumption_audit": [
    {
      "assumption": "...",
      "last_validated": "date or never",
      "invalidation_trigger": "...",
      "current_data_source": "name or none",
      "risk_level": "critical|high|moderate|low"
    }
  ],
  "data_gaps": [
    {
      "gap": "...",
      "importance": "critical|high|moderate",
      "suggested_sources": ["..."],
      "x402_opportunity": boolean
    }
  ],
  "bias_check": {
    "bull_indicators": number,
    "bear_indicators": number,
    "ratio": "...",
    "assessment": "..."
  },
  "stale_assumptions": [
    {
      "assumption": "...",
      "age_estimate": "...",
      "last_new_evidence": "...",
      "staleness_risk": "high|medium|low"
    }
  ],
  "predicted_failure_mode": "...",
  "recommended_actions": ["..."]
}
```

---

## INTEGRATION INTO analyze-thesis.js

### Execution flow for daily briefing:

```javascript
// 1. Gather data (existing)
const marketData = await fetchAllData();

// 2. PASS 1 — Sweep
const sweepResults = await callClaude(SWEEP_PROMPT(marketData));

// 3. PASS 2 — Assess (feeds sweep results back in)
const assessment = await callClaude(ASSESS_PROMPT(sweepResults, marketData, previousScore));

// 4. Store results
// Save assessment to data/360-report.json
// This file drives the 360 tab in the dashboard

// 5. Feed commander_summary and tactical_recommendation into 
//    the existing Telegram briefing template

// 6. Update bear_pressure_score in the dashboard data
```

### Weekly blind spot audit (add to GitHub Actions schedule):

```yaml
# Add to .github/workflows/ — run Sundays at 8am CST
- cron: '0 14 * * 0'  # 14:00 UTC = 8:00 AM CST
```

```javascript
// Weekly job
const auditResults = await callClaude(BLIND_SPOT_PROMPT());
// Save to data/blind-spot-audit.json
// Surface critical findings in Monday's daily briefing
```

---

## DASHBOARD UI — 360 TAB

Replace the current BEAR tab with a 360 tab. Keep the red warning styling 
but expand the content to show the full assessment output.

### Section order (matches the JSON output):
1. **Commander Summary** — top of tab, always visible, plain text BLUF
2. **Bear Pressure Score** — gauge with delta from previous, reasoning
3. **Tactical Recommendation** — HOLD / INCREASE_MONITORING / REDUCE / EXIT
   with color coding (green/yellow/orange/red + pulse animation on EXIT)
4. **Threat Matrix** — sorted by composite score, show top 8
   - Each threat shows: composite score badge, name, description, tags
   - Tags: severity color, proximity, BLIND SPOT (purple), NEW (gold)
5. **Compounding Risks** — chain visualization: A → B → C → [outcome]
6. **Blind Spots Detected** — purple section, x402 opportunity tags
7. **Bias Check** — bull/bear indicator ratio bar
8. **Kill Switch Status** — grid of cards with safe/warning/danger/triggered

### Tag styling:
- BLIND SPOT: purple background, purple text (#a855f7)
- NEW — SWEEP FOUND: gold background, gold text (#f59e0b)  
- KILL SWITCH: red background, red text
- Proximity tags: gray/muted
- x402 opportunity: gold border, gold text

### Tactical recommendation colors:
- HOLD_POSITION: green (#22c55e)
- INCREASE_MONITORING: yellow (#eab308)  
- REDUCE_EXPOSURE: orange (#f97316)
- EXIT_SIGNAL: red (#ef4444) with pulse animation

### Footer:
- Show pass completion status (Sweep ✓, Assessment ✓, Blind Spot Audit: next date)
- Token count and cost for transparency
- Next scheduled 360 time

---

## DATA FILES

### data/360-report.json
Full Pass 2 assessment output. Dashboard reads this file.
Updated twice daily with each briefing run.

### data/blind-spot-audit.json  
Full Pass 3 output. Updated weekly (Sundays).
Monday briefing checks for critical findings and includes them.

### data/360-history.json (optional, future)
Append each 360 report with timestamp for trend analysis.
Enables: "Bear pressure has increased 12 points over 2 weeks" type insights.

---

## TOKEN BUDGET

- Pass 1 (Sweep): ~1500 input + ~2000 output = ~3500 tokens
- Pass 2 (Assess): ~2500 input + ~2500 output = ~5000 tokens  
- Daily total: ~8500 tokens per briefing run (~17K/day for twice-daily)
- Pass 3 (Weekly): ~1000 input + ~1500 output = ~2500 tokens
- Monthly estimate: ~530K tokens (~$1.60 at Haiku rates, ~$8 at Sonnet)

---

## KEY PRINCIPLE

The current BEAR analysis asks: "How are these known risks doing?"
The 360 asks: "What risks exist that we haven't been looking at?"

The sweep has no checklist. It has permission to find anything.
The assessment structures what the sweep found into actionable intel.
The system thinks like an incident commander — assess all sides, 
find what's hidden, change tactics when conditions change.
