#!/usr/bin/env node
'use strict';

/**
 * Overwatch Terminal — x402 Base Agent Module
 * AD #19: Multi-chain acquisition via vendor-agnostic adapter pattern
 *
 * Executes x402 payments on Base (EVM) using USDC via the @x402/fetch library.
 * Vendor-specific request formatting, response parsing, and failover behavior
 * are isolated in the CHANNEL_ADAPTERS registry. The execution loop is blind
 * to which vendor it is talking to — it calls adapter methods.
 *
 * This module is a library — imported by analyze-thesis.js when the routing
 * engine selects a Base channel. It is NOT a standalone script like
 * x402-agent.js (the XRPL manual-trigger agent).
 *
 * The @x402/fetch library handles the entire 402→pay→200 flow automatically:
 *   1. POST to endpoint → receive 402 with payment requirements
 *   2. Library signs USDC transfer authorization (EIP-3009)
 *   3. Library retries with PAYMENT-SIGNATURE header
 *   4. Facilitator settles on Base mainnet
 *   5. Endpoint returns 200 with data
 *
 * Adding a new vendor: Add an entry to CHANNEL_ADAPTERS with the five required
 * methods/properties. No changes to the execution loop needed.
 *
 * paper_trade_only: When true (default), logs what WOULD be purchased
 * without executing any payment. No wallet key required for paper trading.
 *
 * The Integrity Protocol (Patent Pending) — Timothy Joseph Wrenn
 */

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg)  { console.log(`[x402-base] ${msg}`); }
function warn(msg) { console.warn(`[x402-base] WARN: ${msg}`); }
function err(msg)  { console.error(`[x402-base] ERROR: ${msg}`); }

// ─── Channel Adapters ─────────────────────────────────────────────────────────
//
// Each adapter isolates vendor-specific quirks:
//   buildPayload(query, opts)  — Construct the request body
//   buildHeaders(env)          — Construct auth/custom headers (beyond Content-Type)
//   parseResponse(data)        — Extract structured content from vendor response
//   timeoutMs                  — x402 payment flow timeout
//   supportsFiatFailover       — Whether a non-x402 fallback exists
//   failoverEndpoint           — Fiat API URL (if supportsFiatFailover)
//   buildFailoverPayload       — Request body for fiat fallback (if supportsFiatFailover)
//   buildFailoverHeaders       — Headers for fiat fallback (if supportsFiatFailover)
//
// To add a new vendor: add an entry here. The execution loop does not change.

const CHANNEL_ADAPTERS = {

  firecrawl: {
    buildPayload(query, opts) {
      const limit = Math.min(opts.limit || 5, 10);
      const body = { query, limit };
      if (opts.scrapeContent !== false) {
        body.scrapeOptions = { formats: ['markdown'], onlyMainContent: true };
      }
      return body;
    },

    buildHeaders(env) {
      const headers = {};
      if (env.FIRECRAWL_API_KEY) {
        headers['Authorization'] = `Bearer ${env.FIRECRAWL_API_KEY}`;
      }
      return headers;
    },

    parseResponse(data) {
      const items = Array.isArray(data.data) ? data.data : [];
      return {
        result_count: items.length,
        results: items.map(item => ({
          title: item.title || null,
          description: item.description || null,
          url: item.url || null,
          has_markdown: !!(item.markdown && item.markdown.length > 0),
          markdown_length: item.markdown ? item.markdown.length : 0,
          content: item.markdown || item.description || null
        }))
      };
    },

    timeoutMs: 15000,
    supportsFiatFailover: true,
    failoverEndpoint: 'https://api.firecrawl.dev/v1/search',

    buildFailoverPayload(query, opts) {
      // Same format as x402 payload
      return this.buildPayload(query, opts);
    },

    buildFailoverHeaders(env) {
      return { 'Authorization': `Bearer ${env.FIRECRAWL_API_KEY}` };
    }
  },

  messari: {
    buildPayload(query) {
      return {
        messages: [
          { role: 'user', content: query }
        ],
        response_format: 'markdown',
        stream: false,
        verbosity: 'succinct'
      };
    },

    buildHeaders() {
      // x402 payment IS the auth — no additional headers needed
      return {};
    },

    parseResponse(data) {
      // Messari returns OpenAI-compatible chat completions format
      const messages = (data.data && data.data.messages) || data.messages || [];
      const content = messages.length > 0 ? messages[0].content : null;
      return {
        result_count: content ? 1 : 0,
        results: content ? [{
          title: 'Messari Intelligence Response',
          description: content.slice(0, 200),
          url: null,
          has_markdown: true,
          markdown_length: content.length,
          content: content
        }] : []
      };
    },

    timeoutMs: 60000,
    supportsFiatFailover: false,
    failoverEndpoint: null,
    buildFailoverPayload() { return null; },
    buildFailoverHeaders() { return {}; }
  }

};

// ─── Adapter Lookup ───────────────────────────────────────────────────────────

/**
 * Resolve the adapter for a channel. Uses channel.vendor_type first,
 * falls back to matching channel.id prefix against adapter keys.
 * Returns null if no adapter matches.
 */
function getAdapter(channel) {
  // Explicit vendor_type takes priority
  if (channel.vendor_type && CHANNEL_ADAPTERS[channel.vendor_type]) {
    return CHANNEL_ADAPTERS[channel.vendor_type];
  }
  // Fallback: match channel.id prefix (e.g., "firecrawl-base" → "firecrawl")
  for (const key of Object.keys(CHANNEL_ADAPTERS)) {
    if (channel.id && channel.id.startsWith(key)) {
      return CHANNEL_ADAPTERS[key];
    }
  }
  return null;
}

// ─── executeBaseAcquisition ───────────────────────────────────────────────────

/**
 * Execute (or paper trade) a data acquisition request on a Base/EVM channel.
 *
 * @param {object} channel    — Channel config from domain.json acquisition_channels[]
 * @param {string} query      — The falsifiable question / search query
 * @param {object} [opts]     — Optional overrides
 * @param {string} [opts.baseWalletKey]  — Private key (hex, 0x-prefixed). Falls back to env.
 * @param {number} [opts.limit]          — Max search results (default: 5, max: 10)
 * @param {boolean} [opts.scrapeContent] — Include markdown content (default: true)
 * @returns {object} Structured result for paper trade logger / outcome tracking
 */
async function executeBaseAcquisition(channel, query, opts = {}) {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  // ── Resolve adapter ───────────────────────────────────────────────────────
  const adapter = getAdapter(channel);
  if (!adapter) {
    err(`No adapter found for channel ${channel.id} (vendor_type: ${channel.vendor_type || 'none'})`);
    return {
      channel_id: channel.id, channel_name: channel.name,
      settlement_network: channel.network, settlement_asset: channel.settlement_asset,
      query, status: 'ERROR', paper_trade: false, cost_usd: channel.cost_per_request_usd || 0,
      data: null, error: `No adapter for channel ${channel.id}`, duration_ms: Date.now() - startTime,
      timestamp
    };
  }

  // ── Build result skeleton ─────────────────────────────────────────────────
  const result = {
    channel_id: channel.id,
    channel_name: channel.name,
    settlement_network: channel.network,
    settlement_asset: channel.settlement_asset,
    query: query,
    status: null,
    paper_trade: channel.paper_trade_only !== false,
    cost_usd: channel.cost_per_request_usd || 0,
    data: null,
    error: null,
    duration_ms: null,
    timestamp: timestamp
  };

  // ── Paper trade path ──────────────────────────────────────────────────────
  if (channel.paper_trade_only !== false) {
    log(`PAPER TRADE: Would query "${query.slice(0, 80)}..." via ${channel.name}`);
    log(`  Channel: ${channel.id} | Network: ${channel.network} | Cost: ${channel.cost_per_request_usd}`);
    log(`  Endpoint: ${channel.facilitator}`);
    result.status = 'PAPER_TRADE';
    result.duration_ms = Date.now() - startTime;
    return result;
  }

  // ── Live acquisition path ─────────────────────────────────────────────────
  // Lazy-load x402 packages — only needed for live execution
  let wrapFetchWithPayment, x402Client, registerExactEvmScheme, privateKeyToAccount;
  try {
    const fetchMod = require('@x402/fetch');
    wrapFetchWithPayment = fetchMod.wrapFetchWithPayment;

    const coreMod = require('@x402/core/client');
    x402Client = coreMod.x402Client;

    const evmMod = require('@x402/evm/exact/client');
    registerExactEvmScheme = evmMod.registerExactEvmScheme;

    const viemMod = require('viem/accounts');
    privateKeyToAccount = viemMod.privateKeyToAccount;
  } catch (e) {
    err(`Failed to load x402 Base dependencies: ${e.message}`);
    err('Run: cd scripts && npm install');
    result.status = 'ERROR';
    result.error = `Missing dependencies: ${e.message}`;
    result.duration_ms = Date.now() - startTime;
    return result;
  }

  // ── Wallet setup ──────────────────────────────────────────────────────────
  const walletKey = opts.baseWalletKey || process.env.BASE_WALLET_PRIVATE_KEY;
  if (!walletKey) {
    err('No BASE_WALLET_PRIVATE_KEY — cannot execute live acquisition');
    result.status = 'ERROR';
    result.error = 'Missing BASE_WALLET_PRIVATE_KEY';
    result.duration_ms = Date.now() - startTime;
    return result;
  }

  let signer;
  try {
    // Ensure 0x prefix
    const key = walletKey.startsWith('0x') ? walletKey : `0x${walletKey}`;
    signer = privateKeyToAccount(key);
    log(`Base wallet: ${signer.address}`);
  } catch (e) {
    err(`Invalid BASE_WALLET_PRIVATE_KEY: ${e.message}`);
    result.status = 'ERROR';
    result.error = `Invalid wallet key: ${e.message}`;
    result.duration_ms = Date.now() - startTime;
    return result;
  }

  // ── Build x402 client ─────────────────────────────────────────────────────
  let fetchWithPayment;
  try {
    const client = new x402Client();
    registerExactEvmScheme(client, { signer });
    fetchWithPayment = wrapFetchWithPayment(fetch, client);
    log('x402 Base client initialized');
  } catch (e) {
    err(`Failed to initialize x402 client: ${e.message}`);
    result.status = 'ERROR';
    result.error = `x402 client init failed: ${e.message}`;
    result.duration_ms = Date.now() - startTime;
    return result;
  }

  // ── Execute acquisition (vendor-agnostic) ─────────────────────────────────
  const endpoint = channel.facilitator;
  const body = adapter.buildPayload(query, opts);
  const vendorHeaders = adapter.buildHeaders(process.env);

  log(`Executing: POST ${endpoint}`);
  log(`  Query: "${query.slice(0, 100)}"`);
  log(`  Adapter: ${channel.vendor_type || channel.id} | Timeout: ${adapter.timeoutMs}ms`);

  try {
    const x402Promise = fetchWithPayment(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...vendorHeaders
      },
      body: JSON.stringify(body)
    });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`x402 payment flow timed out (${adapter.timeoutMs}ms)`)), adapter.timeoutMs)
    );
    const response = await Promise.race([x402Promise, timeoutPromise]);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 200)}`);
    }

    const data = await response.json();
    const parsed = adapter.parseResponse(data);

    log(`Success: ${parsed.result_count} result(s) returned`);

    result.status = 'SUCCESS';
    result.data = parsed;
    result.duration_ms = Date.now() - startTime;
    return result;

  } catch (e) {
    // ── VENDOR FAILOVER: x402 infrastructure failure → fiat credit reserve ──
    if (adapter.supportsFiatFailover) {
      const failoverHeaders = adapter.buildFailoverHeaders(process.env);
      const hasAuth = Object.keys(failoverHeaders).length > 0;

      if (hasAuth && adapter.failoverEndpoint) {
        warn(`x402 VENDOR_INFRASTRUCTURE_FAILURE: ${e.message}`);
        warn('Executing FIAT_CREDIT_RESERVE_FAILOVER — direct API with subscription credits');
        warn(`  Original channel: ${channel.id} (${channel.network}/${channel.settlement_asset})`);
        warn(`  Failover: ${adapter.failoverEndpoint}`);
        warn('  Cost still deducted from acquisition budget as USD equivalent');

        try {
          const fallbackBody = adapter.buildFailoverPayload(query, opts);
          log(`FAILOVER: POST ${adapter.failoverEndpoint}`);

          const fallbackResponse = await fetch(adapter.failoverEndpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...failoverHeaders
            },
            body: JSON.stringify(fallbackBody),
            signal: AbortSignal.timeout(30000)
          });

          if (!fallbackResponse.ok) {
            const errorText = await fallbackResponse.text().catch(() => '');
            throw new Error(`Failover HTTP ${fallbackResponse.status}: ${errorText.slice(0, 200)}`);
          }

          const data = await fallbackResponse.json();
          const parsed = adapter.parseResponse(data);

          log(`FAILOVER SUCCESS: ${parsed.result_count} result(s) via fiat credit reserve`);

          result.status = 'VENDOR_FAILOVER';
          result.data = {
            ...parsed,
            failover_reason: e.message,
            settlement_method: 'FIAT_CREDIT_RESERVE',
            original_channel: channel.id
          };
          result.duration_ms = Date.now() - startTime;
          return result;

        } catch (fallbackErr) {
          err(`FAILOVER ALSO FAILED: ${fallbackErr.message}`);
          result.status = 'ERROR';
          result.error = `x402: ${e.message} | Failover: ${fallbackErr.message}`;
          result.duration_ms = Date.now() - startTime;
          return result;
        }
      }
    }

    err(`Acquisition failed for ${channel.id}: ${e.message}`);
    result.status = 'ERROR';
    result.error = e.message;
    result.duration_ms = Date.now() - startTime;
    return result;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { executeBaseAcquisition };
