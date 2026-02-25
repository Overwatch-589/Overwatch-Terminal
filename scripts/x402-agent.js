#!/usr/bin/env node
'use strict';

/**
 * Overwatch Terminal — x402 Agent (XRPL mainnet)
 *
 * Hits three paywalled merchant endpoints in sequence, each an independent
 * x402 v2 transaction settled on XRPL mainnet via the T54 facilitator.
 *
 * Endpoints:
 *   /api/v1/premium-analysis   1000 drops  — thesis scorecard + market snapshot
 *   /api/v1/bear-case          1500 drops  — counter-thesis, competing infra, headwinds
 *   /api/v1/stress-report       500 drops  — macro stress, kill switches
 *
 * Required env vars (scripts/.env):
 *   X402_MAINNET_SEED      — XRPL mainnet wallet seed for the agent
 *   XRPL_FACILITATOR_URL   — T54 facilitator (default: mainnet)
 *   X402_MERCHANT_BASE     — merchant base URL (default: http://127.0.0.1:4403)
 *
 * Protocol flow per endpoint:
 *   Step 1 — GET endpoint (no payment) → expect 402
 *   Step 2 — Decode PAYMENT-REQUIRED header (base64 JSON)
 *   Step 3 — Build XRPL Payment tx with invoice binding
 *             (MemoData = hex(utf8(invoiceId)), InvoiceID = SHA-256(invoiceId))
 *   Step 4 — Sign tx; encode PAYMENT-SIGNATURE header; retry GET
 *   Step 5 — Merchant verifies + settles via T54; tx submitted to XRPL mainnet
 *   Step 6 — Receive 200 + data + PAYMENT-RESPONSE header
 *   Step 7 — Write all three transactions to dashboard-data.json x402_agent block
 */

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const xrpl      = require('xrpl');
const simpleGit = require('simple-git');

// ─── Config ────────────────────────────────────────────────────────────────

const AGENT_SEED = process.env.X402_MAINNET_SEED;
if (!AGENT_SEED) {
  console.error('[x402-agent] FATAL: X402_MAINNET_SEED is required — add it to scripts/.env');
  console.error('[x402-agent] This should be a funded XRPL mainnet wallet seed (sXXX...)');
  process.exit(1);
}

const MERCHANT_BASE   = process.env.X402_MERCHANT_BASE  ?? 'http://127.0.0.1:4403';
const FACILITATOR_URL = process.env.XRPL_FACILITATOR_URL ?? 'https://xrpl-facilitator-mainnet.t54.ai';
const MAINNET_WS      = process.env.XRPL_MAINNET_WS     ?? 'wss://xrplcluster.com';
const DATA_FILE       = path.join(__dirname, '..', 'dashboard-data.json');
const REPO_ROOT       = path.join(__dirname, '..');

// Endpoints to hit in sequence — each is an independent x402 transaction
const ENDPOINTS = [
  { path: '/api/v1/premium-analysis', label: 'Premium Analysis' },
  { path: '/api/v1/bear-case',        label: 'Bear Case'        },
  { path: '/api/v1/stress-report',    label: 'Stress Report'    },
];

// x402 protocol constants
const X402_VERSION = 2;
const NETWORK      = 'xrpl:0';   // XRPL mainnet CAIP-2 identifier
const SOURCE_TAG   = 804681468;  // T54 analytics tag

// Balance thresholds (XRP)
const WARN_BALANCE  = 15;
const ERROR_BALANCE = 2;

// ─── Spending guardrails ────────────────────────────────────────────────────
// All configurable via env; defaults are conservative.

// Minimum balance before any transaction is attempted.
// 10 XRP = XRPL base reserve; +1 XRP safety buffer = 11 XRP.
const BALANCE_FLOOR = parseFloat(process.env.X402_BALANCE_FLOOR ?? '11');

// Maximum total drops the agent may spend in a single session.
// Default: 10000 drops = 0.01 XRP.
const SESSION_CAP_DROPS = parseInt((process.env.X402_SESSION_CAP_DROPS ?? '10000').replace(/\D/g, ''), 10);

// Maximum drops the agent will pay for any single transaction.
// Default: 5000 drops = 0.005 XRP. Rejects rogue/misconfigured merchant prices.
const MAX_SINGLE_DROPS = parseInt((process.env.X402_MAX_SINGLE_DROPS ?? '5000').replace(/\D/g, ''), 10);

// ─── Logging ───────────────────────────────────────────────────────────────

function log(msg)  { console.log(`[x402-agent] ${msg}`); }
function warn(msg) { console.warn(`[x402-agent] WARN: ${msg}`); }
function err(msg)  { console.error(`[x402-agent] ERROR: ${msg}`); }
function guardrail(msg) { console.warn(`[x402-agent] GUARDRAIL: ${msg}`); }

// ─── Guardrail error ────────────────────────────────────────────────────────

// Thrown when a spending guardrail is triggered. Caught separately from
// protocol errors so the loop can skip cleanly rather than counting a failure.
class GuardrailError extends Error {
  constructor(msg) { super(msg); this.name = 'GuardrailError'; }
}

// ─── x402 Header Codec ─────────────────────────────────────────────────────

function canonicalJSON(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(obj[k])).join(',') + '}';
}

function encodeX402Header(obj) {
  return Buffer.from(canonicalJSON(obj), 'utf8').toString('base64');
}

function decodeX402Header(b64) {
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

// ─── x402 Protocol Flow ────────────────────────────────────────────────────

/**
 * Execute one full x402 round-trip for a single URL:
 *   1. GET → 402 → decode requirements
 *   2. Build + sign XRPL Payment with invoice binding
 *   3. Retry GET with PAYMENT-SIGNATURE
 *   4. Return data + payment receipt
 */
async function x402Request(url, label, agentWallet, xrplClient, { sessionDropsSpent, sessionCapDrops, maxSingleDrops }) {
  const flowLog = [];
  const prefix  = `[${label}]`;

  // Step 1: Unauthenticated request
  log(`${prefix} Step 1 — GET ${url}`);
  const res1 = await fetch(url, {
    method:  'GET',
    headers: { Accept: 'application/json' },
    signal:  AbortSignal.timeout(15_000),
  });
  flowLog.push(`→ GET ${url}  →  HTTP ${res1.status}`);

  if (res1.status !== 402) {
    const body = await res1.text().catch(() => '');
    throw new Error(`${prefix} Expected 402, got ${res1.status}: ${body.slice(0, 200)}`);
  }

  // Step 2: Decode PAYMENT-REQUIRED header
  const prHeaderRaw = res1.headers.get('payment-required');
  if (!prHeaderRaw) throw new Error(`${prefix} Missing PAYMENT-REQUIRED header`);

  const paymentBody = decodeX402Header(prHeaderRaw);
  const req         = paymentBody.accepts?.[0];
  if (!req) throw new Error(`${prefix} No accepted payment terms in 402 body`);

  const invoiceId = req.extra?.invoiceId;
  if (!invoiceId) throw new Error(`${prefix} No invoiceId in payment requirements`);

  // Strip non-numeric characters (guard against stray unicode from env editors)
  req.amount = String(req.amount).replace(/\D/g, '');
  if (!req.amount) throw new Error(`${prefix} Payment amount empty after sanitizing`);

  const drops = parseInt(req.amount, 10);

  // Guardrail: per-transaction max
  if (drops > maxSingleDrops) {
    throw new GuardrailError(
      `skipped ${url} — merchant requested ${drops} drops, exceeds per-tx max of ${maxSingleDrops} drops`
    );
  }

  // Guardrail: session spending cap
  if (sessionDropsSpent + drops > sessionCapDrops) {
    throw new GuardrailError(
      `skipped ${url} — session spending cap reached (${sessionDropsSpent} + ${drops} = ${sessionDropsSpent + drops} > ${sessionCapDrops} drops cap)`
    );
  }

  log(`${prefix} Step 2 — 402: ${req.amount} drops → ${req.payTo.slice(0, 10)}… invoiceId ${invoiceId.slice(0, 12)}…`);
  flowLog.push(`← 402  amount=${req.amount} drops  invoiceId=${invoiceId.slice(0, 12)}…`);

  // Step 3: Build XRPL Payment with invoice binding
  //   MemoData  = hex(utf8(invoiceId))          — binding method A
  //   InvoiceID = SHA-256(utf8(invoiceId)) hex   — binding method B
  const memoData    = Buffer.from(invoiceId, 'utf8').toString('hex').toUpperCase();
  const invoiceHash = crypto.createHash('sha256').update(invoiceId, 'utf8').digest('hex').toUpperCase();

  const tx = {
    TransactionType: 'Payment',
    Account:         agentWallet.address,
    Destination:     req.payTo,
    Amount:          req.amount,
    SourceTag:       req.extra?.sourceTag ?? SOURCE_TAG,
    Memos:           [{ Memo: { MemoData: memoData } }],
    InvoiceID:       invoiceHash,
  };

  const filled = await xrplClient.autofill(tx);

  // Guardrail: payment-type whitelist — only sign simple Payment transactions.
  // Guards against autofill mutation or a malicious server injecting a different type.
  if (filled.TransactionType !== 'Payment') {
    throw new GuardrailError(
      `blocked non-Payment transaction type: ${filled.TransactionType}`
    );
  }

  // Set LastLedgerSequence per x402 spec
  const serverInfo    = await xrplClient.request({ command: 'server_info' });
  const currentLedger = serverInfo.result.info.validated_ledger.seq;
  filled.LastLedgerSequence = currentLedger + Math.ceil((req.maxTimeoutSeconds ?? 300) / 4) + 2;

  const signed = agentWallet.sign(filled);
  log(`${prefix} Step 3 — signed tx: ${signed.hash}`);
  flowLog.push(`→ Signed Payment  hash=${signed.hash.slice(0, 12)}…  drops=${req.amount}`);

  // Step 4: Retry with PAYMENT-SIGNATURE
  const sigPayload = {
    x402Version: X402_VERSION,
    accepted:    req,
    payload:     { signedTxBlob: signed.tx_blob, invoiceId },
  };

  log(`${prefix} Step 4 — retrying with PAYMENT-SIGNATURE…`);
  const res2 = await fetch(url, {
    method:  'GET',
    headers: { Accept: 'application/json', 'PAYMENT-SIGNATURE': encodeX402Header(sigPayload) },
    signal:  AbortSignal.timeout(45_000),
  });
  flowLog.push(`→ GET (+PAYMENT-SIGNATURE)  →  HTTP ${res2.status}`);

  if (res2.status !== 200) {
    const body = await res2.text().catch(() => '');
    throw new Error(`${prefix} Payment rejected (HTTP ${res2.status}): ${body.slice(0, 200)}`);
  }

  // Step 5: Read response
  const responseData    = await res2.json();
  const prResponseRaw   = res2.headers.get('payment-response');
  const paymentResponse = prResponseRaw ? decodeX402Header(prResponseRaw) : null;
  const txHash          = paymentResponse?.transaction ?? signed.hash;

  log(`${prefix} Step 5 — confirmed: tx=${txHash.slice(0, 12)}… ✓`);
  flowLog.push(`← 200  tx=${txHash.slice(0, 12)}…  payer=${agentWallet.address.slice(0, 10)}…`);

  return { data: responseData, paymentResponse, signedTxHash: signed.hash, invoiceId, flowLog, payTo: req.payTo };
}

// ─── Balance check ─────────────────────────────────────────────────────────

async function checkBalance(client, address) {
  try {
    return parseFloat(await client.getXrpBalance(address)) || 0;
  } catch (e) {
    if (e.message?.includes('Account not found') || e.data?.error === 'actNotFound') {
      throw new Error(`Agent wallet ${address} not found on XRPL mainnet — fund with at least ${WARN_BALANCE} XRP first`);
    }
    throw e;
  }
}

// ─── Git push helper ───────────────────────────────────────────────────────

async function pushFiles(files, message) {
  const git    = simpleGit(REPO_ROOT);
  const isRepo = await git.checkIsRepo();
  if (!isRepo) { warn('Not a git repo — skipping push'); return; }
  try {
    for (const f of files) await git.add(f);
    const status = await git.status();
    if (status.staged.length === 0) { log('Nothing to commit'); return; }
    await git.commit(message);
    await git.push('origin', 'main');
    log(`Pushed: "${message}"`);
  } catch (e) {
    err(`Git push failed: ${e.message}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n━━━ Overwatch x402 Agent (XRPL mainnet — 3 endpoints) ━━━');
  console.log(`Started: ${new Date().toISOString()}\n`);

  // Load agent wallet
  let agentWallet;
  try {
    agentWallet = xrpl.Wallet.fromSeed(AGENT_SEED);
  } catch (e) {
    err(`Invalid X402_MAINNET_SEED: ${e.message}`);
    process.exit(1);
  }
  log(`Agent:       ${agentWallet.address}`);
  log(`Merchant:    ${MERCHANT_BASE}`);
  log(`Facilitator: ${FACILITATOR_URL}`);
  log(`Endpoints:   ${ENDPOINTS.map(e => e.label).join(' → ')}`);

  // Connect to XRPL mainnet
  const client = new xrpl.Client(MAINNET_WS);
  try {
    await client.connect();
    log(`Connected to XRPL mainnet (${MAINNET_WS})`);
  } catch (e) {
    err(`Cannot connect to XRPL mainnet: ${e.message}`);
    process.exit(1);
  }

  // Balance check
  let balance;
  try {
    balance = await checkBalance(client, agentWallet.address);
  } catch (e) {
    err(e.message);
    await client.disconnect();
    process.exit(1);
  }

  log(`Balance: ${balance} XRP`);
  if (balance < ERROR_BALANCE) {
    err(`Balance too low (${balance} XRP) — minimum ${ERROR_BALANCE} XRP required. Fund ${agentWallet.address} and retry.`);
    await client.disconnect();
    process.exit(1);
  }
  if (balance < WARN_BALANCE) {
    warn(`Low balance (${balance} XRP) — consider topping up ${agentWallet.address}`);
  }

  // Check facilitator
  let facilitatorOk = false;
  try {
    const r = await fetch(`${FACILITATOR_URL}/supported`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const supported = await r.json();
    facilitatorOk   = supported?.kinds?.some(k => k.network === NETWORK) ?? false;
    log(`Facilitator reachable — ${NETWORK} supported: ${facilitatorOk}`);
    if (!facilitatorOk) warn(`${NETWORK} not listed in supported kinds — proceeding anyway`);
  } catch (e) {
    warn(`Facilitator check: ${e.message} — proceeding`);
  }

  // Check merchant health
  try {
    const r = await fetch(`${MERCHANT_BASE}/health`, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    log(`Merchant healthy at ${MERCHANT_BASE}`);
  } catch (e) {
    err(`Merchant not reachable at ${MERCHANT_BASE}/health: ${e.message}`);
    err('Start it first: node scripts/x402-merchant.js');
    await client.disconnect();
    process.exit(1);
  }

  // Load existing data for payment count and lifetime spend continuity
  let existingAgent     = null;
  let prevCount         = 0;
  let lifetimeDrops     = 0;
  try {
    existingAgent = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))?.x402_agent;
    prevCount     = existingAgent?.payments_sent          ?? 0;
    lifetimeDrops = existingAgent?.lifetime_drops_spent   ?? 0;
  } catch (_) {}

  log(`Guardrails: balance floor=${BALANCE_FLOOR} XRP | session cap=${SESSION_CAP_DROPS} drops | per-tx max=${MAX_SINGLE_DROPS} drops`);

  // ── Execute x402 flow for each endpoint in sequence ────────────────────────
  const transactions    = [];
  const allFlowLogs     = [];
  let   successCount    = 0;
  let   sessionDropsSpent = 0;

  for (const endpoint of ENDPOINTS) {
    const url = `${MERCHANT_BASE}${endpoint.path}`;
    console.log(`\n  ── ${endpoint.label} (${url}) ──`);

    // Guardrail: re-check balance before each transaction
    let currentBalance;
    try {
      currentBalance = await checkBalance(client, agentWallet.address);
    } catch (e) {
      err(`Balance check failed before ${endpoint.label}: ${e.message}`);
      break;
    }

    if (currentBalance < BALANCE_FLOOR) {
      guardrail(`skipped ${endpoint.path} — balance ${currentBalance} XRP below ${BALANCE_FLOOR} XRP floor`);
      transactions.push({
        endpoint:  endpoint.path,
        label:     endpoint.label,
        status:    'SKIPPED',
        reason:    `balance ${currentBalance} XRP below ${BALANCE_FLOOR} XRP floor`,
        timestamp: new Date().toISOString(),
      });
      allFlowLogs.push(`── ${endpoint.label} ──`, `GUARDRAIL: balance floor hit (${currentBalance} XRP)`);
      // Floor hit — stop all remaining endpoints
      break;
    }

    try {
      const result = await x402Request(url, endpoint.label, agentWallet, client, {
        sessionDropsSpent,
        sessionCapDrops: SESSION_CAP_DROPS,
        maxSingleDrops:  MAX_SINGLE_DROPS,
      });

      const txHash = result.paymentResponse?.transaction ?? result.signedTxHash;
      const drops  = result.data?.payment?.amount_drops ?? '?';
      const dropsInt = typeof drops === 'string' && drops !== '?' ? parseInt(drops, 10) : 0;

      sessionDropsSpent += dropsInt;

      transactions.push({
        endpoint:     endpoint.path,
        label:        endpoint.label,
        pay_to:       result.payTo,
        amount_drops: drops,
        amount_xrp:   dropsInt > 0 ? parseFloat((dropsInt / 1_000_000).toFixed(7)) : null,
        invoice_id:   result.invoiceId,
        tx_hash:      txHash,
        status:       'SUCCESS',
        timestamp:    new Date().toISOString(),
      });

      allFlowLogs.push(`── ${endpoint.label} ──`, ...result.flowLog);
      successCount++;

      if (txHash && txHash.length > 10) {
        console.log(`  ✓ tx: ${txHash}`);
        console.log(`  ✓ explorer: https://livenet.xrpl.org/transactions/${txHash}`);
      }
    } catch (e) {
      if (e.name === 'GuardrailError') {
        guardrail(e.message);
        transactions.push({
          endpoint:  endpoint.path,
          label:     endpoint.label,
          status:    'SKIPPED',
          reason:    e.message,
          timestamp: new Date().toISOString(),
        });
        allFlowLogs.push(`── ${endpoint.label} ──`, `GUARDRAIL: ${e.message}`);
      } else {
        err(`${endpoint.label} failed: ${e.message}`);
        transactions.push({
          endpoint:  endpoint.path,
          label:     endpoint.label,
          status:    'FAILED',
          error:     e.message,
          timestamp: new Date().toISOString(),
        });
        allFlowLogs.push(`── ${endpoint.label} ──`, `ERROR: ${e.message}`);
      }
    }
  }

  // Final balance
  const finalBalance = await checkBalance(client, agentWallet.address).catch(() => balance);
  await client.disconnect();
  log('XRPL mainnet disconnected');

  const totalDropsSpent = sessionDropsSpent;

  // ── Write to dashboard-data.json ──────────────────────────────────────────
  const x402Agent = {
    network:             'XRPL MAINNET',
    merchant_address:    transactions.find(t => t.pay_to)?.pay_to ?? null,
    protocol:            'x402 v2',
    facilitator:         FACILITATOR_URL,
    facilitator_ok:      facilitatorOk,
    agent_address:       agentWallet.address,
    merchant_base:       MERCHANT_BASE,
    balance_xrp:         parseFloat(finalBalance.toFixed(6)),
    payments_sent:       prevCount + successCount,
    session_drops_spent: totalDropsSpent,
    session_xrp_spent:   parseFloat((totalDropsSpent / 1_000_000).toFixed(7)),
    lifetime_drops_spent: lifetimeDrops + totalDropsSpent,
    lifetime_xrp_spent:   parseFloat(((lifetimeDrops + totalDropsSpent) / 1_000_000).toFixed(7)),
    guardrails: {
      balance_floor_xrp: BALANCE_FLOOR,
      session_cap_drops: SESSION_CAP_DROPS,
      max_single_drops:  MAX_SINGLE_DROPS,
    },
    transactions,
    // last_payment kept for dashboard backward compat — mirrors most recent success
    last_payment: transactions.filter(t => t.status === 'SUCCESS').slice(-1)[0] ?? null,
    x402_flow:    allFlowLogs,
    last_updated: new Date().toISOString(),
  };

  const dashData      = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  dashData.x402_agent = x402Agent;
  fs.writeFileSync(DATA_FILE, JSON.stringify(dashData, null, 2));
  log('Wrote x402_agent block to dashboard-data.json');

  // Push
  const stamp = new Date().toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
  await pushFiles(['dashboard-data.json'], `auto: x402 mainnet agent update ${stamp}`);

  // Summary
  console.log('\n─── x402 Agent Summary ──────────────────────────────');
  console.log(`Network:       XRPL MAINNET`);
  console.log(`Agent:         ${agentWallet.address}`);
  console.log(`Balance:       ${finalBalance} XRP  (was ${balance} XRP)  [floor: ${BALANCE_FLOOR} XRP]`);
  console.log(`Session:       ${successCount}/${ENDPOINTS.length} paid  |  ${totalDropsSpent} drops spent  |  cap: ${SESSION_CAP_DROPS} drops`);
  console.log(`Lifetime:      ${lifetimeDrops + totalDropsSpent} drops (${((lifetimeDrops + totalDropsSpent) / 1_000_000).toFixed(6)} XRP) across ${prevCount + successCount} payments`);
  console.log('');
  transactions.forEach(t => {
    const icon = t.status === 'SUCCESS' ? '✓' : t.status === 'SKIPPED' ? '⊘' : '✗';
    const detail = t.status === 'SUCCESS' && t.tx_hash ? `  tx=${t.tx_hash.slice(0, 14)}…`
                 : t.status === 'SKIPPED'              ? `  (${t.reason?.slice(0, 60)})`
                 : t.error                             ? `  ERR: ${t.error.slice(0, 60)}`
                 : '';
    const drops = t.amount_drops != null && t.amount_drops !== '?' ? `${t.amount_drops} drops` : '—';
    console.log(`  ${icon} ${t.label.padEnd(20)} ${drops.padEnd(12)}${detail}`);
  });
  console.log('─────────────────────────────────────────────────────\n');
}

main().catch(e => { err(e.message); process.exit(1); });
