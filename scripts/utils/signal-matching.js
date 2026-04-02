#!/usr/bin/env node
'use strict';

/**
 * Shared signal alias matching — used by both the Signal Dossier Aggregator
 * and the Layer 2 track record injection (AD #21).
 *
 * Single source of truth for signal-to-lineage matching.
 * Uses longest-match-first substring matching on signal-aliases.json.
 *
 * The Integrity Protocol (Patent Pending) — Timothy Joseph Wrenn
 */

const fs = require('fs');

/**
 * Load the signal alias dictionary and return keys sorted longest-first.
 * Longest-match-first prevents substring collisions:
 * "blackrock etf" matches before "blackrock" can steal it.
 *
 * @param {string} aliasPath — absolute path to signal-aliases.json
 * @param {function} [logFn] — optional logging function(area, msg)
 * @returns {{ aliases: object, sortedKeys: string[] }}
 */
function loadAliases(aliasPath, logFn) {
  const log = logFn || (() => {});
  try {
    if (!fs.existsSync(aliasPath)) {
      log('aliases', 'No signal-aliases.json found — all signals will be orphans');
      return { aliases: {}, sortedKeys: [] };
    }
    const raw = JSON.parse(fs.readFileSync(aliasPath, 'utf8'));
    const aliases = {};
    const keys = [];
    for (const [key, value] of Object.entries(raw)) {
      if (key === '_comment') continue;
      aliases[key] = value;
      keys.push(key);
    }
    // Sort by length descending — longest match wins
    keys.sort((a, b) => b.length - a.length);
    log('aliases', `Loaded ${keys.length} alias keys`);
    return { aliases, sortedKeys: keys };
  } catch (e) {
    log('aliases', `Failed to load aliases: ${e.message}`);
    return { aliases: {}, sortedKeys: [] };
  }
}

/**
 * Match a signal title to a lineage using the alias dictionary.
 * Returns { lineage_id, canonical_name } or null if no match.
 *
 * @param {string} signalTitle — signal name/description to match
 * @param {object} aliases — alias dictionary from loadAliases()
 * @param {string[]} sortedKeys — sorted keys from loadAliases()
 * @returns {{ lineage_id: string, canonical_name: string } | null}
 */
function matchAlias(signalTitle, aliases, sortedKeys) {
  const lower = signalTitle.toLowerCase();
  for (const key of sortedKeys) {
    if (lower.includes(key)) {
      return aliases[key];
    }
  }
  return null;
}

module.exports = { loadAliases, matchAlias };
