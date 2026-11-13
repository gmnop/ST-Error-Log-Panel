/**
 * Error log panel store.
 *
 * Keeps the in-memory record list, de-duplicates related failures coming from
 * fetch / toastr / unhandledrejection / SSE sniffing, redacts secrets and
 * persists a capped history to localStorage.
 *
 * This module deliberately avoids touching browser globals at import time so
 * its pure helpers can also be exercised from Node.
 */

import { diagnose, formatDiagnosis } from './diagnose.js';

export const SETTINGS_KEY = 'stErrorLogPanel';
export const ENTRIES_KEY = 'stErrPanel.entries.v1';
export const UI_KEY = 'stErrPanel.ui.v1';
export const MAX_BODY_CHARS = 8192;
export const DEDUPE_WINDOW_MS = 8000;
export const FLOOD_WINDOW_MS = 60_000;
export const FLOOD_SIMILARITY = 0.5;

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    captureHttp: true,
    captureToastr: true,
    captureSse: true,
    captureSuccessErrors: true,
    captureStatusChecks: true,
    captureConsoleError: false,
    captureConsoleWarn: false,
    captureWindowError: true,
    captureUnhandled: true,
    captureUserAborts: false,
    watchPending: true,
    pendingTimeoutSec: 60,
    watchStreamIdle: true,
    streamIdleSec: 60,
    maxEntries: 200,
    persist: true,
    defaultCollapsed: false,
    autoExpandOnError: true,
    notifyOnError: true,
    showDiagnosis: true,
    diagInline: true,
});

const LEVEL_RANK = { info: 1, warn: 2, error: 3 };
const SOURCE_RANK = { console: 1, toastr: 2, js: 2, unhandled: 2, network: 3, watchdog: 3, sse: 4, http: 5 };

const REDACT_PATTERNS = [
    [/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***'],
    [/\bAIza[0-9A-Za-z_-]{20,}\b/g, 'AIza***'],
    [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
    [/\b(Authorization\s*:\s*)(?!Bearer\b)[A-Za-z0-9._~+/=-]{6,}/gi, '$1***'],
    [
        /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)(\s*[:=]\s*["']?)([^\s"',;}]{6,})/gi,
        '$1$2***',
    ],
];

/**
 * Adds missing default settings to the SillyTavern extension settings object.
 * @param {object} context SillyTavern context
 * @returns {object} Live settings object
 */
export function initSettings(context) {
    const extensionSettings = context?.extensionSettings;
    if (!extensionSettings || typeof extensionSettings !== 'object') {
        return { ...DEFAULT_SETTINGS };
    }

    if (!extensionSettings[SETTINGS_KEY] || typeof extensionSettings[SETTINGS_KEY] !== 'object') {
        extensionSettings[SETTINGS_KEY] = {};
    }

    const settings = extensionSettings[SETTINGS_KEY];
    let changed = false;
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) {
            settings[key] = value;
            changed = true;
        }
    }

    if (changed) {
        try {
            context.saveSettingsDebounced?.();
        } catch {
            // Saving defaults is best-effort.
        }
    }

    return settings;
}

/**
 * Replaces common API key / token shapes with a marker.
 * @param {unknown} value
 * @param {number} maxLen
 * @returns {string}
 */
export function redactText(value, maxLen = MAX_BODY_CHARS) {
    let text = value === null || value === undefined ? '' : String(value);
    for (const [pattern, replacement] of REDACT_PATTERNS) {
        text = text.replace(pattern, replacement);
    }
    if (Number.isFinite(maxLen) && text.length > maxLen) {
        text = text.slice(0, maxLen) + '\n…(已截断)';
    }
    return text;
}

/**
 * Normalizes a message for comparison.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeText(value) {
    return String(value ?? '')
        .replace(/\u001b\[[0-9;]*m/g, '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/** @param {string} text @returns {Set<string>} */
function bigramSet(text) {
    const value = normalizeText(text).replace(/\s+/g, '');
    const set = new Set();
    if (value.length < 2) {
        if (value) set.add(value);
        return set;
    }
    for (let i = 0; i < value.length - 1; i++) {
        set.add(value.slice(i, i + 2));
    }
    return set;
}

/**
 * Dice-like bigram similarity in [0, 1]. Works for Chinese and English.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function similarity(a, b) {
    const left = bigramSet(a);
    const right = bigramSet(b);
    if (!left.size || !right.size) return 0;
    let intersection = 0;
    for (const item of left) {
        if (right.has(item)) intersection++;
    }
    return intersection / (left.size + right.size - intersection);
}

/**
 * Pretty-prints JSON where possible and caps the result.
 * @param {string|null|undefined} text
 * @param {number} maxLen
 * @returns {string|null}
 */
export function excerptBody(text, maxLen = MAX_BODY_CHARS) {
    if (text === null || text === undefined || text === '') return null;
    let output = String(text);
    try {
        output = JSON.stringify(JSON.parse(output), null, 2);
    } catch {
        // Not JSON: keep the raw text.
    }
    return redactText(output, maxLen);
}

/** @param {unknown} value @returns {string|null} */
function pickMessage(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value.trim() ? value : null;
    if (typeof value === 'number' || typeof value === 'boolean') return null;
    if (Array.isArray(value)) {
        for (const item of value) {
            const message = pickMessage(item);
            if (message) return message;
        }
        return null;
    }
    if (typeof value === 'object') {
        return (
            pickMessage(value.message) ||
            pickMessage(value.detail) ||
            pickMessage(value.error) ||
            pickMessage(value.code) ||
            pickMessage(value.type) ||
            null
        );
    }
    return null;
}

/** @param {unknown} value @returns {number|null} */
function pickCode(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'string') return Number.isFinite(Number(value)) ? Number(value) : null;
    if (typeof value === 'object') {
        return pickCode(value.code) ?? pickCode(value.status) ?? pickCode(value.statusCode);
    }
    return null;
}

/**
 * Mirrors SillyTavern's idea of an error payload: a 200 response can still
 * carry `{ error, detail, message }` at the top level.
 * @param {unknown} data Parsed JSON value
 * @returns {{message: string, code: number|null, type: string|null}|null}
 */
export function errorFromData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

    const hasChoices =
        Array.isArray(data.choices) ||
        Array.isArray(data.results) ||
        typeof data.content === 'string' ||
        typeof data.text === 'string';

    if (data.error) {
        return {
            message: pickMessage(data.error) || 'API 返回错误（无详细信息）',
            code: pickCode(data.error) ?? pickCode(data.code),
            type: data.error?.type ?? data.type ?? null,
        };
    }

    if (data.detail) {
        const message = pickMessage(data.detail);
        if (message) {
            return {
                message,
                code: pickCode(data.detail) ?? pickCode(data.code),
                type: data.detail?.type ?? data.type ?? null,
            };
        }
    }

    if (!hasChoices && typeof data.message === 'string' && data.message.trim()) {
        return {
            message: data.message,
            code: pickCode(data.code),
            type: data.type ?? null,
        };
    }

    return null;
}

/**
 * Parses a response body into an error summary if it contains one.
 * @param {string|null|undefined} text
 * @returns {{message: string, code: number|null, type: string|null}|null}
 */
export function extractErrorPayload(text) {
    if (!text) return null;
    try {
        return errorFromData(JSON.parse(text));
    } catch {
        return null;
    }
}

/** @param {unknown} value @param {number} maxLen @returns {string} */
export function safeStringify(value, maxLen = 4000) {
    const seen = new WeakSet();
    try {
        const text = JSON.stringify(value, (_key, item) => {
            if (typeof item === 'object' && item !== null) {
                if (seen.has(item)) return '[Circular]';
                seen.add(item);
            }
            if (typeof item === 'bigint') return String(item);
            return item;
        });
        return redactText(text ?? String(value), maxLen);
    } catch {
        return redactText(String(value), maxLen);
    }
}

/** @param {string} message @returns {boolean} */
function isGenericMessage(message) {
    const normalized = normalizeText(message);
    if (!normalized || normalized.length < 4) return true;
    return /^(unknown error|error|an error occurred|request failed|failed to fetch|networkerror when attempting to fetch resource\.?|got response status \d+|http \d+|http error|\d{3})$/.test(
        normalized,
    );
}

/** @param {string} level @param {string} other @returns {string} */
function maxLevel(level, other) {
    return (LEVEL_RANK[other] || 0) > (LEVEL_RANK[level] || 0) ? other : level;
}

/**
 * Redacts every string-ish value in a details object.
 * @param {object|null|undefined} details
 * @returns {object}
 */
function sanitizeDetails(details) {
    const output = {};
    for (const [key, value] of Object.entries(details || {})) {
        if (value === null || value === undefined) {
            output[key] = value;
            continue;
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
            output[key] = value;
            continue;
        }
        if (key === 'headers' && typeof value === 'object') {
            const headers = {};
            for (const [header, headerValue] of Object.entries(value)) {
                headers[header] = redactText(headerValue, 300);
            }
            output[key] = headers;
            continue;
        }
        if (Array.isArray(value)) {
            output[key] = value
                .slice(0, 20)
                .map((item) => redactText(typeof item === 'string' ? item : safeStringify(item, 1000), 1000));
            continue;
        }
        output[key] = typeof value === 'string' ? redactText(value, MAX_BODY_CHARS) : redactText(safeStringify(value, 2000), 2000);
    }
    return output;
}

let sequence = 0;

/** @param {number} now @returns {string} */
function nextId(now) {
    sequence = (sequence + 1) % 1_000_000;
    return `e_${now}_${sequence}`;
}

/**
 * @param {object} partial
 * @param {number} now
 * @returns {object}
 */
function normalizeEntry(partial, now) {
    const source = partial.source || 'http';
    const sources = Array.from(new Set([...(Array.isArray(partial.sources) ? partial.sources : []), source]));
    return {
        id: partial.id || nextId(now),
        ts: Number(partial.ts) || now,
        lastTs: Number(partial.lastTs) || now,
        level: ['error', 'warn', 'info'].includes(partial.level) ? partial.level : 'error',
        source,
        sources,
        title: redactText(partial.title || '错误', 200),
        message: redactText(partial.message || '', 1000),
        count: Math.max(1, Number(partial.count) || 1),
        unread: partial.unread !== false,
        details: sanitizeDetails(partial.details),
    };
}

/** @param {object} target @param {object} incoming @returns {object} */
function mergeDetails(target, incoming) {
    const output = { ...(target || {}) };
    for (const [key, value] of Object.entries(incoming || {})) {
        if (value === null || value === undefined || value === '') continue;
        if (output[key] === null || output[key] === undefined || output[key] === '') {
            output[key] = value;
            continue;
        }
        if (key === 'headers' && typeof value === 'object') {
            output[key] = { ...(output[key] || {}), ...value };
            continue;
        }
        if ((key === 'bodyExcerpt' || key === 'stack') && String(value).length > String(output[key]).length) {
            output[key] = value;
        }
    }
    return output;
}

/** @param {number} bytes @returns {string} */
export function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '未知';
    if (value < 1024) return `${Math.round(value)}B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
    return `${(value / (1024 * 1024)).toFixed(1)}MB`;
}

/** @param {number} ms @returns {string} */
export function formatDuration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return '未知';
    if (value < 1000) return `${Math.round(value)}ms`;
    if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
    return `${(value / 60_000).toFixed(1)}min`;
}

/**
 * Manages the record list and its persisted UI/history state.
 */
export class ErrorStore {
    /**
     * @param {{settings: object, onChange?: (event: object) => void}} options
     */
    constructor({ settings, onChange } = {}) {
        this.settings = settings || { ...DEFAULT_SETTINGS };
        this.onChange = typeof onChange === 'function' ? onChange : () => {};
        /** @type {object[]} */
        this.entries = [];
        this.ui = { collapsed: null, x: null, y: null };
        this._saveTimer = null;
        this._notifyScheduled = false;
        this._pendingEvent = null;
    }

    /** @returns {Storage|null} */
    get _storage() {
        try {
            return typeof localStorage === 'undefined' ? null : localStorage;
        } catch {
            return null;
        }
    }

    /** @returns {number} */
    get maxEntries() {
        return Math.max(10, Math.min(1000, Number(this.settings.maxEntries) || 200));
    }

    /** Loads persisted records and UI state. */
    load() {
        const storage = this._storage;
        if (storage) {
            try {
                const ui = JSON.parse(storage.getItem(UI_KEY) || 'null');
                if (ui && typeof ui === 'object') {
                    this.ui.collapsed = typeof ui.collapsed === 'boolean' ? ui.collapsed : null;
                    this.ui.x = Number.isFinite(ui.x) ? ui.x : null;
                    this.ui.y = Number.isFinite(ui.y) ? ui.y : null;
                }
            } catch {
                // Ignore corrupt UI state.
            }
        }

        if (this.settings.persist !== false && storage) {
            try {
                const raw = JSON.parse(storage.getItem(ENTRIES_KEY) || '[]');
                if (Array.isArray(raw)) {
                    const loaded = raw.map((entry) => normalizeEntry(entry, Number(entry?.ts) || Date.now()));
                    this.entries = this._compact(loaded).slice(0, this.maxEntries);
                }
            } catch {
                // Ignore corrupt history.
            }
        }

        if (this.ui.collapsed === null) {
            this.ui.collapsed = !!this.settings.defaultCollapsed;
        }
    }

    /**
     * Collapses previously persisted duplicates (same status + path + message)
     * so a flood that happened before an update does not keep filling the panel.
     * @param {object[]} entries
     * @returns {object[]}
     */
    _compact(entries) {
        const result = [];
        for (const entry of entries) {
            const status = entry.details?.status ?? null;
            const path = entry.details?.path || '';
            const message = normalizeText(entry.message);
            const match = result.find((candidate) => {
                const candidateStatus = candidate.details?.status ?? null;
                const candidatePath = candidate.details?.path || '';
                return candidateStatus === status && candidatePath === path && normalizeText(candidate.message) === message;
            });

            if (!match) {
                result.push(entry);
                continue;
            }

            match.count += entry.count;
            match.ts = Math.min(match.ts, entry.ts);
            match.lastTs = Math.max(match.lastTs, entry.lastTs);
            match.level = maxLevel(match.level, entry.level);
            match.sources = Array.from(new Set([...(match.sources || []), ...(entry.sources || [])]));
            match.details = mergeDetails(match.details, entry.details);
            match.unread = match.unread || entry.unread;
        }
        return result;
    }

    /**
     * Adds a record, merging it into a recent related one when possible.
     * @param {object} partial
     * @param {{now?: number}} [options]
     * @returns {object|null}
     */
    add(partial, options = {}) {
        if (!partial) return null;
        const now = options.now ?? Date.now();
        const entry = normalizeEntry(partial, now);
        const existing = this._findMergeCandidate(entry, now);

        if (existing) {
            this._merge(existing, entry, now);
            this.saveDebounced();
            this._notify({ reason: 'add', entry: existing });
            return existing;
        }

        this.entries.unshift(entry);
        this._cap();
        this.saveDebounced();
        this._notify({ reason: 'add', entry });
        return entry;
    }

    /**
     * Updates an existing record in place (used by watchdogs / stream recovery).
     * @param {string} id
     * @param {{level?: string, title?: string, message?: string, details?: object}} patch
     * @returns {object|null}
     */
    update(id, patch = {}) {
        const entry = this.entries.find((item) => item.id === id);
        if (!entry) return null;

        if (patch.level) entry.level = patch.level;
        if (patch.source && (SOURCE_RANK[patch.source] || 0) > (SOURCE_RANK[entry.source] || 0)) {
            entry.source = patch.source;
            entry.sources = Array.from(new Set([...(entry.sources || []), patch.source]));
        }
        if (patch.title) entry.title = redactText(patch.title, 200);
        if (patch.message) entry.message = redactText(patch.message, 1000);
        if (patch.details) entry.details = mergeDetails(entry.details, sanitizeDetails(patch.details));
        entry.lastTs = Date.now();
        entry.unread = true;

        this.saveDebounced();
        this._notify({ reason: 'update', entry });
        return entry;
    }

    /** @param {number} now @param {object} candidate @returns {object|null} */
    _findMergeCandidate(candidate, now) {
        const networkFamily = ['http', 'network', 'watchdog', 'sse'];
        const bothNetwork = networkFamily.includes(candidate.source);

        for (const entry of this.entries) {
            const age = now - entry.lastTs;
            const floodWindow = entry.details?.streamStage === 'status-check' ? 5 * 60_000 : FLOOD_WINDOW_MS;
            if (age > floodWindow) continue;
            if (entry.lastTs > now + 2000) continue;

            const requestId = candidate.details?.requestId;
            const entryRequestId = entry.details?.requestId;
            const sameRequest = requestId && entryRequestId && requestId === entryRequestId;
            if (sameRequest) return entry;

            const entryIsNetwork = networkFamily.includes(entry.source);
            const samePath = entry.details?.path && entry.details.path === candidate.details?.path;
            const entryStatus = entry.details?.status;
            const candidateStatus = candidate.details?.status;
            const sameStatus =
                entryStatus !== null && entryStatus !== undefined && entryStatus === candidateStatus;
            const hasAnyStatus =
                (entryStatus !== null && entryStatus !== undefined) ||
                (candidateStatus !== null && candidateStatus !== undefined);
            const statusCompatible = !hasAnyStatus || sameStatus;
            const statusesMatch = sameStatus || (!hasAnyStatus);

            const left = normalizeText(entry.message);
            const right = normalizeText(candidate.message);
            const messageMatch =
                (left && right && left.length >= 12 && right.length >= 12 && (left === right || left.includes(right) || right.includes(left))) ||
                (left && right && similarity(left, right) >= FLOOD_SIMILARITY);

            // Flood aggregation: repeated 5xx/524 responses for the same
            // endpoint and same message are one incident, even when each
            // attempt has a different requestId. This keeps a failing upstream
            // from filling the panel with hundreds of near-identical cards.
            if (bothNetwork && entryIsNetwork && samePath && statusesMatch && messageMatch) {
                return entry;
            }

            // Different requests must not be merged by the loose time/path
            // heuristics below. They are reserved for records without ids
            // (toastr / unhandled / watchdog) and for genuinely identical
            // request ids.
            const differentRequests = requestId && entryRequestId && requestId !== entryRequestId;
            if (differentRequests) continue;

            if (age > DEDUPE_WINDOW_MS) continue;

            if (bothNetwork && entryIsNetwork && samePath && statusesMatch) return entry;
            if (bothNetwork && entryIsNetwork && samePath && statusCompatible && age <= 4000) return entry;
            if (messageMatch && (!bothNetwork || statusCompatible)) return entry;
        }
        return null;
    }

    /** @param {object} target @param {object} incoming @param {number} now */
    _merge(target, incoming, now) {
        target.lastTs = now;
        target.count += incoming.count;
        target.sources = Array.from(new Set([...(target.sources || []), ...(incoming.sources || [])]));

        const levelUpgraded = (LEVEL_RANK[incoming.level] || 0) > (LEVEL_RANK[target.level] || 0);
        target.level = maxLevel(target.level, incoming.level);

        const sourceUpgraded = (SOURCE_RANK[incoming.source] || 0) > (SOURCE_RANK[target.source] || 0);
        if (sourceUpgraded) {
            target.source = incoming.source;
        }

        const promoted = sourceUpgraded || levelUpgraded;
        if ((promoted && incoming.message) || (isGenericMessage(target.message) && !isGenericMessage(incoming.message))) {
            target.message = incoming.message;
        }
        if ((promoted && incoming.title) || (isGenericMessage(target.title) && !isGenericMessage(incoming.title))) {
            target.title = incoming.title;
        }
        if (incoming.message && incoming.message !== target.message) {
            const related = Array.isArray(target.details.relatedMessages) ? target.details.relatedMessages : [];
            if (!related.includes(incoming.message) && related.length < 5) {
                target.details.relatedMessages = [...related, incoming.message];
            }
        }
        target.details = mergeDetails(target.details, incoming.details);
        target.unread = true;
    }

    /** @param {string} filter 'all'|'error'|'warn'|'info' @returns {object[]} */
    getFiltered(filter) {
        if (!filter || filter === 'all') return this.entries;
        return this.entries.filter((entry) => entry.level === filter);
    }

    /** @returns {{total: number, unread: number, error: number, warn: number, info: number}} */
    getCounts() {
        const counts = { total: this.entries.length, unread: 0, error: 0, warn: 0, info: 0 };
        for (const entry of this.entries) {
            if (entry.unread) counts.unread++;
            if (entry.level in counts) counts[entry.level]++;
        }
        return counts;
    }

    /** Marks every record as read without triggering an extra render. */
    markAllRead() {
        for (const entry of this.entries) entry.unread = false;
        this.saveDebounced();
    }

    /** Removes all records. */
    clear() {
        this.entries = [];
        this.saveNow();
        this._notify({ reason: 'clear' });
    }

    /** Applies the max record setting. */
    trim() {
        this._cap();
        this.saveNow();
        this._notify({ reason: 'change' });
    }

    _cap() {
        if (this.entries.length > this.maxEntries) {
            this.entries.length = this.maxEntries;
        }
    }

    saveDebounced() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this.saveNow();
        }, 400);
    }

    saveNow() {
        const storage = this._storage;
        if (!storage) return;

        if (this.settings.persist === false) {
            try {
                storage.removeItem(ENTRIES_KEY);
            } catch {
                // Best-effort only.
            }
            return;
        }

        this._cap();
        try {
            storage.setItem(ENTRIES_KEY, JSON.stringify(this.entries));
        } catch {
            // Quota exceeded: keep the newest half and retry once.
            try {
                this.entries = this.entries.slice(0, Math.max(10, Math.floor(this.entries.length / 2)));
                storage.setItem(ENTRIES_KEY, JSON.stringify(this.entries));
            } catch {
                // Give up silently.
            }
        }
    }

    saveUi() {
        const storage = this._storage;
        if (!storage) return;
        try {
            storage.setItem(UI_KEY, JSON.stringify({ collapsed: this.ui.collapsed, x: this.ui.x, y: this.ui.y }));
        } catch {
            // Best-effort only.
        }
    }

    flush() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        this.saveNow();
    }

    /** @param {object} event */
    _notify(event) {
        this._pendingEvent = event;
        if (this._notifyScheduled) return;
        this._notifyScheduled = true;

        const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (callback) => setTimeout(callback, 0);
        schedule(() => {
            this._notifyScheduled = false;
            const payload = this._pendingEvent || { reason: 'change' };
            this._pendingEvent = null;
            try {
                this.onChange(payload);
            } catch {
                // A broken UI listener must never break capture.
            }
        });
    }

    /**
     * Formats one record as plain text for copy/paste.
     * @param {object} entry
     * @returns {string}
     */
    formatEntry(entry) {
        if (!entry) return '';
        const details = entry.details || {};
        const time = new Date(entry.ts).toLocaleString('zh-CN', { hour12: false });
        const lines = [`[${time}] ${entry.title}`];

        const requestLine = [details.method, details.path].filter(Boolean).join(' ');
        if (requestLine) lines.push(requestLine);

        const meta = [];
        if (details.status) meta.push(`status=${details.status}${details.statusText ? ` ${details.statusText}` : ''}`);
        if (details.errorCode) meta.push(`code=${details.errorCode}`);
        if (details.durationMs !== null && details.durationMs !== undefined) meta.push(`耗时=${formatDuration(details.durationMs)}`);
        if (details.resolvedAfterMs) meta.push(`最终耗时=${formatDuration(details.resolvedAfterMs)}`);
        if (details.model) meta.push(`model=${details.model}`);
        if (details.stream !== null && details.stream !== undefined) meta.push(`stream=${details.stream}`);
        if (details.messageCount) meta.push(`messages=${details.messageCount}`);
        if (meta.length) lines.push(meta.join(' | '));

        if (entry.sources?.length) lines.push(`来源: ${entry.sources.join(' + ')}`);
        if (entry.count > 1) {
            const span = entry.lastTs > entry.ts ? ` / 持续 ${formatDuration(entry.lastTs - entry.ts)}` : '';
            lines.push(`重复: ×${entry.count}${span}`);
        }
        if (entry.message) lines.push(`消息: ${entry.message}`);

        if (this.settings?.showDiagnosis !== false) {
            const diagnosis = formatDiagnosis(diagnose(entry));
            if (diagnosis) lines.push(diagnosis);
        }
        if (details.toastrTitle) lines.push(`Toastr 标题: ${details.toastrTitle}`);
        if (Array.isArray(details.relatedMessages) && details.relatedMessages.length) {
            lines.push(`相关消息:\n${details.relatedMessages.join('\n')}`);
        }
        if (details.bodyExcerpt) {
            const note = details.bodyTruncated
                ? `（已截断，显示 ${formatBytes(MAX_BODY_CHARS)}${details.bodyTotalBytes ? ` / 总 ${formatBytes(details.bodyTotalBytes)}` : ''}）`
                : '';
            lines.push(`响应内容${note}:\n${details.bodyExcerpt}`);
        }
        if (details.headers && Object.keys(details.headers).length) {
            lines.push(`响应头: ${Object.entries(details.headers).map(([key, value]) => `${key}: ${value}`).join('; ')}`);
        }
        if (details.stack) lines.push(`堆栈:\n${details.stack}`);

        return lines.join('\n');
    }

    /** @returns {string} */
    formatAll() {
        if (!this.entries.length) return '（暂无错误记录）';
        return this.entries.map((entry) => this.formatEntry(entry)).join('\n\n---\n\n');
    }
}
