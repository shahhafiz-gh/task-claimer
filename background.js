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

importScripts(
  'assets/firebase/firebase-app-compat.js',
  'assets/firebase/firebase-auth-compat.js',
  'assets/firebase/firebase-firestore-compat.js'
);

const firebaseConfig = {
  apiKey: "AIzaSyD6XJ6g8M5X-aczWcBPxx9aO2-itF6VYss",
  authDomain: "rip-et.firebaseapp.com",
  projectId: "rip-et",
  storageBucket: "rip-et.firebasestorage.app",
  messagingSenderId: "1040676980791",
  appId: "1:1040676980791:web:809adb603cd254c72b97b2",
  measurementId: "G-R07N9N74QB"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();


const DEFAULT_STATE = {
  enabled: false,
  totalClaimed: 0,
  totalFailedClaims: 0,
  lastTaskClaimed: null,
  lastCaptchaSolved: null,
  lastClaimTimestamp: 0,
  lastSkippedSubreddit: null,
  lastStage: null,
  lastStageTimestamp: 0,
  // Firebase State
  isAuthenticated: false,
  userEmail: null,
  tasksRemaining: 0,
  userStatus: 'pending',
  // Configurable selectors
  claimSelector: '',
  captchaSelector: '',
  captchaInputSelector: '',
  submitSelector: '',
  // UI settings
  soundEnabled: true,
  safeModeEnabled: false,
  // BotBouncer settings
  botBouncerCheckEnabled: true,
  // BB check settings — optimized for speed
  bbCheckTimeoutMs: 3000,          // max wait before abort (3s — fast)
  bbTimeoutAction: 'abort',        // STRICT: always abort on timeout
  bbCacheDurationMs: 30 * 60 * 1000,  // 30 minutes
  maxParallelChecks: 2,
  showBBLogs: true,
  botBouncerCacheTtlMs: 30 * 60 * 1000,
  botBouncerTimeoutMs: 3000,
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

function broadcastState(updated) {
  // Send to popup and other extension pages
  try {
    chrome.runtime.sendMessage({
      type: 'STATE_UPDATED',
      payload: updated,
    }, () => {
      // Catch and ignore lastError
      const _ = chrome.runtime.lastError;
    });
  } catch (e) {}

  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      try {
        chrome.tabs.sendMessage(tab.id, {
          type: 'STATE_UPDATED',
          payload: updated,
        }, () => {
          const _ = chrome.runtime.lastError;
        });
      } catch (e) {}
    }
  });
}

// ─── Firebase Auth & Firestore Sync ──────────────────────────────
auth.onAuthStateChanged((user) => {
  if (user) {
    chrome.storage.local.get('state', ({ state }) => {
      const updated = { ...state, isAuthenticated: true, userEmail: user.email };
      chrome.storage.local.set({ state: updated }, () => broadcastState(updated));
    });

    // Listen to user document in Firestore
    db.collection('users').doc(user.uid).onSnapshot((doc) => {
      if (doc.exists) {
        const data = doc.data();
        chrome.storage.local.get('state', ({ state }) => {
          const updated = { 
            ...state, 
            tasksRemaining: data.tasksRemaining || 0,
            userStatus: data.status || 'pending'
          };
          chrome.storage.local.set({ state: updated }, () => broadcastState(updated));
        });
      } else {
        // Create document if doesn't exist
        db.collection('users').doc(user.uid).set({
          email: user.email,
          tasksRemaining: 0,
          status: 'pending',
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      }
    });
  } else {
    chrome.storage.local.get('state', ({ state }) => {
      const updated = { ...state, isAuthenticated: false, userEmail: null, tasksRemaining: 0, userStatus: 'pending' };
      chrome.storage.local.set({ state: updated }, () => broadcastState(updated));
    });
  }
});

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

    // ── Only cache successful API responses ──
    // If Reddit is down or returns an error, we still fail-safe and block the
    // current task, but we DO NOT cache the error. This way, if the error clears
    // up later, we will try the API again.
    if (!result.error) {
      writeCacheEntry(key, result.safe);
    }

    // Resolve all waiting callbacks
    const callbacks = pendingChecks.get(key) || [];
    for (const cb of callbacks) cb(result);
    pendingChecks.delete(key);
  } catch (err) {
    // ── DO NOT cache on error ──
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
      credentials: 'include'
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errMsg = `HTTP ${response.status} for r/${subreddit} on JSON API`;
      console.warn(`[BotBouncer] ${errMsg} — attempting HTML fallback...`);
      
      try {
        // ── HTML Fallback ──
        // Reddit's .json API is heavily rate-limited, but their HTML pages are less strict.
        const htmlUrl = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/about/moderators/`;
        const htmlRes = await fetch(htmlUrl, { signal: controller.signal, credentials: 'include' });
        
        if (htmlRes.ok) {
          const html = await htmlRes.text();
          const hasBB = html.toLowerCase().includes('botbouncer') || html.toLowerCase().includes('bot-bouncer');
          const safe = !hasBB;
          const resultMsg = `r/${subreddit}: ${safe ? 'SAFE ✓' : 'UNSAFE ✗'} (HTML fallback)`;
          console.log(`[BotBouncer] ${resultMsg}`);
          addLog(safe ? 'success' : 'warn', `🛡️ ${resultMsg}`);
          return { safe: safe, cached: false };
        }
      } catch (fallbackErr) {
        console.warn(`[BotBouncer] HTML fallback failed: ${fallbackErr.message}`);
      }

      // ── Fail Open Strategy ──
      // If Reddit completely blocks us, we assume it's SAFE so the user doesn't miss tasks.
      const failOpenMsg = `r/${subreddit} — Reddit API blocked us. FAILING OPEN (Safe)`;
      console.warn(`[BotBouncer] ⚠️ ${failOpenMsg}`);
      addLog('warn', `⚠️ ${failOpenMsg}`);
      return { safe: true, cached: false, error: `HTTP ${response.status} - failed open` };
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

// ═══════════════════════════════════════════════════════════
// CAPSOLVER INTEGRATION (WITH DEBUG LOGS)
// ═══════════════════════════════════════════════════════════
const CAPSOLVER_API_KEY = "CAP-EA13F2A9B1DD997C77026ACC40C3FBFE48FDE78E6569D7EC9D9C1B6868D63754"; 

async function solveTurnstileCapsolver(websiteURL, websiteKey) {
  console.log(`[Capsolver BG] 🧠 Step 1: Requesting token for ${websiteURL}`);
  addLog('info', `🧠 Sending Turnstile to Capsolver...`);

  try {
    // 1. Create Task (Using the exact API docs you provided)
    console.log("[Capsolver BG] Sending createTask...");
    const createRes = await fetch("https://api.capsolver.com/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: CAPSOLVER_API_KEY,
        task: {
          type: "AntiTurnstileTaskProxyLess",
          websiteURL: websiteURL,
          websiteKey: websiteKey
        }
      })
    });
    const createData = await createRes.json();
    console.log("[Capsolver BG] createTask Response:", createData);

    if (createData.errorId !== 0) {
      console.error("[Capsolver BG] Create Task Error:", createData.errorDescription);
      return { success: false, error: createData.errorDescription };
    }

    const taskId = createData.taskId;
    console.log(`[Capsolver BG] Step 2: Task created! ID: ${taskId}. Polling for result...`);

    // 2. Poll for Result (Using the exact API docs you provided)
    for (let i = 0; i < 15; i++) { 
      await new Promise(r => setTimeout(r, 1000));
      
      const resultRes = await fetch("https://api.capsolver.com/getTaskResult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: CAPSOLVER_API_KEY,
          taskId: taskId
        })
      });
      const resultData = await resultRes.json();
      console.log(`[Capsolver BG] Poll ${i+1} status:`, resultData.status);

      if (resultData.errorId !== 0) {
        console.error("[Capsolver BG] Get Result Error:", resultData.errorDescription);
        return { success: false, error: resultData.errorDescription };
      }

      if (resultData.status === "ready") {
        console.log("[Capsolver BG] ✅ Token is READY!");
        addLog('success', `✅ Capsolver token received!`);
        return { success: true, token: resultData.solution.token };
      }
    }

    return { success: false, error: "Timeout waiting for Capsolver" };

  } catch (err) {
    console.error("[Capsolver BG] Network/Fetch Error:", err);
    return { success: false, error: err.message };
  }
}

// ─── Startup ──────────────────────────────────────────────────────
// No need to pre-load the cache on startup — readCacheEntry() reads
// chrome.storage.local on demand, so a cold SW restart won't cause
// unnecessary API calls.
console.log('[BotBouncer] 🚀 Background service worker started. Cache is read on-demand from storage.');

// Known earntask.io Turnstile sitekey — pre-seeded so the ghost solver
// starts immediately from the first page load on any install/reload.
const KNOWN_SITE_KEY = '0x4AAAAAACxj8_tgxWTBH2nu';

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
  // Pre-seed the known sitekey into wsConfig so sendConfig() always delivers it
  chrome.storage.local.get('wsConfig', ({ wsConfig }) => {
    const cfg = wsConfig || {};
    if (!cfg.siteKey) {
      cfg.siteKey = KNOWN_SITE_KEY;
      chrome.storage.local.set({ wsConfig: cfg }, () => {
        console.log('[BG] 💾 Pre-seeded Turnstile siteKey into storage: ' + KNOWN_SITE_KEY);
      });
    }
  });
});

// Central message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case 'GET_STATE':
      chrome.storage.local.get('state', ({ state }) => {
        state = state || DEFAULT_STATE;
        sendResponse({ state: state || DEFAULT_STATE });
      });
      return true;

    case 'SET_STATE':
      chrome.storage.local.get('state', ({ state }) => {
        state = state || DEFAULT_STATE;
        const updated = { ...state, ...payload };

        // Update maxParallel if changed
        if (updated.maxParallelChecks) {
          maxParallel = updated.maxParallelChecks;
        }

        chrome.storage.local.set({ state: updated }, () => {
          broadcastState(updated);
          sendResponse({ state: updated });
        });
      });
      return true;

    case 'CHECK_BOTBOUNCER': {
      const { subreddit } = payload;
      if (!subreddit) {
        sendResponse({ safe: false, error: 'No subreddit provided' });
        return false;
      }

      // NO logging during hot path — use defaults directly, skip storage read
      const timeoutMs = DEFAULT_STATE.botBouncerTimeoutMs;
      const cacheTtlMs = DEFAULT_STATE.bbCacheDurationMs;

      queueBotBouncerCheck(subreddit, timeoutMs, cacheTtlMs)
        .then((result) => {
          sendResponse(result);
        })
        .catch((err) => {
          sendResponse({ safe: false, error: err.message });
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
        state = state || DEFAULT_STATE;
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
        state = state || DEFAULT_STATE;
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
      
      // Decrement tasksRemaining in Firestore
      const user = auth.currentUser;
      if (user) {
        db.collection('users').doc(user.uid).update({
          tasksRemaining: firebase.firestore.FieldValue.increment(-1)
        }).catch(err => console.error("Error decrementing tasks:", err));
      }

      chrome.storage.local.get('state', ({ state }) => {
        state = state || DEFAULT_STATE;
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
        state = state || DEFAULT_STATE;
        const updated = {
          ...state,
          totalFailedClaims: (state.totalFailedClaims || 0) + 1,
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
        state = state || DEFAULT_STATE;
        const updated = {
          ...state,
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
        state = state || DEFAULT_STATE;
        const updated = { ...state, enabled: !state.enabled };
        addLog('info', updated.enabled ? '▶️ Extension ENABLED' : '⏸️ Extension PAUSED');
        chrome.storage.local.set({ state: updated }, () => {
          broadcastState(updated);
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

    case 'SOLVE_TURNSTILE_CAPSOLVER': {
      console.log("[BG] ✅ Received SOLVE_TURNSTILE_CAPSOLVER message from content script!");
      const { websiteURL, websiteKey } = payload;
      solveTurnstileCapsolver(websiteURL, websiteKey)
        .then(result => {
          console.log("[BG] Sending result back to content script:", result.success);
          sendResponse(result);
        })
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // CRITICAL: Required for async sendResponse
    }

    case 'SAVE_SITEKEY': {
      const { siteKey } = payload;
      chrome.storage.local.get(['state', 'wsConfig'], (data) => {
        const state = data.state || DEFAULT_STATE;
        const cfg = data.wsConfig || {};
        if (cfg.siteKey !== siteKey) {
          cfg.siteKey = siteKey;
          chrome.storage.local.set({ wsConfig: cfg }, () => {
            console.log(`[BG] 💾 Saved Turnstile SiteKey: ${siteKey}`);
            addLog('info', `💾 Auto-captured Turnstile SiteKey: ${siteKey}`);
            // Broadcast state updated to content scripts to launch ghost solver
            broadcastState({ ...state, siteKey: siteKey });
          });
        }
      });
      sendResponse({ ok: true });
      return true;
    }

    // ─── Firebase Auth Commands ─────────────────────────────
    case 'LOGIN':
    case 'SIGNUP': {
      const { email, password } = payload;
      const promise = (request.type === 'SIGNUP')
        ? auth.createUserWithEmailAndPassword(email, password)
        : auth.signInWithEmailAndPassword(email, password);
      
      promise
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'GOOGLE_LOGIN': {
      const clientId = '1040676980791-et2cgll13s07c6ko5t3pr57trfl644bt.apps.googleusercontent.com';
      const redirectUri = chrome.identity.getRedirectURL(); // e.g. https://<extension-id>.chromiumapp.org/
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=id_token&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20email%20profile&nonce=random_nonce_123`;

      chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (responseUrl) => {
        if (chrome.runtime.lastError || !responseUrl) {
          console.error('[OAuth Error]', chrome.runtime.lastError);
          sendResponse({ success: false, error: chrome.runtime.lastError?.message || 'OAuth flow cancelled' });
          return;
        }

        try {
          // Parse id_token from the hash fragment: https://<id>.chromiumapp.org/#id_token=...
          const hashStr = new URL(responseUrl).hash.substring(1);
          const hashParams = new URLSearchParams(hashStr);
          const idToken = hashParams.get('id_token');

          if (!idToken) {
            sendResponse({ success: false, error: 'No id_token received from Google.' });
            return;
          }

          const credential = firebase.auth.GoogleAuthProvider.credential(idToken);
          auth.signInWithCredential(credential)
            .then(() => sendResponse({ success: true }))
            .catch((err) => sendResponse({ success: false, error: err.message }));
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      });
      return true; // Keep message channel open for async response
    }

    case 'REQUEST_PLAN': {
      const user = auth.currentUser;
      if (!user) {
        sendResponse({ success: false, error: 'Not logged in' });
        return false;
      }
      db.collection('users').doc(user.uid).update({
        requestedPlan: payload.plan,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      })
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'LOGOUT': {
      auth.signOut()
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    default:
      sendResponse({ error: 'Unknown message type' });
      return false;
  }
});
