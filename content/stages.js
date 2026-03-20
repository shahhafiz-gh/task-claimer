/**
 * Task Auto Claimer — Stage Pipeline & Task Queue
 * Stages: Accept → Confirm → Captcha → Submit/Abort
 */
(function () {
  'use strict';
  var S = TB.state;

  // ─── Abort / Cancel ────────────────────────────────────
  TB.abortClaim = function (reason) {
    console.warn('[TaskBot] ❌ ABORT — ' + reason);
    if (S.verifyTimer) { clearTimeout(S.verifyTimer); S.verifyTimer = null; }
    if (S.bbCheckTimer) { clearTimeout(S.bbCheckTimer); S.bbCheckTimer = null; }
    TB.notify('TASK_CLAIM_FAILED', { reason: reason, subreddit: S.currentSubreddit });
    S.isVerifyingClaim = false;
    TB.resetState();
    TB.advanceToNextTask();
  };

  TB.silentAbort = function (subreddit) {
    console.warn('[TaskBot] 🛡️ Silent abort — r/' + subreddit + ' has BotBouncer');
    if (S.verifyTimer) { clearTimeout(S.verifyTimer); S.verifyTimer = null; }
    if (S.bbCheckTimer) { clearTimeout(S.bbCheckTimer); S.bbCheckTimer = null; }
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
    S.isVerifyingClaim = false;
    TB.notify('TASK_CLAIMED', {
      captchaExpression: S.pendingCaptchaText,
      captchaAnswer: S.pendingCaptchaAnswer,
      subreddit: S.currentSubreddit,
    });
    if (S.currentSubreddit) {
      TB.notify('BB_LOG_ENTRY', { subreddit: S.currentSubreddit, status: 'safe', action: 'claimed' });
    }
    TB.resetState();
    setTimeout(function () {
      var link = document.querySelector('nav a[href="/tasks"]') || document.querySelector('a[href="/tasks"]');
      if (link) link.click();
      else window.location.href = '/tasks';
    }, 1000);
  };

  // ─── Task Queue ────────────────────────────────────────
  TB.rebuildTaskQueue = function () {
    S.taskQueue = [];
    S.taskQueueIndex = 0;
    var buttons = TB.getAllButtons(document.body);
    for (var i = 0; i < buttons.length; i++) {
      if (TB.handled.has(buttons[i]) || !TB.isClickableButton(buttons[i])) continue;
      var text = TB.getText(buttons[i]);
      if (text.includes('accept') && text.includes('task')) S.taskQueue.push(buttons[i]);
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
  };

  TB.advanceToNextTask = function () {
    if (S.isAdvancing) return;
    S.isAdvancing = true;
    setTimeout(function () {
      S.isAdvancing = false;
      if (!S.isEnabled) return;
      S.taskQueueIndex++;
      if (S.taskQueueIndex < S.taskQueue.length) {
        TB.runCurrentStage();
      } else {
        TB.rebuildTaskQueue();
        if (S.taskQueue.length > 0) TB.runCurrentStage();
      }
    }, 800);
  };

  // ─── Stage A: Accept Task ──────────────────────────────
  TB.tryAcceptTask = function () {
    if (S.hasClickedAccept) return false;
    if (S.taskQueue.length === 0 || S.taskQueueIndex >= S.taskQueue.length) {
      TB.rebuildTaskQueue();
    }

    var targetButton = null;
    while (S.taskQueueIndex < S.taskQueue.length) {
      var candidate = S.taskQueue[S.taskQueueIndex];
      if (!TB.handled.has(candidate) && TB.isClickableButton(candidate)) {
        targetButton = candidate; break;
      }
      S.taskQueueIndex++;
    }
    if (!targetButton) return false;

    S.hasClickedAccept = true;
    TB.handled.add(targetButton);
    targetButton.click();
    console.log('[TaskBot] ⚡ Accept clicked — "' + TB.getText(targetButton) + '"');
    TB.deferPostClick(targetButton);
    TB.runCurrentStage();
    return true;
  };

  // ─── Stage B: Confirmation Modal ───────────────────────
  TB.tryConfirmation = function () {
    if (!S.hasClickedAccept || S.hasClickedConfirm) return false;
    if (S.abortSubmission) { TB.silentAbort(S.pendingSubreddit || 'unknown'); return false; }

    var buttons = TB.getAllButtons(document.body);
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (TB.handled.has(btn) || !TB.isClickableButton(btn)) continue;
      var text = TB.getText(btn);
      if (text === 'cancel' || text === 'no' || text === 'close') continue;

      // Pattern 1: "yes" + confirmation word
      if (text.includes('yes') && (text.includes('accept') || text.includes('claim') ||
        text.includes('confirm') || text.includes('continue'))) {
        S.hasClickedConfirm = true;
        TB.handled.add(btn); btn.click();
        TB.notify('STAGE_CONFIRM', { buttonText: text });
        TB.runCurrentStage();
        return true;
      }

      // Pattern 2: Standalone confirmation inside modal
      var isInModal = btn.closest(
        '[role="dialog"], [role="alertdialog"], .modal, .dialog, .popup, .overlay, ' +
        '[class*="modal"], [class*="dialog"], [class*="popup"], [class*="confirm"]'
      );
      if (isInModal && (
        ['confirm', 'claim', 'accept', 'yes', 'ok', 'continue'].indexOf(text) !== -1 ||
        text.includes('yes,') || text.includes('yes '))) {
        S.hasClickedConfirm = true;
        TB.handled.add(btn); btn.click();
        TB.notify('STAGE_CONFIRM', { buttonText: text });
        TB.runCurrentStage();
        return true;
      }
    }
    return false;
  };

  // ─── Stage C: Captcha ──────────────────────────────────
  TB.tryCaptcha = function () {
    if (!S.hasClickedConfirm || S.hasSolvedCaptcha) return false;
    if (S.abortSubmission) { TB.silentAbort(S.pendingSubreddit || 'unknown'); return false; }

    var captchaEl = null;
    if (TB.settings.captchaSelector) {
      try { captchaEl = document.querySelector(TB.settings.captchaSelector); } catch (e) { /* */ }
    }
    if (!captchaEl) captchaEl = TB.findMathElement(document.body);
    if (!captchaEl) return false;

    var captchaText = captchaEl.textContent.trim();
    var answer = TB.solveAddition(captchaText);
    if (answer === null) return false;

    var captchaInput = null;
    if (TB.settings.captchaInputSelector) {
      try { captchaInput = document.querySelector(TB.settings.captchaInputSelector); } catch (e) { /* */ }
    }
    if (!captchaInput) {
      var root = captchaEl.closest(
        '[role="dialog"], .modal, .dialog, .popup, .overlay, ' +
        '[class*="modal"], [class*="dialog"], [class*="captcha"], form'
      ) || document.body;
      captchaInput = root.querySelector(
        'input[type="text"], input[type="number"], input.captcha-input, ' +
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"])' +
        ':not([type="checkbox"]):not([type="radio"])'
      );
    }
    if (!captchaInput) captchaInput = document.querySelector('input[type="text"], input[type="number"]');
    if (!captchaInput) return false;

    S.hasSolvedCaptcha = true;
    TB.handled.add(captchaEl);
    TB.handled.add(captchaInput);
    TB.fillInput(captchaInput, answer);
    S.pendingCaptchaText = captchaText;
    S.pendingCaptchaAnswer = answer;
    S.storedCaptchaInput = captchaInput;

    // Find submit button
    var submitBtn = null;
    if (TB.settings.submitSelector) {
      try { submitBtn = document.querySelector(TB.settings.submitSelector); } catch (e) { /* */ }
    }
    if (!submitBtn) {
      var kws = ['submit', 'send', 'confirm', 'done', 'verify', 'ok'];
      var allBtns = TB.getAllButtons(document.body);
      for (var b = 0; b < allBtns.length; b++) {
        if (!TB.isClickableButton(allBtns[b]) || TB.handled.has(allBtns[b])) continue;
        var btnText = TB.getText(allBtns[b]);
        if (kws.some(function (kw) { return btnText.includes(kw); })) { submitBtn = allBtns[b]; break; }
      }
    }
    S.storedSubmitBtn = submitBtn;

    if (S.bbCheckCompleted) TB.finalDecision();
    return true;
  };

  // ─── Stage Router ──────────────────────────────────────
  TB.runCurrentStage = function () {
    if (!S.isEnabled || S.isVerifyingClaim || S.hasSubmittedCaptcha) return;
    if (!S.hasClickedAccept) { TB.tryAcceptTask(); return; }
    if (!S.hasClickedConfirm) { TB.tryConfirmation(); return; }
    if (!S.hasSolvedCaptcha) TB.tryCaptcha();
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
    if (S.verifyTimer) { clearTimeout(S.verifyTimer); S.verifyTimer = null; }
    if (S.bbCheckTimer) { clearTimeout(S.bbCheckTimer); S.bbCheckTimer = null; }
  };
})();
