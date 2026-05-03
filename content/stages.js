/**
 * Task Auto Claimer — Stage Pipeline & Task Queue
 * Stages: Accept → Confirm ("Yes, accept") → DONE (no captcha)
 *
 * After the EarnTask update, there is no captcha step.
 * Clicking "Accept Task" opens a confirmation popup.
 * Clicking "Yes, accept" in the popup claims the task immediately.
 *
 * SEQUENTIAL mode: Click ONE accept button → handle its popup → next task.
 * Bulk-clicking all buttons at once breaks because the site only shows
 * one popup at a time.
 */
(function () {
  'use strict';
  var S = TB.state;

  // ─── Abort / Cancel ────────────────────────────────────
  TB.abortClaim = function (reason) {
    console.warn('[TaskBot] ❌ ABORT — ' + reason);
    if (S.verifyTimer) { clearTimeout(S.verifyTimer); S.verifyTimer = null; }
    if (S.bbCheckTimer) { clearTimeout(S.bbCheckTimer); S.bbCheckTimer = null; }
    if (S.confirmRetryTimer) { clearTimeout(S.confirmRetryTimer); S.confirmRetryTimer = null; }
    TB.notify('TASK_CLAIM_FAILED', { reason: reason, subreddit: S.currentSubreddit });
    S.isVerifyingClaim = false;
    TB.resetState();

    // After abort, try to advance to next task or go back to /tasks
    setTimeout(function () {
      TB.rebuildTaskQueue();
      if (S.taskQueue.length > 0) {
        TB.advanceToNextTask();
      } else {
        TB.navigateToTasks();
      }
    }, 300);
  };

  TB.silentAbort = function (subreddit) {
    console.warn('[TaskBot] 🛡️ Silent abort — r/' + subreddit + ' has BotBouncer');
    if (S.verifyTimer) { clearTimeout(S.verifyTimer); S.verifyTimer = null; }
    if (S.bbCheckTimer) { clearTimeout(S.bbCheckTimer); S.bbCheckTimer = null; }
    if (S.confirmRetryTimer) { clearTimeout(S.confirmRetryTimer); S.confirmRetryTimer = null; }
    TB.notify('TASK_SKIPPED_BOTBOUNCER', { subreddit: subreddit });
    TB.notify('BB_LOG_ENTRY', { subreddit: subreddit, status: 'unsafe', action: 'skipped' });

    TB.clickCancelButton().then(function () {
      S.isVerifyingClaim = false;
      TB.resetState();
      TB.advanceToNextTask();
    });
  };

  TB.clickCancelButton = function (maxRetries, intervalMs) {
    maxRetries = maxRetries || 10;
    intervalMs = intervalMs || 200;
    var MODAL_SEL = [
      '[role="dialog"]', '[role="alertdialog"]',
      '.modal', '.dialog', '.popup', '.overlay',
      '[class*="modal"]', '[class*="dialog"]',
      '[class*="popup"]', '[class*="confirm"]',
    ];
    var CANCEL = ['cancel', 'no', 'close', 'dismiss', 'deny', 'back'];

    return new Promise(function (resolve) {
      var attempt = 0;

      function tryClick() {
        for (var ms = 0; ms < MODAL_SEL.length; ms++) {
          var modals;
          try { modals = document.querySelectorAll(MODAL_SEL[ms]); } catch (e) { continue; }
          for (var mi = 0; mi < modals.length; mi++) {
            try {
              var st = window.getComputedStyle(modals[mi]);
              if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
            } catch (e) { continue; }
            var btns = modals[mi].querySelectorAll('button, [role="button"]');
            for (var bi = 0; bi < btns.length; bi++) {
              if (!TB.isClickableButton(btns[bi])) continue;
              var text = TB.getText(btns[bi]);
              if (CANCEL.includes(text) || CANCEL.some(function (t) { return text.startsWith(t); })) {
                TB.handled.add(btns[bi]);
                btns[bi].click();
                return true;
              }
            }
          }
        }
        var allBtns = TB.getAllButtons(document.body);
        for (var i = 0; i < allBtns.length; i++) {
          if (TB.handled.has(allBtns[i]) || !TB.isClickableButton(allBtns[i])) continue;
          var t = TB.getText(allBtns[i]);
          if (CANCEL.includes(t) || CANCEL.some(function (c) { return t.startsWith(c); })) {
            TB.handled.add(allBtns[i]);
            allBtns[i].click();
            return true;
          }
        }
        return false;
      }

      function loop() {
        if (tryClick()) resolve(true);
        else if (++attempt < maxRetries) setTimeout(loop, intervalMs);
        else resolve(false);
      }
      loop();
    });
  };

  TB.confirmClaimSuccess = function () {
    if (S.verifyTimer) { clearTimeout(S.verifyTimer); S.verifyTimer = null; }
    if (S.confirmRetryTimer) { clearTimeout(S.confirmRetryTimer); S.confirmRetryTimer = null; }
    S.isVerifyingClaim = false;
    console.log('[TaskBot] ✅ Claim CONFIRMED for r/' + (S.currentSubreddit || 'unknown'));
    TB.notify('TASK_CLAIMED', {
      subreddit: S.currentSubreddit,
    });
    if (S.currentSubreddit) {
      TB.notify('BB_LOG_ENTRY', { subreddit: S.currentSubreddit, status: 'safe', action: 'claimed' });
    }

    TB.resetState();

    // Navigate back to tasks page — more tasks will be picked up by observer
    setTimeout(function () {
      TB.navigateToTasks();
    }, 800);
  };

  // ─── Navigate to Tasks Page (new dashboard sidebar) ────
  TB.navigateToTasks = function () {
    var TASKS_SELECTORS = [
      'a[href="/tasks"]',
      'a[href*="/tasks"]',
      'nav a[href="/tasks"]',
      '[class*="sidebar"] a[href="/tasks"]',
      '[class*="Sidebar"] a[href="/tasks"]',
      '[class*="nav"] a[href="/tasks"]',
      '[class*="Nav"] a[href="/tasks"]',
      '[class*="menu"] a[href="/tasks"]',
      '[class*="Menu"] a[href="/tasks"]',
    ];
    for (var i = 0; i < TASKS_SELECTORS.length; i++) {
      try {
        var link = document.querySelector(TASKS_SELECTORS[i]);
        if (link) {
          link.click();
          console.log('[TaskBot] 🔄 Navigated to tasks via: ' + TASKS_SELECTORS[i]);
          TB.scheduleRescan();
          return;
        }
      } catch (e) { /* invalid selector */ }
    }
    console.log('[TaskBot] 🔄 Navigating to /tasks via URL');
    window.location.href = '/tasks';
  };

  // ─── Schedule Rescan After Navigation ──────────────────
  TB.scheduleRescan = function () {
    var delays = [500, 1000, 2000, 3000, 5000];
    for (var i = 0; i < delays.length; i++) {
      (function (delay) {
        setTimeout(function () {
          if (!S.isEnabled) return;
          if (S.hasClickedAccept || S.isVerifyingClaim) return;
          TB.rebuildTaskQueue();
          if (S.taskQueue.length > 0) {
            console.log('[TaskBot] 🔍 Rescan found ' + S.taskQueue.length + ' task(s) after ' + delay + 'ms');
            TB.runCurrentStage();
          }
        }, delay);
      })(delays[i]);
    }
  };

  // ─── Task Queue ────────────────────────────────────────
  TB.rebuildTaskQueue = function () {
    S.taskQueue = [];
    S.taskQueueIndex = 0;
    var buttons = TB.getAllButtons(document.body);
    for (var i = 0; i < buttons.length; i++) {
      if (TB.handled.has(buttons[i]) || !TB.isClickableButton(buttons[i])) continue;
      var text = TB.getText(buttons[i]);
      if ((text.includes('accept') && text.includes('task')) ||
          text === 'accept' || text === 'accept task' ||
          text === 'claim' || text === 'claim task') {
        S.taskQueue.push(buttons[i]);
      }
    }
    if (TB.settings.claimSelector) {
      try {
        var matched = document.querySelectorAll(TB.settings.claimSelector);
        for (var j = 0; j < matched.length; j++) {
          if (!TB.handled.has(matched[j]) && TB.isClickableButton(matched[j]) && !S.taskQueue.includes(matched[j])) {
            S.taskQueue.push(matched[j]);
          }
        }
      } catch (e) { /* invalid selector */ }
    }
    if (S.taskQueue.length > 0) {
      console.log('[TaskBot] 🗂️ Task queue: ' + S.taskQueue.length + ' task(s) found');
    }
  };

  TB.advanceToNextTask = function () {
    if (S.isAdvancing) return;
    S.isAdvancing = true;
    setTimeout(function () {
      S.isAdvancing = false;
      if (!S.isEnabled) return;
      S.taskQueueIndex++;
      if (S.taskQueueIndex < S.taskQueue.length) {
        console.log('[TaskBot] ➡️ Advancing to task ' + (S.taskQueueIndex + 1) + '/' + S.taskQueue.length);
        TB.runCurrentStage();
      } else {
        TB.rebuildTaskQueue();
        if (S.taskQueue.length > 0) {
          console.log('[TaskBot] 🔄 Queue rebuilt — ' + S.taskQueue.length + ' task(s) found');
          TB.runCurrentStage();
        } else {
          console.log('[TaskBot] 🔄 No more tasks in queue, navigating to /tasks');
          TB.navigateToTasks();
        }
      }
    }, 500);
  };

  // ─── Stage A: Accept Task (SEQUENTIAL — one at a time) ──
  TB.tryAcceptTask = function () {
    if (S.hasClickedAccept) return false;
    if (S.taskQueue.length === 0 || S.taskQueueIndex >= S.taskQueue.length) {
      TB.rebuildTaskQueue();
    }

    // Find the NEXT unhandled, clickable accept button
    var targetButton = null;
    while (S.taskQueueIndex < S.taskQueue.length) {
      var candidate = S.taskQueue[S.taskQueueIndex];
      if (!TB.handled.has(candidate) && TB.isClickableButton(candidate)) {
        targetButton = candidate;
        break;
      }
      S.taskQueueIndex++;
    }
    if (!targetButton) return false;

    // ── Click ONE button only ──
    S.hasClickedAccept = true;
    TB.handled.add(targetButton);
    targetButton.click();
    console.log('[TaskBot] ⚡ Accept clicked — "' + TB.getText(targetButton) + '"');

    TB.startWatchdog('accept');
    TB.deferPostClick(targetButton);
    return true;
  };

  // ─── Stage B: Confirmation Modal ("Yes, accept") ───────
  // After the EarnTask update, clicking "Yes, accept" in the popup
  // is the FINAL step — no captcha follows. The task is claimed
  // immediately after this click.
  //
  // The BB check gates this step: we wait until BB confirms safe
  // before clicking "Yes, accept". If unsafe, we click Cancel.
  TB.tryConfirmation = function () {
    if (!S.hasClickedAccept || S.hasClickedConfirm) return false;

    // If BB flagged unsafe → abort
    if (S.abortSubmission) {
      TB.silentAbort(S.pendingSubreddit || 'unknown');
      return false;
    }

    // BB Gate: if enabled and still pending, schedule retry and wait
    if (TB.settings.botBouncerCheckEnabled && !S.bbCheckCompleted) {
      // Schedule a retry in 200ms in case no DOM mutations fire
      TB.scheduleConfirmRetry();
      return false;
    }

    // BB completed but unsafe
    if (TB.settings.botBouncerCheckEnabled && S.bbCheckCompleted && !S.bbCheckResult) {
      TB.silentAbort(S.pendingSubreddit || 'unknown');
      return false;
    }

    // ── Find the "Yes, accept" button ──
    var confirmBtn = TB.findConfirmButton();
    if (!confirmBtn) {
      // Popup might not have rendered yet — schedule retry
      TB.scheduleConfirmRetry();
      return false;
    }

    // ── CLICK IT ──
    S.hasClickedConfirm = true;
    TB.handled.add(confirmBtn);
    confirmBtn.click();
    console.log('[TaskBot] ✅ Clicked confirmation: "' + TB.getText(confirmBtn) + '"');
    TB.notify('STAGE_CONFIRM', { buttonText: TB.getText(confirmBtn) });

    // Cancel any pending retry timer
    if (S.confirmRetryTimer) { clearTimeout(S.confirmRetryTimer); S.confirmRetryTimer = null; }

    // Go straight to verification (no captcha step)
    S.isVerifyingClaim = true;

    // Check for immediate success or error
    if (TB.detectSuccessSignal()) { TB.confirmClaimSuccess(); return true; }
    var err = TB.detectErrorToast();
    if (err) { TB.abortClaim(err); return true; }

    // Wait for success/error signal from DOM mutations
    S.verifyTimer = setTimeout(function () {
      S.verifyTimer = null;
      if (!S.isVerifyingClaim) return;
      if (TB.detectSuccessSignal()) { TB.confirmClaimSuccess(); return; }
      var finalErr = TB.detectErrorToast();
      if (finalErr) { TB.abortClaim(finalErr); return; }
      // Assume success if no error toast after timeout
      console.log('[TaskBot] ⏱️ Verify timeout — assuming success (no error toast detected)');
      TB.confirmClaimSuccess();
    }, 4000);

    return true;
  };

  // ─── Find Confirm Button in Modal ──────────────────────
  TB.findConfirmButton = function () {
    var buttons = TB.getAllButtons(document.body);
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (TB.handled.has(btn) || !TB.isClickableButton(btn)) continue;
      var text = TB.getText(btn);
      if (text === 'cancel' || text === 'no' || text === 'close') continue;

      // Pattern 1: "yes" + confirmation word (e.g. "Yes, accept", "yes, claim")
      if (text.includes('yes') && (text.includes('accept') || text.includes('claim') ||
        text.includes('confirm') || text.includes('continue'))) {
        return btn;
      }

      // Pattern 2: Standalone confirmation inside a visible modal
      var isInModal = btn.closest(
        '[role="dialog"], [role="alertdialog"], .modal, .dialog, .popup, .overlay, ' +
        '[class*="modal"], [class*="dialog"], [class*="popup"], [class*="confirm"]'
      );
      if (isInModal && (
        ['confirm', 'claim', 'accept', 'yes', 'ok', 'continue'].indexOf(text) !== -1 ||
        text.includes('yes,') || text.includes('yes '))) {
        return btn;
      }
    }
    return null;
  };

  // ─── Retry Timer for Confirmation ──────────────────────
  // Polls for the confirm button at short intervals.
  // Needed because the popup may not render instantly after
  // clicking Accept, and no DOM mutations may fire to re-trigger.
  TB.scheduleConfirmRetry = function () {
    if (S.confirmRetryTimer) return; // already scheduled
    S.confirmRetryTimer = setTimeout(function () {
      S.confirmRetryTimer = null;
      if (!S.isEnabled || S.hasClickedConfirm || S.isVerifyingClaim) return;
      TB.runCurrentStage();
    }, 200);
  };

  // ─── Stage Watchdog ────────────────────────────────────
  var WATCHDOG_TIMEOUT_MS = 12000;

  TB.startWatchdog = function (stageName, timeoutMs) {
    TB.clearWatchdog();
    S.lastStageTransition = Date.now();
    var timeout = timeoutMs || WATCHDOG_TIMEOUT_MS;
    S.stageWatchdog = setTimeout(function () {
      S.stageWatchdog = null;
      if (!S.isEnabled) return;
      if (S.isVerifyingClaim) return;
      console.warn('[TaskBot] ⏰ WATCHDOG — stuck in stage "' + stageName + '" for ' + timeout + 'ms, force-resetting');
      TB.notify('PUSH_LOG', {
        level: 'warn',
        message: '⏰ Watchdog reset — stuck at "' + stageName + '" stage, resuming monitoring',
      });

      S.isVerifyingClaim = false;
      TB.resetState();

      setTimeout(function () {
        TB.rebuildTaskQueue();
        if (S.taskQueue.length > 0) {
          TB.runCurrentStage();
        } else {
          TB.navigateToTasks();
        }
      }, 300);
    }, timeout);
  };

  TB.clearWatchdog = function () {
    if (S.stageWatchdog) { clearTimeout(S.stageWatchdog); S.stageWatchdog = null; }
  };

  // ─── Stage Router ──────────────────────────────────────
  // 2 stages only: Accept → Confirm. No captcha.
  TB.runCurrentStage = function () {
    if (!S.isEnabled || S.isVerifyingClaim || S.hasClickedConfirm) return;
    if (!S.hasClickedAccept) { TB.tryAcceptTask(); return; }
    if (!S.hasClickedConfirm) { TB.tryConfirmation(); return; }
  };

  TB.resetState = function () {
    S.hasClickedAccept = false;
    S.hasClickedConfirm = false;
    S.hasSolvedCaptcha = false;
    S.hasSubmittedCaptcha = false;
    S.isVerifyingClaim = false;
    S.currentSubreddit = null;
    S.pendingSubreddit = null;
    S.bbCheckCompleted = false;
    S.bbCheckResult = true;
    S.abortSubmission = false;
    S.pendingCaptchaText = null;
    S.pendingCaptchaAnswer = null;
    S.storedCaptchaInput = null;
    S.storedSubmitBtn = null;
    S.turnstileDetected = false;
    S.turnstileCompleted = false;
    S.bulkAcceptPending = 0;
    if (S.turnstileTimer) { clearInterval(S.turnstileTimer); S.turnstileTimer = null; }
    if (S.confirmRetryTimer) { clearTimeout(S.confirmRetryTimer); S.confirmRetryTimer = null; }
    S.lastStageTransition = 0;
    if (S.verifyTimer) { clearTimeout(S.verifyTimer); S.verifyTimer = null; }
    if (S.bbCheckTimer) { clearTimeout(S.bbCheckTimer); S.bbCheckTimer = null; }
    TB.clearWatchdog();
  };
})();
