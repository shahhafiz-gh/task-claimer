/**
 * Task Auto Claimer — WebSocket Interceptor (MAIN World)
 * ============================================================
 * Runs in MAIN world at document_start to monkey-patch WebSocket
 * BEFORE the page creates its Convex connection.
 *
 * Since MAIN world cannot access chrome.* APIs, this script
 * communicates with the ISOLATED world bridge via window.postMessage.
 *
 * Architecture:
 *   MAIN world (this file) ←→ postMessage ←→ ISOLATED world (bridge.js) ←→ chrome.runtime
 */
'use strict';

(function () {
  // ─── Hardcoded fallback siteKey (earntask.io Turnstile) ──
  // Captured from live session. Will be overridden by storage if a newer
  // key is saved, but guarantees ghost solving starts from page load.
  var HARDCODED_SITE_KEY = '0x4AAAAAACxj8_tgxWTBH2nu';

  // ─── Configuration (set via postMessage from bridge) ─────
  var config = {
    enabled: false,
    clerkId: '',
    userId: '',
    siteKey: HARDCODED_SITE_KEY, // Pre-seeded — ghost solver starts immediately!
    initialized: false,
  };

  // ─── State ───────────────────────────────────────────────
  var convexWS = null;
  var origSendFn = null;
  var authToken = null;
  var requestIdCounter = 20000;

  var acceptedTaskIds = {};
  var pendingTaskIds  = {}; // taskId -> subreddit — queued when no token was available
  var inFlightClaims = {}; // taskId -> { stage, turnstileToken, ... }
  var preConfigTaskQueue = []; // Queues tasks received before bridge sends config

  // Turnstile Ghost Pool State
  var preSolvedToken = null;
  var tokenTimestamp = 0;
  var ghostWidgetId = null;
  var ghostDiv = null;

  // ─── Logging (routes to bridge) ──────────────────────────
  function log(level, message) {
    var prefix = '[WS-Bot]';
    switch (level) {
      case 'success': console.log(prefix + ' ✅ ' + message); break;
      case 'error':   console.error(prefix + ' ❌ ' + message); break;
      case 'warn':    console.warn(prefix + ' ⚠️ ' + message); break;
      case 'debug':   console.debug(prefix + ' 🔍 ' + message); break;
      default:        console.log(prefix + ' ' + message);
    }
    postToBridge('LOG', { level: level, message: message });
  }

  // ─── PostMessage Bridge ──────────────────────────────────
  function postToBridge(type, data) {
    window.postMessage({
      source: 'EARNTASK_WS_INTERCEPTOR',
      type: type,
      data: data,
    }, '*');
  }

  // Listen for config/commands from bridge
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.source !== 'EARNTASK_WS_BRIDGE') return;

    switch (msg.type) {
      case 'CONFIG':
        config.enabled = msg.data.enabled || false;
        // Prefer storage value, but never overwrite with empty string
        config.clerkId = msg.data.clerkId || config.clerkId;
        config.userId  = msg.data.userId  || config.userId;
        // Keep hardcoded key if storage doesn't have one
        config.siteKey = msg.data.siteKey || config.siteKey || HARDCODED_SITE_KEY;
        config.initialized = true;

        // Permanently set the WS active flag if enabled, so the DOM bot NEVER
        // attempts to click accept buttons, even before the WS connects.
        if (config.enabled) {
          document.documentElement.setAttribute('data-ws-active', 'true');
        } else {
          document.documentElement.removeAttribute('data-ws-active');
        }

        var tokenStatus = preSolvedToken ? 'Ready' : 'Solving/Pending';
        log('info', 'Config received — enabled: ' + config.enabled +
          ' | clerkId: ' + (config.clerkId ? 'set' : 'pending') +
          ' | siteKey: ' + (config.siteKey ? config.siteKey : 'none') + 
          ' | Token: ' + tokenStatus);

        // (Re-)start ghost widget whenever enabled status or siteKey changes
        if (config.enabled && config.siteKey) {
          if (document.body) {
            initGhostWidget();
          } else {
            document.addEventListener('DOMContentLoaded', initGhostWidget);
          }
        }

        // Process any tasks that arrived via WebSocket before config was ready
        if (config.enabled && preConfigTaskQueue.length > 0) {
          log('info', '📦 Processing ' + preConfigTaskQueue.length + ' task(s) that arrived before config was ready');
          onTasksReceived(preConfigTaskQueue);
          preConfigTaskQueue = [];
        }
        break;
    }
  });

  // ─── Eager Ghost Start (hardcoded key — no waiting for bridge) ───────
  // Since we already know the siteKey at script compile-time, we can spin
  // up the ghost solver immediately on DOMContentLoaded WITHOUT waiting for
  // the bridge to deliver the CONFIG message (~100ms later).
  function tryEagerGhostStart() {
    // Only auto-start if the extension is running on earntask.io
    if (window.location.hostname.indexOf('earntask.io') === -1) return;
    if (!config.siteKey) return;
    log('info', '⚡ Eager ghost start — siteKey pre-seeded, launching solver now!');
    // Save hardcoded siteKey to bridge/storage so it persists across reloads
    postToBridge('USER_IDS', { siteKey: config.siteKey });
    // Force=true bypasses the config.enabled guard so the ghost pre-solver
    // always warms up, even before the bridge delivers the enabled state.
    initGhostWidget(true);
  }
  if (document.body) {
    tryEagerGhostStart();
  } else {
    document.addEventListener('DOMContentLoaded', tryEagerGhostStart);
  }

  // ─── Ghost Turnstile Solver Pool ─────────────────────────
  function initGhostWidget(force) {
    // Skip if not on earntask and not forced
    if (!force && !config.enabled) return;
    if (!config.siteKey) return;
    if (ghostDiv) return; // already running

    // Wait 2.5 seconds to ensure React has fully finished rendering and hydration
    setTimeout(function() {
      if (ghostDiv) return; // check again after timeout

      log('info', '👻 Initializing Ghost Turnstile widget for siteKey: ' + config.siteKey);

      // Create a container hidden off-screen
      ghostDiv = document.createElement('div');
      ghostDiv.id = 'turnstile-ghost-pool';
      ghostDiv.style.position = 'fixed';
      ghostDiv.style.top = '-9999px';
      ghostDiv.style.left = '-9999px';
      ghostDiv.style.width = '1px';
      ghostDiv.style.height = '1px';
      ghostDiv.style.opacity = '0';
      ghostDiv.style.pointerEvents = 'none';
      
      if (document.body) {
        document.body.appendChild(ghostDiv);
      } else {
        document.documentElement.appendChild(ghostDiv);
      }

      // Force inject the Turnstile library if the page hasn't loaded it yet.
      if (!document.getElementById('taskbot-turnstile-api')) {
        log('info', '💉 Injecting Turnstile script to jump-start ghost solver');
        var s = document.createElement('script');
        s.id = 'taskbot-turnstile-api';
        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        s.async = true;
        s.defer = true;
        document.head.appendChild(s);
      }

      // Wait for the window.turnstile library to be loaded on the page
      var checkInterval = setInterval(function() {
        if (window.turnstile && typeof window.turnstile.render === 'function') {
          clearInterval(checkInterval);
          renderGhostWidget();
        }
      }, 100);
    }, 2500);
  }

  function renderGhostWidget() {
    if (!window.turnstile || !window.turnstile.render) return;
    if (ghostWidgetId !== null) return; // already rendered
    
    // Ensure the container is actually in the DOM before rendering
    if (!document.body || !document.body.contains(ghostDiv)) {
      if (document.body) document.body.appendChild(ghostDiv);
    }

    log('info', '👻 Rendering invisible Turnstile Ghost Widget...');
    try {
      ghostWidgetId = window.turnstile.render('#turnstile-ghost-pool', {
        sitekey: config.siteKey,
        callback: function(token) {
          preSolvedToken = token;
          tokenTimestamp = Date.now();
          log('success', '🔑 Ghost Turnstile token pre-solved successfully (Free & Ready)!');
          // Immediately claim any tasks that were queued while we had no token
          retryPendingTasks();
        },
        'expired-callback': function() {
          log('warn', '⏰ Ghost Turnstile token expired, resetting...');
          preSolvedToken = null;
          if (ghostWidgetId !== null) window.turnstile.reset(ghostWidgetId);
        },
        'error-callback': function() {
          log('error', '❌ Ghost Turnstile error occurred, retrying in 2s...');
          preSolvedToken = null;
          setTimeout(function() {
            if (ghostWidgetId !== null) window.turnstile.reset(ghostWidgetId);
          }, 2000);
        }
      });
    } catch (e) {
      log('error', 'Failed to render Turnstile Ghost Widget: ' + e.message);
    }
  }

  function getOrResetToken() {
    if (!preSolvedToken) return null;
    
    // Token too old check is now mostly handled by the refresh interval,
    // but keep as a safety net.
    if (Date.now() - tokenTimestamp > 115000) {
      log('warn', '⏰ Cached Turnstile token is unexpectedly old. Resetting...');
      preSolvedToken = null;
        try {
          if (ghostWidgetId !== null && window.turnstile && window.turnstile.reset) {
            window.turnstile.reset(ghostWidgetId);
          } else {
            ghostWidgetId = null;
            renderGhostWidget();
          }
        } catch (e) {
          log('warn', '♻️ Turnstile reset failed, forcing rebuild: ' + e.message);
          try { if (window.turnstile && window.turnstile.remove) window.turnstile.remove(ghostWidgetId); } catch(ex){}
          ghostWidgetId = null;
          renderGhostWidget();
        }
    }

    var token = preSolvedToken;
    preSolvedToken = null; // Consume token

    // Instantly queue a reset to fetch the next token so we are ready for the next task
    if (window.turnstile && ghostWidgetId !== null) {
      log('info', '🔄 Used token. Refreshing Ghost solver for next task...');
      window.turnstile.reset(ghostWidgetId);
    }

    return token;
  }

  // Aggressively force a fresh token every 110 seconds to ensure it never expires
  // Cloudflare tokens last ~300s, but refreshing early guarantees instant readiness
  setInterval(function() {
    if (preSolvedToken && ghostWidgetId !== null && window.turnstile) {
      if (Date.now() - tokenTimestamp >= 110000) {
        log('info', '♻️ Proactively refreshing token (reached 110s age)');
        preSolvedToken = null;
        window.turnstile.reset(ghostWidgetId);
      }
    }
  }, 5000);

  // ─── Method 1: Hook window.turnstile.render (MOST RELIABLE) ─────────
  // When the page calls turnstile.render({sitekey: '0x4...'}), we intercept
  // the argument before it even renders. This fires at the exact right moment.
  function hookTurnstileRender() {
    // Poll until the turnstile object exists on the window (it's loaded lazily)
    var hookAttempts = 0;
    var hookInterval = setInterval(function() {
      hookAttempts++;
      if (hookAttempts > 60) { clearInterval(hookInterval); return; } // 30s timeout

      if (!window.turnstile || typeof window.turnstile.render !== 'function') return;
      if (window.turnstile.__siteKeyHooked) return; // Already hooked

      clearInterval(hookInterval);
      var origRender = window.turnstile.render.bind(window.turnstile);

      window.turnstile.render = function(container, opts) {
        // Capture the sitekey the instant the page calls render!
        if (opts && opts.sitekey && !config.siteKey) {
          var key = opts.sitekey;
          log('success', '🎯 Intercepted turnstile.render() — siteKey: ' + key);
          config.siteKey = key;
          postToBridge('USER_IDS', { siteKey: key });
          // Now that we have the key, spin up the ghost solver
          initGhostWidget();
        }
        return origRender(container, opts);
      };
      window.turnstile.__siteKeyHooked = true;
      log('info', '🪝 Hooked window.turnstile.render for siteKey capture');
    }, 500);
  }
  hookTurnstileRender();

  // ─── Method 2: MutationObserver watching for CF iframes (FAST) ───────
  // Watches the DOM in real-time for Cloudflare iframe injections. Fires
  // instantly when the iframe appears, faster than a 1-second poll interval.
  function extractKeyFromSrc(src) {
    var m = src.match(/(0x4[A-Za-z0-9_-]{15,30})/);
    return m ? m[1] : null;
  }

  function checkNodeForSiteKey(node) {
    if (config.siteKey) return;
    if (!node || node.nodeType !== 1) return;

    // Direct iframe match
    if (node.tagName === 'IFRAME') {
      var src = node.src || node.getAttribute('src') || '';
      if (src.indexOf('challenges.cloudflare.com') !== -1 || src.indexOf('turnstile') !== -1) {
        var key = extractKeyFromSrc(src);
        if (key) { saveSiteKey(key); return; }
      }
    }

    // data-sitekey attribute
    var sk = node.getAttribute && (node.getAttribute('data-sitekey') || node.getAttribute('data-site-key'));
    if (sk) { saveSiteKey(sk); return; }

    // Children — check injected iframes inside this subtree
    var iframes = node.querySelectorAll ? node.querySelectorAll(
      'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], [data-sitekey], [data-site-key]'
    ) : [];
    for (var i = 0; i < iframes.length; i++) {
      var el = iframes[i];
      var elSk = el.getAttribute('data-sitekey') || el.getAttribute('data-site-key');
      if (elSk) { saveSiteKey(elSk); return; }
      var elSrc = el.src || el.getAttribute('src') || '';
      var elKey = extractKeyFromSrc(elSrc);
      if (elKey) { saveSiteKey(elKey); return; }
    }
  }

  function saveSiteKey(key) {
    if (config.siteKey) return;
    log('info', '🔎 Auto-captured siteKey via DOM observer: ' + key);
    config.siteKey = key;
    postToBridge('USER_IDS', { siteKey: key });
    initGhostWidget();
    if (siteKeyObserver) { siteKeyObserver.disconnect(); siteKeyObserver = null; }
  }

  var siteKeyObserver = new MutationObserver(function(mutations) {
    if (config.siteKey) { siteKeyObserver.disconnect(); siteKeyObserver = null; return; }
    for (var m = 0; m < mutations.length; m++) {
      var added = mutations[m].addedNodes;
      for (var n = 0; n < added.length; n++) {
        checkNodeForSiteKey(added[n]);
        if (config.siteKey) return;
      }
    }
  });

  // Start observing immediately — even before body (will hook document.documentElement)
  function startSiteKeyObserver() {
    var target = document.body || document.documentElement;
    siteKeyObserver.observe(target, { childList: true, subtree: true });
  }
  if (document.body) {
    startSiteKeyObserver();
  } else {
    document.addEventListener('DOMContentLoaded', startSiteKeyObserver);
  }

  // ─── Method 3: Periodic full-DOM fallback scan (safety net) ──────────
  function checkDomForSiteKey() {
    if (config.siteKey) return;

    // Check data attributes
    var el = document.querySelector('.cf-turnstile, [data-sitekey], [data-site-key]');
    var key = el ? (el.getAttribute('data-sitekey') || el.getAttribute('data-site-key')) : null;

    // Check CF iframes
    if (!key) {
      var iframes = document.querySelectorAll('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]');
      for (var i = 0; i < iframes.length; i++) {
        key = extractKeyFromSrc(iframes[i].src || '');
        if (key) break;
      }
    }

    if (key) saveSiteKey(key);
  }
  setInterval(checkDomForSiteKey, 1000);

  // ─── WebSocket Monkey-Patch ──────────────────────────────
  var OrigWebSocket = window.WebSocket;

  window.WebSocket = function (url) {
    var args = Array.prototype.slice.call(arguments, 1);
    var ws = args.length > 0
      ? new OrigWebSocket(url, args[0])
      : new OrigWebSocket(url);

    if (url && (url.indexOf('convex.cloud') !== -1 || url.indexOf('convex.earntask.io') !== -1)) {
      convexWS = ws;
      origSendFn = ws.send.bind(ws);
      log('info', '🟢 Convex WS captured');

      // Intercept outgoing messages
      ws.send = function (data) {
        try {
          // Dump ALL outgoing mutations to find botProtectionData
          if (typeof data === 'string' && data.indexOf('"type":"Mutation"') !== -1) {
            console.log('[WS-Bot] 🕵️ INTERCEPTED OFFICIAL MUTATION:', data);
          }

          var d = JSON.parse(data);

          // Capture auth token
          if (d.type === 'Authenticate' && d.value) {
            authToken = d.value;
            var tokenStatus = preSolvedToken ? 'Ready' : 'Solving/Pending';
            log('info', '🟢 WS Authenticated | Token: ' + tokenStatus);
          }

          // Auto-extract user IDs from page traffic
          if (!config.clerkId || !config.userId) {
            extractUserIds(d);
          }
        } catch (e) { /* not JSON */ }

        return origSendFn(data);
      };

      // Intercept incoming messages
      ws.addEventListener('message', function (event) {
        // Fast string check before parsing to minimize CPU overhead
        if (event.data.indexOf('tasks') === -1 && event.data.indexOf('MutationResponse') === -1 && event.data.indexOf('ActionResponse') === -1) return;

        try {
          var d = JSON.parse(event.data);
          handleIncomingMessage(d);
        } catch (e) { /* not JSON */ }
      });

      // Handle disconnect
      ws.addEventListener('close', function (event) {
        log('warn', 'WS closed (code: ' + event.code + ')');
        convexWS = null;
        origSendFn = null;
        authToken = null;
        // We no longer remove data-ws-active here. If the extension is enabled,
        // we want the DOM bot to remain disabled even during a reconnect.
        document.documentElement.removeAttribute('data-ws-claiming');
      });
    }

    return ws;
  };

  window.WebSocket.prototype = OrigWebSocket.prototype;
  Object.defineProperty(window.WebSocket, 'CONNECTING', { value: 0 });
  Object.defineProperty(window.WebSocket, 'OPEN', { value: 1 });
  Object.defineProperty(window.WebSocket, 'CLOSING', { value: 2 });
  Object.defineProperty(window.WebSocket, 'CLOSED', { value: 3 });

  // ─── Extract User IDs ────────────────────────────────────
  function extractUserIds(d) {
    try {
      var str = JSON.stringify(d);
      var updated = false;
      var payload = {};

      if (!config.clerkId) {
        var cm = str.match(/"clerkId"\s*:\s*"(user_[^"]+)"/);
        if (cm) {
          config.clerkId = cm[1];
          payload.clerkId = config.clerkId;
          log('info', 'Auto-captured clerkId: ' + config.clerkId);
          updated = true;
        }
      }
      if (!config.userId) {
        var um = str.match(/"userId"\s*:\s*"([a-z0-9]{20,})"/);
        if (um) {
          config.userId = um[1];
          payload.userId = config.userId;
          log('info', 'Auto-captured userId: ' + config.userId);
          updated = true;
        }
      }
      if (updated) {
        postToBridge('USER_IDS', payload);
      }
    } catch (e) { /* ignore */ }
  }

  // ─── Handle Incoming WS Messages ─────────────────────────
  function handleIncomingMessage(d) {
    if (d.type === 'Transition') {
      var mods = d.modifications;
      if (!mods) return;
      for (var i = 0; i < mods.length; i++) {
        var mod = mods[i];
        if (mod.type === 'QueryUpdated' && mod.value) {
          // Convex might send the array under any key (page, tasks, results, list, etc)
          var arrays = [];
          if (Array.isArray(mod.value)) arrays.push(mod.value);
          else if (typeof mod.value === 'object') {
            for (var k in mod.value) {
              if (Array.isArray(mod.value[k])) arrays.push(mod.value[k]);
            }
          }
          
          for (var a = 0; a < arrays.length; a++) {
            var arr = arrays[a];
            if (arr.length > 0 && arr[0] && arr[0]._id) {
              // Only process arrays that look like they contain tasks, not notifications
              if (arr[0].type !== 'task_report_submitted' && typeof arr[0].read !== 'boolean') {
                onTasksReceived(arr);
              } else {
                console.log('[WS-Bot] 🔍 Ignored array (looks like notifications):', arr);
              }
            } else {
              console.log('[WS-Bot] 🔍 Ignored non-task array:', arr);
            }
          }
        }
      }
    } else if (d.requestId) {
      // Process responses for our active 3-step claiming handshakes
      handleHandshakeResponse(d);
    }
  }

  // ─── Extract Subreddit from WS Task Object ────────────────
  function extractSubredditFromTask(t) {
    if (!t) return null;
    
    // First, try direct properties that might just hold the name without /r/
    var possibleNames = t.subreddit || t.subredditName || (t.campaign && (t.campaign.subreddit || t.campaign.subredditName));
    if (typeof possibleNames === 'string' && possibleNames.length > 2 && possibleNames.indexOf('/') === -1) {
      return possibleNames;
    }

    // Deep search the entire task object for any URL or text containing /r/
    var str = JSON.stringify(t);
    var match = str.match(/\/(?:r|u)\/([a-zA-Z0-9_]+)/i);
    if (match) return match[1];
    
    // Fallback: look for "r/something" in quotes
    match = str.match(/"r\/([a-zA-Z0-9_]+)"/i);
    if (match) return match[1];

    console.log('[WS-Bot] ⚠️ Could not extract subreddit. Raw task:', t);
    return null;
  }

  // ─── BotBouncer Check via Bridge ──────────────────────────
  var bbCallbacks = {};
  var bbMsgId = 1;

  function checkBotBouncer(subreddit, callback) {
    // ── BOTBOUNCER CHECK COMPLETELY BYPASSED ──
    // Hardcoded to instantly approve all tasks without querying the API.
    // This removes all Reddit API rate limits and guarantees flash-like claiming.
    return callback(true);
  }

  // Handle BB response (kept for compatibility, though unused now)
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (msg && msg.source === 'EARNTASK_WS_BRIDGE' && msg.type === 'BB_RESULT') {
      if (bbCallbacks[msg.id]) {
        bbCallbacks[msg.id](msg.safe);
        delete bbCallbacks[msg.id];
      }
    }
  });

  // ─── Retry tasks that arrived before the ghost token was ready ────
  function retryPendingTasks() {
    var ids = Object.keys(pendingTaskIds);
    if (ids.length === 0) return;
    log('info', '🔄 Token ready — retrying ' + ids.length + ' queued task(s) now!');
    for (var i = 0; i < ids.length; i++) {
      if (!preSolvedToken) break; // Stop if we ran out of token mid-loop
      var taskId = ids[i];
      var subreddit = pendingTaskIds[taskId];
      delete pendingTaskIds[taskId];
      acceptedTaskIds[taskId] = true;

      (function(id, sub) {
        checkBotBouncer(sub, function(isSafe) {
          if (!isSafe) {
            log('error', '⛔ BotBouncer blocked queued task ' + id + ' for r/' + sub);
            delete acceptedTaskIds[id];
            return;
          }
          log('info', '⚡ Retrying SAFE queued task: ' + id + ' (r/' + sub + ')');
          startWebSocketHandshake(id, sub);
        });
      })(taskId, subreddit);
    }
  }

  // ─── Task Processing & 3-Step WS Handshake ────────────────────
  function onTasksReceived(tasks) {
    log('info', '📡 Incoming task data packet detected via WS! (' + tasks.length + ' items)');
    if (!config.initialized) {
      log('warn', '⚠️ Extension config not initialized yet. Queuing tasks...');
      // Park tasks if config hasn't arrived from background script yet
      for (var j = 0; j < tasks.length; j++) {
        preConfigTaskQueue.push(tasks[j]);
      }
      return;
    }
    
    if (!config.enabled) {
      log('info', '⏸️ Extension is paused. Ignoring tasks.');
      return;
    }
    if (!config.clerkId) {
      log('error', '❌ Missing clerkId! Cannot claim tasks over WS. Please ensure you are logged in and refresh the page.');
      return;
    }
    
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (!t._id) continue;
      // Skip if this is a notification, history record, or unrelated object
      if (t.type === 'task_report_submitted' || typeof t.read === 'boolean') continue;
      if (t.task || t.acceptedAt || t.status === 'approved' || t.status === 'cancelled') continue;

      // Already successfully started/completed — skip
      if (acceptedTaskIds[t._id]) continue;

      var sub = extractSubredditFromTask(t) || 'unknown';

      // If we have no pre-solved token, park the task in the pending queue
      if (!preSolvedToken) {
        if (!pendingTaskIds[t._id]) {
          pendingTaskIds[t._id] = sub;
          log('warn', '⏳ No token yet — queuing task for retry: ' + t._id + ' (r/' + sub + ')');
        }
        continue;
      }

      // We have a token AND a new task — check BotBouncer FIRST
      if (pendingTaskIds[t._id]) delete pendingTaskIds[t._id];
      acceptedTaskIds[t._id] = true;

      (function(taskId, subreddit) {
        checkBotBouncer(subreddit, function(isSafe) {
          if (!isSafe) {
            log('error', '⛔ BotBouncer blocked task ' + taskId + ' for r/' + subreddit);
            // Delete from acceptedTaskIds so it won't be retried
            // but we don't start the handshake.
            delete acceptedTaskIds[taskId];
            return;
          }
          log('info', '⚡ New SAFE task detected: ' + taskId + ' (r/' + subreddit + ')');
          startWebSocketHandshake(taskId, subreddit);
        });
      })(t._id, sub);
    }
  }

  function startWebSocketHandshake(taskId, subreddit) {
    // 1. Check if we have a pre-solved Turnstile token ready!
    var turnstileToken = getOrResetToken();
    if (!turnstileToken) {
      log('warn', '⚠️ No pre-solved Turnstile token available in pool! Falling back to DOM flow.');
      // Don't block the DOM flow — let it handle this one naturally
      postToBridge('TASK_CLAIM_FAILED', { reason: 'No pre-solved Turnstile token ready', subreddit: subreddit });
      return;
    }

    // ── Synchronous cross-world lock ──────────────────────────────────
    // Set a DOM attribute that the ISOLATED world can read instantly
    // (no postMessage delay). This prevents the DOM observer from also
    // clicking the Accept button while we handle it via WebSocket.
    document.documentElement.setAttribute('data-ws-claiming', 'true');

    var reqId = requestIdCounter++;
    inFlightClaims[taskId] = {
      taskId: taskId,
      subreddit: subreddit,
      turnstileToken: turnstileToken,
      stage: 'START_CHALLENGE',
      startChallengeReqId: reqId
    };

    log('info', '⚡ Handshake Step 1/3: Requesting math challenge...');
    postToBridge('ACCEPT_SENT', { subreddit: subreddit });

    origSendFn(JSON.stringify({
      type: 'Mutation',
      requestId: reqId,
      udfPath: 'tasks/index:startTaskAcceptChallenge',
      args: [{ clerkId: config.clerkId, taskId: taskId }]
    }));
  }

  // Helper: release the cross-world claim lock
  function releaseWSLock() {
    document.documentElement.removeAttribute('data-ws-claiming');
  }

  function handleHandshakeResponse(d) {
    for (var taskId in inFlightClaims) {
      var claim = inFlightClaims[taskId];

      // Step 1 Response: Received Math Challenge
      if (claim.stage === 'START_CHALLENGE' && d.requestId === claim.startChallengeReqId) {
        if (d.type === 'MutationResponse' && d.success && d.result) {
          var res = d.result;
          claim.challengeId = res.challengeId;
          claim.prompt = res.prompt;

          log('info', '⚡ Handshake Step 1 Success: Math challenge received: "' + res.prompt + '"');

          // Instantly solve math challenge
          var ans = solveMathChallenge(res.prompt);
          if (ans === null) {
            log('error', '❌ Handshake Error: Failed to solve math prompt: "' + res.prompt + '"');
            postToBridge('TASK_CLAIM_FAILED', { reason: 'Failed to solve math challenge: ' + res.prompt, subreddit: claim.subreddit });
            delete inFlightClaims[taskId];
            return;
          }
          
          claim.mathAnswer = String(ans);
          log('success', '🔑 Instantly solved Math: ' + res.prompt + ' = ' + ans);

          // Trigger Step 2: Exchange Turnstile Token for Nonce
          claim.stage = 'EXCHANGE_TURNSTILE';
          claim.exchangeReqId = requestIdCounter++;

          log('info', '⚡ Handshake Step 2/3: Exchanging Turnstile token for Nonce...');
          origSendFn(JSON.stringify({
            type: 'Action',
            requestId: claim.exchangeReqId,
            udfPath: 'tasks/index:exchangeTurnstileForAcceptNonce',
            args: [{
              clerkId: config.clerkId,
              turnstileToken: claim.turnstileToken
            }]
          }));
        } else {
          var err = d.errorMessage || d.error || 'Challenge request failed';
          log('error', '❌ Handshake Step 1 Failed: ' + err);
          postToBridge('TASK_CLAIM_FAILED', { reason: err, subreddit: claim.subreddit });
          delete inFlightClaims[taskId];
          releaseWSLock();
        }
        return;
      }

      // Step 2 Response: Exchanged Turnstile for Nonce
      if (claim.stage === 'EXCHANGE_TURNSTILE' && d.requestId === claim.exchangeReqId) {
        if (d.type === 'ActionResponse' && d.success && d.result && d.result.nonceId) {
          claim.nonceId = d.result.nonceId;
          log('success', '🔑 Handshake Step 2 Success: Nonce acquired: ' + claim.nonceId);

          // Trigger Step 3: Final Accept Mutation
          claim.stage = 'ACCEPT_TASK';
          claim.acceptReqId = requestIdCounter++;

          log('info', '⚡ Handshake Step 3/3: Submitting final acceptTask mutation...');
          origSendFn(JSON.stringify({
            type: 'Mutation',
            requestId: claim.acceptReqId,
            udfPath: 'tasks/index:acceptTask',
            args: [{
              clerkId: config.clerkId,
              taskId: claim.taskId,
              turnstileNonceId: claim.nonceId,
              acceptChallenge: {
                answer: claim.mathAnswer,
                challengeId: claim.challengeId
              },
              botProtectionData: {
                clickTiming: Math.floor(Math.random() * 2000) + 1500, // 1.5s - 3.5s
                interactionScore: Math.floor(Math.random() * 15) + 84, // 84 - 98 (Avoids '100' warning)
                mouseMovements: Math.floor(Math.random() * 40) + 15, // 15 - 55
                timeOnPage: Math.floor(Math.random() * 30000) + 10000, // 10s - 40s
                verificationToken: Date.now().toString() + '-' + Math.random().toString(36).substring(2, 12)
              }
            }]
          }));
        } else {
          var err = d.errorMessage || d.error || 'Turnstile exchange failed';
          log('error', '❌ Handshake Step 2 Failed: ' + err);
          postToBridge('TASK_CLAIM_FAILED', { reason: err, subreddit: claim.subreddit });
          delete inFlightClaims[taskId];
          releaseWSLock();
        }
        return;
      }

      // Step 3 Response: Final Accept Confirmation
      if (claim.stage === 'ACCEPT_TASK' && d.requestId === claim.acceptReqId) {
        if (d.type === 'MutationResponse' && d.success) {
          log('success', '🎉 🎉 TASK CLAIMED SUCCESSFULLY VIA WEBSOCKET IN < 100ms!');
          postToBridge('TASK_CLAIMED', { subreddit: claim.subreddit });
        } else {
          var err = d.errorMessage || d.error;
          // Convex sometimes hides the error string in the result field for Uncaught ConvexErrors
          if (!err && typeof d.result === 'string' && d.result.includes('Error')) {
            var match = d.result.match(/Uncaught ConvexError:\s*(.*)/);
            if (match) {
              err = match[1].trim();
            } else {
              err = d.result.split('\n')[0];
            }
          }
          if (!err) err = 'Final accept task rejected';
          
          console.log('[WS-Bot] 🔴 Raw Error Object for Step 3:', d);
          log('error', '❌ Handshake Step 3 Failed: ' + err);
          postToBridge('TASK_CLAIM_FAILED', { reason: err, subreddit: claim.subreddit });
        }
        delete inFlightClaims[taskId];
        releaseWSLock(); // Always release lock on final step
        return;
      }
    }
  }

  function solveMathChallenge(text) {
    if (!text || typeof text !== 'string') return null;
    var match = text.match(/(\d+)\s*\+\s*(\d+)/);
    if (!match) return null;
    var a = parseInt(match[1], 10), b = parseInt(match[2], 10);
    return (isNaN(a) || isNaN(b)) ? null : a + b;
  }

  // ─── Status Heartbeat ─────────────────────────────────────
  setInterval(function() {
    if (!config.enabled) return;
    var tokenStatus = preSolvedToken 
      ? ('Ready (' + Math.round((Date.now() - tokenTimestamp) / 1000) + 's old)') 
      : 'Solving/Pending';
    var connStatus = (convexWS && convexWS.readyState === OrigWebSocket.OPEN)
      ? (authToken ? 'Authenticated' : 'Connected')
      : 'Disconnected';
      
    log('info', '💓 Heartbeat | WS: ' + connStatus + ' | Token: ' + tokenStatus + ' | Queued: ' + Object.keys(pendingTaskIds).length);
  }, 60000);

  // ─── Expose for debugging ───────────────────────────────
  window.__WSBot = {
    getState: function () {
      return {
        connected: !!(convexWS && convexWS.readyState === OrigWebSocket.OPEN),
        hasAuth: !!authToken,
        config: config,
        acceptedCount: Object.keys(acceptedTaskIds).length,
        pendingCount: Object.keys(pendingTaskIds).length,  // tasks queued waiting for token
        inFlightClaims: inFlightClaims,
        hasPreSolvedToken: !!preSolvedToken,
        tokenAgeSeconds: preSolvedToken ? Math.round((Date.now() - tokenTimestamp) / 1000) : null
      };
    },
  };

  console.log('[WS-Bot] 🚀 Invisible Turnstile Ghost Pre-solver & Handshake Interceptor loaded!');
})();
