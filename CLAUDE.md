# Overwatch Terminal

Autonomous AI intelligence system monitoring a high-conviction XRP investment thesis with formal falsification criteria. Built by Tim Wrenn (fire lieutenant, zero coding background) by directing AI tools.

## What's Running (Production)

Two-layer analysis system executing 2x daily via GitHub Actions:
- `scripts/fetch-data.js` — Data pipeline, 12+ sources with retry/fallback chains
- `scripts/analyze-thesis.js` — Claude API analyst (SWEEP + ASSESS), Telegram delivery
- `scripts/x402-agent.js` — XRPL mainnet payment agent (manual trigger)
- `scripts/x402-merchant.js` — x402 merchant server (3 endpoints)
- `index.html` — Dashboard frontend, reads from `dashboard-data.json`
- `dashboard-data.json` — Live data store, committed by overwatch-bot 2x daily
- `data/360-report.json` — Latest 360 assessment
- `data/360-history.json` — Archive of all assessments (last 60 entries)
- `thesis-context.md` — Investment thesis context fed to Claude API analyst

## What's Designed (Not Yet Built — Target March 3-7)

### Four-Layer Architecture (replacing current two-layer)
- **Layer 1 SWEEP:** Perception. Widest intake, no filtering.
- **Layer 2 CONTEXTUALIZE:** Knowledge audit + contextual scoring. Replaces current ASSESS. Two phases: knowledge audit ("do I understand the thesis well enough to score this?"), then contextual scoring with verified understanding.
- **Layer 3 INFER:** Game theory on knowledge-verified inputs. Circuit breakers: null hypothesis mandate, assumption count (3+ = SPECULATIVE), evidence-to-inference ratio. Paper trades x402 intelligence purchases.
- **Layer 4 RECONCILE:** Judgment. Resolves contradictions, applies skeptic discount (75% weight on speculative), produces final bear pressure score + tactical recommendation.

### Corrections Ledger (`data/corrections-ledger.json`)
Structured memory of analytical mistakes. Layers 2-3 read during live analysis. Layer 4 and Sunday blind spot audit write to it. 12 root cause types. System learns from its own errors.

### Rejection Log (`data/rejection-log.json`)
Real-time record of Layer 4 overruling Layer 3. Feeds into corrections ledger.

### X API Integration (Three-Tier Monitoring)
- Tier 1 (~15-20 accounts): Every post ingested and scored
- Tier 2 (~30-40 accounts): Keyword intersection scanning
- Tier 3: Broad keyword monitoring across all of X

## Architecture Design Documents (Private — Not in Repo)

These live in the Claude Project, not the repo:
- `OVERWATCH-4-LAYER-ARCHITECTURE.md` — Layer 3-4 prompts, data flow, token budgets
- `OVERWATCH-CIRCUIT-BREAKERS.md` — Apophenia prevention, assumption limits, Layer 4 skeptic
- `ARCHITECTURE-DECISION-CORRECTIONS-LEDGER.md` — Learning-from-mistakes system design
- `ARCHITECTURE-DECISION-LAYER2-CONTEXTUALIZE.md` — Knowledge audit rationale and proof case
- `SESSION-14-DECISIONS.md` — Build sequencing, X monitoring tiers, x402 paper trading

## Build Principles

- **Falsification-first.** The system challenges assumptions, not confirms them. "INSUFFICIENT_EVIDENCE" is high-quality output.
- **Don't break what's running.** The production pipeline works. Build forward, don't restructure.
- **Circuit breakers over confidence.** Value is in what the system refuses to believe.
- **Paper trading before authority.** New capabilities prove judgment before getting operational power.
- **Architecture follows cognition.** Every layer maps to how Tim actually thinks, not theoretical best practice.

## Hard Rules

- Do NOT modify `fetch-data.js` retry/fallback chains without explicit approval
- Do NOT touch `x402-agent.js` wallet logic or signing without explicit approval
- Do NOT commit secrets, API keys, or wallet seeds
- Do NOT restructure the four-layer architecture — it was validated by four independent AI systems
- Do NOT add dependencies without discussing first
- Private architecture docs (listed above) are IP — never commit to repo

## Key Context

- GitHub Actions cron runs at ~06:00 and ~18:00 UTC
- Telegram briefing chunked for 4K character limit
- Dashboard is static HTML reading JSON — no build step, no framework
- Claude API calls use claude-opus-4-6 for analysis
- x402 payments are on XRPL mainnet (not testnet)
- `thesis-context.md` is the source of truth for kill switches and probability framework
- Data sources include: CoinGecko, Twelve Data, FRED, Stooq (JGB 10Y primary), SoSoValue, XRPL on-chain, and others

## Cost Structure

| Component | Monthly |
|-----------|---------|
| Claude API (2x daily, Opus) | ~$36 |
| X API Basic (when live) | ~$100 |
| Total new costs | ~$136/month |
