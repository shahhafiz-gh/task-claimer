/**
 * Popup Script — UI Controller v2 — "Accept First, Verify Later"
 *
 * Reads state from background, renders UI, handles user interactions.
 * NEW: BB Logs panel, BB Settings, cache management, export.
 */

(() => {
    'use strict';

    // ─── DOM References ──────────────────────────────────────────────
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
        // BB Settings (NEW)
        bbSettingsToggle: $('bbSettingsToggle'),
        bbSettingsChevron: $('bbSettingsChevron'),
        bbSettingsBody: $('bbSettingsBody'),
        bbTimeoutSlider: $('bbTimeoutSlider'),
        bbTimeoutValue: $('bbTimeoutValue'),
        bbTimeoutAction: $('bbTimeoutAction'),
        bbCacheDuration: $('bbCacheDuration'),
        bbMaxParallel: $('bbMaxParallel'),
    };

    // BB Logs elements (NEW)
    const bbElements = {
        bbLogsToggle: $('bbLogsToggle'),
        bbLogsChevron: $('bbLogsChevron'),
        bbLogsBody: $('bbLogsBody'),
        bbTableBody: $('bbTableBody'),
        bbTableContainer: $('bbTableContainer'),
        bbStatClaimed: $('bbStatClaimed'),
        bbStatSkipped: $('bbStatSkipped'),
        bbStatCache: $('bbStatCache'),
        bbClearLogsBtn: $('bbClearLogsBtn'),
        bbClearCacheBtn: $('bbClearCacheBtn'),
        bbExportBtn: $('bbExportBtn'),
        bbRefreshBtn: $('bbRefreshBtn'),
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

        // BB Settings
        elements.bbTimeoutSlider.value = state.bbCheckTimeoutMs || 1000;
        elements.bbTimeoutValue.textContent = `${state.bbCheckTimeoutMs || 1000}ms`;
        elements.bbTimeoutAction.value = state.bbTimeoutAction || 'submit';
        elements.bbCacheDuration.value = String(state.bbCacheDurationMs || 1800000);
        elements.bbMaxParallel.value = String(state.maxParallelChecks || 2);
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

    // ─── Time Formatting ────────────────────────────────────────────
    function formatRelativeTime(timestamp) {
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

    // BB Settings accordion
    elements.bbSettingsToggle.addEventListener('click', () => {
        const isOpen = elements.bbSettingsBody.classList.toggle('open');
        elements.bbSettingsChevron.classList.toggle('open', isOpen);
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

    // BB Timeout slider
    elements.bbTimeoutSlider.addEventListener('input', () => {
        elements.bbTimeoutValue.textContent = `${elements.bbTimeoutSlider.value}ms`;
    });
    elements.bbTimeoutSlider.addEventListener('change', () => {
        updateState({ bbCheckTimeoutMs: parseInt(elements.bbTimeoutSlider.value, 10) });
    });

    // BB Timeout Action
    elements.bbTimeoutAction.addEventListener('change', () => {
        updateState({ bbTimeoutAction: elements.bbTimeoutAction.value });
    });

    // BB Cache Duration
    elements.bbCacheDuration.addEventListener('change', () => {
        updateState({ bbCacheDurationMs: parseInt(elements.bbCacheDuration.value, 10) });
    });

    // BB Max Parallel
    elements.bbMaxParallel.addEventListener('change', () => {
        updateState({ maxParallelChecks: parseInt(elements.bbMaxParallel.value, 10) });
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

    // ═══════════════════════════════════════════════════════════════
    // ─── BB Logs Panel ───────────────────────────────────────────
    // ═══════════════════════════════════════════════════════════════

    // BB Logs accordion
    bbElements.bbLogsToggle.addEventListener('click', () => {
        const isOpen = bbElements.bbLogsBody.classList.toggle('open');
        bbElements.bbLogsChevron.classList.toggle('open', isOpen);
        if (isOpen) loadBBLogs();
    });

    /**
     * Status badge map
     */
    function getStatusBadge(status) {
        switch (status) {
            case 'safe': return '<span class="bb-badge bb-badge-safe">🟢 Safe</span>';
            case 'unsafe': return '<span class="bb-badge bb-badge-unsafe">🔴 BB Detected</span>';
            case 'pending': return '<span class="bb-badge bb-badge-pending">⏳ Pending</span>';
            case 'timeout': return '<span class="bb-badge bb-badge-timeout">⏱️ Timeout</span>';
            default: return '<span class="bb-badge bb-badge-unknown">❓ Unknown</span>';
        }
    }

    function getActionText(action) {
        switch (action) {
            case 'claimed': return 'Claimed ✓';
            case 'confirmed_safe': return 'Safe ✓';
            case 'skipped': return 'Skipped ✗';
            case 'bb_detected': return 'BB Found ✗';
            case 'check_error': return 'Error ✗';
            case 'checking': return 'Checking...';
            case 'submitted_on_timeout': return 'Submitted (timeout)';
            case 'aborted_on_timeout': return 'Aborted (timeout)';
            case 'aborted_timeout_strict': return 'Aborted (strict)';
            case 'aborted_not_safe': return 'Aborted ✗';
            case 'marked_unsafe_on_timeout': return 'Timeout → Unsafe';
            case 'no_subreddit_strict_abort': return 'No Sub → Abort';
            default: return action || '—';
        }
    }

    /**
     * Render BB logs into the table.
     */
    function renderBBLogs(bbLogs) {
        const tbody = bbElements.bbTableBody;

        if (!bbLogs || bbLogs.length === 0) {
            tbody.innerHTML = '<tr class="bb-empty-row"><td colspan="4" class="bb-empty">No checks recorded yet</td></tr>';
            return;
        }

        // Deduplicate: show latest entry per subreddit (but keep all for export)
        // Show newest first, max 50 rows
        const reversed = [...bbLogs].reverse().slice(0, 50);

        tbody.innerHTML = '';

        // Calculate stats
        let claimedCount = 0;
        let skippedCount = 0;
        for (const entry of bbLogs) {
            if (entry.action === 'claimed') claimedCount++;
            if (entry.action === 'skipped') skippedCount++;
        }
        bbElements.bbStatClaimed.textContent = claimedCount;
        bbElements.bbStatSkipped.textContent = skippedCount;

        for (const entry of reversed) {
            const tr = document.createElement('tr');
            tr.className = 'bb-log-row';

            tr.innerHTML = `
                <td class="bb-cell-sub">r/${entry.subreddit || 'unknown'}</td>
                <td class="bb-cell-status">${getStatusBadge(entry.status)}</td>
                <td class="bb-cell-time">${formatRelativeTime(entry.timestamp)}</td>
                <td class="bb-cell-action">${getActionText(entry.action)}</td>
            `;

            tbody.appendChild(tr);
        }
    }

    /**
     * Load BB logs from background.
     */
    function loadBBLogs() {
        chrome.runtime.sendMessage({ type: 'GET_BB_LOGS' }, (response) => {
            if (response?.bbLogs) {
                renderBBLogs(response.bbLogs);
            }
        });

        // Also load cache stats
        chrome.runtime.sendMessage({ type: 'GET_BB_CACHE_STATS' }, (response) => {
            if (response?.stats) {
                bbElements.bbStatCache.textContent = response.stats.entries;
            }
        });
    }

    // Clear BB logs
    bbElements.bbClearLogsBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'CLEAR_BB_LOGS' }, () => {
            renderBBLogs([]);
        });
    });

    // Clear BB cache
    bbElements.bbClearCacheBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'CLEAR_BB_CACHE' }, () => {
            bbElements.bbStatCache.textContent = '0';
            loadBBLogs();
        });
    });

    // Export BB logs
    bbElements.bbExportBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'GET_BB_LOGS' }, (response) => {
            const logs = response?.bbLogs || [];
            const data = JSON.stringify(logs, null, 2);
            const blob = new Blob([data], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `bb-logs-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
        });
    });

    // Refresh BB logs
    bbElements.bbRefreshBtn.addEventListener('click', loadBBLogs);

    // ═══════════════════════════════════════════════════════════════
    // ─── Activity Log ────────────────────────────────────────────
    // ═══════════════════════════════════════════════════════════════

    const logElements = {
        logToggle: $('logToggle'),
        logChevron: $('logChevron'),
        logBody: $('logBody'),
        logContainer: $('logContainer'),
        logEmpty: $('logEmpty'),
        logClearBtn: $('logClearBtn'),
        logRefreshBtn: $('logRefreshBtn'),
    };

    function renderLogs(logs) {
        if (!logs || logs.length === 0) {
            logElements.logContainer.innerHTML = '';
            logElements.logContainer.appendChild(logElements.logEmpty);
            logElements.logEmpty.style.display = 'block';
            return;
        }

        logElements.logEmpty.style.display = 'none';
        logElements.logContainer.innerHTML = '';

        const reversed = [...logs].reverse();

        for (const entry of reversed) {
            const row = document.createElement('div');
            row.className = 'log-entry';

            const time = document.createElement('span');
            time.className = 'log-time';
            time.textContent = formatRelativeTime(entry.timestamp);

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

    function loadLogs() {
        chrome.runtime.sendMessage({ type: 'GET_LOGS' }, (response) => {
            if (response?.logs) {
                renderLogs(response.logs);
            }
        });
    }

    function clearLogs() {
        chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' }, () => {
            renderLogs([]);
        });
    }

    // Log accordion
    logElements.logToggle.addEventListener('click', () => {
        const isOpen = logElements.logBody.classList.toggle('open');
        logElements.logChevron.classList.toggle('open', isOpen);
        if (isOpen) loadLogs();
    });

    logElements.logClearBtn.addEventListener('click', clearLogs);
    logElements.logRefreshBtn.addEventListener('click', loadLogs);

    // ─── Initialize ──────────────────────────────────────────────────
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
        if (response?.state) {
            renderState(response.state);
        }
    });

    loadLogs();
    loadBBLogs();
})();
