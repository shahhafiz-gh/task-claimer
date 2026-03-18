/**
 * Background Service Worker — v5 "Accept First, Verify Later"
 *
 * Handles:
 *   - State persistence & broadcasting
 *   - BotBouncer API checking with queue system
 *   - In-memory + persistent cache
 *   - BB logs for popup panel
 *   - Activity log system
 */

const DEFAULT_STATE = {
  enabled: false,
  totalClaimed: 0,
  totalSkippedBotBouncer: 0,
  lastTaskClaimed: null,
  lastCaptchaSolved: null,
  lastClaimTimestamp: 0,
  lastSkippedSubreddit: null,
  lastStage: null,
  lastStageTimestamp: 0,
  // Configurable selectors
  claimSelector: '',
  captchaSelector: '',
  captchaInputSelector: '',
  submitSelector: '',
  // UI settings
  soundEnabled: true,
  delayMs: 0,
  safeModeEnabled: false,
  // BotBouncer settings
  botBouncerCheckEnabled: true,
  bbCheckTimeoutMs: 10000,
  bbTimeoutAction: 'abort',
  bbCacheDurationMs: 30 * 60 * 1000,
  maxParallelChecks: 2,
};

// ─── Activity Log System ──────────────────────────────────────────
const MAX_LOG_ENTRIES = 100;

function addLog(level, message) {
  const entry = {
    level,
    message,
    timestamp: Date.now(),
  };

  chrome.storage.local.get('logs', ({ logs }) => {
    const arr = Array.isArray(logs) ? logs : [];
    arr.push(entry);
    while (arr.length > MAX_LOG_ENTRIES) arr.shift();
    chrome.storage.local.set({ logs: arr });
  });
}

// ─── BB Logs System (separate from activity logs) ──────────────────
const MAX_BB_LOG_ENTRIES = 200;

function addBBLog(entry) {
  chrome.storage.local.get('bbLogs', ({ bbLogs }) => {
    const arr = Array.isArray(bbLogs) ? bbLogs : [];
    arr.push({
      ...entry,
      timestamp: Date.now(),
    });
    while (arr.length > MAX_BB_LOG_ENTRIES) arr.shift();
    chrome.storage.local.set({ bbLogs: arr });
  });
}

// ─── BotBouncer In-Memory Cache (hot-path within a SW session) ────
// This is a fast short-circuit. Chrome can kill and restart the service
// worker at any time, so we ALWAYS back reads up with chrome.storage.local.
const botBouncerCache = new Map();

// ─── Request Deduplication Queue ──────────────────────────────────
// Prevents firing duplicate API calls for the same subreddit at the same time.
const pendingChecks = new Map();  // subreddit -> [resolve callbacks]
let activeChecks = 0;
let maxParallel = 2;

/**
 * Read a subreddit's cached result.
 * Checks in-memory first (fast), then chrome.storage.local (persistent).
 * Returns { safe, timestamp } if a valid (non-expired) entry exists, or null.
 */
function readCacheEntry(key, cacheTtlMs) {
  return new Promise((resolve) => {
    // 1. Hot-path: in-memory map (within the same SW session)
    const mem = botBouncerCache.get(key);
    if (mem && (Date.now() - mem.timestamp) < cacheTtlMs) {
      resolve(mem);
      return;
    }

    // 2. Cold-path: chrome.storage.local (survives SW restart)
    chrome.storage.local.get('bbCache', ({ bbCache }) => {
      const disk = (bbCache || {})[key];
      if (disk && (Date.now() - disk.timestamp) < cacheTtlMs) {
        // Warm the in-memory cache while we're at it
        botBouncerCache.set(key, disk);
        resolve(disk);
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Persist a cache entry to BOTH in-memory and chrome.storage.local.
 * Called for every completed check, whether safe or unsafe.
 */
function writeCacheEntry(key, safe) {
  const entry = { safe, timestamp: Date.now() };

  // In-memory hot cache
  botBouncerCache.set(key, entry);

  // Persistent storage
  chrome.storage.local.get('bbCache', ({ bbCache }) => {
    const cache = bbCache || {};
    cache[key] = entry;

    // Prune to most-recent 500 entries to avoid bloat
    const entries = Object.entries(cache);
    if (entries.length > 500) {
      entries.sort((a, b) => b[1].timestamp - a[1].timestamp);
      chrome.storage.local.set({ bbCache: Object.fromEntries(entries.slice(0, 500)) });
    } else {
      chrome.storage.local.set({ bbCache: cache });
    }
  });
}

/**
 * Queue a BotBouncer check.
 * - Checks persistent cache first (no API call if already known).
 * - Deduplicates concurrent requests for the same subreddit.
 * - Caches ALL results (safe AND unsafe) so future tasks skip the API call.
 */
async function queueBotBouncerCheck(subreddit, timeoutMs, cacheTtlMs) {
  const key = subreddit.toLowerCase();

  // ── 1. Cache check (memory + storage) ─────────────────────
  const cached = await readCacheEntry(key, cacheTtlMs);
  if (cached) {
    const label = cached.safe ? 'SAFE ✓' : 'UNSAFE ✗';
    const msg = `Cache hit for r/${subreddit}: ${label} (no API call needed)`;
    console.log(`[BotBouncer] 📂 ${msg}`);
    addLog('info', `📂 ${msg}`);
    return { safe: cached.safe, cached: true };
  }

  // ── 2. Deduplication: if already in-flight, wait for it ───
  if (pendingChecks.has(key)) {
    console.log(`[BotBouncer] ⏳ Piggybacking on in-flight check for r/${subreddit}`);
    return new Promise((resolve) => {
      pendingChecks.get(key).push(resolve);
    });
  }

  // ── 3. New live API check ──────────────────────────────────
  return new Promise((resolve) => {
    pendingChecks.set(key, [resolve]);
    processCheck(key, subreddit, timeoutMs, cacheTtlMs);
  });
}

/**
 * Execute the live API check (respects the maxParallel concurrency limit).
 */
async function processCheck(key, subreddit, timeoutMs, cacheTtlMs) {
  // Wait if at max concurrency
  while (activeChecks >= maxParallel) {
    await new Promise(r => setTimeout(r, 50));
  }

  activeChecks++;

  try {
    const result = await fetchBotBouncerCheck(subreddit, timeoutMs);

    // ── Always cache the result — safe OR unsafe ──
    writeCacheEntry(key, result.safe);

    // Resolve all waiting callbacks
    const callbacks = pendingChecks.get(key) || [];
    for (const cb of callbacks) cb(result);
    pendingChecks.delete(key);
  } catch (err) {
    // On hard error, cache as unsafe so we don't hammer the API
    writeCacheEntry(key, false);

    const result = { safe: false, cached: false, error: err.message };
    const callbacks = pendingChecks.get(key) || [];
    for (const cb of callbacks) cb(result);
    pendingChecks.delete(key);
  } finally {
    activeChecks--;
  }
}

/**
 * REMOVED: loadPersistentCache() — no longer needed.
 * Cache is now read on-demand from chrome.storage.local per check,
 * so service-worker restarts never cause spurious API calls.
 */

/**
 * Actual fetch to Reddit API.
 */
async function fetchBotBouncerCheck(subreddit, timeoutMs = 5000) {
  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/about/moderators.json`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TaskAutoClaimerExtension/1.0)',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errMsg = `HTTP ${response.status} for r/${subreddit} — treating as UNSAFE`;
      console.warn(`[BotBouncer] ${errMsg}`);
      addLog('error', `🚫 ${errMsg}`);
      return { safe: false, cached: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    const moderators = data?.data?.children || [];

    const hasBotBouncer = moderators.some((mod) => {
      const name = (mod.name || mod.author || '').toLowerCase();
      return name.includes('bot-bouncer') || name.includes('botbouncer');
    });

    const safe = !hasBotBouncer;
    const resultMsg = `r/${subreddit}: ${safe ? 'SAFE ✓' : 'UNSAFE ✗ (BotBouncer found)'}`;
    console.log(`[BotBouncer] ${resultMsg}`);
    addLog(safe ? 'success' : 'warn', `🛡️ ${resultMsg}`);

    return { safe, cached: false };
  } catch (err) {
    const netErr = `Error checking r/${subreddit}: ${err.message} — treating as UNSAFE`;
    console.warn(`[BotBouncer] ${netErr}`);
    addLog('error', `⚠️ ${netErr}`);
    return { safe: false, cached: false, error: err.message };
  }
}

// ─── Startup ──────────────────────────────────────────────────────
// No need to pre-load the cache on startup — readCacheEntry() reads
// chrome.storage.local on demand, so a cold SW restart won't cause
// unnecessary API calls.
console.log('[BotBouncer] 🚀 Background service worker started. Cache is read on-demand from storage.');

// Initialize state on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('state', ({ state }) => {
    if (!state) {
      chrome.storage.local.set({ state: DEFAULT_STATE });
    } else {
      chrome.storage.local.set({ state: { ...DEFAULT_STATE, ...state } });
    }
  });
  // Initialize empty BB logs if not present
  chrome.storage.local.get('bbLogs', ({ bbLogs }) => {
    if (!bbLogs) {
      chrome.storage.local.set({ bbLogs: [] });
    }
  });
});

// Central message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case 'GET_STATE':
      chrome.storage.local.get('state', ({ state }) => {
        sendResponse({ state: state || DEFAULT_STATE });
      });
      return true;

    case 'SET_STATE':
      chrome.storage.local.get('state', ({ state }) => {
        const updated = { ...state, ...payload };

        // Update maxParallel if changed
        if (updated.maxParallelChecks) {
          maxParallel = updated.maxParallelChecks;
        }

        chrome.storage.local.set({ state: updated }, () => {
          chrome.tabs.query({}, (tabs) => {
            for (const tab of tabs) {
              chrome.tabs.sendMessage(tab.id, {
                type: 'STATE_UPDATED',
                payload: updated,
              }).catch(() => { });
            }
          });
          sendResponse({ state: updated });
        });
      });
      return true;

    case 'CHECK_BOTBOUNCER': {
      const { subreddit } = payload;
      if (!subreddit) {
        addLog('error', '🚫 BotBouncer check called with no subreddit');
        sendResponse({ safe: false, error: 'No subreddit provided' });
        return false;
      }

      addLog('info', `🔍 Checking r/${subreddit} for BotBouncer...`);

      chrome.storage.local.get('state', ({ state }) => {
        const s = state || DEFAULT_STATE;
        const timeoutMs = s.bbCheckTimeoutMs || 5000;
        const cacheTtlMs = s.bbCacheDurationMs || 1800000;

        queueBotBouncerCheck(subreddit, timeoutMs, cacheTtlMs)
          .then((result) => {
            sendResponse(result);
          })
          .catch((err) => {
            addLog('error', `💥 BotBouncer check crashed: ${err.message}`);
            sendResponse({ safe: false, error: err.message });
          });
      });
      return true;
    }

    case 'BB_LOG_ENTRY': {
      // Log a BB check result from content script
      addBBLog({
        subreddit: payload.subreddit || 'unknown',
        status: payload.status || 'unknown',  // 'safe', 'unsafe', 'pending', 'timeout'
        action: payload.action || 'unknown',   // 'claimed', 'skipped', 'checking', etc.
      });
      sendResponse({ ok: true });
      return false;
    }

    case 'GET_BB_LOGS':
      chrome.storage.local.get('bbLogs', ({ bbLogs }) => {
        sendResponse({ bbLogs: Array.isArray(bbLogs) ? bbLogs : [] });
      });
      return true;

    case 'CLEAR_BB_LOGS':
      chrome.storage.local.set({ bbLogs: [] }, () => {
        sendResponse({ ok: true });
      });
      return true;

    case 'CLEAR_BB_CACHE':
      botBouncerCache.clear();
      chrome.storage.local.set({ bbCache: {} }, () => {
        addLog('info', '🗑️ BotBouncer cache cleared');
        sendResponse({ ok: true });
      });
      return true;

    case 'GET_BB_CACHE_STATS': {
      // Count entries from persistent storage for accurate stats
      chrome.storage.local.get('bbCache', ({ bbCache }) => {
        const cache = bbCache || {};
        const now = Date.now();
        const cacheTtlMs = DEFAULT_STATE.bbCacheDurationMs;
        let safe = 0, unsafe = 0, expired = 0;
        for (const val of Object.values(cache)) {
          if ((now - val.timestamp) >= cacheTtlMs) { expired++; continue; }
          if (val.safe) safe++; else unsafe++;
        }
        sendResponse({
          stats: {
            entries: safe + unsafe,
            safeCount: safe,
            unsafeCount: unsafe,
            expiredCount: expired,
            totalStored: Object.keys(cache).length,
          },
        });
      });
      return true;
    }

    case 'STAGE_ACCEPT':
      addLog('success', `⚡ Accepted task${payload?.subreddit ? ` from r/${payload.subreddit}` : ''} (instant)`);
      chrome.storage.local.get('state', ({ state }) => {
        const updated = {
          ...state,
          lastStage: 'accept',
          lastStageTimestamp: Date.now(),
        };
        chrome.storage.local.set({ state: updated }, () => {
          sendResponse({ state: updated });
        });
      });
      return true;

    case 'STAGE_CONFIRM':
      addLog('info', '🔘 Clicked confirmation button');
      chrome.storage.local.get('state', ({ state }) => {
        const updated = {
          ...state,
          lastStage: 'confirm',
          lastStageTimestamp: Date.now(),
        };
        chrome.storage.local.set({ state: updated }, () => {
          sendResponse({ state: updated });
        });
      });
      return true;

    case 'TASK_CLAIMED':
      addLog('success', `🎉 Task claimed! Captcha: ${payload.captchaExpression || 'N/A'} = ${payload.captchaAnswer || '?'}${payload.subreddit ? ` | r/${payload.subreddit}` : ''}`);
      chrome.storage.local.get('state', ({ state }) => {
        const updated = {
          ...state,
          totalClaimed: (state.totalClaimed || 0) + 1,
          lastTaskClaimed: 'Task Claimed',
          lastCaptchaSolved: payload.captchaExpression || null,
          lastClaimTimestamp: Date.now(),
          lastStage: 'captcha',
          lastStageTimestamp: Date.now(),
        };
        chrome.storage.local.set({ state: updated }, () => {
          sendResponse({ state: updated });
        });
      });
      return true;

    case 'TASK_CLAIM_FAILED':
      addLog('error', `❌ Claim FAILED${payload?.subreddit ? ` for r/${payload.subreddit}` : ''} — ${payload?.reason || 'unknown error'}`);
      chrome.storage.local.get('state', ({ state }) => {
        const updated = {
          ...state,
          lastStage: 'claim_failed',
          lastStageTimestamp: Date.now(),
        };
        chrome.storage.local.set({ state: updated }, () => {
          sendResponse({ state: updated });
        });
      });
      return true;

    case 'TASK_SKIPPED_BOTBOUNCER':
      addLog('warn', `⛔ Skipped task from r/${payload.subreddit || 'unknown'} — BotBouncer detected`);
      chrome.storage.local.get('state', ({ state }) => {
        const updated = {
          ...state,
          totalSkippedBotBouncer: (state.totalSkippedBotBouncer || 0) + 1,
          lastSkippedSubreddit: payload.subreddit || null,
          lastStage: 'skipped_botbouncer',
          lastStageTimestamp: Date.now(),
        };
        chrome.storage.local.set({ state: updated }, () => {
          sendResponse({ state: updated });
        });
      });
      return true;

    case 'TOGGLE_ENABLED':
      chrome.storage.local.get('state', ({ state }) => {
        const updated = { ...state, enabled: !state.enabled };
        addLog('info', updated.enabled ? '▶️ Extension ENABLED' : '⏸️ Extension PAUSED');
        chrome.storage.local.set({ state: updated }, () => {
          chrome.tabs.query({}, (tabs) => {
            for (const tab of tabs) {
              chrome.tabs.sendMessage(tab.id, {
                type: 'STATE_UPDATED',
                payload: updated,
              }).catch(() => { });
            }
          });
          sendResponse({ state: updated });
        });
      });
      return true;

    case 'PUSH_LOG':
      if (payload?.level && payload?.message) {
        addLog(payload.level, payload.message);
      }
      sendResponse({ ok: true });
      return false;

    case 'GET_LOGS':
      chrome.storage.local.get('logs', ({ logs }) => {
        sendResponse({ logs: Array.isArray(logs) ? logs : [] });
      });
      return true;

    case 'CLEAR_LOGS':
      chrome.storage.local.set({ logs: [] }, () => {
        sendResponse({ ok: true });
      });
      return true;

    default:
      sendResponse({ error: 'Unknown message type' });
      return false;
  }
});
