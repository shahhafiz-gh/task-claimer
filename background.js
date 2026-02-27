/**
 * Background Service Worker
 * Handles state persistence, message routing, BotBouncer cache, and extension lifecycle.
 */

const DEFAULT_STATE = {
  enabled: false,
  totalClaimed: 0,
  totalSkippedBotBouncer: 0,
  lastTaskClaimed: null,
  lastCaptchaSolved: null,
  lastClaimTimestamp: 0,
  lastSkippedSubreddit: null,
  // Stage tracking
  lastStage: null,       // 'accept' | 'confirm' | 'captcha' | null
  lastStageTimestamp: 0,
  // Configurable settings
  claimSelector: '',
  captchaSelector: '',
  captchaInputSelector: '',
  submitSelector: '',
  soundEnabled: true,
  delayMs: 0,
  safeModeEnabled: false,
  botBouncerCheckEnabled: true,       // BotBouncer protection on by default
  botBouncerCacheTtlMs: 5 * 60 * 1000,  // 5 minutes (reduced for fresher data)
  botBouncerTimeoutMs: 2000,           // 2 second API timeout (speed!)
};

// ─── Activity Log System ──────────────────────────────────────────
const MAX_LOG_ENTRIES = 100;

/**
 * Adds a log entry to persistent storage.
 * Each entry: { level, message, timestamp }
 * level: 'info' | 'warn' | 'error' | 'success'
 */
function addLog(level, message) {
  const entry = {
    level,
    message,
    timestamp: Date.now(),
  };

  chrome.storage.local.get('logs', ({ logs }) => {
    const arr = Array.isArray(logs) ? logs : [];
    arr.push(entry);
    // Keep only the last MAX_LOG_ENTRIES
    while (arr.length > MAX_LOG_ENTRIES) arr.shift();
    chrome.storage.local.set({ logs: arr });
  });
}

// ─── BotBouncer In-Memory Cache ───────────────────────────────────
// Map<subreddit_lowercase, { safe: boolean, timestamp: number }>
const botBouncerCache = new Map();

/**
 * Checks if a subreddit uses BotBouncer by fetching its moderator list.
 * Returns { safe: boolean }
 *
 * Safe = BotBouncer NOT found among moderators.
 * Unsafe = BotBouncer IS a moderator, or any error occurred (fail-safe).
 */
async function checkBotBouncer(subreddit, timeoutMs = 5000, cacheTtlMs = 600000) {
  const key = subreddit.toLowerCase();

  // ── Check cache first ──
  const cached = botBouncerCache.get(key);
  if (cached && (Date.now() - cached.timestamp) < cacheTtlMs) {
    const msg = `Cache hit for r/${subreddit}: ${cached.safe ? 'SAFE ✓' : 'UNSAFE ✗'}`;
    console.log(`[BotBouncer] ${msg}`);
    addLog('info', `🔄 ${msg}`);
    return { safe: cached.safe, cached: true };
  }

  // ── Fetch moderator list from Reddit ──
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
      // 403 = private/quarantined, 404 = nonexistent — treat as unsafe
      const errMsg = `HTTP ${response.status} for r/${subreddit} — treating as UNSAFE`;
      console.warn(`[BotBouncer] ${errMsg}`);
      addLog('error', `🚫 ${errMsg}`);
      const result = { safe: false, cached: false, error: `HTTP ${response.status}` };
      botBouncerCache.set(key, { safe: false, timestamp: Date.now() });
      return result;
    }

    const data = await response.json();
    const moderators = data?.data?.children || [];

    // Scan for any moderator whose name contains "bot-bouncer" (case-insensitive)
    const hasBotBouncer = moderators.some((mod) => {
      const name = (mod.name || mod.author || '').toLowerCase();
      return name.includes('bot-bouncer') || name.includes('botbouncer');
    });

    const safe = !hasBotBouncer;
    const resultMsg = `r/${subreddit}: ${safe ? 'SAFE ✓' : 'UNSAFE ✗ (BotBouncer found)'}`;
    console.log(`[BotBouncer] ${resultMsg}`);
    addLog(safe ? 'success' : 'warn', `🛡️ ${resultMsg}`);

    // Cache the result
    botBouncerCache.set(key, { safe, timestamp: Date.now() });

    return { safe, cached: false };
  } catch (err) {
    // Network error, timeout, aborted — treat as unsafe (better safe than sorry)
    const netErr = `Error checking r/${subreddit}: ${err.message} — treating as UNSAFE`;
    console.warn(`[BotBouncer] ${netErr}`);
    addLog('error', `⚠️ ${netErr}`);
    botBouncerCache.set(key, { safe: false, timestamp: Date.now() });
    return { safe: false, cached: false, error: err.message };
  }
}

// Initialize state on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('state', ({ state }) => {
    if (!state) {
      chrome.storage.local.set({ state: DEFAULT_STATE });
    } else {
      // Merge new defaults with existing state (preserves user data across updates)
      chrome.storage.local.set({ state: { ...DEFAULT_STATE, ...state } });
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
      return true; // async response

    case 'SET_STATE':
      chrome.storage.local.get('state', ({ state }) => {
        const updated = { ...state, ...payload };
        chrome.storage.local.set({ state: updated }, () => {
          // Broadcast state change to all content scripts
          chrome.tabs.query({}, (tabs) => {
            for (const tab of tabs) {
              chrome.tabs.sendMessage(tab.id, {
                type: 'STATE_UPDATED',
                payload: updated,
              }).catch(() => { /* tab may not have content script */ });
            }
          });
          sendResponse({ state: updated });
        });
      });
      return true;

    case 'CHECK_BOTBOUNCER': {
      // Async BotBouncer check — content script sends subreddit, we respond safe/unsafe
      const { subreddit } = payload;
      if (!subreddit) {
        addLog('error', '🚫 BotBouncer check called with no subreddit');
        sendResponse({ safe: false, error: 'No subreddit provided' });
        return false;
      }

      addLog('info', `🔍 Checking r/${subreddit} for BotBouncer...`);

      // Get current settings for timeout/ttl
      chrome.storage.local.get('state', ({ state }) => {
        const s = state || DEFAULT_STATE;
        const timeoutMs = s.botBouncerTimeoutMs || 5000;
        const cacheTtlMs = s.botBouncerCacheTtlMs || 600000;

        checkBotBouncer(subreddit, timeoutMs, cacheTtlMs)
          .then((result) => {
            sendResponse(result);
          })
          .catch((err) => {
            addLog('error', `💥 BotBouncer check crashed: ${err.message}`);
            sendResponse({ safe: false, error: err.message });
          });
      });
      return true; // async response
    }

    case 'STAGE_ACCEPT':
      addLog('success', `✅ Accepted task${payload?.subreddit ? ` from r/${payload.subreddit}` : ''}`);
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
      addLog('success', `🎉 Task claimed! Captcha: ${payload.captchaExpression || 'N/A'} = ${payload.captchaAnswer || '?'}`);
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
          // Broadcast to all tabs
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
      // Content script can push logs directly
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
