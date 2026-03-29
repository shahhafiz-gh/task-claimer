/**
 * Task Auto Claimer — BotBouncer Integration
 * Fast-path accept, BB check firing, result handling, final decision.
 */
(function () {
  'use strict';
  var S = TB.state;

  // ─── Fast-Path Accept Button Detection ─────────────────
  TB.isAcceptButton = function (el) {
    if (!el || el.nodeType !== 1) return false;
    if (TB.handled.has(el) || el.disabled) return false;
    if (el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') return false;
    if (el.offsetParent === null && el.offsetHeight === 0) return false;
    var text = (el.textContent || '').toLowerCase().trim();
    // Match "Accept Task", "accept task", etc.
    if (text.includes('accept') && text.includes('task')) return true;
    // Also match standalone "Accept" inside task card containers
    if (text === 'accept' || text === 'accept task' || text === 'claim' || text === 'claim task') return true;
    if (TB.settings.claimSelector) {
      try { if (el.matches(TB.settings.claimSelector)) return true; } catch (e) { }
    }
    return false;
  };

  TB.fastFindAcceptButton = function (node) {
    if (TB.isAcceptButton(node)) return node;
    if (node.getElementsByTagName) {
      var btns = node.getElementsByTagName('button');
      for (var i = 0; i < btns.length; i++) {
        if (TB.isAcceptButton(btns[i])) return btns[i];
      }
    }
    return null;
  };

  TB.fastFindAllAcceptButtons = function (node) {
    var results = [];
    if (TB.isAcceptButton(node)) results.push(node);
    if (node.getElementsByTagName) {
      var btns = node.getElementsByTagName('button');
      for (var i = 0; i < btns.length; i++) {
        if (TB.isAcceptButton(btns[i])) results.push(btns[i]);
      }
    }
    return results;
  };

  // ─── Deferred Post-Click Work ──────────────────────────
  TB.deferPostClick = function (btn) {
    queueMicrotask(function () {
      var subreddit = TB.extractSubreddit(btn);
      S.currentSubreddit = subreddit;
      S.pendingSubreddit = subreddit;

      TB.notify('STAGE_ACCEPT', {
        buttonText: TB.getText(btn),
        subreddit: subreddit || 'unknown',
      });

      if (TB.settings.botBouncerCheckEnabled && subreddit) {
        TB.fireBBCheck(subreddit);
        S.bbCheckTimer = setTimeout(function () {
          S.bbCheckTimer = null;
          if (!S.bbCheckCompleted) {
            S.bbCheckCompleted = true;
            S.bbCheckResult = false;
            S.abortSubmission = true;
            TB.notify('BB_LOG_ENTRY', {
              subreddit: subreddit, status: 'timeout', action: 'marked_unsafe_on_timeout',
            });
            if (S.hasSolvedCaptcha && !S.hasSubmittedCaptcha) TB.finalDecision();
          }
        }, TB.settings.bbCheckTimeoutMs);
      } else if (TB.settings.botBouncerCheckEnabled && !subreddit) {
        S.bbCheckCompleted = true;
        S.bbCheckResult = false;
        S.abortSubmission = true;
        TB.notify('BB_LOG_ENTRY', {
          subreddit: 'unknown', status: 'unsafe', action: 'no_subreddit_strict_abort',
        });
      } else {
        S.bbCheckCompleted = true;
        S.bbCheckResult = true;
      }
      TB.runCurrentStage();
    });
  };

  TB.fastClickAccept = function (btn) {
    if (S.hasClickedAccept) return;
    S.hasClickedAccept = true;
    TB.handled.add(btn);
    btn.click();
    console.log('[TaskBot] ⚡ FAST-PATH Accept clicked — "' + TB.getText(btn) + '"');
    S.bulkAcceptPending = 1;
    TB.deferPostClick(btn);
  };

  TB.fastClickAllAccept = function (buttons) {
    if (S.hasClickedAccept) return;
    if (buttons.length === 0) return;
    S.hasClickedAccept = true;

    for (var i = 0; i < buttons.length; i++) {
      TB.handled.add(buttons[i]);
      buttons[i].click();
      console.log('[TaskBot] ⚡ FAST-PATH Accept clicked (' + (i + 1) + '/' + buttons.length + ') — "' + TB.getText(buttons[i]) + '"');
    }

    S.bulkAcceptPending = buttons.length;
    console.log('[TaskBot] ⚡ FAST-PATH Bulk-clicked ' + buttons.length + ' accept button(s)');
    // Pre-warm BB cache for all subreddits
    TB.preWarmBBCache(buttons);
    // Full post-click processing for the first button
    TB.deferPostClick(buttons[0]);
  };

  // ─── BB Check ─────────────────────────────────────────
  TB.fireBBCheck = function (subreddit) {
    TB.notify('BB_LOG_ENTRY', { subreddit: subreddit, status: 'pending', action: 'checking' });
    try {
      chrome.runtime.sendMessage(
        { type: 'CHECK_BOTBOUNCER', payload: { subreddit: subreddit } },
        function (response) {
          if (chrome.runtime.lastError) {
            TB.handleBBResult(subreddit, false, chrome.runtime.lastError.message);
            return;
          }
          TB.handleBBResult(subreddit, (response || {}).safe);
        }
      );
    } catch (err) {
      TB.handleBBResult(subreddit, false, err.message);
    }
  };

  TB.handleBBResult = function (subreddit, safe, error) {
    TB.notify('BB_LOG_ENTRY', {
      subreddit: subreddit,
      status: safe ? 'safe' : 'unsafe',
      action: safe ? 'confirmed_safe' : (error ? 'check_error' : 'bb_detected'),
    });
    if (S.pendingSubreddit !== subreddit) return;

    S.bbCheckCompleted = true;
    S.bbCheckResult = safe;
    if (S.bbCheckTimer) { clearTimeout(S.bbCheckTimer); S.bbCheckTimer = null; }
    if (!safe) S.abortSubmission = true;
    if (S.hasSolvedCaptcha && !S.hasSubmittedCaptcha) TB.finalDecision();
  };

  // ─── Final Decision: Submit or Abort ───────────────────
  TB.finalDecision = function () {
    if (S.hasSubmittedCaptcha || !S.hasSolvedCaptcha) return;

    if (!TB.settings.botBouncerCheckEnabled) { TB.submitCaptcha(); return; }
    if (S.abortSubmission || (S.bbCheckCompleted && !S.bbCheckResult)) {
      TB.silentAbort(S.pendingSubreddit || 'unknown'); return;
    }
    if (S.bbCheckCompleted && S.bbCheckResult === true) { TB.submitCaptcha(); return; }
    if (!S.bbCheckCompleted) {
      TB.notify('BB_LOG_ENTRY', {
        subreddit: S.pendingSubreddit, status: 'timeout', action: 'aborted_timeout_strict',
      });
      TB.silentAbort(S.pendingSubreddit || 'unknown');
    }
  };

  // ─── Pre-warm BB Cache for Bulk Accept ──────────────────
  TB.preWarmBBCache = function (buttons) {
    if (!TB.settings.botBouncerCheckEnabled) return;
    for (var i = 1; i < buttons.length; i++) {
      var subreddit = TB.extractSubreddit(buttons[i]);
      if (subreddit) {
        try {
          chrome.runtime.sendMessage(
            { type: 'CHECK_BOTBOUNCER', payload: { subreddit: subreddit } },
            function () { /* pre-warming cache, ignore response */ }
          );
        } catch (e) { /* ignore */ }
      }
    }
  };

  // ─── Deferred Post-Click from Modal (Bulk Mode) ────────
  // Used when processing subsequent modals after bulk-clicking.
  // Extracts subreddit from the visible modal and fires BB check.
  TB.deferPostClickFromModal = function () {
    queueMicrotask(function () {
      var subreddit = null;
      var MODAL_SEL = '[role="dialog"], [role="alertdialog"], .modal, .dialog, [class*="modal"], [class*="dialog"], [class*="confirm"], [class*="popup"]';
      try {
        var modals = document.querySelectorAll(MODAL_SEL);
        for (var i = 0; i < modals.length; i++) {
          try {
            var style = window.getComputedStyle(modals[i]);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
          } catch (e) { continue; }
          var match = (modals[i].textContent || '').match(/\/r\/([a-zA-Z0-9_]+)/i);
          if (match) { subreddit = match[1]; break; }
        }
      } catch (e) { /* invalid selector */ }

      S.currentSubreddit = subreddit;
      S.pendingSubreddit = subreddit;

      TB.notify('STAGE_ACCEPT', {
        buttonText: '(bulk-next)',
        subreddit: subreddit || 'unknown',
      });

      if (TB.settings.botBouncerCheckEnabled && subreddit) {
        TB.fireBBCheck(subreddit);
        S.bbCheckTimer = setTimeout(function () {
          S.bbCheckTimer = null;
          if (!S.bbCheckCompleted) {
            S.bbCheckCompleted = true;
            S.bbCheckResult = false;
            S.abortSubmission = true;
            TB.notify('BB_LOG_ENTRY', {
              subreddit: subreddit, status: 'timeout', action: 'marked_unsafe_on_timeout',
            });
            if (S.hasSolvedCaptcha && !S.hasSubmittedCaptcha) TB.finalDecision();
          }
        }, TB.settings.bbCheckTimeoutMs);
      } else if (TB.settings.botBouncerCheckEnabled && !subreddit) {
        S.bbCheckCompleted = true;
        S.bbCheckResult = false;
        S.abortSubmission = true;
        TB.notify('BB_LOG_ENTRY', {
          subreddit: 'unknown', status: 'unsafe', action: 'no_subreddit_strict_abort',
        });
      } else {
        S.bbCheckCompleted = true;
        S.bbCheckResult = true;
      }
      TB.runCurrentStage();
    });
  };

  // ─── Submit Captcha ────────────────────────────────────
  TB.submitCaptcha = function () {
    if (S.hasSubmittedCaptcha) return;
    if (TB.settings.botBouncerCheckEnabled) {
      if (!S.bbCheckCompleted || S.bbCheckResult !== true || S.abortSubmission) {
        TB.silentAbort(S.pendingSubreddit || 'unknown'); return;
      }
    }

    S.hasSubmittedCaptcha = true;
    if (S.storedSubmitBtn && TB.isClickableButton(S.storedSubmitBtn)) {
      TB.handled.add(S.storedSubmitBtn);
      S.storedSubmitBtn.click();
    } else if (S.storedCaptchaInput) {
      TB.simulateEnter(S.storedCaptchaInput);
    }

    S.isVerifyingClaim = true;
    if (TB.detectSuccessSignal()) { TB.confirmClaimSuccess(); return; }
    var err = TB.detectErrorToast();
    if (err) { TB.abortClaim(err); return; }

    S.verifyTimer = setTimeout(function () {
      S.verifyTimer = null;
      if (!S.isVerifyingClaim) return;
      if (TB.detectSuccessSignal()) { TB.confirmClaimSuccess(); return; }
      var finalErr = TB.detectErrorToast();
      if (finalErr) { TB.abortClaim(finalErr); return; }
      // Assume success if no error toast after timeout — sometimes the success
      // signal is different in the new UI
      console.log('[TaskBot] ⏱️ Verify timeout — assuming success (no error toast detected)');
      TB.confirmClaimSuccess();
    }, 4000);
  };
})();
