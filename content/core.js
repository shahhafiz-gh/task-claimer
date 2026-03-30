/**
 * Task Auto Claimer — Core State & Constants
 * Shared namespace for all content script modules.
 */
'use strict';

/* exported TB */
var TB = {
  state: {
    observer: null,
    isEnabled: false,
    hasClickedAccept: false,
    hasClickedConfirm: false,
    hasSolvedCaptcha: false,
    hasSubmittedCaptcha: false,
    isVerifyingClaim: false,
    verifyTimer: null,
    pendingCaptchaText: null,
    pendingCaptchaAnswer: null,
    pendingSubreddit: null,
    bbCheckCompleted: false,
    bbCheckResult: true,
    abortSubmission: false,
    bbCheckTimer: null,
    storedCaptchaInput: null,
    storedSubmitBtn: null,
    currentSubreddit: null,
    // Cloudflare Turnstile state
    turnstileDetected: false,
    turnstileCompleted: false,
    turnstileTimer: null,
    taskQueue: [],
    taskQueueIndex: 0,
    isAdvancing: false,
    bulkAcceptPending: 0,
    stageRAF: null,
    // Watchdog: auto-reset if stuck in any intermediate stage
    stageWatchdog: null,
    lastStageTransition: 0,
  },

  settings: {
    claimSelector: '',
    captchaSelector: '',
    captchaInputSelector: '',
    submitSelector: '',
    botBouncerCheckEnabled: true,
    bbCheckTimeoutMs: 10000,
    bbCacheDurationMs: 30 * 60 * 1000,
    maxParallelChecks: 2,
  },

  handled: new WeakSet(),

  ERROR_PATTERNS: [
    'already claimed', 'already been claimed',
    'called by client', 'task is no longer available',
    'task unavailable', 'task has been taken',
    'error claiming', 'failed to claim', 'claim failed',
    'task was claimed', 'unable to claim', 'cannot claim',
    'comment not found', 'reply not found',
    'post not found', 'post deleted',
    'not found', 'no longer exists',
    'does not exist', 'content removed', 'deleted',
  ],

  TOAST_SELECTORS: [
    '[class*="toast"]', '[class*="Toast"]',
    '[class*="snackbar"]', '[class*="Snackbar"]',
    '[role="alert"]',
    '.ant-message', '.ant-notification',
    '.MuiSnackbar-root', '.MuiAlert-root',
    '[class*="flash"]', '[class*="notice"]',
  ],

  SUCCESS_TEXTS: [
    'task accepted with this account',
    "you've already accepted this task",
    'task accepted',
    'successfully accepted',
    'task claimed',
    'successfully claimed',
    'accepted successfully',
    'claimed successfully',
  ],
};

console.log('[TaskBot] 🚀 Content script loaded — "Accept First, Verify Later"');
