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
})();
