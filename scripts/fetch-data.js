#!/usr/bin/env node
'use strict';

/**
 * Overwatch Terminal — Automated Data Ingestion
 * Fetches live data from free APIs, merges with existing JSON, and writes
 * dashboard-data.json. Run `node scripts/fetch-data.js` or via cron.
 */

const path    = require('path');
const fs      = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { ENDPOINTS, COINGECKO_DELAY_MS, KILL_SWITCH_TARGETS } = require('./config');
const { fetchXIntelligence } = require('./fetch-x');
const pushToGitHub = require('./push-to-github');

const OUTPUT_PATH = path.join(__dirname, '..', 'dashboard-data.json');

// ─── Utilities ────────────────────────────────────────────────────────────────

function log(label, msg)  { console.log(`[${label}] ${msg}`); }
function warn(label, msg) { console.warn(`[${label}] WARN: ${msg}`); }
function err(label, msg)  { console.error(`[${label}] ERROR: ${msg}`); }

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Load existing dashboard-data.json so we can fall back to previous values. */
function loadExisting() {
  try {
    if (fs.existsSync(OUTPUT_PATH)) {
      return JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    }
  } catch (e) {
    warn('io', `Could not read existing dashboard-data.json: ${e.message}`);
  }
  return {};
}

/**
 * Thin fetch wrapper with timeout.
 * Returns parsed JSON or throws.
 */
async function fetchJSON(url, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ─── Individual fetchers ──────────────────────────────────────────────────────

async function fetchXRP(fallback) {
  const fetchedAt = new Date().toISOString().slice(0, 10);
  try {
    const data = await fetchJSON(ENDPOINTS.xrp);
    const r = data?.ripple;
    if (!r) throw new Error('Unexpected response shape');
    const result = {
      price:      r.usd              ?? null,
      change_24h: r.usd_24h_change   ?? null,
      volume_24h: r.usd_24h_vol      ?? null,
      market_cap: r.usd_market_cap   ?? null,
      data_date:  fetchedAt,
      source:     'coingecko',
    };
    log('XRP', `price=$${result.price}  24h=${result.change_24h?.toFixed(2)}%`);
    return result;
  } catch (e) {
    err('XRP', e.message);
    return fallback?.xrp ?? { price: null, change_24h: null, volume_24h: null, market_cap: null, data_date: null, source: 'coingecko' };
  }
}

async function fetchRLUSD(fallback) {
  const fetchedAt = new Date().toISOString().slice(0, 10);
  await sleep(COINGECKO_DELAY_MS);
  try {
    const data = await fetchJSON(ENDPOINTS.rlusd);
    const r = data?.['ripple-usd'];
    if (!r) throw new Error('Unexpected response shape — will try search');
    const result = { market_cap: r.usd_market_cap ?? null, data_date: fetchedAt, source: 'coingecko' };
    log('RLUSD', `market_cap=$${result.market_cap?.toLocaleString()}`);
    return result;
  } catch (e) {
    warn('RLUSD', `Primary ID failed (${e.message}), trying search…`);
    try {
      await sleep(COINGECKO_DELAY_MS);
      const search = await fetchJSON(ENDPOINTS.rlusd_search);
      const coin = search?.coins?.find(c => c.symbol?.toUpperCase() === 'RLUSD');
      if (!coin) throw new Error('RLUSD not found in search results');
      // Fetch by the discovered id
      await sleep(COINGECKO_DELAY_MS);
      const data2 = await fetchJSON(
        `https://api.coingecko.com/api/v3/simple/price?ids=${coin.id}&vs_currencies=usd&include_market_cap=true`
      );
      const r2 = data2?.[coin.id];
      const result = { market_cap: r2?.usd_market_cap ?? null, data_date: fetchedAt, source: 'coingecko' };
      log('RLUSD', `market_cap=$${result.market_cap?.toLocaleString()} (via search id=${coin.id})`);
      return result;
    } catch (e2) {
      err('RLUSD', e2.message);
      return fallback?.rlusd ?? { market_cap: null, data_date: null, source: 'manual' };
    }
  }
}

async function fetchFearGreed(fallback) {
  try {
    const data = await fetchJSON(ENDPOINTS.fear_greed);
    const entry = data?.data?.[0];
    if (!entry) throw new Error('Unexpected response shape');
    // alternative.me returns unix timestamp; convert to YYYY-MM-DD
    const dataDate = entry.timestamp
      ? new Date(Number(entry.timestamp) * 1000).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const result = {
      value:     Number(entry.value),
      label:     entry.value_classification,
      data_date: dataDate,
      source:    'alternative.me',
    };
    log('Fear&Greed', `${result.value} — ${result.label} (date: ${dataDate})`);
    return result;
  } catch (e) {
    err('Fear&Greed', e.message);
    return fallback?.macro?.fear_greed ?? { value: null, label: null, data_date: null, source: 'alternative.me' };
  }
}

async function fetchUSDJPY(fallback) {
  const fetchedAt = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  try {
    const data = await fetchJSON(ENDPOINTS.usd_jpy);
    const rate = data?.rates?.JPY;
    if (!rate) throw new Error('Unexpected response shape');
    const dataDate = data?.date || fetchedAt; // Frankfurter returns a date field
    log('USD/JPY', `${rate} (date: ${dataDate})`);
    return { value: rate, data_date: dataDate, source: 'frankfurter' };
  } catch (e) {
    err('USD/JPY', e.message);
    return fallback?.macro?.usd_jpy ?? { value: null, data_date: null, source: 'frankfurter' };
  }
}

/**
 * Fetch a single FRED series. Returns the most recent non-null observation value.
 */
async function fetchFRED(seriesLabel, url, fallbackValue) {
  const key = process.env.FRED_API_KEY;
  if (!key) {
    warn('FRED', `FRED_API_KEY not set — skipping ${seriesLabel}`);
    return fallbackValue ?? { value: null, data_date: null, source: 'fred' };
  }
  try {
    const fullUrl = `${url}&api_key=${encodeURIComponent(key)}`;
    const data = await fetchJSON(fullUrl);
    // FRED returns observations newest-first; find the first with a real value
    const obs = data?.observations?.find(o => o.value !== '.' && o.value !== '');
    if (!obs) throw new Error('No valid observation in response');
    const value = parseFloat(obs.value);
    const dataDate = obs.date || null;
    log('FRED', `${seriesLabel} = ${value} (date: ${dataDate})`);
    return { value, data_date: dataDate, source: 'fred' };
  } catch (e) {
    err('FRED', `${seriesLabel}: ${e.message}`);
    return fallbackValue ?? { value: null, data_date: null, source: 'fred' };
  }
}

// ─── Stooq fetcher (CSV) ──────────────────────────────────────────────────────

async function fetchStooq(label, url, fallbackValue) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const lines = text.trim().split('\n');
    if (lines.length < 2) throw new Error('No data rows in CSV');
    const values = lines[1].split(',');
    // Stooq CSV columns: Symbol,Date,Time,Open,High,Low,Close,Volume
    const close = parseFloat(values[6]);
    if (isNaN(close)) throw new Error('Could not parse close price');
    const dataDate = values[1] || null; // YYYY-MM-DD from Stooq CSV
    log('Stooq', `${label} = ${close} (date: ${dataDate})`);
    return { value: close, data_date: dataDate, source: 'stooq' };
  } catch (e) {
    err('Stooq', `${label}: ${e.message}`);
    return fallbackValue ?? { value: null, data_date: null, source: 'stooq' };
  }
}

// ─── Twelve Data fetcher ──────────────────────────────────────────────────────

async function fetchTwelveData(label, url, fallbackValue) {
  const key = process.env.TWELVE_DATA_KEY;
  if (!key) {
    warn('TwelveData', `TWELVE_DATA_KEY not set — skipping ${label}`);
    return fallbackValue ?? { value: null, data_date: null, source: 'twelve_data' };
  }
  try {
    const fullUrl = `${url}&apikey=${encodeURIComponent(key)}`;
    const data = await fetchJSON(fullUrl);
    if (data.status === 'error') throw new Error(data.message || 'API error');
    const value = parseFloat(data?.values?.[0]?.close);
    if (isNaN(value)) throw new Error('Could not parse close value');
    const dataDate = data?.values?.[0]?.datetime ?? null;
    log('TwelveData', `${label} = ${value} (date: ${dataDate})`);
    return { value, data_date: dataDate, source: 'twelve_data' };
  } catch (e) {
    err('TwelveData', `${label}: ${e.message}`);
    return fallbackValue ?? { value: null, data_date: null, source: 'twelve_data' };
  }
}

// ─── Kill-switch helpers ──────────────────────────────────────────────────────

function pct(current, target) {
  if (current == null || target == null || target === 0) return null;
  return Math.round((current / target) * 100);
}

function buildKillSwitches(manual, rlusd) {
  const odl    = manual?.odl_volume_annualized ?? null;
  const rlusdC = rlusd?.market_cap ?? manual?.rlusd_circulation ?? null;
  const etfAum = manual?.xrp_etf_aum ?? null;
  const dex    = manual?.permissioned_dex_institutions ?? null;
  const clarity = manual?.clarity_act_status ?? 'pending';

  const T = KILL_SWITCH_TARGETS;

  return {
    odl_volume: {
      target:   T.odl_volume.target,
      current:  odl,
      deadline: T.odl_volume.deadline,
      status:   odl == null ? 'NEEDS_DATA' : odl >= T.odl_volume.target ? 'HIT' : 'TRACKING',
      pct_complete: pct(odl, T.odl_volume.target),
    },
    rlusd_circulation: {
      target:      T.rlusd_circulation.target,
      current:     rlusdC,
      deadline:    T.rlusd_circulation.deadline,
      status:      rlusdC == null ? 'NEEDS_DATA' : rlusdC >= T.rlusd_circulation.target ? 'HIT' : 'TRACKING',
      pct_complete: pct(rlusdC, T.rlusd_circulation.target),
    },
    xrp_etf_aum: {
      target:      T.xrp_etf_aum.target,
      current:     etfAum,
      deadline:    T.xrp_etf_aum.deadline,
      status:      etfAum == null ? 'NEEDS_DATA' : etfAum >= T.xrp_etf_aum.target ? 'HIT' : 'TRACKING',
      pct_complete: pct(etfAum, T.xrp_etf_aum.target),
    },
    permissioned_dex_adoption: {
      target_institutions: T.permissioned_dex_adoption.target_institutions,
      current:             dex,
      deadline:            T.permissioned_dex_adoption.deadline,
      status:              dex == null ? 'NEEDS_DATA' : dex >= T.permissioned_dex_adoption.target_institutions ? 'HIT' : 'TRACKING',
    },
    clarity_act: {
      target:   T.clarity_act.target,
      current:  'pending',
      deadline: T.clarity_act.deadline,
      status:   clarity?.toLowerCase().includes('passed') ? 'HIT' : 'PENDING',
    },
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n━━━ Overwatch Terminal — Data Fetch ━━━');
  console.log(`Started: ${new Date().toISOString()}\n`);

  const existing = loadExisting();

  // Fetch all live data. Each fetcher is self-contained and falls back gracefully.
  const [xrp, rlusd, fearGreed, usdJpy] = await Promise.all([
    fetchXRP(existing),
    fetchRLUSD(existing),
    fetchFearGreed(existing),
    fetchUSDJPY(existing),
  ]);

  // FRED calls are sequential to avoid hammering the API
  const brent  = await fetchFRED('BRENT',   ENDPOINTS.fred.brent,   existing?.macro?.brent_crude);
  const us10y  = await fetchFRED('US_10Y',  ENDPOINTS.fred.us_10y,  existing?.macro?.us_10y_yield);

  // Stooq — daily JGB 10Y (replaces stale FRED monthly)
  const jpn10y = await fetchStooq('JPN_10Y', ENDPOINTS.stooq.jpn_10y, existing?.macro?.jpn_10y);

  // Twelve Data — DXY and S&P 500
  const dxy   = await fetchTwelveData('DXY',   ENDPOINTS.twelve_data.dxy,   existing?.macro?.dxy);
  const sp500 = await fetchTwelveData('SP500', ENDPOINTS.twelve_data.sp500, existing?.macro?.sp500);

  const xIntelligence = await fetchXIntelligence(existing?.x_intelligence);

  // Preserve manually-managed fields from existing JSON (never overwrite with null)
  const manual = {
    odl_volume_annualized:          existing?.manual?.odl_volume_annualized          ?? null,
    xrp_etf_aum:                    existing?.manual?.xrp_etf_aum                    ?? null,
    rlusd_circulation:              existing?.manual?.rlusd_circulation              ?? null,
    permissioned_dex_institutions:  existing?.manual?.permissioned_dex_institutions  ?? null,
    clarity_act_status:             existing?.manual?.clarity_act_status             ?? 'Pending',
    _last_manual_update:            existing?.manual?._last_manual_update            ?? null,
  };

  // Preserve thesis scores — these are editorially managed
  const thesis_scores = existing?.thesis_scores ?? {
    regulatory:             { status: 'CONFIRMED',     confidence: 'high'   },
    institutional_custody:  { status: 'STRONG',        confidence: 'high'   },
    etf_adoption:           { status: 'CONFIRMED',     confidence: 'high'   },
    xrpl_infrastructure:    { status: 'ACCELERATING',  confidence: 'high'   },
    stablecoin_adoption:    { status: 'GROWING',       confidence: 'medium' },
    odl_volume:             { status: 'NEEDS_DATA',    confidence: 'low'    },
    japan_adoption:         { status: 'FAVORABLE',     confidence: 'medium' },
    macro_environment:      { status: 'STRESSED',      confidence: 'medium' },
  };

  const output = {
    updated:      new Date().toISOString(),
    auto_fetched: true,
    xrp,
    rlusd,
    macro: {
      usd_jpy:       usdJpy,     // { value, data_date, source }
      jpn_10y:       jpn10y,     // { value, data_date, source }
      us_10y_yield:  us10y,      // { value, data_date, source }
      brent_crude:   brent,      // { value, data_date, source }
      dxy:           dxy,        // { value, data_date, source }
      sp500:         sp500,      // { value, data_date, source }
      fear_greed:    fearGreed,  // { value, label, data_date, source }
    },
    x_intelligence: xIntelligence,
    manual,
    kill_switches:  buildKillSwitches(manual, rlusd),
    thesis_scores,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  log('io', `Wrote ${OUTPUT_PATH}`);
  await validateDataContract();

  console.log('\n─── Summary ───────────────────────────────────');
  console.log(`XRP price:       $${xrp.price ?? 'N/A'}`);
  console.log(`RLUSD mktcap:    $${rlusd.market_cap?.toLocaleString() ?? 'N/A'} (${rlusd.source})`);
  console.log(`USD/JPY:         ${usdJpy.value ?? 'N/A'} (${usdJpy.data_date ?? 'no date'})`);
  console.log(`JPN 10Y yield:   ${jpn10y.value ?? 'N/A'}% (${jpn10y.data_date ?? 'no date'})`);
  console.log(`US 10Y yield:    ${us10y.value ?? 'N/A'}% (${us10y.data_date ?? 'no date'})`);
  console.log(`Brent crude:     $${brent.value ?? 'N/A'} (${brent.data_date ?? 'no date'})`);
  console.log(`DXY:             ${dxy.value ?? 'N/A'} (${dxy.data_date ?? 'no date'})`);
  console.log(`S&P 500:         ${sp500.value ?? 'N/A'} (${sp500.data_date ?? 'no date'})`);
  console.log(`Fear & Greed:    ${fearGreed.value ?? 'N/A'} (${fearGreed.label ?? 'N/A'}) (${fearGreed.data_date ?? 'no date'})`);
  console.log('───────────────────────────────────────────────\n');

  await pushToGitHub();

  console.log(`\nDone: ${new Date().toISOString()}`);
}

main().catch(e => {
  console.error('\nFATAL:', e);
  process.exit(1);
});

// ─── Data Contract Validation ─────────────────────────────────────────────────

/**
 * Validates the freshly-written dashboard-data.json against data-contract.json.
 *
 * WHY: fetch-data.js owns a specific subset of dashboard-data.json fields (listed
 * under "required_from_fetch" in data-contract.json). Silent failures — API timeouts,
 * shape changes, rate-limit fallbacks — can leave fields null without crashing the
 * pipeline. This validation makes those failures visible in the run log so they can
 * be caught before the next analysis cycle reads stale or missing data.
 *
 * data-contract.json is the source of truth for what this script is responsible for.
 * Validation runs after the write so it reflects exactly what landed on disk.
 * Wrapped in try/catch: validation MUST NOT crash the pipeline under any circumstance.
 */
async function validateDataContract() {
  try {
    const contractPath = path.join(__dirname, '..', 'data-contract.json');
    const contract     = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    const dashboard    = JSON.parse(fs.readFileSync(OUTPUT_PATH,  'utf8'));

    const fields  = contract?.fields?.required_from_fetch ?? [];
    let populated = 0;
    const missing = [];

    for (const fieldPath of fields) {
      const keys = fieldPath.split('.');
      let value  = dashboard;
      for (const key of keys) {
        value = value?.[key];
      }
      if (value !== null && value !== undefined) {
        populated++;
      } else {
        missing.push(fieldPath);
      }
    }

    log('contract', `DATA CONTRACT: ${populated}/${fields.length} fields populated`);
    for (const f of missing) {
      warn('contract', `missing field: ${f}`);
    }

    // Write pipeline health snapshot for downstream consumers (e.g. analyze-thesis.js).
    // WHY: downstream scripts shouldn't re-run validation themselves — they just need
    // a cheap status read to append one line to Telegram without slowing the pipeline.
    try {
      const health = {
        fetch_timestamp:  new Date().toISOString(),
        fields_populated: populated,
        fields_total:     fields.length,
        missing_fields:   missing,
        status:           missing.length === 0 ? 'OK' : 'DEGRADED',
      };
      const healthPath = path.join(__dirname, 'pipeline-health.json');
      fs.writeFileSync(healthPath, JSON.stringify(health, null, 2));
      log('contract', `Pipeline health written (${health.status})`);
    } catch (writeErr) {
      err('contract', `Could not write pipeline-health.json (non-fatal): ${writeErr.message}`);
    }
  } catch (e) {
    err('contract', `Validation failed (non-fatal): ${e.message}`);
  }
}
