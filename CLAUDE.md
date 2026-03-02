# Overwatch Terminal — Claude Code Context

## What This Is
Autonomous AI intelligence system monitoring an institutional adoption thesis. Four-layer cognitive architecture (SWEEP → CONTEXTUALIZE → INFER → RECONCILE) with epistemological guardrails, circuit breakers, and a corrections ledger. Running in production on GitHub Actions, twice daily. Built entirely by directing AI tools — the builder has zero coding background.

## Critical Build Rules
- NEVER modify a file without stating: what changes, what it affects downstream, what could break
- One change at a time. Verify before moving to next.
- After ANY commit touching fetch-data.js, analyze-thesis.js, index.html, or dashboard-data.json: trace the change forward AND backward
- No silent failures. Every error must surface. No empty catch blocks.
- If restoring a file from a prior commit, validate the FULL data contract between that file and everything it connects to
- Tim cannot read code. Provide complete file replacements, not diffs. Explain changes in plain language.
- Do NOT recalibrate thresholds without explicit instruction.
- Comments explain WHY, not WHAT. Reference architectural decision documents.

## File Map
- scripts/fetch-data.js — Data pipeline, 7 active API sources, writes dashboard-data.json, runs data contract validation
- scripts/analyze-thesis.js — Claude API analyst (currently 2-layer: SWEEP + ASSESS), writes 360-report.json + 360-history.json, sends Telegram briefing with pipeline health line
- scripts/apply-analysis.js — Merges analysis results into dashboard-data.json (etf, supply, xrpl_metrics, bear_case, probability, stress fields)
- scripts/x402-agent.js — XRPL mainnet payment agent (manual trigger only)
- scripts/thesis-context.md — Thesis context fed to Claude API analyst. Lives in scripts/, NOT repo root.
- scripts/pipeline-health.json — Written by fetch-data.js validation, read by analyze-thesis.js for Telegram heartbeat
- data-contract.json — Lists every field index.html expects from dashboard-data.json. Source of truth for validation.
- data/360-report.json — Latest analysis output
- data/360-history.json — Archive of all assessments (last 60 entries)
- index.html — Dashboard frontend, reads dashboard-data.json on load

## Data Flow
fetch-data.js writes dashboard-data.json (partial: macro, rlusd, xrp, thesis_scores) → validates against data-contract.json → writes pipeline-health.json → analyze-thesis.js runs Claude API → writes 360-report.json + 360-history.json → sends Telegram with pipeline health appended → apply-analysis.js merges analysis into dashboard-data.json (etf, supply, xrpl_metrics, bear_case, probability, stress) → git commit + push

## GitHub Actions
- Cron: 12:00 UTC and 00:00 UTC daily
- Workflow: .github/workflows/analyze-thesis.yml
- Steps: checkout → setup node → npm install → fetch-data.js → analyze-thesis.js → apply-analysis.js → git commit/push

## Key Field Names
- index.html reads thesis_scores (NOT thesis). Bug fixed March 3, 2026.
- fetch-data.js owns 18 fields. analyze-thesis.js/apply-analysis.js own 73 fields. x402-agent.js owns 23 fields. See data-contract.json for full list.
- kill_switches in dashboard-data.json is written by fetch-data.js but NOT read by index.html. Kill switch display comes from data/360-report.json.

## What's Built and Running
- Layer 1 SWEEP + Layer 2 ASSESS (current two-layer system)
- Automated twice-daily analysis via GitHub Actions
- Telegram briefing with pipeline health heartbeat
- Data contract validation (18 fetch fields checked every run)
- Dashboard on GitHub Pages
- x402 agent (12 mainnet transactions, 9,000 drops lifetime spend)

## Build State (as of March 3, 2026 — end of session)

### Completed Today
- thesis-context.md updated: March 3 market data, compound stress matrix, key players section
- Dashboard bug fixed: d.thesis → d.thesis_scores in index.html
- Data contract: data-contract.json created, validation wired into fetch-data.js (18 fields checked)
- Pipeline heartbeat: data contract status appended to Telegram briefing via pipeline-health.json
- CLAUDE.md rewritten with current build state
- Empty corrections ledger files created: data/corrections-ledger.json, data/rejection-log.json
- Layer 2 CONTEXTUALIZE function written and tested: 12/12 validation checks passed

### In Progress — Stashed
- scripts/analyze-thesis.js has Layer 2 CONTEXTUALIZE replacing runAssessment(). Changes are in git stash:
  `git stash pop` to restore
- The stashed version includes: new runContextualize() function (lines 538-749), updated call site (line 869), updated overlay bridge (lines 967-971)
- Layer 2 was tested with Sonnet locally (Opus timed out on local network — works fine in GitHub Actions)
- Test fixtures: scripts/test-layer2.js and scripts/test-layer2-output.json are committed to main

### Still To Build
- Layer 3 INFER: write runInfer(), test in isolation against test-layer2-output.json
- Layer 4 RECONCILE: write runReconcile(), test in isolation against Layer 3 output
- Wire full pipeline: runSweep() → runContextualize() → runInfer() → runReconcile()
- Update render360Report() in index.html to read Layer 4 output schema
- Update Telegram formatting to use Layer 4 final_report field
- Update caller overlay (lines 967-971) for Layer 4 field names
- Full end-to-end test before committing to main
- Production system (current 2-layer) keeps running untouched until all 4 layers are verified

### Key Decision: Option C3
All four layers are built and tested before any dashboard changes. The 360 tab reads Layer 4 output. One coordinated commit, not incremental pushes. Each layer tested in isolation first (progressive isolation testing).

### Test Approach
- Local test scripts call the API with real pipeline data as fixtures
- Opus times out locally (SDK default timeout) — add timeout: 300000 to Anthropic client, or test with Sonnet locally and let GitHub Actions validate Opus
- Each layer's test output becomes the next layer's test input

## Architectural Authority
If code contradicts an architectural decision document, the document wins. The code has a bug. Architectural documents live in the Claude.ai project files, not in this repo. Key documents:
- OVERWATCH-4-LAYER-ARCHITECTURE.md
- OVERWATCH-CIRCUIT-BREAKERS.md
- ARCHITECTURE-DECISION-CORRECTIONS-LEDGER.md
- ARCHITECTURE-DECISION-LAYER2-CONTEXTUALIZE.md
- LAYER-2-3-4-PROMPTS-DRAFT.md (PRIVATE — never commit to public repo)
