/**
 * Task Auto Claimer — DOM Helpers & Utilities
 */
(function () {
  'use strict';

  TB.isClickableButton = function (el) {
    if (!el || el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.offsetParent === null && el.offsetHeight === 0) return false;
    return true;
  };

  TB.getText = function (el) {
    return (el.textContent || el.value || el.innerText || '').trim().toLowerCase();
  };

  TB.fillInput = function (input, value) {
    var setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    );
    if (setter && setter.set) {
      setter.set.call(input, String(value));
    } else {
      input.value = String(value);
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  TB.simulateEnter = function (element) {
    var opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    element.dispatchEvent(new KeyboardEvent('keydown', opts));
    element.dispatchEvent(new KeyboardEvent('keypress', opts));
    element.dispatchEvent(new KeyboardEvent('keyup', opts));
  };

  TB.getAllButtons = function (root) {
    return root.querySelectorAll(
      'button, [role="button"], a.btn, input[type="button"], input[type="submit"]'
    );
  };

  TB.solveAddition = function (text) {
    if (!text || typeof text !== 'string') return null;
    var match = text.match(/(\d+)\s*\+\s*(\d+)/);
    if (!match) return null;
    var a = parseInt(match[1], 10), b = parseInt(match[2], 10);
    return (isNaN(a) || isNaN(b)) ? null : a + b;
  };

  TB.findMathElement = function (root) {
    if (!root) return null;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
      var text = walker.currentNode.textContent.trim();
      if (/\d+\s*\+\s*\d+/.test(text) && walker.currentNode.parentElement) {
        return walker.currentNode.parentElement;
      }
    }
    return null;
  };

  TB.notify = function (type, payload) {
    try {
      chrome.runtime.sendMessage({ type: type, payload: payload }).catch(function () { });
    } catch (e) { /* Extension context may be invalidated */ }
  };

  // ─── Cloudflare Turnstile Detection ────────────────────
  TB.detectTurnstile = function () {
    var selectors = [
      '.cf-turnstile',
      '[data-sitekey]',
      'iframe[src*="challenges.cloudflare.com"]',
      'iframe[src*="turnstile"]',
    ];
    for (var i = 0; i < selectors.length; i++) {
      try {
        var el = document.querySelector(selectors[i]);
        if (el) return el;
      } catch (e) { continue; }
    }
    return null;
  };

  TB.isTurnstileCompleted = function () {
    // Method 1: Non-empty Turnstile response token in hidden input/textarea
    var responseEls = document.querySelectorAll(
      'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], ' +
      'input[name*="turnstile"], textarea[name*="turnstile"]'
    );
    for (var i = 0; i < responseEls.length; i++) {
      if (responseEls[i].value && responseEls[i].value.trim().length > 0) return true;
    }
    // Method 2: data-response attribute on container
    var containers = document.querySelectorAll('.cf-turnstile, [data-sitekey]');
    for (var j = 0; j < containers.length; j++) {
      var resp = containers[j].getAttribute('data-response');
      if (resp && resp.trim().length > 0) return true;
    }
    // Method 3: Visual "Success" indicator near the Turnstile widget
    // The widget shows a green checkmark + "Success!" text when resolved
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
      var text = walker.currentNode.textContent.trim().toLowerCase();
      if (text === 'success!' || text === 'success') {
        var parent = walker.currentNode.parentElement;
        if (parent && parent.closest && (
          parent.closest('.cf-turnstile, [data-sitekey], [class*="turnstile"], [class*="captcha"], [class*="verification"]')
        )) return true;
      }
    }
    return false;
  };

  // Try to activate Turnstile managed challenge by clicking the iframe/widget
  TB.tryClickTurnstile = function () {
    // Click the Turnstile iframe — triggers managed challenge activation
    var iframes = document.querySelectorAll(
      'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]'
    );
    for (var i = 0; i < iframes.length; i++) {
      try {
        var rect = iframes[i].getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          iframes[i].focus();
          iframes[i].click();
          console.log('[TaskBot] \ud83d\udd12 Clicked Turnstile iframe to activate challenge');
          return true;
        }
      } catch (e) { continue; }
    }
    // Fallback: click the container div (some implementations use a div overlay)
    var containers = document.querySelectorAll('.cf-turnstile, [data-sitekey]');
    for (var j = 0; j < containers.length; j++) {
      try {
        var cRect = containers[j].getBoundingClientRect();
        if (cRect.width > 0 && cRect.height > 0) {
          containers[j].click();
          console.log('[TaskBot] \ud83d\udd12 Clicked Turnstile container to activate challenge');
          return true;
        }
      } catch (e) { continue; }
    }
    return false;
  };
})();
