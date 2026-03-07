/**
 * Content Script — Task Auto Claimer v5 — "Accept First, Verify Later"
 *
 * Architecture:
 *   ONE MutationObserver watching document.body
 *   Observes: childList + subtree + attributes (style/class/hidden)
 *   Every mutation triggers stage checks:
 *     A) "Accept Task" button → click IMMEDIATELY, fire BB check in parallel
 *     B) Confirmation button (Yes accept / Yes claim / Confirm)
 *     C) Captcha text + input → solve + HOLD submission
 *     D) Final decision: submit if safe, abort if unsafe
 *     E) Error/toast detection — abort if task was already claimed
 *
 * New Flow ("Accept First, Verify Later"):
 *   1. Task appears → Click Accept IMMEDIATELY (<50ms)
 *   2. Extract subreddit, fire background BB check (async)
 *   3. Solve captcha, store solved value (DON'T submit)
 *   4. When BB result arrives:
 *      - Safe → submit captcha
 *      - Unsafe → silently abort
 *      - Timeout → configurable (submit or abort)
 *   5. Log result in popup panel
 *   6. Cache for next time
 *
 * Zero polling. Zero setInterval. Fully event-driven.
 * Target reaction time: < 50ms to click Accept.
 */

(() => {
    'use strict';

    console.log('[TaskBot] 🚀 Content script v5 loaded — "Accept First, Verify Later"');

    // ─── State ───────────────────────────────────────────────────────
    let observer = null;
    let isEnabled = false;

    // Stage flags — prevent duplicate clicks/submissions per cycle
    let hasClickedAccept = false;
    let hasClickedConfirm = false;
    let hasSolvedCaptcha = false;   // captcha solved but NOT submitted
    let hasSubmittedCaptcha = false; // captcha actually submitted

    // Verification state — wait after captcha to confirm success
    let isVerifyingClaim = false;
    let verifyTimer = null;
    let pendingCaptchaText = null;
    let pendingCaptchaAnswer = null;

    // ─── NEW: Parallel BB Check State ────────────────────────────────
    let pendingSubreddit = null;     // subreddit for current task
    let bbCheckCompleted = false;    // whether BB check has returned
    let bbCheckResult = true;        // true = safe, false = unsafe
    let abortSubmission = false;     // set true if BB found
    let bbCheckTimer = null;         // timeout timer for BB check

    // Stored captcha elements for deferred submission
    let storedCaptchaInput = null;
    let storedSubmitBtn = null;

    // WeakSet to track already-handled elements (extra safety)
    const handledElements = new WeakSet();

    // Track the current subreddit being claimed for logging
    let currentSubreddit = null;

    // ─── Task Queue — iterate ALL visible task cards ──────────────────
    // Rebuilt whenever we start scanning. We walk through it in order,
    // skipping tasks that have already been handled (WeakSet).
    let taskQueue = [];        // Array of Accept-Task buttons found on page
    let taskQueueIndex = 0;   // Index of the next task to try
    let isAdvancing = false;  // guard against re-entrant advanceToNextTask

    // Mutation counter for diagnostics
    let mutationCount = 0;


    let settings = {
        claimSelector: '',
        captchaSelector: '',
        captchaInputSelector: '',
        submitSelector: '',
        soundEnabled: true,
        delayMs: 0,
        safeModeEnabled: false,
        botBouncerCheckEnabled: true,
        bbCheckTimeoutMs: 10000,     // max wait for BB check (10s — generous, always aborts on timeout)
        bbTimeoutAction: 'abort',    // STRICT: always abort on timeout, never submit without green signal
        bbCacheDurationMs: 30 * 60 * 1000, // 30 minutes
        maxParallelChecks: 2,
    };

    // ─── Error Toast / Failure Detection ─────────────────────────────
    /**
     * STRICT error patterns — only things that DEFINITELY mean the task
     * claim failed. Removed vague patterns like 'called by client',
     * 'expired', 'someone else', 'not available' which cause false
     * positives on pages like earntask.io that have those words in
     * normal page content.
     */
    const ERROR_TOAST_PATTERNS = [
        'already claimed',
        'already been claimed',
        'called by client',          // earntask.io specific — "error called by client"
        'task is no longer available',
        'task unavailable',
        'task has been taken',
        'error claiming',
        'failed to claim',
        'claim failed',
        'task was claimed',
        'unable to claim',
        'cannot claim',
        // Comment/reply/post not found — earntask.io throws these as toast errors
        'comment not found',
        'reply not found',
        'post not found',
        'post deleted',
        'not found',
        'no longer exists',
        'does not exist',
        'content removed',
        'deleted',
    ];

    /**
     * Selectors for toast/snackbar containers — these are the ONLY
     * elements we check for error text. We do NOT scan all added nodes.
     */
    const TOAST_SELECTORS = [
        '[class*="toast"]', '[class*="Toast"]',
        '[class*="snackbar"]', '[class*="Snackbar"]',
        '[role="alert"]',
        '.ant-message', '.ant-notification',
        '.MuiSnackbar-root', '.MuiAlert-root',
        '[class*="flash"]', '[class*="notice"]',
    ];

    function detectErrorToast() {
        for (const selector of TOAST_SELECTORS) {
            try {
                const els = document.querySelectorAll(selector);
                for (const el of els) {
                    const text = (el.textContent || '').toLowerCase().trim();
                    if (!text || text.length > 300) continue; // skip large containers
                    for (const pattern of ERROR_TOAST_PATTERNS) {
                        if (text.includes(pattern)) {
                            const style = window.getComputedStyle(el);
                            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                                console.warn(`[TaskBot] 🚨 Error toast matched: "${pattern}" in element:`, el.tagName, el.className);
                                return text;
                            }
                        }
                    }
                }
            } catch (e) { /* selector might be invalid */ }
        }
        return null;
    }

    /**
     * Check newly added mutation nodes for error toasts.
     * STRICT: Only checks nodes that MATCH a toast selector.
     * Does NOT blindly scan all added nodes — that causes false positives
     * when normal page content (task descriptions, etc.) contains error-like words.
     */
    function checkMutationsForErrorToast(mutations) {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;

                // Only check this node if it matches a known toast selector
                let isToastElement = false;
                for (const selector of TOAST_SELECTORS) {
                    try {
                        if (node.matches && node.matches(selector)) {
                            isToastElement = true;
                            break;
                        }
                        // Also check if any child matches a toast selector
                        if (node.querySelector && node.querySelector(selector)) {
                            isToastElement = true;
                            break;
                        }
                    } catch (e) { /* invalid selector */ }
                }

                if (!isToastElement) continue; // Skip non-toast nodes entirely

                const text = (node.textContent || '').toLowerCase().trim();
                if (!text || text.length > 300) continue; // skip large containers

                for (const pattern of ERROR_TOAST_PATTERNS) {
                    if (text.includes(pattern)) {
                        try {
                            const style = window.getComputedStyle(node);
                            if (style.display !== 'none' && style.visibility !== 'hidden') {
                                console.warn(`[TaskBot] 🚨 Error toast in mutation: "${pattern}" in`, node.tagName, node.className);
                                return text;
                            }
                        } catch (e) { /* node may have been removed */ }
                    }
                }
            }
        }
        return null;
    }

    // ─── Abort Claim ─────────────────────────────────────────────────
    function abortClaim(reason) {
        console.warn(`[TaskBot] ❌ ABORT — ${reason}`);

        if (verifyTimer) {
            clearTimeout(verifyTimer);
            verifyTimer = null;
        }
        if (bbCheckTimer) {
            clearTimeout(bbCheckTimer);
            bbCheckTimer = null;
        }

        notifyBackground('TASK_CLAIM_FAILED', {
            reason,
            subreddit: currentSubreddit,
        });

        isVerifyingClaim = false;
        resetState();
        // Move on to the next task in queue instead of stopping
        advanceToNextTask();
    }

    /**
     * Silently abort — used when BB detects unsafe subreddit.
     * Clicks Cancel in any open confirmation modal, then moves to next task.
     */
    function silentAbort(subreddit) {
        console.warn(`[TaskBot] 🛡️ Silent abort — r/${subreddit} has BotBouncer`);

        if (verifyTimer) {
            clearTimeout(verifyTimer);
            verifyTimer = null;
        }
        if (bbCheckTimer) {
            clearTimeout(bbCheckTimer);
            bbCheckTimer = null;
        }

        notifyBackground('TASK_SKIPPED_BOTBOUNCER', { subreddit });

        // Log BB result
        notifyBackground('BB_LOG_ENTRY', {
            subreddit,
            status: 'unsafe',
            action: 'skipped',
        });

        // ── Click Cancel/No to dismiss any open confirmation dialog ──
        clickCancelButton().then(() => {
            isVerifyingClaim = false;
            resetState();
            // Move on to the next task in queue
            advanceToNextTask();
        });
    }

    /**
     * Find and click the Cancel / No / Close button in any open modal or dialog.
     * Called during silentAbort so the confirmation dialog is cleanly dismissed
     * before the bot moves on to the next task card.
     */
    function clickCancelButton(maxRetries = 10, intervalMs = 200) {
        return new Promise((resolve) => {
            let attempt = 0;

            function tryClick() {
                // Priority 1: look inside a visible modal/dialog first
                const MODAL_SELECTORS = [
                    '[role="dialog"]', '[role="alertdialog"]',
                    '.modal', '.dialog', '.popup', '.overlay',
                    '[class*="modal"]', '[class*="dialog"]',
                    '[class*="popup"]', '[class*="confirm"]',
                ];

                const CANCEL_TEXT = ['cancel', 'no', 'close', 'dismiss', 'deny', 'back'];

                // Try inside modals first
                for (const modalSel of MODAL_SELECTORS) {
                    let modals;
                    try { modals = document.querySelectorAll(modalSel); } catch (e) { continue; }
                    for (const modal of modals) {
                        try {
                            const style = window.getComputedStyle(modal);
                            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
                        } catch (e) { continue; }

                        const btns = modal.querySelectorAll('button, [role="button"]');
                        for (const btn of btns) {
                            if (!isClickableButton(btn)) continue;
                            const text = getText(btn);
                            if (CANCEL_TEXT.includes(text) || CANCEL_TEXT.some(t => text.startsWith(t))) {
                                console.log(`[TaskBot] 🚫 Clicking Cancel in modal: "${getText(btn)}"`);
                                handledElements.add(btn);
                                btn.click();
                                return true; // done
                            }
                        }
                    }
                }

                // Priority 2: fall back to any visible cancel-like button on the page
                const allBtns = getAllButtons(document.body);
                for (const btn of allBtns) {
                    if (handledElements.has(btn)) continue;
                    if (!isClickableButton(btn)) continue;
                    const text = getText(btn);
                    if (CANCEL_TEXT.includes(text) || CANCEL_TEXT.some(t => text.startsWith(t))) {
                        console.log(`[TaskBot] 🚫 Clicking Cancel (page-level): "${getText(btn)}"`);
                        handledElements.add(btn);
                        btn.click();
                        return true;
                    }
                }

                return false;
            }

            function attemptLoop() {
                if (tryClick()) {
                    resolve(true);
                } else {
                    attempt++;
                    if (attempt < maxRetries) {
                        setTimeout(attemptLoop, intervalMs);
                    } else {
                        console.log(`[TaskBot] ℹ️ No Cancel button found to click after ${maxRetries} attempts — modal may not be open yet.`);
                        resolve(false);
                    }
                }
            }

            attemptLoop();
        });
    }

    // ─── View Task Detection (Positive Success Signal) ───────────────
    const SUCCESS_TEXTS = [
        'task accepted with this account',
        "you've already accepted this task"
    ];

    function detectSuccessSignal() {
        // 1. Check for success text on the page directly
        const bodyText = (document.body.textContent || '').toLowerCase();
        for (const st of SUCCESS_TEXTS) {
            if (bodyText.includes(st)) return true;
        }

        return false;
    }

    function checkMutationsForSuccessSignal(mutations) {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                const text = (node.textContent || '').toLowerCase().trim();

                for (const st of SUCCESS_TEXTS) {
                    if (text.includes(st)) return true;
                }
            }
        }
        return false;
    }

    function confirmClaimSuccess() {
        if (verifyTimer) {
            clearTimeout(verifyTimer);
            verifyTimer = null;
        }

        isVerifyingClaim = false;
        console.log(`[TaskBot] ✅ Claim VERIFIED — "View Task" button detected!`);

        notifyBackground('TASK_CLAIMED', {
            captchaExpression: pendingCaptchaText,
            captchaAnswer: pendingCaptchaAnswer,
            subreddit: currentSubreddit,
        });

        // Log BB result as safe + claimed
        if (currentSubreddit) {
            notifyBackground('BB_LOG_ENTRY', {
                subreddit: currentSubreddit,
                status: 'safe',
                action: 'claimed',
            });
        }

        resetState();

        // Automatically navigate back to the tasks list after 1 second
        setTimeout(() => {
            const tasksLink = document.querySelector('nav a[href="/tasks"]') || document.querySelector('a[href="/tasks"]');
            if (tasksLink) {
                console.log('[TaskBot] 🔄 Redirecting to active tasks list...');
                tasksLink.click();
            } else {
                console.log('[TaskBot] 🔄 Tasks link not found in navbar, navigating directly...');
                window.location.href = '/tasks';
            }
        }, 1000);
    }

    // ─── Captcha Solver ──────────────────────────────────────────────
    function solveAddition(text) {
        if (!text || typeof text !== 'string') return null;
        const match = text.match(/(\d+)\s*\+\s*(\d+)/);
        if (!match) return null;
        const a = parseInt(match[1], 10);
        const b = parseInt(match[2], 10);
        if (isNaN(a) || isNaN(b)) return null;
        return a + b;
    }

    // ─── DOM Helpers ─────────────────────────────────────────────────
    function isClickableButton(el) {
        if (!el) return false;
        if (el.disabled) return false;
        if (el.getAttribute('aria-disabled') === 'true') return false;
        try {
            const style = window.getComputedStyle(el);
            if (style.display === 'none') return false;
            if (style.visibility === 'hidden') return false;
            if (style.opacity === '0') return false;
            if (el.offsetParent === null && style.position !== 'fixed' && style.position !== 'sticky') return false;
        } catch (e) {
            return false;
        }
        return true;
    }

    function getText(el) {
        return (el.textContent || el.value || el.innerText || '').trim().toLowerCase();
    }

    function fillInput(input, value) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
        );
        if (nativeInputValueSetter && nativeInputValueSetter.set) {
            nativeInputValueSetter.set.call(input, String(value));
        } else {
            input.value = String(value);
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function simulateEnter(element) {
        const opts = {
            key: 'Enter', code: 'Enter',
            keyCode: 13, which: 13, bubbles: true,
        };
        element.dispatchEvent(new KeyboardEvent('keydown', opts));
        element.dispatchEvent(new KeyboardEvent('keypress', opts));
        element.dispatchEvent(new KeyboardEvent('keyup', opts));
    }

    function getAllButtons(root) {
        return root.querySelectorAll('button, [role="button"], a.btn, input[type="button"], input[type="submit"]');
    }

    // ─── Subreddit Extraction ────────────────────────────────────────
    function extractSubredditFromTaskCard(button) {
        if (!button) return null;
        const subredditRegex = /\/r\/([a-zA-Z0-9_]+)/i;
        const cardSelectors = [
            '[class*="task"]', '[class*="card"]', '[class*="item"]',
            '[class*="row"]', '[class*="job"]', '[class*="listing"]',
            'tr', 'li', 'article', 'section',
            '[role="listitem"]', '[role="row"]',
        ];
        let searchRoot = null;
        for (const sel of cardSelectors) {
            const container = button.closest(sel);
            if (container) { searchRoot = container; break; }
        }
        if (!searchRoot) {
            searchRoot = button;
            for (let i = 0; i < 6 && searchRoot.parentElement; i++) {
                searchRoot = searchRoot.parentElement;
            }
        }

        // 1. Look for explicit links containing /r/ (e.g., href="https://old.reddit.com/r/startups")
        const links = searchRoot.querySelectorAll('a[href*="/r/"]');
        for (const link of links) {
            const match = link.href.match(subredditRegex);
            if (match) return match[1].toLowerCase();
        }

        // 2. Check individual leaf nodes to avoid textContent concatenation issues 
        // (e.g. <span>Reddit Post</span><span>r/startups</span> becomes "Reddit Postr/startups")
        const allElements = searchRoot.querySelectorAll('*');
        for (const el of allElements) {
            if (el.children.length === 0) {
                const text = (el.textContent || '').trim();
                // Match exact "r/subreddit" or containing spaces " r/subreddit "
                const match = text.match(/(?:^|\s)r\/([a-zA-Z0-9_]+)(?:\s|$)/i);
                if (match) return match[1].toLowerCase();
            }
        }

        // 3. Look at innerHTML to easily find >r/subreddit< regardless of element structure
        const innerHTML = searchRoot.innerHTML || '';
        const htmlMatch = innerHTML.match(/(?:>|\s|'|")r\/([a-zA-Z0-9_]+)(?=<|\s|'|")/i);
        if (htmlMatch) return htmlMatch[1].toLowerCase();

        // 4. Fallback: full textContent with boundaries
        const textContent = searchRoot.textContent || '';
        const textMatch = textContent.match(/\br\/([a-zA-Z0-9_]+)\b/i);
        if (textMatch) return textMatch[1].toLowerCase();

        // 5. Fallback: very permissive regex, look for anything that looks like "r/subreddit" 
        // that's preceded by non-word characters or lowercased words accidentally mashed.
        // We use {3,21} as reasonably sized subreddit names to prevent false positives.
        const blindTextMatch = textContent.match(/r\/([a-zA-Z0-9_]{3,21})/i);
        if (blindTextMatch) return blindTextMatch[1].toLowerCase();

        // 6. Global sweep of all links on page if everything else fails
        const allLinks = document.querySelectorAll('a[href*="/r/"]');
        for (const link of allLinks) {
            const match = link.href.match(subredditRegex);
            if (match) return match[1].toLowerCase();
        }

        return null;
    }

    // ─── BotBouncer Background Check (Fire & Forget) ─────────────────
    function fireBBCheck(subreddit) {
        console.log(`[BotBouncer] 🔍 Firing parallel check for r/${subreddit}...`);

        notifyBackground('BB_LOG_ENTRY', {
            subreddit,
            status: 'pending',
            action: 'checking',
        });

        try {
            chrome.runtime.sendMessage(
                { type: 'CHECK_BOTBOUNCER', payload: { subreddit } },
                (response) => {
                    if (chrome.runtime.lastError) {
                        console.warn('[BotBouncer] Runtime error:', chrome.runtime.lastError.message);
                        handleBBResult(subreddit, false, chrome.runtime.lastError.message);
                        return;
                    }
                    const result = response || { safe: false };
                    handleBBResult(subreddit, result.safe);
                }
            );
        } catch (err) {
            console.warn('[BotBouncer] sendMessage error:', err.message);
            handleBBResult(subreddit, false, err.message);
        }
    }

    function handleBBResult(subreddit, safe, error) {
        // ── Log the result so the BB Logs panel updates from "Pending" ──
        notifyBackground('BB_LOG_ENTRY', {
            subreddit,
            status: safe ? 'safe' : 'unsafe',
            action: safe ? 'confirmed_safe' : (error ? 'check_error' : 'bb_detected'),
        });

        if (pendingSubreddit !== subreddit) {
            console.log(`[BotBouncer] Result for r/${subreddit} arrived but task changed — ignoring`);
            return;
        }

        bbCheckCompleted = true;
        bbCheckResult = safe;

        if (bbCheckTimer) {
            clearTimeout(bbCheckTimer);
            bbCheckTimer = null;
        }

        if (safe) {
            console.log(`[BotBouncer] ✅ r/${subreddit} is SAFE`);
        } else {
            console.warn(`[BotBouncer] ⛔ r/${subreddit} is UNSAFE — BotBouncer detected`);
            abortSubmission = true;
        }

        if (hasSolvedCaptcha && !hasSubmittedCaptcha) {
            finalDecision();
        }
    }

    // ─── Final Decision: Submit or Abort ─────────────────────────────
    /**
     * STRICT BB ENFORCEMENT:
     *   - ONLY submit if bbCheckCompleted === true AND bbCheckResult === true (explicitly safe)
     *   - If BB check not completed yet → DO NOTHING (keep waiting)
     *   - If BB check completed but unsafe → ABORT
     *   - If BB check timed out → ABORT (never submit without green signal)
     *   - If BB check errored → already set safe=false, so ABORT
     */
    function finalDecision() {
        if (hasSubmittedCaptcha) return;
        if (!hasSolvedCaptcha) return;

        // If BB protection is disabled entirely, submit freely
        if (!settings.botBouncerCheckEnabled) {
            console.log(`[TaskBot] 🔓 BB check disabled — submitting captcha`);
            submitCaptcha();
            return;
        }

        // STRICT: If abort flag is set (BB detected), abort immediately
        if (abortSubmission) {
            console.warn(`[TaskBot] 🛡️ STRICT ABORT — BotBouncer detected in r/${pendingSubreddit}`);
            silentAbort(pendingSubreddit || 'unknown');
            return;
        }

        // STRICT: ONLY submit if we have EXPLICIT confirmation that subreddit is safe
        if (bbCheckCompleted === true && bbCheckResult === true) {
            console.log(`[TaskBot] ✅ BB check CONFIRMED SAFE for r/${pendingSubreddit} — submitting captcha`);
            submitCaptcha();
            return;
        }

        // BB check completed but result is NOT safe (error, HTTP failure, etc.)
        if (bbCheckCompleted === true && bbCheckResult !== true) {
            console.warn(`[TaskBot] 🛡️ STRICT ABORT — BB check completed but NOT safe for r/${pendingSubreddit}`);
            notifyBackground('BB_LOG_ENTRY', {
                subreddit: pendingSubreddit,
                status: 'unsafe',
                action: 'aborted_not_safe',
            });
            silentAbort(pendingSubreddit || 'unknown');
            return;
        }

        // BB check NOT completed yet — this is the timeout path
        // STRICT: ALWAYS abort on timeout. NEVER submit without green signal.
        if (!bbCheckCompleted) {
            console.warn(`[TaskBot] ⏱️ STRICT ABORT — BB check timed out for r/${pendingSubreddit}. Will NOT submit.`);
            notifyBackground('BB_LOG_ENTRY', {
                subreddit: pendingSubreddit,
                status: 'timeout',
                action: 'aborted_timeout_strict',
            });
            silentAbort(pendingSubreddit || 'unknown');
            return;
        }
    }

    function submitCaptcha() {
        if (hasSubmittedCaptcha) return;

        // ── LAST SAFETY GATE: Double-check BB state before submitting ──
        if (settings.botBouncerCheckEnabled) {
            if (!bbCheckCompleted) {
                console.error('[TaskBot] 🚫 BLOCKED — Tried to submit but BB check not completed! Waiting...');
                return; // DO NOT submit
            }
            if (bbCheckResult !== true) {
                console.error('[TaskBot] 🚫 BLOCKED — Tried to submit but BB result is NOT safe! Aborting...');
                silentAbort(pendingSubreddit || 'unknown');
                return; // DO NOT submit
            }
            if (abortSubmission) {
                console.error('[TaskBot] 🚫 BLOCKED — abortSubmission flag is set! Aborting...');
                silentAbort(pendingSubreddit || 'unknown');
                return; // DO NOT submit
            }
        }

        hasSubmittedCaptcha = true;
        console.log(`[TaskBot] 📤 SUBMITTING captcha — BB confirmed safe for r/${pendingSubreddit || 'unknown'}`);

        if (storedSubmitBtn && isClickableButton(storedSubmitBtn)) {
            handledElements.add(storedSubmitBtn);
            storedSubmitBtn.click();
        } else if (storedCaptchaInput) {
            simulateEnter(storedCaptchaInput);
        }

        isVerifyingClaim = true;
        console.log(`[TaskBot] ⏳ Captcha submitted (${pendingCaptchaText} = ${pendingCaptchaAnswer}). Waiting for "View Task" to confirm...`);

        if (detectSuccessSignal()) {
            confirmClaimSuccess();
            return;
        }
        const immediateError = detectErrorToast();
        if (immediateError) {
            abortClaim(immediateError);
            return;
        }

        verifyTimer = setTimeout(() => {
            verifyTimer = null;
            if (!isVerifyingClaim) return;
            if (detectSuccessSignal()) { confirmClaimSuccess(); return; }
            const finalError = detectErrorToast();
            if (finalError) { abortClaim(finalError); return; }
            console.warn(`[TaskBot] ⚠️ No confirmation signal after 5s — treating as FAILED`);
            abortClaim('timeout — no confirmation signal detected');
        }, 5000);
    }

    // ─── Task Queue Management ────────────────────────────────────────
    /**
     * Rebuild the task queue by scanning ALL visible "Accept Task" buttons.
     * Skips buttons already in `handledElements`.
     */
    function rebuildTaskQueue() {
        taskQueue = [];
        taskQueueIndex = 0;
        const buttons = getAllButtons(document.body);
        for (const btn of buttons) {
            if (handledElements.has(btn)) continue;
            if (!isClickableButton(btn)) continue;
            const text = getText(btn);
            if (text.includes('accept') && text.includes('task')) {
                taskQueue.push(btn);
            }
        }
        // Also include buttons matched by user-configured selector
        if (settings.claimSelector && settings.claimSelector.trim()) {
            try {
                const matched = document.querySelectorAll(settings.claimSelector);
                for (const btn of matched) {
                    if (!handledElements.has(btn) && isClickableButton(btn) && !taskQueue.includes(btn)) {
                        taskQueue.push(btn);
                    }
                }
            } catch (e) {
                console.warn('[TaskBot] Invalid claimSelector:', e.message);
            }
        }
        console.log(`[TaskBot] 🗂️ Task queue rebuilt — ${taskQueue.length} task(s) found`);
    }

    /**
     * Advance to the next task in the queue without rebuilding it.
     * Called after a failed/aborted claim so the bot tries the next card.
     */
    function advanceToNextTask() {
        if (isAdvancing) return;
        isAdvancing = true;

        // Small delay so the page can settle (toast disappears, modal closes)
        setTimeout(function () {
            isAdvancing = false;
            if (!isEnabled) return;

            taskQueueIndex++;

            // If we have more tasks in the current queue, try the next one
            if (taskQueueIndex < taskQueue.length) {
                console.log(`[TaskBot] ➡️ Advancing to task #${taskQueueIndex + 1} of ${taskQueue.length}`);
                runCurrentStage();
            } else {
                // Queue exhausted — do a fresh scan in case new cards loaded
                console.log(`[TaskBot] 🔄 Task queue exhausted — rebuilding...`);
                rebuildTaskQueue();
                if (taskQueue.length > 0) {
                    console.log(`[TaskBot] ➡️ Fresh scan found ${taskQueue.length} task(s)`);
                    runCurrentStage();
                } else {
                    console.log(`[TaskBot] 💤 No more tasks available. Waiting for new ones...`);
                }
            }
        }, 800); // 800 ms grace period
    }

    // ─── Stage A: Accept Task (IMMEDIATE — no BB wait) ───────────────
    function tryAcceptTask() {
        if (hasClickedAccept) return false;

        // On the very first call (or after queue exhausted), build the queue
        if (taskQueue.length === 0 || taskQueueIndex >= taskQueue.length) {
            rebuildTaskQueue();
        }

        // Walk from the current index to find the next unhandled, clickable button
        let targetButton = null;
        while (taskQueueIndex < taskQueue.length) {
            const candidate = taskQueue[taskQueueIndex];
            if (!handledElements.has(candidate) && isClickableButton(candidate)) {
                targetButton = candidate;
                break;
            }
            // Already handled or gone — skip
            taskQueueIndex++;
        }

        if (!targetButton) return false;

        // ── CLICK IMMEDIATELY — no waiting! ──
        hasClickedAccept = true;
        handledElements.add(targetButton);
        targetButton.click();
        console.log(`[TaskBot] ⚡ Accept clicked IMMEDIATELY — "${getText(targetButton)}"`);

        // Extract subreddit
        const subreddit = extractSubredditFromTaskCard(targetButton);
        currentSubreddit = subreddit;
        pendingSubreddit = subreddit;

        notifyBackground('STAGE_ACCEPT', {
            buttonText: getText(targetButton),
            subreddit: subreddit || 'unknown',
        });

        // ── Fire BB check (if enabled) — background checks its own persistent
        //    cache first, so no API call is made for already-known subreddits ──
        if (settings.botBouncerCheckEnabled && subreddit) {
            // Always delegate to background — it checks chrome.storage.local before API
            fireBBCheck(subreddit);

            // Safety timeout: if BB check takes too long, ABORT (never submit)
            bbCheckTimer = setTimeout(function () {
                bbCheckTimer = null;
                if (!bbCheckCompleted) {
                    console.warn(`[BotBouncer] ⏱️ STRICT: Check timed out after ${settings.bbCheckTimeoutMs}ms — will ABORT if captcha solved`);
                    // Force abort — mark as unsafe so any pending/future finalDecision aborts
                    bbCheckCompleted = true;
                    bbCheckResult = false;  // NOT safe
                    abortSubmission = true;

                    notifyBackground('BB_LOG_ENTRY', {
                        subreddit: subreddit,
                        status: 'timeout',
                        action: 'marked_unsafe_on_timeout',
                    });

                    // If captcha is already solved and waiting, trigger abort
                    if (hasSolvedCaptcha && !hasSubmittedCaptcha) {
                        finalDecision(); // will abort because abortSubmission=true
                    }
                }
            }, settings.bbCheckTimeoutMs);
        } else if (settings.botBouncerCheckEnabled && !subreddit) {
            // STRICT: Cannot proceed without knowing the subreddit — mark as UNSAFE
            console.warn('[BotBouncer] ⛔ STRICT: Could not extract subreddit — treating as UNSAFE');
            bbCheckCompleted = true;
            bbCheckResult = false;
            abortSubmission = true;
            notifyBackground('BB_LOG_ENTRY', {
                subreddit: 'unknown',
                status: 'unsafe',
                action: 'no_subreddit_strict_abort',
            });
        } else {
            // BB check is disabled — proceed freely
            bbCheckCompleted = true;
            bbCheckResult = true;
        }

        // Immediately try next stage (confirm modal / captcha)
        runCurrentStage();
        return true;
    }

    // ─── Stage B: Confirmation Modal ─────────────────────────────────
    function tryConfirmation() {
        if (!hasClickedAccept || hasClickedConfirm) return false;

        if (abortSubmission) {
            silentAbort(pendingSubreddit || 'unknown');
            return false;
        }

        const buttons = getAllButtons(document.body);
        for (const btn of buttons) {
            if (handledElements.has(btn)) continue;
            if (!isClickableButton(btn)) continue;
            const text = getText(btn);

            if (text === 'cancel' || text === 'no' || text === 'close') continue;

            // Pattern 1: "yes" + confirmation word
            if (text.includes('yes')) {
                if (text.includes('accept') || text.includes('claim') ||
                    text.includes('confirm') || text.includes('continue')) {
                    hasClickedConfirm = true;
                    handledElements.add(btn);
                    btn.click();
                    console.log(`[TaskBot] 🔘 Confirmation clicked: "${text}"`);
                    notifyBackground('STAGE_CONFIRM', { buttonText: text });
                    runCurrentStage();
                    return true;
                }
            }

            // Pattern 2: Standalone confirmation words inside a modal
            const isInModal = btn.closest('[role="dialog"], [role="alertdialog"], .modal, .dialog, .popup, .overlay, [class*="modal"], [class*="dialog"], [class*="popup"], [class*="confirm"]');
            if (isInModal) {
                if (text === 'confirm' || text === 'claim' || text === 'accept' ||
                    text === 'yes' || text === 'ok' || text === 'continue' ||
                    text.includes('yes,') || text.includes('yes ')) {
                    hasClickedConfirm = true;
                    handledElements.add(btn);
                    btn.click();
                    console.log(`[TaskBot] 🔘 Modal confirmation clicked: "${text}"`);
                    notifyBackground('STAGE_CONFIRM', { buttonText: text });
                    runCurrentStage();
                    return true;
                }
            }
        }
        return false;
    }

    // ─── Stage C: Captcha Solving & HOLDING ──────────────────────────
    function tryCaptcha() {
        if (!hasClickedConfirm || hasSolvedCaptcha) return false;

        if (abortSubmission) {
            silentAbort(pendingSubreddit || 'unknown');
            return false;
        }

        // ── Find captcha expression ──
        let captchaText = null;
        let captchaEl = null;

        if (settings.captchaSelector && settings.captchaSelector.trim()) {
            try {
                captchaEl = document.querySelector(settings.captchaSelector);
            } catch (e) {
                console.warn('[TaskBot] Invalid captchaSelector:', e.message);
            }
        }
        if (!captchaEl) {
            captchaEl = findMathElement(document.body);
        }
        if (!captchaEl) return false;

        captchaText = captchaEl.textContent.trim();
        const answer = solveAddition(captchaText);
        if (answer === null) return false;

        // ── Find captcha input ──
        let captchaInput = null;

        if (settings.captchaInputSelector && settings.captchaInputSelector.trim()) {
            try {
                captchaInput = document.querySelector(settings.captchaInputSelector);
            } catch (e) {
                console.warn('[TaskBot] Invalid captchaInputSelector:', e.message);
            }
        }
        if (!captchaInput) {
            const searchRoot = captchaEl.closest('[role="dialog"], [role="alertdialog"], .modal, .dialog, .popup, .overlay, [class*="modal"], [class*="dialog"], [class*="captcha"], form') || document.body;
            captchaInput = searchRoot.querySelector('input[type="text"], input[type="number"], input.captcha-input, input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])');
        }
        if (!captchaInput) {
            captchaInput = document.querySelector('input[type="text"], input[type="number"]');
        }
        if (!captchaInput) return false;

        // ── Fill the answer (but DON'T submit yet!) ──
        hasSolvedCaptcha = true;
        handledElements.add(captchaEl);
        handledElements.add(captchaInput);
        fillInput(captchaInput, answer);

        pendingCaptchaText = captchaText;
        pendingCaptchaAnswer = answer;
        storedCaptchaInput = captchaInput;

        // Find submit button (store for later)
        let submitBtn = null;
        if (settings.submitSelector && settings.submitSelector.trim()) {
            try {
                submitBtn = document.querySelector(settings.submitSelector);
            } catch (e) {
                console.warn('[TaskBot] Invalid submitSelector:', e.message);
            }
        }
        if (!submitBtn) {
            const submitKeywords = ['submit', 'send', 'confirm', 'done', 'verify', 'ok'];
            const btns = getAllButtons(document.body);
            for (const btn of btns) {
                if (!isClickableButton(btn)) continue;
                if (handledElements.has(btn)) continue;
                const text = getText(btn);
                if (submitKeywords.some(kw => text.includes(kw))) {
                    submitBtn = btn;
                    break;
                }
            }
        }
        storedSubmitBtn = submitBtn;

        console.log(`[TaskBot] 🧮 Captcha solved: ${captchaText} = ${answer} — HOLDING submission...`);

        // ── Now decide: submit or wait for BB ──
        if (bbCheckCompleted) {
            finalDecision();
        } else {
            console.log(`[TaskBot] ⏳ Waiting for BB check result before submitting...`);
        }

        return true;
    }

    /**
     * Scan a subtree for elements containing simple addition expressions.
     */
    function findMathElement(root) {
        if (!root) return null;
        const mathRegex = /\d+\s*\+\s*\d+/;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        while (walker.nextNode()) {
            const text = walker.currentNode.textContent.trim();
            if (mathRegex.test(text) && walker.currentNode.parentElement) {
                return walker.currentNode.parentElement;
            }
        }
        return null;
    }

    // ─── Notification Helper ─────────────────────────────────────────
    function notifyBackground(type, payload) {
        try {
            chrome.runtime.sendMessage({ type, payload }).catch(function () { });
        } catch (e) {
            // Extension context may be invalidated
        }
    }

    // ─── State Reset ─────────────────────────────────────────────────
    /**
     * Reset per-task claim state but deliberately KEEP the taskQueue and
     * taskQueueIndex so advanceToNextTask() can continue from where we left off.
     */
    function resetState() {
        hasClickedAccept = false;
        hasClickedConfirm = false;
        hasSolvedCaptcha = false;
        hasSubmittedCaptcha = false;
        isVerifyingClaim = false;
        currentSubreddit = null;
        pendingSubreddit = null;
        bbCheckCompleted = false;
        bbCheckResult = true;
        abortSubmission = false;
        pendingCaptchaText = null;
        pendingCaptchaAnswer = null;
        storedCaptchaInput = null;
        storedSubmitBtn = null;

        if (verifyTimer) {
            clearTimeout(verifyTimer);
            verifyTimer = null;
        }
        if (bbCheckTimer) {
            clearTimeout(bbCheckTimer);
            bbCheckTimer = null;
        }
        // NOTE: taskQueue, taskQueueIndex, isAdvancing are intentionally NOT reset here
    }

    // ─── Run Current Stage ───────────────────────────────────────────
    function runCurrentStage() {
        if (!isEnabled) return;
        if (isVerifyingClaim) return;
        if (hasSubmittedCaptcha) return;

        if (!hasClickedAccept) {
            tryAcceptTask();
            return;
        }

        if (!hasClickedConfirm) {
            tryConfirmation();
            return;
        }

        if (!hasSolvedCaptcha) {
            tryCaptcha();
        }
    }

    // ─── MutationObserver ────────────────────────────────────────────
    function startObserver() {
        if (observer) return;

        console.log('[TaskBot] 👁️ MutationObserver STARTED — watching for tasks...');

        // Push a log to background so it shows in the popup
        notifyBackground('PUSH_LOG', {
            level: 'info',
            message: '👁️ Observer started — watching for tasks on ' + window.location.hostname,
        });

        observer = new MutationObserver(function (mutations) {
            if (!isEnabled) return;

            mutationCount++;

            // Log first few mutations for diagnostics
            if (mutationCount <= 3) {
                console.log(`[TaskBot] 📡 Mutation #${mutationCount} detected (${mutations.length} records)`);
            }

            // Check for error toasts in newly added nodes
            if (hasClickedAccept) {
                const errorText = checkMutationsForErrorToast(mutations);
                if (errorText) {
                    console.warn(`[TaskBot] 🚨 Error toast detected: "${errorText}"`);
                    abortClaim(errorText);
                    return;
                }
            }

            // If in verification phase, check for success signals
            if (isVerifyingClaim) {
                if (checkMutationsForSuccessSignal(mutations)) {
                    confirmClaimSuccess();
                }
                return;
            }
            if (hasSubmittedCaptcha) return;

            runCurrentStage();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class', 'hidden', 'aria-hidden', 'open'],
        });

        // Scan existing DOM immediately
        console.log('[TaskBot] 🔍 Scanning existing DOM for tasks...');
        runCurrentStage();
    }

    function stopObserver() {
        if (observer) {
            observer.disconnect();
            observer = null;
            console.log('[TaskBot] ⏹️ MutationObserver STOPPED');
        }
        mutationCount = 0;
        // Full reset including task queue when bot is disabled
        taskQueue = [];
        taskQueueIndex = 0;
        isAdvancing = false;
        resetState();
    }

    // ─── State Sync ──────────────────────────────────────────────────
    function applyState(state) {
        const wasEnabled = isEnabled;
        isEnabled = state.enabled;

        console.log(`[TaskBot] 📋 State applied — enabled: ${isEnabled}, wasEnabled: ${wasEnabled}`);

        settings = {
            claimSelector: state.claimSelector || '',
            captchaSelector: state.captchaSelector || '',
            captchaInputSelector: state.captchaInputSelector || '',
            submitSelector: state.submitSelector || '',
            soundEnabled: state.soundEnabled !== false,
            delayMs: state.delayMs || 0,
            safeModeEnabled: state.safeModeEnabled || false,
            botBouncerCheckEnabled: state.botBouncerCheckEnabled !== false,
            bbCheckTimeoutMs: state.bbCheckTimeoutMs || 1000,
            bbTimeoutAction: state.bbTimeoutAction || 'submit',
            bbCacheDurationMs: state.bbCacheDurationMs || (30 * 60 * 1000),
            maxParallelChecks: state.maxParallelChecks || 2,
        };

        if (isEnabled && !wasEnabled) {
            console.log('[TaskBot] ▶️ Enabling — starting observer...');
            resetState();
            startObserver();
        } else if (!isEnabled && wasEnabled) {
            console.log('[TaskBot] ⏸️ Disabling — stopping observer...');
            stopObserver();
        }
    }

    // Listen for state updates from background
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
        if (message.type === 'STATE_UPDATED') {
            console.log('[TaskBot] 📨 Received STATE_UPDATED from background');
            applyState(message.payload);
            sendResponse({ ok: true });
        }
        return false;
    });

    // ─── Initialization ─────────────────────────────────────────────
    function init() {
        console.log('[TaskBot] 🔧 Initializing — requesting state from background...');
        chrome.runtime.sendMessage({ type: 'GET_STATE' }, function (response) {
            if (chrome.runtime.lastError) {
                console.error('[TaskBot] ❌ Failed to get state:', chrome.runtime.lastError.message);
                return;
            }
            if (response && response.state) {
                console.log('[TaskBot] ✅ State received — enabled:', response.state.enabled);
                applyState(response.state);
            } else {
                console.warn('[TaskBot] ⚠️ No state in response:', response);
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
