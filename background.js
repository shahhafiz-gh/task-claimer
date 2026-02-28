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
  // Configurable settings
  claimSelector: '',
  captchaSelector: '',
  captchaInputSelector: '',
  submitSelector: '',
  soundEnabled: true,
  delayMs: 0,
  safeModeEnabled: false,
  botBouncerCheckEnabled: true,
  // NEW: Parallel flow settings
  bbCheckTimeoutMs: 10000,         // max wait before fallback (10s — strict)
  bbTimeoutAction: 'abort',        // STRICT: always abort on timeout
  bbCacheDurationMs: 30 * 60 * 1000,  // 30 minutes
  maxParallelChecks: 2,
  showBBLogs: true,
  botBouncerCacheTtlMs: 30 * 60 * 1000,
  botBouncerTimeoutMs: 2000,
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

// ─── BotBouncer In-Memory Cache ───────────────────────────────────
const botBouncerCache = new Map();

// ─── Request Queue System ─────────────────────────────────────────
const pendingChecks = new Map();  // subreddit -> [resolve callbacks]
let activeChecks = 0;
let maxParallel = 2;

/**
 * Queue a BotBouncer check. Deduplicates requests for the same subreddit.
 */
function queueBotBouncerCheck(subreddit, timeoutMs, cacheTtlMs) {
  const key = subreddit.toLowerCase();

  // Check cache first
  const cached = botBouncerCache.get(key);
  if (cached && (Date.now() - cached.timestamp) < cacheTtlMs) {
    const msg = `Cache hit for r/${subreddit}: ${cached.safe ? 'SAFE ✓' : 'UNSAFE ✗'}`;
    console.log(`[BotBouncer] ${msg}`);
    addLog('info', `🔄 ${msg}`);
    return Promise.resolve({ safe: cached.safe, cached: true });
  }

  // Deduplicate: if already checking this subreddit, piggyback
  if (pendingChecks.has(key)) {
    return new Promise((resolve) => {
      pendingChecks.get(key).push(resolve);
    });
  }

  return new Promise((resolve) => {
    pendingChecks.set(key, [resolve]);
    processQueue(key, subreddit, timeoutMs, cacheTtlMs);
  });
}

async function processQueue(key, subreddit, timeoutMs, cacheTtlMs) {
  // Wait if at max capacity
  while (activeChecks >= maxParallel) {
    await new Promise(r => setTimeout(r, 50));
  }

  activeChecks++;

  try {
    const result = await fetchBotBouncerCheck(subreddit, timeoutMs);

    // Cache the result
    botBouncerCache.set(key, { safe: result.safe, timestamp: Date.now() });

    // Also persist to chrome.storage for cross-session persistence
    persistCacheEntry(key, result.safe);

    // Resolve all waiting callbacks
    const callbacks = pendingChecks.get(key) || [];
    for (const cb of callbacks) {
      cb(result);
    }
    pendingChecks.delete(key);
  } catch (err) {
    const result = { safe: false, cached: false, error: err.message };
    botBouncerCache.set(key, { safe: false, timestamp: Date.now() });
    persistCacheEntry(key, false);

    const callbacks = pendingChecks.get(key) || [];
    for (const cb of callbacks) {
      cb(result);
    }
    pendingChecks.delete(key);
  } finally {
    activeChecks--;
  }
}

/**
 * Persist a cache entry to chrome.storage.local for cross-session persistence.
 */
function persistCacheEntry(key, safe) {
  chrome.storage.local.get('bbCache', ({ bbCache }) => {
    const cache = bbCache || {};
    cache[key] = { safe, timestamp: Date.now() };
    // Prune old entries (keep last 500)
    const entries = Object.entries(cache);
    if (entries.length > 500) {
      entries.sort((a, b) => b[1].timestamp - a[1].timestamp);
      const pruned = Object.fromEntries(entries.slice(0, 500));
      chrome.storage.local.set({ bbCache: pruned });
    } else {
      chrome.storage.local.set({ bbCache: cache });
    }
  });
}

/**
 * Load persistent cache into memory on startup.
 */
function loadPersistentCache(cacheTtlMs) {
  chrome.storage.local.get('bbCache', ({ bbCache }) => {
    if (!bbCache) return;
    const now = Date.now();
    for (const [key, val] of Object.entries(bbCache)) {
      if ((now - val.timestamp) < cacheTtlMs) {
        botBouncerCache.set(key, val);
      }
    }
    console.log(`[BotBouncer] Loaded ${botBouncerCache.size} cached entries from storage`);
  });
}

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

// ─── Load persistent cache on startup ─────────────────────────────
loadPersistentCache(DEFAULT_STATE.bbCacheDurationMs);

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
        const timeoutMs = s.botBouncerTimeoutMs || 5000;
        const cacheTtlMs = s.bbCacheDurationMs || s.botBouncerCacheTtlMs || 1800000;

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
      const stats = {
        entries: botBouncerCache.size,
        safeCount: 0,
        unsafeCount: 0,
      };
      for (const [, val] of botBouncerCache) {
        if (val.safe) stats.safeCount++;
        else stats.unsafeCount++;
      }
      sendResponse({ stats });
      return false;
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
