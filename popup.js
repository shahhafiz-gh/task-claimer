/**
 * Popup Script — UI Controller
 * Reads state from background, renders UI, handles user interactions.
 */

(() => {
    'use strict';

    // ─── DOM References (cached once) ────────────────────────────────
    const $ = (id) => document.getElementById(id);

    const elements = {
        masterToggle: $('masterToggle'),
        statusBar: $('statusBar'),
        statusDot: $('statusDot'),
        statusText: $('statusText'),
        totalClaimed: $('totalClaimed'),
        totalSkippedBotBouncer: $('totalSkippedBotBouncer'),
        lastCaptcha: $('lastCaptcha'),
        lastTask: $('lastTask'),
        lastSkippedSubreddit: $('lastSkippedSubreddit'),
        // Settings
        settingsToggle: $('settingsToggle'),
        settingsChevron: $('settingsChevron'),
        settingsBody: $('settingsBody'),
        claimSelector: $('claimSelector'),
        captchaSelector: $('captchaSelector'),
        captchaInputSelector: $('captchaInputSelector'),
        submitSelector: $('submitSelector'),
        delaySlider: $('delaySlider'),
        delayValue: $('delayValue'),
        soundToggle: $('soundToggle'),
        safeModeToggle: $('safeModeToggle'),
        botBouncerToggle: $('botBouncerToggle'),
    };

    // ─── Render State ────────────────────────────────────────────────

    function renderState(state) {
        if (!state) return;

        // Toggle
        elements.masterToggle.checked = state.enabled;

        // Status bar
        const isActive = state.enabled;
        elements.statusBar.className = `status-bar ${isActive ? 'active' : 'paused'}`;
        elements.statusDot.className = `status-dot ${isActive ? 'active' : ''}`;
        elements.statusText.textContent = isActive ? 'Active — Monitoring' : 'Paused';

        // Stats
        elements.totalClaimed.textContent = state.totalClaimed || '0';
        elements.totalSkippedBotBouncer.textContent = state.totalSkippedBotBouncer || '0';
        elements.lastCaptcha.textContent = state.lastCaptchaSolved || '—';
        elements.lastTask.textContent = state.lastTaskClaimed || 'No tasks claimed yet';
        elements.lastSkippedSubreddit.textContent = state.lastSkippedSubreddit
            ? `r/${state.lastSkippedSubreddit}`
            : '—';

        // Settings inputs
        elements.claimSelector.value = state.claimSelector || '';
        elements.captchaSelector.value = state.captchaSelector || '';
        elements.captchaInputSelector.value = state.captchaInputSelector || '';
        elements.submitSelector.value = state.submitSelector || '';
        elements.delaySlider.value = state.delayMs || 0;
        elements.delayValue.textContent = `${state.delayMs || 0}ms`;
        elements.soundToggle.checked = state.soundEnabled ?? true;
        elements.safeModeToggle.checked = state.safeModeEnabled ?? false;
        elements.botBouncerToggle.checked = state.botBouncerCheckEnabled ?? true;
    }

    // ─── Send State Update ──────────────────────────────────────────

    function updateState(partial) {
        chrome.runtime.sendMessage(
            { type: 'SET_STATE', payload: partial },
            (response) => {
                if (response?.state) {
                    renderState(response.state);
                }
            }
        );
    }

    // ─── Debounce Helper ────────────────────────────────────────────

    function debounce(fn, ms = 300) {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), ms);
        };
    }

    // ─── Event Listeners ────────────────────────────────────────────

    // Master toggle
    elements.masterToggle.addEventListener('change', () => {
        chrome.runtime.sendMessage({ type: 'TOGGLE_ENABLED' }, (response) => {
            if (response?.state) {
                renderState(response.state);
            }
        });
    });

    // Settings accordion
    elements.settingsToggle.addEventListener('click', () => {
        const isOpen = elements.settingsBody.classList.toggle('open');
        elements.settingsChevron.classList.toggle('open', isOpen);
    });

    // Delay slider (live update)
    elements.delaySlider.addEventListener('input', () => {
        elements.delayValue.textContent = `${elements.delaySlider.value}ms`;
    });

    elements.delaySlider.addEventListener('change', () => {
        updateState({ delayMs: parseInt(elements.delaySlider.value, 10) });
    });

    // Sound toggle
    elements.soundToggle.addEventListener('change', () => {
        updateState({ soundEnabled: elements.soundToggle.checked });
    });

    // Safe mode toggle
    elements.safeModeToggle.addEventListener('change', () => {
        updateState({ safeModeEnabled: elements.safeModeToggle.checked });
    });

    // BotBouncer toggle
    elements.botBouncerToggle.addEventListener('change', () => {
        updateState({ botBouncerCheckEnabled: elements.botBouncerToggle.checked });
    });

    // Custom selector inputs (debounced save)
    const selectorFields = [
        { el: elements.claimSelector, key: 'claimSelector' },
        { el: elements.captchaSelector, key: 'captchaSelector' },
        { el: elements.captchaInputSelector, key: 'captchaInputSelector' },
        { el: elements.submitSelector, key: 'submitSelector' },
    ];

    for (const { el, key } of selectorFields) {
        el.addEventListener('input', debounce(() => {
            updateState({ [key]: el.value.trim() });
        }, 500));
    }
    // ─── Activity Log ────────────────────────────────────────────────

    const logElements = {
        logToggle: $('logToggle'),
        logChevron: $('logChevron'),
        logBody: $('logBody'),
        logContainer: $('logContainer'),
        logEmpty: $('logEmpty'),
        logClearBtn: $('logClearBtn'),
        logRefreshBtn: $('logRefreshBtn'),
    };

    /**
     * Format a timestamp into a short relative or time string.
     */
    function formatLogTime(timestamp) {
        const now = Date.now();
        const diff = now - timestamp;

        if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;

        const d = new Date(timestamp);
        const h = d.getHours().toString().padStart(2, '0');
        const m = d.getMinutes().toString().padStart(2, '0');
        const s = d.getSeconds().toString().padStart(2, '0');
        return `${h}:${m}:${s}`;
    }

    /**
     * Render log entries into the log container.
     */
    function renderLogs(logs) {
        if (!logs || logs.length === 0) {
            logElements.logContainer.innerHTML = '';
            logElements.logContainer.appendChild(logElements.logEmpty);
            logElements.logEmpty.style.display = 'block';
            return;
        }

        logElements.logEmpty.style.display = 'none';
        logElements.logContainer.innerHTML = '';

        // Show newest first (reverse)
        const reversed = [...logs].reverse();

        for (const entry of reversed) {
            const row = document.createElement('div');
            row.className = 'log-entry';

            const time = document.createElement('span');
            time.className = 'log-time';
            time.textContent = formatLogTime(entry.timestamp);

            const dot = document.createElement('span');
            dot.className = `log-dot ${entry.level}`;

            const msg = document.createElement('span');
            msg.className = 'log-message';
            msg.textContent = entry.message;

            row.appendChild(time);
            row.appendChild(dot);
            row.appendChild(msg);
            logElements.logContainer.appendChild(row);
        }
    }

    /**
     * Fetch logs from background and render.
     */
    function loadLogs() {
        chrome.runtime.sendMessage({ type: 'GET_LOGS' }, (response) => {
            if (response?.logs) {
                renderLogs(response.logs);
            }
        });
    }

    /**
     * Clear all logs.
     */
    function clearLogs() {
        chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' }, () => {
            renderLogs([]);
        });
    }

    // Log accordion
    logElements.logToggle.addEventListener('click', () => {
        const isOpen = logElements.logBody.classList.toggle('open');
        logElements.logChevron.classList.toggle('open', isOpen);
        if (isOpen) loadLogs(); // Refresh on open
    });

    // Clear button
    logElements.logClearBtn.addEventListener('click', clearLogs);

    // Refresh button
    logElements.logRefreshBtn.addEventListener('click', loadLogs);

    // ─── Initialize ──────────────────────────────────────────────────

    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
        if (response?.state) {
            renderState(response.state);
        }
    });

    // Load logs on startup
    loadLogs();
})();
