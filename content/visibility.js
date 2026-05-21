/**
 * Anti-Background-Throttle & Focus Spoof
 */

// 1. Spoof Visibility State
Object.defineProperty(document, 'visibilityState', {
  get: function() { return 'visible'; },
  configurable: true
});

Object.defineProperty(document, 'hidden', {
  get: function() { return false; },
  configurable: true
});

// 2. Spoof Focus State
Object.defineProperty(document, 'hasFocus', {
  get: function() { return function() { return true; }; },
  configurable: true
});

// 3. Intercept visibility AND blur/focus events
const realAddEventListener = document.addEventListener.bind(document);
document.addEventListener = function(type, listener, options) {
  // Block visibility and blur events from reaching Cloudflare
  if (type === 'visibilitychange' || type === 'blur' || type === 'focus') {
    return;
  }
  return realAddEventListener(type, listener, options);
};

const realAddEventListenerWindow = window.addEventListener.bind(window);
window.addEventListener = function(type, listener, options) {
  if (type === 'visibilitychange' || type === 'webkitvisibilitychange' || type === 'blur' || type === 'focus') {
    return;
  }
  return realAddEventListenerWindow(type, listener, options);
};

console.log('[TaskBot] 🕵️‍♂️ Focus & Visibility spoofing active.');