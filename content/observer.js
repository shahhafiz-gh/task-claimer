/**
 * Task Auto Claimer — Observer & Initialization
 */
(function () {
  'use strict';
  var S = TB.state;

  // Track URL for SPA navigation detection
  var lastUrl = window.location.href;

  function startObserver() {
    if (S.observer) return;
    TB.notify('PUSH_LOG', {
      level: 'info',
      message: '👁️ Observer started on ' + window.location.hostname,
    });

    S.observer = new MutationObserver(function (mutations) {
      if (!S.isEnabled) return;

      // SPA navigation detection — if URL changed, reset and rescan
      var currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        console.log('[TaskBot] 🔄 SPA navigation detected: ' + currentUrl);
        if (currentUrl.includes('/tasks')) {
          // We're on the tasks page — reset and start scanning for new tasks
          if (!S.hasClickedAccept && !S.isVerifyingClaim && !S.hasSubmittedCaptcha) {
            TB.resetState();
            TB.scheduleRescan();
          }
        }
      }

      // Fast path: scan addedNodes directly for ALL accept buttons and click them all
      if (!S.hasClickedAccept && !S.isVerifyingClaim && !S.hasSubmittedCaptcha) {
        var foundButtons = [];
        for (var i = 0; i < mutations.length; i++) {
          var added = mutations[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            if (added[j].nodeType !== 1) continue;
            var btns = TB.fastFindAllAcceptButtons(added[j]);
            for (var k = 0; k < btns.length; k++) {
              foundButtons.push(btns[k]);
            }
          }
        }
        if (foundButtons.length > 0) {
          if (foundButtons.length === 1) {
            TB.fastClickAccept(foundButtons[0]);
          } else {
            TB.fastClickAllAccept(foundButtons);
          }
          return;
        }
      }

      // Immediate: error toast detection
      if (S.hasClickedAccept && !S.isVerifyingClaim) {
        var error = TB.checkMutationsForErrorToast(mutations);
        if (error) { TB.abortClaim(error); return; }
      }

      // Immediate: success detection
      if (S.isVerifyingClaim) {
        if (TB.checkMutationsForSuccessSignal(mutations)) TB.confirmClaimSuccess();
        return;
      }
      if (S.hasSubmittedCaptcha) return;

      // Debounced: confirmation/captcha stages
      if (!S.stageRAF) {
        S.stageRAF = requestAnimationFrame(function () {
          S.stageRAF = null;
          if (S.isEnabled && !S.isVerifyingClaim && !S.hasSubmittedCaptcha) {
            TB.runCurrentStage();
          }
        });
      }
    });

    S.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'aria-hidden', 'open'],
    });

    TB.runCurrentStage();

    // Start periodic idle scan — catches tasks that appear without DOM mutations
    // (e.g. WebSocket push, React state update that doesn't trigger attributed mutations)
    startIdleScan();
  }

  // Periodic idle scan interval ID
  var idleScanTimer = null;
  var IDLE_SCAN_INTERVAL = 2000; // 2 seconds — check for tasks that appeared silently

  function startIdleScan() {
    if (idleScanTimer) return;
    idleScanTimer = setInterval(function () {
      if (!S.isEnabled) return;

      // Stuck state detection — if we've been in an intermediate state
      // for over 15 seconds with no watchdog firing, force reset here too.
      // This is a safety net in case the watchdog was somehow cleared.
      if (S.hasClickedAccept && !S.hasSubmittedCaptcha && !S.isVerifyingClaim) {
        if (S.lastStageTransition > 0 && (Date.now() - S.lastStageTransition) > 15000) {
          console.warn('[TaskBot] ⏰ Idle scan detected stuck state (' +
            (Date.now() - S.lastStageTransition) + 'ms since last transition), force-resetting');
          TB.notify('PUSH_LOG', {
            level: 'warn',
            message: '⏰ Idle scan: stuck state detected, force-resetting to monitor',
          });

          var pendingCount = S.bulkAcceptPending > 1 ? S.bulkAcceptPending - 1 : 0;
          TB.resetState();

          if (pendingCount > 0) {
            S.bulkAcceptPending = pendingCount;
            S.hasClickedAccept = true;
            TB.startWatchdog('bulk-next');
            TB.deferPostClickFromModal();
          } else {
            TB.rebuildTaskQueue();
            if (S.taskQueue.length > 0) {
              TB.runCurrentStage();
            } else {
              TB.navigateToTasks();
            }
          }
          return;
        }
        return; // Still in a claim attempt, don't scan for new tasks
      }
      if (S.isVerifyingClaim || S.hasSubmittedCaptcha) return;

      // Quick DOM scan for accept buttons
      TB.rebuildTaskQueue();
      if (S.taskQueue.length > 0) {
        console.log('[TaskBot] 🔍 Idle scan found ' + S.taskQueue.length + ' task(s)');
        TB.runCurrentStage();
      }
    }, IDLE_SCAN_INTERVAL);
  }

  function stopIdleScan() {
    if (idleScanTimer) { clearInterval(idleScanTimer); idleScanTimer = null; }
  }

  function stopObserver() {
    if (S.observer) { S.observer.disconnect(); S.observer = null; }
    if (S.stageRAF) { cancelAnimationFrame(S.stageRAF); S.stageRAF = null; }
    stopIdleScan();
    S.taskQueue = [];
    S.taskQueueIndex = 0;
    S.isAdvancing = false;
    S.bulkAcceptPending = 0;
    TB.resetState();
  }

  function applyState(state) {
    var wasEnabled = S.isEnabled;
    S.isEnabled = state.enabled;

    TB.settings = {
      claimSelector: state.claimSelector || '',
      captchaSelector: state.captchaSelector || '',
      captchaInputSelector: state.captchaInputSelector || '',
      submitSelector: state.submitSelector || '',
      botBouncerCheckEnabled: state.botBouncerCheckEnabled !== false,
      bbCheckTimeoutMs: state.bbCheckTimeoutMs || 10000,
      bbCacheDurationMs: state.bbCacheDurationMs || (30 * 60 * 1000),
      maxParallelChecks: state.maxParallelChecks || 2,
    };

    if (S.isEnabled && !wasEnabled) { TB.resetState(); startObserver(); }
    else if (!S.isEnabled && wasEnabled) { stopObserver(); }
  }

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (message.type === 'STATE_UPDATED') {
      applyState(message.payload);
      sendResponse({ ok: true });
    }
    return false;
  });

  // ─── Init ──────────────────────────────────────────────
  function init() {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, function (response) {
      if (chrome.runtime.lastError) return;
      if (response && response.state) applyState(response.state);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
