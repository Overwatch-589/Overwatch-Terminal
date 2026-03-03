'use strict';
const { X_MONITOR_ACCOUNTS } = require('./x-monitor-config');
function log(label, msg) { console.log('[' + label + '] ' + msg); }
function warn(label, msg) { console.warn('[' + label + '] WARN: ' + msg); }
function err(label, msg) { console.error('[' + label + '] ERROR: ' + msg); }
function buildSearchQueries(accounts) {
  const queries = [];
  let current = '';
  for (const username of accounts) {
    const fragment = 'from:' + username;
    const candidate = current ? current + ' OR ' + fragment : fragment;
    if (candidate.length > 500) {
      queries.push(current);
      current = fragment;
    } else {
      current = candidate;
    }
  }
  if (current) queries.push(current);
  return queries;
}
async function searchRecentPosts(query, bearerToken, maxResults, sinceId) {
  const params = new URLSearchParams({
    query: query,
    max_results: String(maxResults),
    'tweet.fields': 'created_at,author_id,public_metrics',
    expansions: 'author_id',
    'user.fields': 'username',
  });
  if (sinceId) params.set('since_id', sinceId);
  const url = 'https://api.x.com/2/tweets/search/recent?' + params.toString();
  const controller = new AbortController();
  const timer = setTimeout(function() { controller.abort(); }, 15000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: 'Bearer ' + bearerToken },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text();
      throw new Error('HTTP ' + res.status + ': ' + body.slice(0, 200));
    }
    const data = await res.json();
    const userMap = {};
    if (data.includes && data.includes.users) {
      for (const u of data.includes.users) {
        userMap[u.id] = u.username;
      }
    }
    const posts = [];
    if (data.data) {
      for (const tweet of data.data) {
        posts.push({
          username: userMap[tweet.author_id] || 'unknown',
          text: tweet.text,
          created_at: tweet.created_at,
          tweet_id: tweet.id,
          metrics: tweet.public_metrics || null,
        });
      }
    }
    return posts;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}
async function fetchXIntelligence(fallback) {
  const bearerToken = process.env.X_BEARER_TOKEN;
  if (!bearerToken) {
    warn('X-API', 'X_BEARER_TOKEN not set - skipping X intelligence feed');
    return fallback || { tier1_posts: [], tier2_posts: [], fetched_at: null, post_count: 0, errors: ['X_BEARER_TOKEN not configured'] };
  }
  const fetchedAt = new Date().toISOString();
  const result = { tier1_posts: [], tier2_posts: [], fetched_at: fetchedAt, post_count: 0, errors: [] };
  try {
    const queries = buildSearchQueries(X_MONITOR_ACCOUNTS.tier1.accounts);
    log('X-API', 'Tier 1: ' + queries.length + ' query(s) for ' + X_MONITOR_ACCOUNTS.tier1.accounts.length + ' accounts');
    for (const q of queries) {
      const posts = await searchRecentPosts(q, bearerToken, 20, null);
      for (const p of posts) { p.tier = 1; p.weight = X_MONITOR_ACCOUNTS.tier1.weight; }
      result.tier1_posts = result.tier1_posts.concat(posts);
    }
    log('X-API', 'Tier 1: ' + result.tier1_posts.length + ' posts found');
  } catch (e) {
    err('X-API', 'Tier 1 fetch failed: ' + e.message);
    result.errors.push('Tier 1: ' + e.message);
  }
  try {
    const queries = buildSearchQueries(X_MONITOR_ACCOUNTS.tier2.accounts);
    log('X-API', 'Tier 2: ' + queries.length + ' query(s) for ' + X_MONITOR_ACCOUNTS.tier2.accounts.length + ' accounts');
    for (const q of queries) {
      const posts = await searchRecentPosts(q, bearerToken, 20, null);
      for (const p of posts) { p.tier = 2; p.weight = X_MONITOR_ACCOUNTS.tier2.weight; }
      result.tier2_posts = result.tier2_posts.concat(posts);
    }
    log('X-API', 'Tier 2: ' + result.tier2_posts.length + ' posts found');
  } catch (e) {
    err('X-API', 'Tier 2 fetch failed: ' + e.message);
    result.errors.push('Tier 2: ' + e.message);
  }
  result.post_count = result.tier1_posts.length + result.tier2_posts.length;
  log('X-API', 'Total: ' + result.post_count + ' posts from X intelligence feed');
  return result;
}
module.exports = { fetchXIntelligence, X_MONITOR_ACCOUNTS };
