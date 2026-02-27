/**
 * Content Script — Task Auto Claimer v4 — Speed + Anti-False-Claim
 *
 * Architecture:
 *   ONE MutationObserver watching document.body
 *   Observes: childList + subtree + attributes (style/class/hidden)
 *   Every mutation triggers stage checks:
 *     A) "Accept Task" button → BotBouncer check → click if safe
 *     B) Confirmation button (Yes accept / Yes claim / Confirm)
 *     C) Captcha text + input + submit
 *     D) [NEW] Error/toast detection — abort if task was already claimed
 *
 * BotBouncer Protection:
 *   Before clicking "Accept Task", extracts the subreddit from the task card,
 *   sends a CHECK_BOTBOUNCER message to the background script, and only proceeds
 *   if the subreddit does NOT have BotBouncer as a moderator.
 *
 * Anti-False-Claim:
 *   After captcha submission, waits up to 1.5s monitoring for error toasts.
 *   Only reports TASK_CLAIMED if no error/failure toast detected.
 *   If an error toast appears at ANY stage, immediately aborts and resets.
 *
 * Zero polling. Zero setInterval. Fully event-driven.
 * Target reaction time: < 50ms.
 */

(() => {
    'use strict';

    // ─── State ───────────────────────────────────────────────────────
    let observer = null;
    let isEnabled = false;

    // Stage flags — prevent duplicate clicks/submissions per cycle
    let hasClickedAccept = false;
    let hasClickedConfirm = false;
    let hasSubmittedCaptcha = false;

    // Verification state — wait after captcha to confirm success
    let isVerifyingClaim = false;
    let verifyTimer = null;
    let pendingCaptchaText = null;
    let pendingCaptchaAnswer = null;

    // BotBouncer concurrency flags
    let isCheckingBotBouncer = false;
    let pendingAcceptButton = null;

    // WeakSet to track already-handled elements (extra safety)
    const handledElements = new WeakSet();

    // Rate-limit: track last BotBouncer check time
    let lastBotBouncerCheckTime = 0;
    const BOT_BOUNCER_RATE_LIMIT_MS = 50; // reduced from 500ms for speed

    // Track the current subreddit being claimed for logging
    let currentSubreddit = null;

    let settings = {
        claimSelector: '',
        captchaSelector: '',
        captchaInputSelector: '',
        submitSelector: '',
        soundEnabled: true,
        delayMs: 0,
        safeModeEnabled: false,
        botBouncerCheckEnabled: true,
    };

    // ─── Error Toast / Failure Detection ─────────────────────────────
    /**
     * Keywords that indicate the task was already claimed by someone else
     * or that the claim failed. These appear in toast/snackbar notifications.
     * Add more patterns as discovered.
     */
    const ERROR_TOAST_PATTERNS = [
        'already claimed',
        'already been claimed',
        'claimed by',
        'called by client',
        'task is no longer available',
        'no longer available',
        'task unavailable',
        'expired',
        'task has been taken',
        'someone else',
        'too late',
        'not available',
        'error claiming',
        'failed to claim',
        'claim failed',
        'task was claimed',
        'unable to claim',
        'cannot claim',
    ];

    /**
     * Selectors for common toast/snackbar/notification containers.
     */
    const TOAST_SELECTORS = [
        // Common toast frameworks
        '[class*="toast"]',
        '[class*="Toast"]',
        '[class*="snackbar"]',
        '[class*="Snackbar"]',
        '[class*="notification"]',
        '[class*="Notification"]',
        '[class*="alert"]',
        '[class*="Alert"]',
        '[role="alert"]',
        '[role="status"]',
        '[class*="message"]',
        '[class*="Message"]',
        '[class*="error"]',
        '[class*="Error"]',
        '[class*="banner"]',
        // Ant Design / Material UI / etc
        '.ant-message',
        '.ant-notification',
        '.MuiSnackbar-root',
        '.MuiAlert-root',
        // Generic
        '[class*="popup"]',
        '[class*="flash"]',
        '[class*="notice"]',
    ];

    /**
     * Check if any visible toast/notification contains an error about the task
     * being already claimed or unavailable.
     * Returns the detected error text if found, or null.
     */
    function detectErrorToast() {
        // Strategy 1: Check known toast containers
        for (const selector of TOAST_SELECTORS) {
            try {
                const els = document.querySelectorAll(selector);
                for (const el of els) {
                    const text = (el.textContent || '').toLowerCase().trim();
                    if (!text) continue;

                    for (const pattern of ERROR_TOAST_PATTERNS) {
                        if (text.includes(pattern)) {
                            // Verify the element is visible
                            const style = window.getComputedStyle(el);
                            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                                return text;
                            }
                        }
                    }
                }
            } catch { /* selector might be invalid in some DOMs */ }
        }

        // Strategy 2: Quick scan of recently-added elements (new nodes from mutations)
        // This is handled in the mutation observer callback directly

        return null;
    }

    /**
     * Scan specific mutation nodes for error toast text.
     * Much faster than scanning the whole DOM — only checks what just changed.
     */
    function checkMutationsForErrorToast(mutations) {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;

                const text = (node.textContent || '').toLowerCase().trim();
                if (!text) continue;

                for (const pattern of ERROR_TOAST_PATTERNS) {
                    if (text.includes(pattern)) {
                        // Quick visibility check
                        try {
                            const style = window.getComputedStyle(node);
                            if (style.display !== 'none' && style.visibility !== 'hidden') {
                                return text;
                            }
                        } catch { /* node may have been removed */ }
                    }
                }
            }
        }
        return null;
    }

    /**
     * Called when an error toast is detected — aborts current claim flow.
     */
    function abortClaim(reason) {
        console.warn(`[TaskBot] ❌ ABORT — Error detected: "${reason}"`);

        // Cancel verification timer if running
        if (verifyTimer) {
            clearTimeout(verifyTimer);
            verifyTimer = null;
        }

        // We did NOT actually claim it — notify background
        notifyBackground('TASK_CLAIM_FAILED', {
            reason,
            subreddit: currentSubreddit,
        });

        // Full reset for next cycle
        isVerifyingClaim = false;
        resetState();
    }

    // ─── View Task Detection (Positive Success Signal) ───────────────

    /**
     * Detects the "View Task" button which appears ONLY when a task is
     * actually successfully claimed. This is the definitive success signal.
     * Returns true if found, false otherwise.
     */
    function detectViewTaskButton() {
        const buttons = getAllButtons(document.body);
        for (const btn of buttons) {
            if (!isClickableButton(btn)) continue;
            const text = getText(btn);
            // Match: "view task", "view your task", etc.
            if (text.includes('view') && text.includes('task')) {
                return true;
            }
        }
        // Also check links that might say "view task"
        const links = document.querySelectorAll('a');
        for (const link of links) {
            const text = getText(link);
            if (text.includes('view') && text.includes('task')) {
                try {
                    const style = window.getComputedStyle(link);
                    if (style.display !== 'none' && style.visibility !== 'hidden') {
                        return true;
                    }
                } catch { /* ignore */ }
            }
        }
        return false;
    }

    /**
     * Checks newly added mutation nodes for a "View Task" button.
     * Faster than scanning the whole DOM.
     */
    function checkMutationsForViewTask(mutations) {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                const text = (node.textContent || '').toLowerCase().trim();
                if (text.includes('view') && text.includes('task')) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Called when "View Task" button is detected — confirms real claim.
     */
    function confirmClaimSuccess() {
        // Cancel safety timer
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

        // Reset for next task cycle
        resetState();
    }

    // ─── Captcha Solver ──────────────────────────────────────────────
    /**
     * Parses simple addition captcha text and returns the sum.
     * Handles: "1+2", "3 + 7", " 11 +  6 ", "12+9", etc.
     * Uses regex: /(\d+)\s*\+\s*(\d+)/
     * Returns null if no valid expression found.
     */
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

    /**
     * Check if an element is visible and enabled.
     */
    function isClickableButton(el) {
        if (!el) return false;
        if (el.disabled) return false;
        if (el.getAttribute('aria-disabled') === 'true') return false;

        // Check computed visibility — catches display:none, visibility:hidden, opacity:0
        const style = window.getComputedStyle(el);
        if (style.display === 'none') return false;
        if (style.visibility === 'hidden') return false;
        if (style.opacity === '0') return false;
        if (el.offsetParent === null && style.position !== 'fixed' && style.position !== 'sticky') return false;

        return true;
    }

    /**
     * Get normalized text from an element.
     */
    function getText(el) {
        return (el.textContent || el.value || el.innerText || '').trim().toLowerCase();
    }

    /**
     * Fills an input field with a value, dispatching proper events
     * so frameworks (React, Vue, Angular) detect the change.
     */
    function fillInput(input, value) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
        )?.set;

        if (nativeInputValueSetter) {
            nativeInputValueSetter.call(input, String(value));
        } else {
            input.value = String(value);
        }

        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /**
     * Simulates pressing Enter on an element — fires keydown, keypress, keyup.
     */
    function simulateEnter(element) {
        const opts = {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
        };
        element.dispatchEvent(new KeyboardEvent('keydown', opts));
        element.dispatchEvent(new KeyboardEvent('keypress', opts));
        element.dispatchEvent(new KeyboardEvent('keyup', opts));
    }

    /**
     * Get all clickable button-like elements from a root.
     */
    function getAllButtons(root) {
        return root.querySelectorAll('button, [role="button"], a.btn, input[type="button"], input[type="submit"]');
    }

    // ─── Subreddit Extraction ────────────────────────────────────────

    /**
     * Extracts the subreddit name from the task card surrounding the Accept button.
     * Looks for links containing /r/[subreddit]/ pattern.
     *
     * Strategy:
     *   1. Walk up from the button to find the closest "card-like" container
     *   2. Search for any <a> with href matching /r/subreddit/
     *   3. Fallback: search the entire visible page for subreddit links near the button
     *
     * Returns the subreddit name (lowercase) or null if not found.
     */
    function extractSubredditFromTaskCard(button) {
        if (!button) return null;

        const subredditRegex = /\/r\/([a-zA-Z0-9_]+)/i;

        // Strategy 1: Look in the closest card/container ancestor
        const cardSelectors = [
            '[class*="task"]', '[class*="card"]', '[class*="item"]',
            '[class*="row"]', '[class*="job"]', '[class*="listing"]',
            'tr', 'li', 'article', 'section',
            '[role="listitem"]', '[role="row"]',
        ];

        let searchRoot = null;

        // Try to find a meaningful container
        for (const sel of cardSelectors) {
            const container = button.closest(sel);
            if (container) {
                searchRoot = container;
                break;
            }
        }

        // Fallback: walk up to a reasonable parent (max 6 levels)
        if (!searchRoot) {
            searchRoot = button;
            for (let i = 0; i < 6 && searchRoot.parentElement; i++) {
                searchRoot = searchRoot.parentElement;
            }
        }

        // Search for subreddit links within the container
        const links = searchRoot.querySelectorAll('a[href*="/r/"]');
        for (const link of links) {
            const match = link.href.match(subredditRegex);
            if (match) {
                return match[1].toLowerCase();
            }
        }

        // Strategy 2: Check text content for r/subreddit patterns
        const textContent = searchRoot.textContent || '';
        const textMatch = textContent.match(/\br\/([a-zA-Z0-9_]+)\b/i);
        if (textMatch) {
            return textMatch[1].toLowerCase();
        }

        // Strategy 3: Broadest fallback — scan all links on the page
        const allLinks = document.querySelectorAll('a[href*="/r/"]');
        for (const link of allLinks) {
            const match = link.href.match(subredditRegex);
            if (match) {
                return match[1].toLowerCase();
            }
        }

        return null;
    }

    // ─── BotBouncer Check ────────────────────────────────────────────

    /**
     * Sends a CHECK_BOTBOUNCER message to background script.
     * Returns a Promise<{ safe: boolean }>.
     */
    function checkBotBouncer(subreddit) {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage(
                    { type: 'CHECK_BOTBOUNCER', payload: { subreddit } },
                    (response) => {
                        if (chrome.runtime.lastError) {
                            console.warn('[BotBouncer] Runtime error:', chrome.runtime.lastError.message);
                            resolve({ safe: false, error: chrome.runtime.lastError.message });
                            return;
                        }
                        resolve(response || { safe: false });
                    }
                );
            } catch (err) {
                console.warn('[BotBouncer] sendMessage error:', err.message);
                resolve({ safe: false, error: err.message });
            }
        });
    }

    // ─── Stage A: Accept Task (with BotBouncer Guard) ────────────────

    /**
     * Scans the ENTIRE visible DOM for an "Accept Task" button.
     * If BotBouncer check is enabled, extracts the subreddit and checks
     * before clicking. Otherwise, clicks immediately.
     */
    function tryAcceptTask() {
        if (hasClickedAccept) return false;
        if (isCheckingBotBouncer) return false; // already checking, wait

        // Rate limit: don't fire checks too rapidly
        const now = Date.now();
        if (now - lastBotBouncerCheckTime < BOT_BOUNCER_RATE_LIMIT_MS) return false;

        let targetButton = null;

        const buttons = getAllButtons(document.body);
        for (const btn of buttons) {
            if (handledElements.has(btn)) continue;
            if (!isClickableButton(btn)) continue;

            const text = getText(btn);

            // Match: contains both "accept" and "task"
            if (text.includes('accept') && text.includes('task')) {
                targetButton = btn;
                break;
            }
        }

        // Also try user-configured selector if no button found
        if (!targetButton && settings.claimSelector?.trim()) {
            const btn = document.querySelector(settings.claimSelector);
            if (btn && isClickableButton(btn) && !handledElements.has(btn)) {
                targetButton = btn;
            }
        }

        if (!targetButton) return false;

        // ── BotBouncer check gate ──
        if (settings.botBouncerCheckEnabled) {
            const subreddit = extractSubredditFromTaskCard(targetButton);

            if (!subreddit) {
                // No subreddit found — default: skip to be safe
                console.warn('[BotBouncer] Could not extract subreddit from task card — SKIPPING (safe default)');
                handledElements.add(targetButton);
                notifyBackground('TASK_SKIPPED_BOTBOUNCER', { subreddit: 'unknown' });
                // Reset so we can check the next task
                resetState();
                return false;
            }

            // Set concurrency flags
            isCheckingBotBouncer = true;
            pendingAcceptButton = targetButton;
            lastBotBouncerCheckTime = Date.now();
            currentSubreddit = subreddit;

            console.log(`[BotBouncer] Checking r/${subreddit} before accepting task...`);

            checkBotBouncer(subreddit).then((result) => {
                // Check if button is still in the DOM
                if (!document.body.contains(pendingAcceptButton)) {
                    console.warn('[BotBouncer] Button disappeared during check — resetting');
                    isCheckingBotBouncer = false;
                    pendingAcceptButton = null;
                    resetState();
                    return;
                }

                if (result.safe) {
                    // ✓ SAFE — click the button and proceed
                    console.log(`[BotBouncer] r/${subreddit} is SAFE — accepting task`);
                    hasClickedAccept = true;
                    handledElements.add(pendingAcceptButton);
                    pendingAcceptButton.click();
                    notifyBackground('STAGE_ACCEPT', {
                        buttonText: getText(pendingAcceptButton),
                        subreddit,
                    });
                    // Immediately try next stage after click
                    runCurrentStage();
                } else {
                    // ✗ UNSAFE — skip this task
                    console.warn(`[BotBouncer] r/${subreddit} is UNSAFE — skipping task`);
                    handledElements.add(pendingAcceptButton);
                    notifyBackground('TASK_SKIPPED_BOTBOUNCER', { subreddit });
                    // Don't click — just reset so the next task can be checked
                    resetState();
                }

                isCheckingBotBouncer = false;
                pendingAcceptButton = null;
            });

            return false; // async — don't proceed yet
        }

        // ── No BotBouncer check — click immediately (original behavior) ──
        hasClickedAccept = true;
        handledElements.add(targetButton);
        targetButton.click();
        notifyBackground('STAGE_ACCEPT', { buttonText: getText(targetButton) });
        // Immediately try next stage
        runCurrentStage();
        return true;
    }

    // ─── Stage B: Confirmation Modal ─────────────────────────────────

    /**
     * Scans the ENTIRE visible DOM for a confirmation button.
     * 
     * Matches ANY of these patterns (flexible):
     *   - Text contains "yes" AND any of: "accept", "claim", "confirm", "continue"
     *   - Text is exactly or contains "yes, accept" / "yes, claim"
     *   - Text is "confirm" or "claim" standalone (common modal buttons)
     * 
     * Excludes: "cancel", "no", "close" buttons.
     */
    function tryConfirmation() {
        if (!hasClickedAccept || hasClickedConfirm) return false;

        const buttons = getAllButtons(document.body);
        for (const btn of buttons) {
            if (handledElements.has(btn)) continue;
            if (!isClickableButton(btn)) continue;

            const text = getText(btn);

            // Skip negative/cancel buttons
            if (text === 'cancel' || text === 'no' || text === 'close') continue;

            // Pattern 1: "yes" + confirmation word
            if (text.includes('yes')) {
                if (text.includes('accept') || text.includes('claim') ||
                    text.includes('confirm') || text.includes('continue')) {
                    hasClickedConfirm = true;
                    handledElements.add(btn);
                    btn.click();
                    notifyBackground('STAGE_CONFIRM', { buttonText: text });
                    // Immediately try next stage
                    runCurrentStage();
                    return true;
                }
            }

            // Pattern 2: Standalone confirmation words inside a modal/dialog
            const isInModal = btn.closest('[role="dialog"], [role="alertdialog"], .modal, .dialog, .popup, .overlay, [class*="modal"], [class*="dialog"], [class*="popup"], [class*="confirm"]');
            if (isInModal) {
                if (text === 'confirm' || text === 'claim' || text === 'accept' ||
                    text === 'yes' || text === 'ok' || text === 'continue' ||
                    text.includes('yes,') || text.includes('yes ')) {
                    hasClickedConfirm = true;
                    handledElements.add(btn);
                    btn.click();
                    notifyBackground('STAGE_CONFIRM', { buttonText: text });
                    // Immediately try next stage
                    runCurrentStage();
                    return true;
                }
            }
        }

        return false;
    }

    function tryCaptcha() {
        if (!hasClickedConfirm || hasSubmittedCaptcha) return false;

        // ── Find captcha expression ──
        let captchaText = null;
        let captchaEl = null;

        // Try user-configured captcha selector
        if (settings.captchaSelector?.trim()) {
            captchaEl = document.querySelector(settings.captchaSelector);
        }

        // Try finding math expression in the DOM via TreeWalker
        if (!captchaEl) {
            captchaEl = findMathElement(document.body);
        }

        if (!captchaEl) return false;

        captchaText = captchaEl.textContent.trim();
        const answer = solveAddition(captchaText);
        if (answer === null) return false;

        // ── Find captcha input ──
        let captchaInput = null;

        // Try user-configured input selector
        if (settings.captchaInputSelector?.trim()) {
            captchaInput = document.querySelector(settings.captchaInputSelector);
        }

        // Search near the captcha element (modal, dialog, or parent)
        if (!captchaInput) {
            const searchRoot = captchaEl.closest('[role="dialog"], [role="alertdialog"], .modal, .dialog, .popup, .overlay, [class*="modal"], [class*="dialog"], [class*="captcha"], form') || document.body;
            captchaInput = searchRoot.querySelector('input[type="text"], input[type="number"], input.captcha-input, input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])');
        }

        // Broadest fallback
        if (!captchaInput) {
            captchaInput = document.querySelector('input[type="text"], input[type="number"]');
        }

        if (!captchaInput) return false;

        // ── Fill and submit ──
        hasSubmittedCaptcha = true;
        handledElements.add(captchaEl);
        handledElements.add(captchaInput);

        // Fill the answer
        fillInput(captchaInput, answer);

        // Find submit button
        let submitBtn = null;

        if (settings.submitSelector?.trim()) {
            submitBtn = document.querySelector(settings.submitSelector);
        }

        if (!submitBtn) {
            const submitKeywords = ['submit', 'send', 'confirm', 'done', 'verify', 'ok'];
            const buttons = getAllButtons(document.body);
            for (const btn of buttons) {
                if (!isClickableButton(btn)) continue;
                if (handledElements.has(btn)) continue;
                const text = getText(btn);
                if (submitKeywords.some(kw => text.includes(kw))) {
                    submitBtn = btn;
                    break;
                }
            }
        }

        if (submitBtn && isClickableButton(submitBtn)) {
            handledElements.add(submitBtn);
            submitBtn.click();
        } else {
            // Fallback: simulate Enter on the input
            simulateEnter(captchaInput);
        }

        // ── Enter verification phase ──
        // Do NOT report TASK_CLAIMED yet!
        // Wait for a POSITIVE signal ("View Task" button) or NEGATIVE signal (error toast).
        // Whichever appears first determines outcome.
        isVerifyingClaim = true;
        pendingCaptchaText = captchaText;
        pendingCaptchaAnswer = answer;

        console.log(`[TaskBot] ⏳ Captcha submitted (${captchaText} = ${answer}). Waiting for "View Task" button to confirm...`);

        // Check immediately — maybe "View Task" or error is already there
        if (detectViewTaskButton()) {
            confirmClaimSuccess();
            return true;
        }
        const immediateError = detectErrorToast();
        if (immediateError) {
            abortClaim(immediateError);
            return true;
        }

        // Safety fallback timer — if neither signal appears within 5s,
        // do a final check and decide
        verifyTimer = setTimeout(() => {
            verifyTimer = null;
            if (!isVerifyingClaim) return; // already resolved

            // Final check for View Task button
            if (detectViewTaskButton()) {
                confirmClaimSuccess();
                return;
            }

            // Final check for error
            const finalError = detectErrorToast();
            if (finalError) {
                abortClaim(finalError);
                return;
            }

            // Neither signal found after 5s — treat as failed (conservative)
            console.warn(`[TaskBot] ⚠️ No "View Task" button or error toast detected after 5s — treating as FAILED`);
            abortClaim('timeout — no confirmation signal detected');
        }, 5000);

        return true;
    }

    /**
     * Scan a subtree for elements containing simple addition expressions.
     * Uses TreeWalker for efficiency — only visits text nodes.
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
            chrome.runtime.sendMessage({ type, payload }).catch(() => { });
        } catch {
            // Extension context may be invalidated
        }
    }

    // ─── State Reset ─────────────────────────────────────────────────

    function resetState() {
        hasClickedAccept = false;
        hasClickedConfirm = false;
        hasSubmittedCaptcha = false;
        isCheckingBotBouncer = false;
        isVerifyingClaim = false;
        pendingAcceptButton = null;
        currentSubreddit = null;
        pendingCaptchaText = null;
        pendingCaptchaAnswer = null;

        if (verifyTimer) {
            clearTimeout(verifyTimer);
            verifyTimer = null;
        }
    }

    // ─── Run Current Stage ───────────────────────────────────────────

    /**
     * Called on EVERY mutation. Runs only the current pending stage.
     * Lightweight: each stage returns false fast if nothing found.
     */
    function runCurrentStage() {
        if (!isEnabled) return;
        if (isVerifyingClaim) return; // waiting for verification, don't start new actions
        if (hasSubmittedCaptcha) return; // cycle complete, wait for reset

        if (!hasClickedAccept) {
            tryAcceptTask();
            return;
        }

        if (!hasClickedConfirm) {
            tryConfirmation();
            return;
        }

        if (!hasSubmittedCaptcha) {
            tryCaptcha();
        }
    }

    // ─── MutationObserver ────────────────────────────────────────────

    function startObserver() {
        if (observer) return;

        observer = new MutationObserver((mutations) => {
            if (!isEnabled) return;

            // ── Check for error toasts in newly added nodes ──
            // This runs at EVERY stage — if an error toast appears at any point
            // (after accept, after confirm, or during verification), we abort.
            if (hasClickedAccept) {
                const errorText = checkMutationsForErrorToast(mutations);
                if (errorText) {
                    console.warn(`[TaskBot] 🚨 Error toast detected in mutation: "${errorText}"`);
                    abortClaim(errorText);
                    return; // don't proceed to any stage
                }
            }

            // If we're in verification phase, check for "View Task" button too
            if (isVerifyingClaim) {
                if (checkMutationsForViewTask(mutations)) {
                    confirmClaimSuccess();
                }
                return;
            }
            if (hasSubmittedCaptcha) return;

            // Run the current stage check.
            runCurrentStage();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            // CRITICAL: Also observe attribute changes so we catch modals
            // that are shown/hidden via CSS class or style toggles
            attributes: true,
            attributeFilter: ['style', 'class', 'hidden', 'aria-hidden', 'open'],
        });

        // Scan existing DOM in case elements are already present
        runCurrentStage();
    }

    function stopObserver() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        resetState();
    }

    // ─── State Sync ──────────────────────────────────────────────────

    function applyState(state) {
        const wasEnabled = isEnabled;
        isEnabled = state.enabled;

        settings = {
            claimSelector: state.claimSelector || '',
            captchaSelector: state.captchaSelector || '',
            captchaInputSelector: state.captchaInputSelector || '',
            submitSelector: state.submitSelector || '',
            soundEnabled: state.soundEnabled ?? true,
            delayMs: state.delayMs || 0,
            safeModeEnabled: state.safeModeEnabled || false,
            botBouncerCheckEnabled: state.botBouncerCheckEnabled ?? true,
        };

        if (isEnabled && !wasEnabled) {
            resetState();
            startObserver();
        } else if (!isEnabled && wasEnabled) {
            stopObserver();
        }
    }

    // Listen for state updates from background
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'STATE_UPDATED') {
            applyState(message.payload);
            sendResponse({ ok: true });
        }
        return false;
    });

    // ─── Initialization ─────────────────────────────────────────────

    function init() {
        chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
            if (chrome.runtime.lastError) {
                return;
            }
            if (response?.state) {
                applyState(response.state);
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
