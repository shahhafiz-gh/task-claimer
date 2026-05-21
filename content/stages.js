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

    var pendingCount = S.bulkAcceptPending > 1 ? S.bulkAcceptPending - 1 : 0;
    TB.resetState();

    if (pendingCount > 0) {
      // More tasks were bulk-accepted — move to the next modal
      S.bulkAcceptPending = pendingCount;
      console.log('[TaskBot] 🔄 Bulk mode: ' + pendingCount + ' task(s) still pending after abort');
      setTimeout(function () {
        if (!S.isEnabled) return;
        S.hasClickedAccept = true;
        TB.startWatchdog('bulk-next');
        TB.deferPostClickFromModal();
      }, 300);
    } else {
      // After abort, try to advance to next task or go back to /tasks
      setTimeout(function () {
        TB.rebuildTaskQueue();
        if (S.taskQueue.length > 0) {
          TB.advanceToNextTask();
        } else {
          TB.navigateToTasks();
        }
      }, 300);
    }
  };

  TB.silentAbort = function (subreddit) {
    console.warn('[TaskBot] 🛡️ Silent abort — r/' + subreddit + ' has BotBouncer');
    if (S.verifyTimer) { clearTimeout(S.verifyTimer); S.verifyTimer = null; }
    if (S.bbCheckTimer) { clearTimeout(S.bbCheckTimer); S.bbCheckTimer = null; }
    TB.notify('TASK_SKIPPED_BOTBOUNCER', { subreddit: subreddit });
    TB.notify('BB_LOG_ENTRY', { subreddit: subreddit, status: 'unsafe', action: 'skipped' });

    var pendingCount = S.bulkAcceptPending > 1 ? S.bulkAcceptPending - 1 : 0;

    TB.clickCancelButton().then(function () {
      S.isVerifyingClaim = false;
      TB.resetState();

      if (pendingCount > 0) {
        S.bulkAcceptPending = pendingCount;
        console.log('[TaskBot] 🔄 Bulk mode: ' + pendingCount + ' task(s) still pending after silent abort');
        setTimeout(function () {
          if (!S.isEnabled) return;
          S.hasClickedAccept = true;
          TB.startWatchdog('bulk-next');
          TB.deferPostClickFromModal();
        }, 300);
      } else {
        TB.advanceToNextTask();
      }
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

    var pendingCount = S.bulkAcceptPending > 1 ? S.bulkAcceptPending - 1 : 0;
    TB.resetState();

    if (pendingCount > 0) {
      // More tasks were bulk-accepted — check for more modals
      S.bulkAcceptPending = pendingCount;
      console.log('[TaskBot] 🔄 Bulk mode: ' + pendingCount + ' task(s) still pending');
      setTimeout(function () {
        if (!S.isEnabled) return;
        S.hasClickedAccept = true;
        TB.startWatchdog('bulk-next');
        TB.deferPostClickFromModal();
      }, 500);
    } else {
      // All done — navigate back to tasks page
      setTimeout(function () {
        TB.navigateToTasks();
      }, 800);
    }
  };

  // ─── Navigate to Tasks Page (new dashboard sidebar) ────
  TB.navigateToTasks = function () {
    // New dashboard sidebar selectors (current UI)
    var TASKS_SELECTORS = [
      'a[href="/tasks"]',                    // direct link
      'a[href*="/tasks"]',                   // partial match
      'nav a[href="/tasks"]',                // inside nav
      '[class*="sidebar"] a[href="/tasks"]', // sidebar nav
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
    // Fallback: direct navigation
    console.log('[TaskBot] 🔄 Navigating to /tasks via URL');
    window.location.href = '/tasks';
  };

  // ─── Schedule Rescan After Navigation ──────────────────
  // After SPA navigation, the DOM may update asynchronously.
  // We schedule multiple rescans to catch newly rendered tasks.
  TB.scheduleRescan = function () {
    var delays = [500, 1000, 2000, 3000, 5000];
    for (var i = 0; i < delays.length; i++) {
      (function (delay) {
        setTimeout(function () {
          if (!S.isEnabled) return;
          if (S.hasClickedAccept || S.isVerifyingClaim || S.hasSubmittedCaptcha) return;
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
      // Match various accept/claim button texts from the new dashboard UI
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
        if (S.taskQueue.length > 0) {
          TB.runCurrentStage();
        } else {
          // No more tasks on this page — navigate back and keep monitoring
          console.log('[TaskBot] 🔄 No more tasks in queue, navigating to /tasks to keep monitoring');
          TB.navigateToTasks();
        }
      }
    }, 500);
  };

  // ─── Stage A: Accept Task (Bulk) ────────────────────────
  TB.tryAcceptTask = function () {
    // WS bot is authenticated — it handles all claiming via WebSocket. Stand down.
    if (document.documentElement.getAttribute('data-ws-active') === 'true') return;
    if (S.hasClickedAccept) return false;
    if (S.taskQueue.length === 0 || S.taskQueueIndex >= S.taskQueue.length) {
      TB.rebuildTaskQueue();
    }

    // Collect ALL clickable accept buttons
    var clickable = [];
    for (var i = S.taskQueueIndex; i < S.taskQueue.length; i++) {
      var candidate = S.taskQueue[i];
      if (!TB.handled.has(candidate) && TB.isClickableButton(candidate)) {
        clickable.push(candidate);
      }
    }
    if (clickable.length === 0) return false;

    S.hasClickedAccept = true;

    // Click ALL accept buttons at once
    for (var c = 0; c < clickable.length; c++) {
      TB.handled.add(clickable[c]);
      clickable[c].click();
      console.log('[TaskBot] ⚡ Accept clicked (' + (c + 1) + '/' + clickable.length + ') — "' + TB.getText(clickable[c]) + '"');
    }

    S.bulkAcceptPending = clickable.length;
    console.log('[TaskBot] ⚡ Bulk-clicked ' + clickable.length + ' accept button(s) simultaneously');

    TB.startWatchdog('accept');
    // Pre-warm BB cache for all subreddits
    TB.preWarmBBCache(clickable);
    // Full post-click processing for the first button
    TB.deferPostClick(clickable[0]);
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
        TB.startWatchdog('confirm');
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
        TB.startWatchdog('confirm');
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
    TB.instantInject(captchaInput, answer);
    console.log('[TaskBot] 🔢 Solved Math: ' + captchaText + ' = ' + answer);
    TB.notify('PUSH_LOG', { level: 'info', message: '🔢 Solved Math: ' + captchaText + ' = ' + answer });
    S.pendingCaptchaText = captchaText;
    S.pendingCaptchaAnswer = answer;
    S.storedCaptchaInput = captchaInput;

    // Find submit button (store for later)
    var submitBtn = null;
    if (TB.settings.submitSelector && TB.settings.submitSelector.trim()) {
      try {
        submitBtn = document.querySelector(TB.settings.submitSelector);
      } catch (e) {
        console.warn('[TaskBot] Invalid submitSelector:', e.message);
      }
    }
    if (!submitBtn) {
      // STRICT SEARCH: We must find the FINAL submit button, NOT the "Yes, accept" button!
      var btns = TB.getAllButtons(document.body);
      for (var i = 0; i < btns.length; i++) {
        var btn = btns[i];
        if (!TB.isClickableButton(btn)) continue;
        if (TB.handled.has(btn)) continue;
        var text = TB.getText(btn);
        
        // CRITICAL: Exclude Stage 2 confirmation buttons
        if (text.includes('yes') || text === 'accept' || text === 'claim') continue;
        
        // Check for Stage 4 final submission keywords
        // Put "verify & accept" first for fastest match
        var submitKeywords = ['verify & accept', 'verify and accept', 'submit', 'send', 'done', 'verify', 'ok', 'confirm'];
        if (submitKeywords.some(function (kw) { return text.includes(kw); })) {
          submitBtn = btn;
          console.log("[TaskBot] 🎯 Found FINAL submit button: \"" + text + "\"");
          break;
        }
      }
    }
    S.storedSubmitBtn = submitBtn;
    if (submitBtn) {
      TB.notify('PUSH_LOG', { level: 'info', message: '🎯 Found FINAL submit button: "' + TB.getText(submitBtn) + '"' });
    } else {
      console.warn('[TaskBot] ⚠️ Could not find final submit button!');
      TB.notify('PUSH_LOG', { level: 'warn', message: '⚠️ Could not find final submit button!' });
    }
    
    // ── THE PARALLEL SPRINT ──
    // This website ALWAYS uses Turnstile. Force Capsolver to fire immediately!
    S.turnstileDetected = true;
    S.turnstileCompleted = false;

    // 1. Start watching the DOM natively (in case auto-verify beats Capsolver)
    TB.monitorTurnstile();

    // 2. FIRE CAPSOLVER! (Runs in parallel with native Turnstile)
    TB.fireCapsolverAndInject();

    // ── Now decide: submit or wait ──
    if (S.bbCheckCompleted && S.turnstileCompleted) {
      TB.finalDecision();
    }
    return true;
  };

  // ─── Turnstile Monitoring (BLITZ SYSTEM) ───────────────
  TB.monitorTurnstile = function () {
    if (S.turnstileTimer) clearInterval(S.turnstileTimer);
    TB.startWatchdog('turnstile-wait', 35000);
    console.log('[TaskBot] ⚡ Blitz System initialized for Turnstile');
    TB.notify('PUSH_LOG', { level: 'info', message: '⚡ Blitz System initialized for Turnstile' });

    var responseInput = document.querySelector('input[name="cf-turnstile-response"]');
    var pollCount = 0;
    var hasClicked = false;
    var MAX_POLLS = 300; // 30 seconds at 100ms

    // Step 3: Success/Failure Monitoring (The Toast Observer)
    function startToastObserver() {
      var successKeywords = ['success', 'claimed', 'completed', 'accepted'];
      var failureKeywords = ['error', 'already claimed', 'failed', 'expired'];

      var observer = new MutationObserver(function(mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var mutation = mutations[i];
          for (var j = 0; j < mutation.addedNodes.length; j++) {
            var node = mutation.addedNodes[j];
            if (node.nodeType === Node.ELEMENT_NODE) {
              var text = (node.textContent || '').toLowerCase().trim();
              if (!text || text.length > 300) continue;

              for (var s = 0; s < successKeywords.length; s++) {
                if (text.includes(successKeywords[s])) {
                  console.log('[TaskBot] ✅ Blitz Observer: Success detected ("' + successKeywords[s] + '")');
                  TB.notify('PUSH_LOG', { level: 'info', message: '✅ Blitz Success: ' + text.substring(0, 50) });
                  TB.confirmClaimSuccess();
                  observer.disconnect();
                  return;
                }
              }
              for (var f = 0; f < failureKeywords.length; f++) {
                if (text.includes(failureKeywords[f])) {
                  console.warn('[TaskBot] ❌ Blitz Observer: Failure detected ("' + failureKeywords[f] + '")');
                  TB.notify('PUSH_LOG', { level: 'error', message: '❌ Blitz Failure: ' + text.substring(0, 50) });
                  TB.abortClaim('Blitz Failure: ' + text.substring(0, 30));
                  observer.disconnect();
                  return;
                }
              }
            }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      return observer;
    }

    S.turnstileTimer = setInterval(function () {
      pollCount++;

      // Managed challenge click logic (fallback for non-auto solving Turnstiles)
      if (!hasClicked && pollCount === 8) { // 800ms
        hasClicked = true;
        TB.tryClickTurnstile();
      }
      if (hasClicked && pollCount === 30 && (!responseInput || responseInput.value.length < 20)) { // 3s
        TB.tryClickTurnstile();
      }

      if (!responseInput) {
        responseInput = document.querySelector('input[name="cf-turnstile-response"]');
      }

      // Step 1: Detect Turnstile Completion (The "Green" Signal)
      if (responseInput && responseInput.value && responseInput.value.length > 20) {
        clearInterval(S.turnstileTimer);
        S.turnstileTimer = null;
        S.turnstileCompleted = true;
        console.log('[TaskBot] ⚡ Blitz Signal: Turnstile token ready!:', responseInput);
        
        // BB Check Guard
        if (TB.settings.botBouncerCheckEnabled) {
          if (S.abortSubmission || (S.bbCheckCompleted && !S.bbCheckResult)) {
            console.warn('[TaskBot] 🛡️ Blitz: BB Check failed. Aborting Blitz submission.');
            TB.silentAbort(S.pendingSubreddit || 'unknown');
            return;
          }
          if (!S.bbCheckCompleted) {
            console.warn('[TaskBot] ⏱️ Blitz: BB Check not yet completed! Deferring to finalDecision.');
            TB.finalDecision();
            return;
          }
        }

        // Start observer immediately before clicking
        startToastObserver();

        // Step 2: The "Pre-emptive" Button Search
        var submitBtn = S.storedSubmitBtn;
        if (!submitBtn || !TB.isClickableButton(submitBtn)) {
          var allBtns = TB.getAllButtons(document.body);
          for (var i = 0; i < allBtns.length; i++) {
            if (TB.isClickableButton(allBtns[i])) {
              var text = TB.getText(allBtns[i]);
              if (text.includes('verify') || text.includes('submit') || text.includes('accept') || text.includes('claim')) {
                submitBtn = allBtns[i];
                break;
              }
            }
          }
        }

        S.hasSubmittedCaptcha = true;
        S.isVerifyingClaim = true;

        if (submitBtn) {
          console.log('[TaskBot] ⚡ Blitz: Clicking pre-located submit button NOW!');
          TB.handled.add(submitBtn);
          submitBtn.click();
        } else {
          console.warn('[TaskBot] ⚠️ Blitz: Submit button missing, simulating enter on input.');
          TB.simulateEnter(responseInput);
        }
        
        // Fallback verify timer in case toast observer doesn't catch it
        S.verifyTimer = setTimeout(function () {
          S.verifyTimer = null;
          if (!S.isVerifyingClaim) return;
          console.log('[TaskBot] ⏱️ Blitz Verify timeout — no success signal. Aborting claim.');
          TB.silentAbort(S.pendingSubreddit || 'unknown');
        }, 4000);

      } else if (pollCount >= MAX_POLLS) {
        clearInterval(S.turnstileTimer);
        S.turnstileTimer = null;
        TB.notify('PUSH_LOG', {
          level: 'warn',
          message: '⏱️ Cloudflare Turnstile timed out — aborting claim',
        });
        TB.abortClaim('Turnstile verification timed out');
      }
    }, 200);
  };

  // ─── Stage Watchdog ────────────────────────────────────
  // If we're stuck in any intermediate stage (accept clicked but no confirm,
  // confirm clicked but no captcha, etc.) for more than WATCHDOG_TIMEOUT_MS,
  // force-reset and resume monitoring. This prevents the bot from going
  // permanently dead when a claim attempt silently fails.
  var WATCHDOG_TIMEOUT_MS = 12000; // 12 seconds max per stage

  TB.startWatchdog = function (stageName, timeoutMs) {
    TB.clearWatchdog();
    S.lastStageTransition = Date.now();
    var timeout = timeoutMs || WATCHDOG_TIMEOUT_MS;
    S.stageWatchdog = setTimeout(function () {
      S.stageWatchdog = null;
      // Only fire if we're still in an intermediate state
      if (!S.isEnabled) return;
      if (S.hasSubmittedCaptcha || S.isVerifyingClaim) return; // these have their own timeouts
      console.warn('[TaskBot] ⏰ WATCHDOG — stuck in stage "' + stageName + '" for ' + timeout + 'ms, force-resetting');
      TB.notify('PUSH_LOG', {
        level: 'warn',
        message: '⏰ Watchdog reset — stuck at "' + stageName + '" stage, resuming monitoring',
      });

      var pendingCount = S.bulkAcceptPending > 1 ? S.bulkAcceptPending - 1 : 0;
      S.isVerifyingClaim = false;
      TB.resetState();

      if (pendingCount > 0) {
        // Still have bulk tasks pending — try next modal
        S.bulkAcceptPending = pendingCount;
        console.log('[TaskBot] 🔄 Watchdog: ' + pendingCount + ' bulk task(s) still pending');
        setTimeout(function () {
          if (!S.isEnabled) return;
          S.hasClickedAccept = true;
          TB.startWatchdog('bulk-next');
          TB.deferPostClickFromModal();
        }, 300);
      } else {
        // Navigate back to tasks to keep monitoring
        setTimeout(function () {
          TB.rebuildTaskQueue();
          if (S.taskQueue.length > 0) {
            TB.runCurrentStage();
          } else {
            TB.navigateToTasks();
          }
        }, 300);
      }
}, timeout);
  };

  TB.clearWatchdog = function () {
    if (S.stageWatchdog) { clearTimeout(S.stageWatchdog); S.stageWatchdog = null; }
  };

  // ─── Stage Router ──────────────────────────────────────
  TB.runCurrentStage = function () {
    // Double-guard: check both the state flag AND the synchronous DOM attribute
    // that the MAIN world interceptor sets immediately (no postMessage lag).
    if (S.isWSClaiming || document.documentElement.getAttribute('data-ws-claiming') === 'true') return;
    if (!S.isEnabled || S.isVerifyingClaim || S.hasSubmittedCaptcha) return;
    if (!S.hasClickedAccept) { TB.tryAcceptTask(); return; }
    if (!S.hasClickedConfirm) { TB.tryConfirmation(); return; }
    if (!S.hasSolvedCaptcha) TB.tryCaptcha();
  };

  TB.resetState = function () {
    S.isWSClaiming = false;
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
    if (S.turnstileTimer) { clearInterval(S.turnstileTimer); S.turnstileTimer = null; }
    S.lastStageTransition = 0;
    if (S.verifyTimer) { clearTimeout(S.verifyTimer); S.verifyTimer = null; }
    if (S.bbCheckTimer) { clearTimeout(S.bbCheckTimer); S.bbCheckTimer = null; }
    TB.clearWatchdog();
  };
})();
