/**
 * Task Auto Claimer — BotBouncer Integration
 * Fast-path accept, BB check firing, result handling.
 *
 * SEQUENTIAL mode: Click ONE accept button at a time.
 * After EarnTask update: No captcha step. The BB check gates the
 * confirmation click ("Yes, accept"). If BB says unsafe, we click
 * Cancel instead of "Yes, accept".
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
    if (text.includes('accept') && text.includes('task')) return true;
    if (text === 'accept' || text === 'accept task' || text === 'claim' || text === 'claim task') return true;
    if (TB.settings.claimSelector) {
      try { if (el.matches(TB.settings.claimSelector)) return true; } catch (e) { }
    }
    return false;
  };

  // Find the first accept button in a DOM node (used by observer fast-path)
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

  // Find all accept buttons in a DOM node (used by observer — but only first is clicked)
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
  // Extracts subreddit from the task card and fires BB check.
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
            // BB timed out — re-trigger stage so tryConfirmation sees the abort flag
            TB.runCurrentStage();
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
        // BB disabled — mark as safe
        S.bbCheckCompleted = true;
        S.bbCheckResult = true;
      }
      TB.runCurrentStage();
    });
  };

  // ─── Fast-Path Accept (Single) — Observer calls this ───
  TB.fastClickAccept = function (btn) {
    if (S.hasClickedAccept) return;
    S.hasClickedAccept = true;
    TB.handled.add(btn);
    btn.click();
    console.log('[TaskBot] ⚡ FAST-PATH Accept clicked — "' + TB.getText(btn) + '"');
    TB.startWatchdog('accept');
    TB.deferPostClick(btn);
  };

  // When observer finds multiple accept buttons, click only the FIRST one.
  // Sequential processing is more reliable than bulk-clicking.
  TB.fastClickAllAccept = function (buttons) {
    if (S.hasClickedAccept || buttons.length === 0) return;
    // Click only the first button — the rest stay in the queue for later
    TB.fastClickAccept(buttons[0]);
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

    // BB check completed — re-trigger the stage router so tryConfirmation can proceed
    if (!S.hasClickedConfirm && S.hasClickedAccept) {
      console.log('[TaskBot] 🛡️ BB check result for r/' + subreddit + ': ' + (safe ? 'SAFE ✓' : 'UNSAFE ✗'));
      TB.runCurrentStage();
    }
  };

  // ─── Pre-warm BB Cache ─────────────────────────────────
  // Fire BB checks for all visible tasks so results are cached
  // by the time we get to them sequentially.
  TB.preWarmBBCache = function (buttons) {
    if (!TB.settings.botBouncerCheckEnabled) return;
    for (var i = 0; i < buttons.length; i++) {
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

  // ─── Deferred Post-Click from Modal ────────────────────
  // Legacy — kept for compatibility. Extracts subreddit from
  // a visible modal and fires BB check.
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
        buttonText: '(from-modal)',
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
            TB.runCurrentStage();
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
})();
