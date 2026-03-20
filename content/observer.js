/**
 * Task Auto Claimer — Observer & Initialization
 */
(function () {
  'use strict';
  var S = TB.state;

  function startObserver() {
    if (S.observer) return;
    TB.notify('PUSH_LOG', {
      level: 'info',
      message: '👁️ Observer started on ' + window.location.hostname,
    });

    S.observer = new MutationObserver(function (mutations) {
      if (!S.isEnabled) return;

      // Fast path: scan addedNodes directly for accept buttons
      if (!S.hasClickedAccept && !S.isVerifyingClaim && !S.hasSubmittedCaptcha) {
        for (var i = 0; i < mutations.length; i++) {
          var added = mutations[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            if (added[j].nodeType !== 1) continue;
            var btn = TB.fastFindAcceptButton(added[j]);
            if (btn) { TB.fastClickAccept(btn); return; }
          }
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
  }

  function stopObserver() {
    if (S.observer) { S.observer.disconnect(); S.observer = null; }
    if (S.stageRAF) { cancelAnimationFrame(S.stageRAF); S.stageRAF = null; }
    S.taskQueue = [];
    S.taskQueueIndex = 0;
    S.isAdvancing = false;
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
