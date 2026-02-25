#!/usr/bin/env node
'use strict';

/**
 * Overwatch Terminal — x402 Testnet Agent (v2)
 *
 * Implements the full x402 v2 protocol flow against T54's XRPL facilitator:
 *
 *   Step 1 — Agent makes HTTP GET /api/premium-data (no payment)
 *   Step 2 — Local server returns 402 + PAYMENT-REQUIRED header (base64 JSON)
 *   Step 3 — Agent decodes requirements, builds XRPL Payment tx with
 *             invoice binding (MemoData + InvoiceID field)
 *   Step 4 — Agent signs tx, encodes PAYMENT-SIGNATURE header, retries
 *   Step 5 — Server calls T54 testnet facilitator /settle
 *   Step 6 — Facilitator verifies + submits signed tx to XRPL testnet
 *   Step 7 — Server returns 200 + data + PAYMENT-RESPONSE header
 *   Step 8 — Agent reads data + payment receipt; writes to dashboard-data.json
 *
 * Reference: https://xrpl-x402.t54.ai/docs/quickstart
 */

const path      = require('path');
const fs        = require('fs');
const http      = require('http');
const crypto    = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const xrpl      = require('xrpl');
const simpleGit = require('simple-git');

// ─── Config ────────────────────────────────────────────────────────────────

const WALLET_FILE     = path.join(__dirname, 'x402-wallet.json');
const DATA_FILE       = path.join(__dirname, '..', 'dashboard-data.json');
const REPO_ROOT       = path.join(__dirname, '..');

const TESTNET_WS      = 'wss://s.altnet.rippletest.net:51233';
const FAUCET_URL      = 'https://faucet.altnet.rippletest.net/accounts';
const FACILITATOR_URL = 'https://xrpl-facilitator-testnet.t54.ai';

const SERVER_HOST     = '127.0.0.1';
const SERVER_PORT     = 4402;
const RESOURCE_PATH   = '/api/premium-data';

// x402 protocol constants (per T54 spec)
const X402_VERSION    = 2;
const NETWORK         = 'xrpl:1';    // XRPL testnet CAIP-2 identifier
const PAYMENT_AMOUNT  = '100';       // drops (0.0001 XRP per request)
const SOURCE_TAG      = 804681468;   // T54 analytics tag — facilitator verifies this

const MIN_BALANCE     = 50;          // XRP — refund threshold

// ─── Logging ───────────────────────────────────────────────────────────────

function log(msg)  { console.log(`[x402-agent] ${msg}`); }
function warn(msg) { console.warn(`[x402-agent] WARN: ${msg}`); }
function err(msg)  { console.error(`[x402-agent] ERROR: ${msg}`); }

// ─── x402 Header Codec ─────────────────────────────────────────────────────

/**
 * Recursively sort object keys for canonical JSON (required by x402 spec).
 * x402 headers are base64(canonicalJSON(payload)).
 */
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

// ─── Wallet / Faucet helpers ───────────────────────────────────────────────

function loadWallets() {
  try {
    if (fs.existsSync(WALLET_FILE)) {
      const raw = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
      if (raw?.agent?.seed && raw?.provider?.seed) return raw;
    }
  } catch (e) {
    warn(`Cannot read wallet file: ${e.message}`);
  }
  return null;
}

function saveWallets(data) {
  fs.writeFileSync(WALLET_FILE, JSON.stringify(data, null, 2));
  log('Wallet state saved');
}

async function callFaucet(address) {
  log(`Requesting testnet XRP for ${address}...`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const res = await fetch(FAUCET_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ destination: address, xrpAmount: '1000' }),
      signal:  controller.signal,
    });
    if (!res.ok) throw new Error(`Faucet HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getBalanceSafe(client, address) {
  try {
    return parseFloat(await client.getXrpBalance(address)) || 0;
  } catch (e) {
    if (e.message?.includes('Account not found') || e.data?.error === 'actNotFound') return 0;
    throw e;
  }
}

async function ensureFunded(client, address, label) {
  const bal = await getBalanceSafe(client, address);
  if (bal >= MIN_BALANCE) {
    log(`${label} (${address.slice(0, 8)}…) balance: ${bal} XRP — ok`);
    return bal;
  }
  log(`${label} balance: ${bal} XRP — below ${MIN_BALANCE}, calling faucet...`);
  await callFaucet(address);
  log('Waiting 12s for faucet to confirm...');
  await new Promise(r => setTimeout(r, 12_000));
  const newBal = await getBalanceSafe(client, address);
  log(`${label} new balance: ${newBal} XRP`);
  return newBal;
}

// ─── x402 Server ───────────────────────────────────────────────────────────

/**
 * Spin up a local HTTP server that acts as a payment-protected endpoint.
 *
 *   GET /api/premium-data (no PAYMENT-SIGNATURE)
 *     → 402 + PAYMENT-REQUIRED header
 *
 *   GET /api/premium-data (with PAYMENT-SIGNATURE header)
 *     → POST to T54 facilitator /settle
 *     → 200 + data + PAYMENT-RESPONSE header   (on success)
 *     → 402                                    (on failure)
 */
function startX402Server(providerAddress) {
  const pendingInvoices = new Map();

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (req.url !== RESOURCE_PATH || req.method !== 'GET') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      // Node's http module lowercases all incoming header names
      const paymentSig = req.headers['payment-signature'];

      if (!paymentSig) {
        // ── Return 402 ────────────────────────────────────────────────────────
        const invoiceId = crypto.randomUUID().replace(/-/g, '').toUpperCase();

        const requirements = {
          scheme:            'exact',
          network:           NETWORK,
          amount:            PAYMENT_AMOUNT,
          asset:             'XRP',
          payTo:             providerAddress,
          maxTimeoutSeconds: 300,
          extra:             { invoiceId, sourceTag: SOURCE_TAG },
        };
        pendingInvoices.set(invoiceId, requirements);

        const body402 = {
          x402Version: X402_VERSION,
          resource: {
            url:         `http://${SERVER_HOST}:${SERVER_PORT}${RESOURCE_PATH}`,
            description: 'Overwatch Terminal — Premium XRPL Testnet Data Feed',
            mimeType:    'application/json',
          },
          accepts:    [requirements],
          error:      'Payment required — include PAYMENT-SIGNATURE header',
          extensions: {},
        };

        log(`[server] 402 → invoiceId ${invoiceId.slice(0, 12)}…`);
        res.writeHead(402, {
          'Content-Type':     'application/json',
          'PAYMENT-REQUIRED': encodeX402Header(body402),
        });
        res.end(JSON.stringify(body402));
        return;
      }

      // ── Settle via T54 facilitator ─────────────────────────────────────────
      try {
        const sigObj    = decodeX402Header(paymentSig);
        const invoiceId = sigObj.payload?.invoiceId;
        const requirements = pendingInvoices.get(invoiceId);

        if (!requirements) {
          log(`[server] Unknown invoiceId: ${invoiceId}`);
          res.writeHead(402);
          res.end(JSON.stringify({ error: 'Unknown invoice — restart request' }));
          return;
        }

        log(`[server] Calling facilitator /settle for invoice ${invoiceId.slice(0, 12)}…`);
        const settleRes = await fetch(`${FACILITATOR_URL}/settle`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            // Facilitator expects the full decoded PAYMENT-SIGNATURE object
            // (x402Version + accepted + payload), not just payload alone
            paymentPayload:      sigObj,
            paymentRequirements: requirements,
          }),
        });

        const settlement = await settleRes.json();
        log(`[server] Facilitator: success=${settlement.success} tx=${settlement.transaction}`);

        if (!settlement.success) {
          res.writeHead(402);
          res.end(JSON.stringify({ error: settlement.errorReason ?? 'Settlement failed' }));
          return;
        }

        pendingInvoices.delete(invoiceId);

        const responseData = {
          access:    'GRANTED',
          resource:  'Overwatch Terminal — Premium XRPL Testnet Data Feed',
          timestamp: new Date().toISOString(),
          payload: {
            description: 'XRPL testnet metrics snapshot (x402 paid access demo)',
            network:     'XRPL TESTNET',
            facilitator: FACILITATOR_URL,
            note:        'Real x402 v2 payment settled on XRPL testnet by T54 facilitator',
          },
          payment: {
            protocol:     'x402',
            version:      X402_VERSION,
            tx_hash:      settlement.transaction,
            payer:        settlement.payer,
            amount_drops: PAYMENT_AMOUNT,
          },
        };

        res.writeHead(200, {
          'Content-Type':     'application/json',
          'PAYMENT-RESPONSE': encodeX402Header({
            success:     true,
            transaction: settlement.transaction,
            network:     settlement.network,
            payer:       settlement.payer,
          }),
        });
        res.end(JSON.stringify(responseData));

      } catch (e) {
        err(`[server] ${e.message}`);
        res.writeHead(500);
        res.end('Internal server error');
      }
    });

    server.listen(SERVER_PORT, SERVER_HOST, () => {
      log(`x402 server listening on http://${SERVER_HOST}:${SERVER_PORT}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

// ─── x402 Client ───────────────────────────────────────────────────────────

/**
 * Execute the full x402 protocol flow:
 *   1. GET url — expect 402
 *   2. Decode PAYMENT-REQUIRED header
 *   3. Build + sign XRPL Payment with invoice binding (MemoData + InvoiceID)
 *   4. Encode PAYMENT-SIGNATURE header
 *   5. Retry GET with signature
 *   6. Decode PAYMENT-RESPONSE header from 200 response
 */
async function x402Request(url, agentWallet, xrplClient) {
  const flowLog = [];

  // ── Step 1: Initial unauthenticated request ─────────────────────────────
  log('Step 1 — sending unauthenticated request...');
  const res1 = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  flowLog.push(`→ GET ${url}  →  HTTP ${res1.status}`);

  if (res1.status !== 402) {
    throw new Error(`Expected 402, got ${res1.status}`);
  }

  // ── Step 2: Decode PAYMENT-REQUIRED header ──────────────────────────────
  const prHeaderRaw = res1.headers.get('payment-required');
  if (!prHeaderRaw) throw new Error('Missing PAYMENT-REQUIRED header on 402');

  const paymentBody = decodeX402Header(prHeaderRaw);
  const req         = paymentBody.accepts?.[0];
  if (!req) throw new Error('No accepted payment terms in 402 body');

  const invoiceId = req.extra?.invoiceId;
  if (!invoiceId) throw new Error('No invoiceId in payment requirements');

  log(`Step 2 — 402 received: ${req.amount} drops → ${req.payTo}, invoiceId ${invoiceId.slice(0, 12)}…`);
  flowLog.push(`← 402 PAYMENT-REQUIRED  amount=${req.amount} drops  invoiceId=${invoiceId.slice(0, 12)}…`);

  // ── Step 3: Build XRPL Payment tx with invoice binding ──────────────────
  //
  //   Binding method A — MemoData = hex(utf8(invoiceId))
  //   Binding method B — InvoiceID field = SHA-256(utf8(invoiceId)) hex
  //   T54 facilitator validates both ("invoiceBinding: both" per x402 spec)
  //
  log('Step 3 — building XRPL Payment tx with invoice binding...');

  const memoData    = Buffer.from(invoiceId, 'utf8').toString('hex').toUpperCase();
  const invoiceHash = crypto.createHash('sha256').update(invoiceId, 'utf8').digest('hex').toUpperCase();

  const tx = {
    TransactionType: 'Payment',
    Account:         agentWallet.address,
    Destination:     req.payTo,
    Amount:          req.amount,                        // drops as string
    SourceTag:       req.extra?.sourceTag ?? SOURCE_TAG, // facilitator verifies this
    Memos:           [{ Memo: { MemoData: memoData } }],
    InvoiceID:       invoiceHash,
  };

  // autofill sets Fee, Sequence, NetworkID from live XRPL state
  const filled = await xrplClient.autofill(tx);

  // Override LastLedgerSequence per x402 spec:
  //   maxDelta = ceil(maxTimeoutSeconds / avg_ledger_close_time) + 2
  const serverInfo    = await xrplClient.request({ command: 'server_info' });
  const currentLedger = serverInfo.result.info.validated_ledger.seq;
  const maxDelta      = Math.ceil((req.maxTimeoutSeconds ?? 300) / 5) + 2;
  filled.LastLedgerSequence = currentLedger + maxDelta;

  const signed = agentWallet.sign(filled);
  log(`Step 3 — signed tx: ${signed.hash}`);
  flowLog.push(`→ Signed XRPL Payment  hash=${signed.hash.slice(0, 12)}…  MemoData+InvoiceID bound`);

  // ── Step 4: Encode PAYMENT-SIGNATURE header and retry ───────────────────
  const sigPayload = {
    x402Version: X402_VERSION,
    accepted:    req,
    payload:     { signedTxBlob: signed.tx_blob, invoiceId },
  };
  const paymentSig = encodeX402Header(sigPayload);

  log('Step 4 — retrying with PAYMENT-SIGNATURE header...');
  const res2 = await fetch(url, {
    method:  'GET',
    headers: { Accept: 'application/json', 'PAYMENT-SIGNATURE': paymentSig },
  });
  flowLog.push(`→ GET ${url} (PAYMENT-SIGNATURE)  →  HTTP ${res2.status}`);

  if (res2.status !== 200) {
    const body = await res2.text().catch(() => '');
    throw new Error(`Payment rejected (HTTP ${res2.status}): ${body}`);
  }

  // ── Step 5: Read data + PAYMENT-RESPONSE ────────────────────────────────
  const responseData    = await res2.json();
  const prResponseRaw   = res2.headers.get('payment-response');
  const paymentResponse = prResponseRaw ? decodeX402Header(prResponseRaw) : null;

  log(`Step 5 — payment confirmed: tx=${paymentResponse?.transaction ?? '(none)'}`);
  flowLog.push(`← 200 PAYMENT-RESPONSE  tx=${(paymentResponse?.transaction ?? '?').slice(0, 12)}…  payer=${(paymentResponse?.payer ?? '?').slice(0, 10)}…`);

  return { data: responseData, paymentResponse, signedTxHash: signed.hash, invoiceId, flowLog };
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
  console.log('\n━━━ Overwatch x402 Testnet Agent (v2 — full protocol) ━━━');
  console.log(`Started: ${new Date().toISOString()}\n`);

  // ── Wallets ──────────────────────────────────────────────────────────────
  let walletState = loadWallets();
  let isFirstRun  = false;

  if (!walletState) {
    log('No wallet state — generating new testnet wallets...');
    isFirstRun = true;
    const aw = xrpl.Wallet.generate();
    const pw = xrpl.Wallet.generate();
    walletState = {
      _note:      'TESTNET ONLY — no real-world value',
      network:    'XRPL TESTNET',
      created_at: new Date().toISOString(),
      agent:    { seed: aw.seed, address: aw.address, label: 'Overwatch Analyst Agent' },
      provider: { seed: pw.seed, address: pw.address, label: 'Premium Data Service (DEMO)' },
    };
    saveWallets(walletState);
  }

  const agentWallet    = xrpl.Wallet.fromSeed(walletState.agent.seed);
  const providerWallet = xrpl.Wallet.fromSeed(walletState.provider.seed);
  log(`Agent:    ${agentWallet.address}`);
  log(`Provider: ${providerWallet.address}`);

  // ── XRPL testnet connection + funding ────────────────────────────────────
  const client = new xrpl.Client(TESTNET_WS);
  await client.connect();
  log('Connected to XRPL testnet');

  await ensureFunded(client, agentWallet.address,    'Agent');
  await ensureFunded(client, providerWallet.address, 'Provider');

  // ── Check T54 facilitator is reachable ────────────────────────────────────
  let facilitatorOk      = false;
  let facilitatorDetails = null;
  try {
    const r = await fetch(`${FACILITATOR_URL}/supported`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const supported = await r.json();
    facilitatorOk      = supported?.kinds?.some(k => k.network === NETWORK) ?? false;
    facilitatorDetails = supported?.kinds ?? null;
    log(`Facilitator reachable — ${NETWORK} supported: ${facilitatorOk}`);
  } catch (e) {
    warn(`Facilitator unreachable: ${e.message}`);
  }

  // ── Load existing agent data for counter continuity ───────────────────────
  let existingAgent = null;
  try { existingAgent = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))?.x402_agent; } catch (_) {}
  const prevPaymentCount = existingAgent?.demo_payments_sent ?? 0;

  // ── Start local x402 server ───────────────────────────────────────────────
  const server      = await startX402Server(providerWallet.address);
  const resourceUrl = `http://${SERVER_HOST}:${SERVER_PORT}${RESOURCE_PATH}`;

  // ── Execute x402 protocol flow ────────────────────────────────────────────
  let x402Result   = null;
  let lastPayment  = existingAgent?.last_payment ?? null;
  let paymentCount = prevPaymentCount;

  try {
    x402Result   = await x402Request(resourceUrl, agentWallet, client);
    paymentCount = prevPaymentCount + 1;
    lastPayment  = {
      protocol:     'x402 v2',
      to:           providerWallet.address,
      to_label:     walletState.provider.label,
      amount_drops: PAYMENT_AMOUNT,
      amount_xrp:   parseFloat((parseInt(PAYMENT_AMOUNT, 10) / 1_000_000).toFixed(7)),
      invoice_id:   x402Result.invoiceId,
      tx_hash:      x402Result.paymentResponse?.transaction ?? x402Result.signedTxHash,
      facilitator:  FACILITATOR_URL,
      timestamp:    new Date().toISOString(),
      status:       'SUCCESS',
    };
    log('x402 protocol flow completed ✓');
  } catch (e) {
    err(`x402 flow: ${e.message}`);
    x402Result = { error: e.message, flowLog: [`ERROR: ${e.message}`] };
  }

  // ── Final balance + tx history ────────────────────────────────────────────
  const finalBal = await getBalanceSafe(client, agentWallet.address);

  let txHistory = [];
  try {
    const txRes = await client.request({
      command: 'account_tx', account: agentWallet.address,
      ledger_index_min: -1, ledger_index_max: -1, limit: 10, forward: false,
    });
    txHistory = (txRes.result.transactions ?? []).slice(0, 10).map((entry) => {
      const tx   = entry.tx_json ?? entry.tx ?? {};
      const meta = entry.meta ?? entry.metadata ?? {};
      const amt  = tx.Amount && typeof tx.Amount === 'string' ? tx.Amount : null;
      return {
        type:         tx.TransactionType ?? null,
        hash:         tx.hash ?? entry.hash ?? null,
        amount_xrp:   amt ? parseFloat(xrpl.dropsToXrp(amt)) : null,
        direction:    tx.Account === agentWallet.address ? 'out' : 'in',
        counterparty: tx.Account === agentWallet.address ? (tx.Destination ?? null) : (tx.Account ?? null),
        result:       meta?.TransactionResult ?? null,
        date:         tx.date ? new Date((tx.date + 946684800) * 1000).toISOString() : null,
      };
    });
    log(`Fetched ${txHistory.length} transactions`);
  } catch (e) {
    warn(`tx history: ${e.message}`);
  }

  await client.disconnect();
  server.close();
  log('XRPL disconnected, server stopped');

  // ── Build output block ────────────────────────────────────────────────────
  const x402Agent = {
    network:            'XRPL TESTNET',
    network_warning:    '⚠ TESTNET ONLY — Not real XRP',
    protocol:           'x402 v2',
    facilitator:        FACILITATOR_URL,
    facilitator_ok:     facilitatorOk,
    agent_address:      agentWallet.address,
    agent_label:        walletState.agent.label,
    provider_address:   providerWallet.address,
    provider_label:     walletState.provider.label,
    balance_xrp:        parseFloat(finalBal.toFixed(6)),
    demo_payments_sent: paymentCount,
    last_payment:       lastPayment,
    last_data_received: x402Result?.data ?? null,
    x402_flow:          x402Result?.flowLog ?? [],
    tx_history:         txHistory,
    demo_scenario:      `Agent (${agentWallet.address.slice(0,8)}…) sends HTTP GET → receives 402 → signs XRPL Payment with invoice binding → retries with PAYMENT-SIGNATURE → T54 facilitator settles on XRPL testnet → 200 + data returned`,
    last_updated:       new Date().toISOString(),
  };

  const dashData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  dashData.x402_agent = x402Agent;
  fs.writeFileSync(DATA_FILE, JSON.stringify(dashData, null, 2));
  log('Wrote x402_agent to dashboard-data.json');

  // ── Push ──────────────────────────────────────────────────────────────────
  const filesToPush = ['dashboard-data.json'];
  if (isFirstRun) filesToPush.push('scripts/x402-wallet.json');
  const stamp = new Date().toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
  await pushFiles(filesToPush, `auto: x402 agent update ${stamp}`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n─── x402 Agent Summary ─────────────────────────');
  console.log(`Protocol:       x402 v2 (T54 XRPL facilitator)`);
  console.log(`Agent:          ${agentWallet.address}`);
  console.log(`Provider:       ${providerWallet.address}`);
  console.log(`Balance:        ${finalBal} XRP`);
  console.log(`Payments sent:  ${paymentCount}`);
  if (x402Result?.flowLog?.length) {
    console.log('\nx402 Flow:');
    x402Result.flowLog.forEach(s => console.log(`  ${s}`));
  }
  console.log('─────────────────────────────────────────────────\n');
}

main().catch(e => { err(e.message); process.exit(1); });
