
'use strict';

(function () {

  
  function safeSendMessage(msg, callback) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return; // context dead
      chrome.runtime.sendMessage(msg, callback);
    } catch (e) {
      // Extension context invalidated — ignore
    }
  }

  // ─── Listen for messages from MAIN world interceptor ─────
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.source !== 'EARNTASK_WS_INTERCEPTOR') return;

    switch (msg.type) {
      case 'LOG':
        // Forward log to background
        safeSendMessage({
          type: 'PUSH_LOG',
          payload: { level: msg.data.level, message: '🌐 ' + msg.data.message },
        });
        break;

      case 'USER_IDS':
        // Persist auto-captured user IDs
        try {
          chrome.storage.local.get('wsConfig', function (data) {
            if (chrome.runtime.lastError) return;
            var cfg = data.wsConfig || {};
            if (msg.data.clerkId) cfg.clerkId = msg.data.clerkId;
            if (msg.data.userId) cfg.userId = msg.data.userId;
            chrome.storage.local.set({ wsConfig: cfg });
          });
        } catch (e) { /* context invalidated */ }
        break;

      case 'CHECK_BB':

        safeSendMessage(
          { type: 'CHECK_BOTBOUNCER', payload: { subreddit: msg.data.subreddit } },
          function (response) {
            if (chrome.runtime.lastError) {
              // BB check failed — send unsafe result
              window.postMessage({
                source: 'EARNTASK_WS_BRIDGE',
                type: 'BB_RESULT',
                data: {
                  taskId: msg.data.taskId,
                  subreddit: msg.data.subreddit,
                  safe: false,
                  candidates: msg.data.candidates,
                },
              }, '*');
              return;
            }

            var result = response || { safe: false };

            // Log BB result
            safeSendMessage({
              type: 'BB_LOG_ENTRY',
              payload: {
                subreddit: msg.data.subreddit,
                status: result.safe ? 'safe' : 'unsafe',
                action: result.safe ? 'confirmed_safe' : 'bb_detected',
              },
            });

            // Send result back to MAIN world
            window.postMessage({
              source: 'EARNTASK_WS_BRIDGE',
              type: 'BB_RESULT',
              data: {
                taskId: msg.data.taskId,
                subreddit: msg.data.subreddit,
                safe: result.safe,
                candidates: msg.data.candidates,
              },
            }, '*');
          }
        );
        break;

      case 'TASK_CLAIMED':
        safeSendMessage({
          type: 'TASK_CLAIMED',
          payload: { subreddit: msg.data.subreddit },
        });
        safeSendMessage({
          type: 'BB_LOG_ENTRY',
          payload: { subreddit: msg.data.subreddit, status: 'safe', action: 'claimed' },
        });
        break;

      case 'TASK_CLAIM_FAILED':
        safeSendMessage({
          type: 'TASK_CLAIM_FAILED',
          payload: { reason: msg.data.reason, subreddit: msg.data.subreddit },
        });
        break;

      case 'TASK_SKIPPED':
        safeSendMessage({
          type: 'TASK_SKIPPED_BOTBOUNCER',
          payload: { subreddit: msg.data.subreddit },
        });
        safeSendMessage({
          type: 'BB_LOG_ENTRY',
          payload: { subreddit: msg.data.subreddit, status: 'unsafe', action: 'skipped' },
        });
        break;

      case 'ACCEPT_SENT':
        safeSendMessage({
          type: 'STAGE_ACCEPT',
          payload: { subreddit: msg.data.subreddit, buttonText: '(WebSocket direct)' },
        });
        break;
    }
  });

  // ─── Send Config to MAIN World ───────────────────────────
  function sendConfig() {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
    } catch (e) { return; }
    chrome.storage.local.get(['state', 'wsConfig'], function (data) {
      if (chrome.runtime.lastError) return;
      var state = data.state || {};
      var wsConfig = data.wsConfig || {};

      window.postMessage({
        source: 'EARNTASK_WS_BRIDGE',
        type: 'CONFIG',
        data: {
          enabled: state.enabled || false,
          clerkId: wsConfig.clerkId || '',
          userId: wsConfig.userId || '',
          minPay: state.minPay || wsConfig.minPay || 0,
          bbEnabled: state.botBouncerCheckEnabled !== false,
        },
      }, '*');
    });
  }

  // ─── Listen for State Changes from Background ────────────
  try {
  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (message.type === 'STATE_UPDATED') {
      // Forward state change to MAIN world
      var payload = message.payload || {};
      window.postMessage({
        source: 'EARNTASK_WS_BRIDGE',
        type: 'CONFIG',
        data: {
          enabled: payload.enabled || false,
          clerkId: payload.clerkId || '',
          userId: payload.userId || '',
          minPay: payload.minPay || 0,
          bbEnabled: payload.botBouncerCheckEnabled !== false,
        },
      }, '*');
      sendResponse({ ok: true });
    }
    return false;
  });
  } catch (e) { /* context invalidated */ }

  // ─── Initialize ──────────────────────────────────────────

  setTimeout(sendConfig, 100);


  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (msg && msg.source === 'EARNTASK_WS_INTERCEPTOR' && msg.type === 'REQUEST_CONFIG') {
      sendConfig();
    }
  });

  console.log('[WS-Bridge] 🔗 Bridge active (ISOLATED world)');
})();
