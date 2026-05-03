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
  // ─── Configuration (set via postMessage from bridge) ─────
  var config = {
    enabled: false,
    clerkId: '',
    userId: '',
    minPay: 0,
    bbEnabled: true,
    initialized: false,
  };

  // ─── State ───────────────────────────────────────────────
  var convexWS = null;
  var origSendFn = null;
  var authToken = null;
  var requestIdCounter = 10000;
  var isAccepting = false;
  var lastAcceptTime = 0;
  var ACCEPT_COOLDOWN_MS = 2000;

  // Query subscription tracking: queryId → udfPath
  var queryIdMap = {};

  // Pending accept mutations: requestId → { taskId, subreddit, timestamp }
  var pendingAccepts = {};

  // Already-handled task IDs
  var acceptedTaskIds = {};
  var skippedTaskIds = {};

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
        config.clerkId = msg.data.clerkId || config.clerkId;
        config.userId = msg.data.userId || config.userId;
        config.minPay = parseFloat(msg.data.minPay || 0);
        config.bbEnabled = msg.data.bbEnabled !== false;
        config.initialized = true;
        log('info', 'Config received — enabled: ' + config.enabled +
          ' | clerkId: ' + (config.clerkId ? 'set' : 'pending'));
        break;

      case 'BB_RESULT':
        // BotBouncer result from bridge
        handleBBResult(msg.data.taskId, msg.data.subreddit, msg.data.safe, msg.data.candidates);
        break;
    }
  });

  // ─── WebSocket Monkey-Patch ──────────────────────────────
  var OrigWebSocket = window.WebSocket;

  window.WebSocket = function (url) {
    var args = Array.prototype.slice.call(arguments, 1);
    var ws = args.length > 0
      ? new OrigWebSocket(url, args[0])
      : new OrigWebSocket(url);

    if (url && url.indexOf('convex.cloud') !== -1) {
      convexWS = ws;
      origSendFn = ws.send.bind(ws);
      log('info', 'Convex WS captured');

      // Intercept outgoing messages
      var _origSend = ws.send.bind(ws);
      ws.send = function (data) {
        try {
          var d = JSON.parse(data);

          // Capture auth token
          if (d.type === 'Authenticate' && d.value) {
            authToken = d.value;
          }

          // Track query subscriptions
          if (d.type === 'ModifyQuerySet' && d.modifications) {
            for (var i = 0; i < d.modifications.length; i++) {
              var mod = d.modifications[i];
              if (mod.type === 'Add') {
                queryIdMap[mod.queryId] = mod.udfPath;
              } else if (mod.type === 'Remove') {
                delete queryIdMap[mod.queryId];
              }
            }
          }

          // Auto-extract user IDs from page traffic
          if (!config.clerkId || !config.userId) {
            extractUserIds(d);
          }
        } catch (e) { /* not JSON */ }

        return _origSend(data);
      };

      // Intercept incoming messages
      ws.addEventListener('message', function (event) {
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
        queryIdMap = {};
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
      if (!config.clerkId) {
        var cm = str.match(/"clerkId"\s*:\s*"(user_[^"]+)"/);
        if (cm) {
          config.clerkId = cm[1];
          log('info', 'Auto-captured clerkId: ' + config.clerkId);
          postToBridge('USER_IDS', { clerkId: config.clerkId, userId: config.userId });
        }
      }
      if (!config.userId) {
        var um = str.match(/"userId"\s*:\s*"([a-z0-9]{20,})"/);
        if (um) {
          config.userId = um[1];
          log('info', 'Auto-captured userId: ' + config.userId);
          postToBridge('USER_IDS', { clerkId: config.clerkId, userId: config.userId });
        }
      }
    } catch (e) { /* ignore */ }
  }

  // ─── Handle Incoming WS Messages ─────────────────────────
  function handleIncomingMessage(d) {
    // Task updates from subscribed queries
    if (d.type === 'Transition' && d.modifications) {
      for (var i = 0; i < d.modifications.length; i++) {
        var mod = d.modifications[i];
        if (mod.type === 'QueryUpdated') {
          var udfPath = queryIdMap[mod.queryId] || '';
          if (udfPath.indexOf('getAvailableTasks') !== -1 && mod.value && mod.value.tasks) {
            onTasksReceived(mod.value.tasks);
          }
        }
      }
    }

    // Mutation responses (accept results)
    if (d.type === 'MutationResponse' && pendingAccepts[d.requestId]) {
      var pending = pendingAccepts[d.requestId];
      delete pendingAccepts[d.requestId];

      if (d.success) {
        var result = d.result;
        var ok = result && result.success !== false;
        if (ok) {
          log('success', 'Task ' + pending.taskId + ' accepted! (r/' + pending.subreddit + ')');
          acceptedTaskIds[pending.taskId] = Date.now();
          postToBridge('TASK_CLAIMED', { subreddit: pending.subreddit, taskId: pending.taskId });
        } else {
          var reason = (result && result.error) || 'rejected';
          log('warn', 'Accept rejected: ' + reason);
          postToBridge('TASK_CLAIM_FAILED', { reason: reason, subreddit: pending.subreddit });
        }
      } else {
        log('error', 'Mutation failed: ' + (d.errorMessage || 'unknown'));
        postToBridge('TASK_CLAIM_FAILED', {
          reason: d.errorMessage || 'mutation error', subreddit: pending.subreddit,
        });
      }

      isAccepting = false;
    }
  }

  // ─── Task Processing ─────────────────────────────────────
  function onTasksReceived(tasks) {
    if (!config.enabled || !config.initialized) return;
    if (isAccepting) return;
    if (!config.clerkId) {
      log('warn', 'Cannot accept — clerkId not captured yet');
      return;
    }

    var now = Date.now();
    if ((now - lastAcceptTime) < ACCEPT_COOLDOWN_MS) return;

    log('info', '📋 ' + tasks.length + ' tasks received');

    // Filter candidates
    var candidates = [];
    for (var i = 0; i < tasks.length; i++) {
      var task = tasks[i];
      if (!task._id) continue;
      if (acceptedTaskIds[task._id] || skippedTaskIds[task._id]) continue;
      if (task.expiresAt && task.expiresAt < now) continue;

      // Try multiple field names for pay
      var pay = parseFloat(task.pay || task.price || task.payout ||
        task.reward || task.amount || task.taskPay || 0);

      if (config.minPay > 0 && pay < config.minPay) continue;

      candidates.push({
        id: task._id,
        pay: pay,
        subreddit: task.subreddit || '',
        postUrl: task.postUrl || '',
        isOP: task.isOPTask || false,
      });
    }

    if (candidates.length === 0) return;

    // Sort by pay descending
    candidates.sort(function (a, b) { return b.pay - a.pay; });

    // Start accept pipeline
    tryAcceptCandidate(candidates, 0);
  }

  // ─── Accept Pipeline (with BB check via bridge) ──────────
  function tryAcceptCandidate(candidates, index) {
    if (index >= candidates.length) {
      isAccepting = false;
      return;
    }

    var task = candidates[index];

    if (config.bbEnabled && task.subreddit) {
      // Ask bridge to do BB check
      postToBridge('CHECK_BB', {
        taskId: task.id,
        subreddit: task.subreddit,
        candidateIndex: index,
        candidates: candidates,
      });
    } else {
      sendAcceptMutation(task);
    }
  }

  // ─── Handle BB Result from Bridge ────────────────────────
  function handleBBResult(taskId, subreddit, safe, candidates) {
    if (!safe) {
      log('warn', '🛡️ BotBouncer UNSAFE: r/' + subreddit + ' — skipping');
      skippedTaskIds[taskId] = true;
      postToBridge('TASK_SKIPPED', { subreddit: subreddit });

      // Try next candidate
      if (candidates && candidates.length > 0) {
        var nextIndex = -1;
        for (var i = 0; i < candidates.length; i++) {
          if (candidates[i].id === taskId) { nextIndex = i + 1; break; }
        }
        if (nextIndex > 0 && nextIndex < candidates.length) {
          tryAcceptCandidate(candidates, nextIndex);
          return;
        }
      }
      isAccepting = false;
      return;
    }

    log('info', '🛡️ BotBouncer SAFE: r/' + subreddit);

    // Find the task in candidates
    var task = null;
    if (candidates) {
      for (var j = 0; j < candidates.length; j++) {
        if (candidates[j].id === taskId) { task = candidates[j]; break; }
      }
    }

    if (task) {
      sendAcceptMutation(task);
    } else {
      isAccepting = false;
    }
  }

  // ─── Send Accept Mutation ────────────────────────────────
  function sendAcceptMutation(task) {
    if (!convexWS || convexWS.readyState !== OrigWebSocket.OPEN) {
      log('error', 'WS not ready');
      isAccepting = false;
      return;
    }

    isAccepting = true;
    lastAcceptTime = Date.now();
    var reqId = requestIdCounter++;

    pendingAccepts[reqId] = {
      taskId: task.id,
      subreddit: task.subreddit,
      timestamp: Date.now(),
    };

    var mutation = JSON.stringify({
      type: 'Mutation',
      requestId: reqId,
      udfPath: 'tasks/index:acceptTask',
      args: [{
        clerkId: config.clerkId,
        taskId: task.id,
      }],
    });

    // Use origSendFn to bypass our interceptor
    if (origSendFn) {
      origSendFn(mutation);
    } else {
      convexWS.send(mutation);
    }

    log('info', '⚡ ACCEPT SENT — r/' + task.subreddit +
      ' | $' + task.pay + ' | task: ' + task.id.substring(0, 12) + '...');

    postToBridge('ACCEPT_SENT', { taskId: task.id, subreddit: task.subreddit });

    // Timeout safety
    setTimeout(function () {
      if (pendingAccepts[reqId]) {
        log('warn', 'Accept timeout — reqId: ' + reqId);
        delete pendingAccepts[reqId];
        isAccepting = false;
      }
    }, 5000);
  }

  // ─── Expose for debugging ───────────────────────────────
  window.__WSBot = {
    getState: function () {
      return {
        connected: !!(convexWS && convexWS.readyState === OrigWebSocket.OPEN),
        hasAuth: !!authToken,
        config: config,
        isAccepting: isAccepting,
        queryMap: queryIdMap,
        acceptedCount: Object.keys(acceptedTaskIds).length,
        skippedCount: Object.keys(skippedTaskIds).length,
        pendingAccepts: pendingAccepts,
      };
    },
  };

  console.log('[WS-Bot] 🚀 Interceptor installed (MAIN world) — waiting for Convex WS...');
})();
