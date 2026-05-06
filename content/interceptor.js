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
    initialized: false,
  };

  // ─── State ───────────────────────────────────────────────
  var convexWS = null;
  var origSendFn = null;
  var authToken = null;
  var requestIdCounter = 10000;

  var acceptedTaskIds = {};

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
        config.initialized = true;
        log('info', 'Config received — enabled: ' + config.enabled +
          ' | clerkId: ' + (config.clerkId ? 'set' : 'pending'));
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

          // Auto-extract user IDs from page traffic
          if (!config.clerkId || !config.userId) {
            extractUserIds(d);
          }
        } catch (e) { /* not JSON */ }

        return _origSend(data);
      };

      // Intercept incoming messages
      ws.addEventListener('message', function (event) {
        // Fast string check before parsing
        if (event.data.indexOf('tasks') === -1 && event.data.indexOf('MutationResponse') === -1) return;

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
    if (d.type === 'Transition') {
      var mods = d.modifications;
      if (!mods) return;
      for (var i = 0; i < mods.length; i++) {
        var mod = mods[i];
        if (mod.type === 'QueryUpdated' && mod.value && mod.value.tasks) {
          onTasksReceived(mod.value.tasks);
        }
      }
    } else if (d.requestId && pendingAccepts[d.requestId]) {
      var acceptData = pendingAccepts[d.requestId];
      delete pendingAccepts[d.requestId];
      
      if (d.type === 'MutationResponse' && d.success) {
        postToBridge('TASK_CLAIMED', { subreddit: acceptData.subreddit });
      } else {
        var reason = d.errorMessage || d.error || (d.type !== 'MutationResponse' ? 'Server returned ' + d.type : 'Server rejected claim');
        postToBridge('TASK_CLAIM_FAILED', { reason: reason, subreddit: acceptData.subreddit });
      }
    }
  }

  // ─── Task Processing ─────────────────────────────────────
  function onTasksReceived(tasks) {
    if (!config.clerkId) return;
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (!t._id || acceptedTaskIds[t._id]) continue;
      acceptedTaskIds[t._id] = true;
      var reqId = requestIdCounter++;
      pendingAccepts[reqId] = { taskId: t._id, subreddit: t.subreddit || '' };
      origSendFn(JSON.stringify({
        type: 'Mutation',
        requestId: reqId,
        udfPath: 'tasks/index:acceptTask',
        args: [{ clerkId: config.clerkId, taskId: t._id }]
      }));
    }
  }

  // ─── Expose for debugging ───────────────────────────────
  window.__WSBot = {
    getState: function () {
      return {
        connected: !!(convexWS && convexWS.readyState === OrigWebSocket.OPEN),
        hasAuth: !!authToken,
        config: config,
        acceptedCount: Object.keys(acceptedTaskIds).length,
        pendingAccepts: pendingAccepts,
      };
    },
  };

  console.log('[WS-Bot] 🚀 Interceptor installed (MAIN world) — waiting for Convex WS...');
})();
