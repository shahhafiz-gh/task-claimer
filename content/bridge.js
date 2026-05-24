
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
            if (msg.data.siteKey) cfg.siteKey = msg.data.siteKey;
            chrome.storage.local.set({ wsConfig: cfg }, function() {
              sendConfig();
            });
          });
        } catch (e) { /* context invalidated */ }
        break;


      case 'TASK_CLAIMED':
        if (window.TB) {
          if (!window.TB.state.currentSubreddit && msg.data.subreddit) {
            window.TB.state.currentSubreddit = msg.data.subreddit;
          }
          window.TB.confirmClaimSuccess();
        } else {
          safeSendMessage({
            type: 'TASK_CLAIMED',
            payload: { subreddit: msg.data.subreddit },
          });
          safeSendMessage({
            type: 'BB_LOG_ENTRY',
            payload: { subreddit: msg.data.subreddit, status: 'safe', action: 'claimed' },
          });
        }
        break;

      case 'TASK_CLAIM_FAILED':
        safeSendMessage({
          type: 'TASK_CLAIM_FAILED',
          payload: { reason: msg.data.reason, subreddit: msg.data.subreddit },
        });
        if (window.TB) {
          window.TB.abortClaim(msg.data.reason);
        }
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
        if (window.TB) {
          window.TB.silentAbort(msg.data.subreddit);
        }
        break;

      case 'ACCEPT_SENT':
        safeSendMessage({
          type: 'STAGE_ACCEPT',
          payload: { subreddit: msg.data.subreddit, buttonText: '(WebSocket direct)' },
        });
        if (window.TB) {
          window.TB.state.isWSClaiming = true;
          window.TB.state.hasClickedAccept = true;
          window.TB.state.currentSubreddit = msg.data.subreddit;
          window.TB.state.isVerifyingClaim = true;
        }
        break;

      case 'CHECK_BB':
        chrome.runtime.sendMessage({ action: 'CHECK_BOTBOUNCER', subreddit: msg.subreddit }, function(resp) {
          window.postMessage({
            source: 'EARNTASK_WS_BRIDGE',
            type: 'BB_RESULT',
            id: msg.id,
            safe: resp && resp.safe
          }, '*');
        });
        break;
    }
  });

  // Known sitekey fallback — guarantees ghost solving works even on fresh installs
  // before the user manually triggers a Turnstile modal for capture.
  var KNOWN_SITE_KEY = '0x4AAAAAACxj8_tgxWTBH2nu';

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
          // Always deliver a siteKey — use stored value first, fall back to known key
          siteKey: wsConfig.siteKey || KNOWN_SITE_KEY,
          isAuthenticated: state.isAuthenticated || false,
          userStatus: (state.userStatus || 'pending').trim(),
          tasksRemaining: state.tasksRemaining || 0,
        },
      }, '*');
    });
  }

  // ─── Listen for State Changes from Background ────────────
  try {
  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (message.type === 'STATE_UPDATED') {
      sendConfig();
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
