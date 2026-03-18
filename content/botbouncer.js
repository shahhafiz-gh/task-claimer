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
    var text = (el.textContent || '').toLowerCase();
    if (text.includes('accept') && text.includes('task')) return true;
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
    TB.deferPostClick(btn);
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
      TB.abortClaim('timeout — no confirmation signal detected');
    }, 5000);
  };
})();
