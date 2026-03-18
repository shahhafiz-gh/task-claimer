/**
 * Task Auto Claimer — Detection (Toasts, Success Signals, Subreddit)
 */
(function () {
  'use strict';

  // ─── Error Toast Detection ─────────────────────────────
  TB.detectErrorToast = function () {
    for (var s = 0; s < TB.TOAST_SELECTORS.length; s++) {
      try {
        var els = document.querySelectorAll(TB.TOAST_SELECTORS[s]);
        for (var e = 0; e < els.length; e++) {
          var text = (els[e].textContent || '').toLowerCase().trim();
          if (!text || text.length > 300) continue;
          for (var p = 0; p < TB.ERROR_PATTERNS.length; p++) {
            if (text.includes(TB.ERROR_PATTERNS[p])) {
              var style = window.getComputedStyle(els[e]);
              if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                return text;
              }
            }
          }
        }
      } catch (err) { /* invalid selector */ }
    }
    return null;
  };

  TB.checkMutationsForErrorToast = function (mutations) {
    for (var m = 0; m < mutations.length; m++) {
      var added = mutations[m].addedNodes;
      for (var a = 0; a < added.length; a++) {
        var node = added[a];
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        var isToast = false;
        for (var s = 0; s < TB.TOAST_SELECTORS.length; s++) {
          try {
            if ((node.matches && node.matches(TB.TOAST_SELECTORS[s])) ||
              (node.querySelector && node.querySelector(TB.TOAST_SELECTORS[s]))) {
              isToast = true; break;
            }
          } catch (e) { /* invalid selector */ }
        }
        if (!isToast) continue;

        var text = (node.textContent || '').toLowerCase().trim();
        if (!text || text.length > 300) continue;
        for (var p = 0; p < TB.ERROR_PATTERNS.length; p++) {
          if (text.includes(TB.ERROR_PATTERNS[p])) {
            try {
              var style = window.getComputedStyle(node);
              if (style.display !== 'none' && style.visibility !== 'hidden') return text;
            } catch (e) { /* node removed */ }
          }
        }
      }
    }
    return null;
  };

  // ─── Success Signal Detection ──────────────────────────
  TB.detectSuccessSignal = function () {
    var bodyText = (document.body.textContent || '').toLowerCase();
    for (var i = 0; i < TB.SUCCESS_TEXTS.length; i++) {
      if (bodyText.includes(TB.SUCCESS_TEXTS[i])) return true;
    }
    return false;
  };

  TB.checkMutationsForSuccessSignal = function (mutations) {
    for (var m = 0; m < mutations.length; m++) {
      var added = mutations[m].addedNodes;
      for (var a = 0; a < added.length; a++) {
        if (added[a].nodeType !== Node.ELEMENT_NODE) continue;
        var text = (added[a].textContent || '').toLowerCase().trim();
        for (var i = 0; i < TB.SUCCESS_TEXTS.length; i++) {
          if (text.includes(TB.SUCCESS_TEXTS[i])) return true;
        }
      }
    }
    return false;
  };

  // ─── Subreddit Extraction ──────────────────────────────
  TB.extractSubreddit = function (button) {
    if (!button) return null;
    var regex = /\/r\/([a-zA-Z0-9_]+)/i;
    var cardSelectors = [
      '[class*="task"]', '[class*="card"]', '[class*="item"]',
      '[class*="row"]', '[class*="job"]', '[class*="listing"]',
      'tr', 'li', 'article', 'section',
      '[role="listitem"]', '[role="row"]',
    ];

    var root = null;
    for (var c = 0; c < cardSelectors.length; c++) {
      var container = button.closest(cardSelectors[c]);
      if (container) { root = container; break; }
    }
    if (!root) {
      root = button;
      for (var i = 0; i < 6 && root.parentElement; i++) root = root.parentElement;
    }

    // 1. Links with /r/
    var links = root.querySelectorAll('a[href*="/r/"]');
    for (var l = 0; l < links.length; l++) {
      var lm = links[l].href.match(regex);
      if (lm) return lm[1].toLowerCase();
    }

    // 2. Leaf text nodes
    var allEls = root.querySelectorAll('*');
    for (var e = 0; e < allEls.length; e++) {
      if (allEls[e].children.length === 0) {
        var tm = (allEls[e].textContent || '').trim().match(/(?:^|\s)r\/([a-zA-Z0-9_]+)(?:\s|$)/i);
        if (tm) return tm[1].toLowerCase();
      }
    }

    // 3. innerHTML
    var hm = (root.innerHTML || '').match(/(?:>|\s|'|")r\/([a-zA-Z0-9_]+)(?=<|\s|'|")/i);
    if (hm) return hm[1].toLowerCase();

    // 4-5. textContent fallbacks
    var tc = root.textContent || '';
    var tcm = tc.match(/\br\/([a-zA-Z0-9_]+)\b/i);
    if (tcm) return tcm[1].toLowerCase();
    var bm = tc.match(/r\/([a-zA-Z0-9_]{3,21})/i);
    if (bm) return bm[1].toLowerCase();

    // 6. Global sweep
    var allLinks = document.querySelectorAll('a[href*="/r/"]');
    for (var g = 0; g < allLinks.length; g++) {
      var gm = allLinks[g].href.match(regex);
      if (gm) return gm[1].toLowerCase();
    }
    return null;
  };
})();
