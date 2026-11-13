/**
 * Capture layer: fetch, toastr, window errors, console (optional) and SSE.
 *
 * All observation is best-effort. Nothing in this file may delay, replace or
 * re-issue a request, and every observer swallows its own errors.
 */

import { errorFromData, excerptBody, extractErrorPayload, formatDuration, redactText, safeStringify } from './store.js';

const PENDING_CHECK_MS = 2000;
const BODY_LIMIT = 8 * 1024;
const SUCCESS_BODY_LIMIT = 512 * 1024;
const SSE_TOTAL_LIMIT = 8 * 1024 * 1024;
const SSE_BUFFER_LIMIT = 256 * 1024;
const READ_TIMEOUT_MS = 10_000;
const USER_ABORT_WINDOW_MS = 3000;
const MAX_PENDING_AGE_MS = 30 * 60 * 1000;

const BINARY_CONTENT_TYPE =
    /^(image|audio|video)\/|application\/(octet-stream|zip|pdf|gzip|x-?tar|wasm)/i;

const DIAGNOSTIC_HEADERS = new Set([
    'retry-after',
    'x-request-id',
    'request-id',
    'cf-ray',
    'server',
    'via',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'x-ratelimit-requests-remaining',
    'x-ratelimit-tokens-remaining',
    'x-should-retry',
]);

const NOISE_PATTERN =
    /ResizeObserver loop (limit exceeded|completed with undelivered notifications)|^Script error\.?$/i;

const ERROR_TEXT_PATTERN =
    /error|exception|timeout|timed out|failed|failure|invalid|unauthorized|forbidden|unavailable|overloaded|rate.?limit|quota|bad gateway|service unavailable|internal server/i;

const HTTP_STATUS_LABELS = {
    400: '请求错误',
    401: '未授权',
    403: '禁止访问',
    404: '未找到',
    408: '请求超时',
    409: '冲突',
    413: '请求体过大',
    422: '参数错误',
    429: '请求过多',
    500: '服务器内部错误',
    502: '网关错误',
    503: '服务不可用',
    504: '网关超时',
    520: 'Cloudflare 未知错误',
    521: '源站不可用',
    522: '连接超时',
    523: '源站不可达',
    524: '上游超时',
    525: 'SSL 握手失败',
    526: 'SSL 证书无效',
    530: 'DNS 错误',
};

/** @param {number} status @param {string} statusText @returns {string} */
function httpTitle(status, statusText) {
    const label = HTTP_STATUS_LABELS[status];
    if (label) return `HTTP ${status} ${label}`;
    return `HTTP ${status}${statusText ? ` ${statusText}` : ''}`.trim();
}

/**
 * Cloudflare / Caddy error pages are HTML. Pull a readable title out of them
 * instead of showing the raw markup as the main message.
 * @param {string|null} html
 * @returns {string|null}
 */
function extractHtmlSummary(html) {
    if (!html || !/<(?:!doctype|html|head|body)\b/i.test(html)) return null;

    const clean = (value) => value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    if (title) {
        const text = clean(title);
        if (text) return redactText(text, 300);
    }

    const heading = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
    if (heading) {
        const text = clean(heading);
        if (text) return redactText(text, 300);
    }

    const code = html.match(/(?:Error code|error code|错误代码)\s*[:：]?\s*(\d{3})/i)?.[1];
    return code ? `HTML 错误页（错误码 ${code}）` : null;
}

/** @param {string|null} text @returns {boolean} */
function isEsaBlockPage(text) {
    return /Performance\s*&\s*Security\s+by\s+ESA|Denied by http_custom|X-Tengine-Error|阿里云\s*ESA/i.test(String(text || ''));
}

/** @param {string|null} text @returns {string|null} */
function extractEsaRule(text) {
    const rule = String(text || '').match(/RuleID\s*[:：]?\s*(\d+)/i)?.[1];
    return rule ? `RuleID ${rule}` : null;
}

/**
 * Installs all capture hooks.
 * @param {{store: import('./store.js').ErrorStore, settings: object, runtime: {paused: boolean, unloading: boolean}}} options
 * @returns {{state: object, cleanup: () => void}}
 */
export function installCapture({ store, settings, runtime }) {
    if (window.__stelpCaptureInstalled) {
        return window.__stelpCaptureInstalled;
    }

    const state = {
        pending: new Map(),
        streams: new Map(),
        userAbortedSignals: new WeakSet(),
        lastUserAbortAt: 0,
    };

    const isActive = () => !!settings.enabled && !runtime?.paused;
    const isRecentUserAbort = () => Date.now() - state.lastUserAbortAt <= USER_ABORT_WINDOW_MS;

    // ---------------------------------------------------------------------
    // AbortController classification
    // ---------------------------------------------------------------------
    function patchAbortController() {
        try {
            const prototype = AbortController.prototype;
            if (prototype.__stelpPatched) return;
            const originalAbort = prototype.abort;
            prototype.abort = function patchedAbort(...args) {
                try {
                    state.userAbortedSignals.add(this.signal);
                    state.lastUserAbortAt = Date.now();
                } catch {
                    // Ignore exotic controller implementations.
                }
                return Reflect.apply(originalAbort, this, args);
            };
            Object.defineProperty(prototype, '__stelpPatched', { value: true, configurable: true });
        } catch {
            // Abort classification is optional.
        }
    }

    // ---------------------------------------------------------------------
    // Request metadata helpers
    // ---------------------------------------------------------------------
    function summarizeRequestBody(body) {
        const summary = { model: null, stream: null, messageCount: null };
        if (typeof body !== 'string' || body.length > 1_000_000) return summary;
        try {
            const data = JSON.parse(body);
            if (data && typeof data === 'object') {
                if (typeof data.model === 'string') summary.model = data.model;
                if (typeof data.stream === 'boolean') summary.stream = data.stream;
                if (Array.isArray(data.messages)) summary.messageCount = data.messages.length;
                else if (typeof data.prompt === 'string') summary.messageCount = 1;
            }
        } catch {
            // Non-JSON bodies are ignored.
        }
        return summary;
    }

    function makeMeta(args) {
        try {
            const input = args[0];
            const init = args[1];
            let rawUrl;
            let method;
            let signal = null;
            let body;

            if (typeof Request !== 'undefined' && input instanceof Request) {
                rawUrl = input.url;
                method = init?.method || input.method || 'GET';
                signal = init?.signal || input.signal || null;
            } else {
                rawUrl = typeof input === 'string' ? input : String(input?.url ?? input);
                method = init?.method || 'GET';
                signal = init?.signal || null;
                body = init?.body;
            }

            const url = new URL(rawUrl, location.href);
            if (url.origin !== location.origin) return null;
            if (!url.pathname.startsWith('/api/')) return null;

            const summary = summarizeRequestBody(body);
            return {
                requestId: `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                path: url.pathname,
                method: String(method).toUpperCase(),
                start: performance.now(),
                startedAt: Date.now(),
                signal,
                model: summary.model,
                stream: summary.stream,
                messageCount: summary.messageCount,
                warned: false,
                entryId: null,
            };
        } catch {
            return null;
        }
    }

    function pickHeaders(headers) {
        const output = {};
        try {
            for (const [key, value] of headers.entries()) {
                if (DIAGNOSTIC_HEADERS.has(key.toLowerCase())) {
                    output[key] = redactText(value, 300);
                }
            }
        } catch {
            // Headers are optional diagnostics.
        }
        return Object.keys(output).length ? output : null;
    }

    function baseDetails(meta, headerMs, response, contentType) {
        return {
            status: response?.status ?? null,
            statusText: response?.statusText ?? '',
            method: meta.method,
            path: meta.path,
            durationMs: Number.isFinite(headerMs) ? Math.round(headerMs) : null,
            requestId: meta.requestId,
            contentType: contentType || null,
            model: meta.model,
            stream: meta.stream,
            messageCount: meta.messageCount,
            headers: response ? pickHeaders(response.headers) : null,
        };
    }

    // ---------------------------------------------------------------------
    // Body reading
    // ---------------------------------------------------------------------
    /**
     * Reads at most maxBytes from a cloned response body.
     * @param {Response} response
     * @param {number} maxBytes
     * @param {string} contentType
     * @returns {Promise<string|null>}
     */
    async function readCapped(response, maxBytes, contentType) {
        if (BINARY_CONTENT_TYPE.test(contentType || '')) return null;

        let clone;
        try {
            clone = response.clone();
        } catch {
            return null;
        }

        if (!clone.body) {
            try {
                const text = await clone.text();
                return text ? text.slice(0, maxBytes) : null;
            } catch {
                return null;
            }
        }

        const reader = clone.body.getReader();
        const chunks = [];
        let total = 0;
        let cancelled = false;
        const timer = setTimeout(() => {
            cancelled = true;
            try {
                reader.cancel();
            } catch {
                // Ignore.
            }
        }, READ_TIMEOUT_MS);

        try {
            while (total < maxBytes && !cancelled) {
                const { done, value } = await reader.read();
                if (done || cancelled) break;
                if (!value?.byteLength) continue;
                const remaining = maxBytes - total;
                const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value.slice();
                chunks.push(chunk);
                total += chunk.byteLength;
            }
        } catch {
            // A failed body read must not affect the request.
        } finally {
            clearTimeout(timer);
            try {
                await reader.cancel();
            } catch {
                // Ignore.
            }
        }

        if (!chunks.length) return null;
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return new TextDecoder().decode(merged);
    }

    // ---------------------------------------------------------------------
    // Pending watchdog helpers
    // ---------------------------------------------------------------------
    function takePending(meta) {
        const info = state.pending.get(meta.requestId);
        if (info) state.pending.delete(meta.requestId);
        return info;
    }

    function updateOrAdd(preferredEntryId, patch, partial) {
        if (preferredEntryId) {
            const updated = store.update(preferredEntryId, patch);
            if (updated) return updated;
        }
        return store.add(partial);
    }

    function noteResolvedSlow(preferredEntryId, meta, status) {
        if (!preferredEntryId) return;
        const ms = Math.round(performance.now() - meta.start);
        store.update(preferredEntryId, {
            level: 'info',
            message: `请求最终已响应，耗时 ${formatDuration(ms)}`,
            details: { resolvedAfterMs: ms, status: status ?? null, streamStage: 'resolved' },
        });
    }

    /**
     * Finds the most relevant pending or active streaming backend request.
     * @returns {object|null}
     */
    function correlateRequest() {
        const now = Date.now();
        let best = null;

        const consider = (candidate, rank) => {
            if (!candidate || !String(candidate.path || '').startsWith('/api/backends/')) return;
            if (!best || rank > best.rank) best = { ...candidate, rank };
        };

        for (const meta of state.pending.values()) {
            consider(
                {
                    requestId: meta.requestId,
                    path: meta.path,
                    method: meta.method,
                    model: meta.model,
                    stream: meta.stream,
                    startedAt: meta.startedAt,
                    endedAt: now,
                },
                meta.startedAt,
            );
        }

        for (const streamState of state.streams.values()) {
            const meta = streamState.meta;
            consider(
                {
                    requestId: meta?.requestId,
                    path: meta?.path,
                    method: meta?.method,
                    model: meta?.model,
                    stream: meta?.stream,
                    startedAt: meta?.startedAt || 0,
                    endedAt: now,
                },
                (meta?.startedAt || 0) + 1,
            );
        }

        // Completed requests are intentionally excluded here: a toastr that
        // arrives just after an unrelated request must not inherit its id.
        // Completed HTTP entries are still merged by message similarity.
        return best;
    }

    // ---------------------------------------------------------------------
    // HTTP response observation
    // ---------------------------------------------------------------------
    async function observeResponse(response, meta) {
        const headerMs = performance.now() - meta.start;
        const pendingInfo = takePending(meta);
        const preferredEntryId = pendingInfo?.entryId || null;

        try {
            if (!isActive()) {
                noteResolvedSlow(preferredEntryId, meta, response.status);
                return;
            }

            const contentType = response.headers.get('content-type') || '';
            const isOk = response.ok;

            if (!isOk) {
                if (!settings.captureHttp) {
                    noteResolvedSlow(preferredEntryId, meta, response.status);
                    return;
                }

                const contentLength = Number(response.headers.get('content-length') || 0);
                const text = await readCapped(response, BODY_LIMIT, contentType);
                const jsonSummary = extractErrorPayload(text);
                const htmlSummary = !jsonSummary && /html/i.test(contentType) ? extractHtmlSummary(text) : null;
                const summary = jsonSummary || (htmlSummary ? { message: htmlSummary } : null);
                const esaBlocked = isEsaBlockPage(text);
                const title = esaBlocked
                    ? `HTTP ${response.status} ESA 边缘拦截`
                    : httpTitle(response.status, response.statusText);
                const bodyTruncated =
                    (contentLength > 0 && contentLength > BODY_LIMIT) ||
                    (typeof text === 'string' && text.length >= BODY_LIMIT - 32);
                const details = {
                    ...baseDetails(meta, headerMs, response, contentType),
                    bodyExcerpt: excerptBody(text, BODY_LIMIT),
                    bodyTotalBytes: contentLength > 0 ? contentLength : null,
                    bodyTruncated,
                    streamStage: esaBlocked ? 'esa-block' : 'http-error',
                };

                const esaRule = esaBlocked ? extractEsaRule(text) : null;
                const message = esaBlocked
                    ? `请求被阿里云 ESA 边缘拦截，未到达 SillyTavern${esaRule ? `（${esaRule}）` : ''}；请检查代理或非中国大陆 IP`
                    : summary?.message || title;
                updateOrAdd(
                    preferredEntryId,
                    {
                        source: 'http',
                        level: 'error',
                        title,
                        message,
                        details: { ...details, resolvedAfterMs: Math.round(headerMs) },
                    },
                    { source: 'http', level: 'error', title, message, details },
                );
                return;
            }

            if (settings.captureSse && contentType.includes('text/event-stream')) {
                noteResolvedSlow(preferredEntryId, meta, response.status);
                sniffSse(response, meta, preferredEntryId);
                return;
            }

            if (!settings.captureSuccessErrors || !meta.path.startsWith('/api/backends/') || !contentType.includes('json')) {
                noteResolvedSlow(preferredEntryId, meta, response.status);
                return;
            }

            const isStatusCheck = meta.path.endsWith('/status');
            if (isStatusCheck && !settings.captureStatusChecks) {
                noteResolvedSlow(preferredEntryId, meta, response.status);
                return;
            }

            const declaredLength = Number(response.headers.get('content-length') || 0);
            if (declaredLength > SUCCESS_BODY_LIMIT) {
                noteResolvedSlow(preferredEntryId, meta, response.status);
                return;
            }

            const text = await readCapped(response, SUCCESS_BODY_LIMIT, contentType);
            const summary = extractErrorPayload(text);
            if (!summary) {
                noteResolvedSlow(preferredEntryId, meta, response.status);
                return;
            }

            const details = {
                ...baseDetails(meta, headerMs, response, contentType),
                bodyExcerpt: excerptBody(text, BODY_LIMIT),
                bodyTotalBytes: declaredLength > 0 ? declaredLength : null,
                bodyTruncated: declaredLength > BODY_LIMIT,
                streamStage: isStatusCheck ? 'status-check' : 'success-error-payload',
            };

            const title = isStatusCheck ? '连接状态检查失败' : '上游错误载荷（HTTP 200）';
            const level = isStatusCheck ? 'warn' : 'error';
            const message =
                isStatusCheck && summary.message === 'API 返回错误（无详细信息）'
                    ? 'API 端点不可用，或 Access Token / 连接配置异常'
                    : summary.message;
            updateOrAdd(
                preferredEntryId,
                {
                    source: 'http',
                    level,
                    title,
                    message,
                    details: { ...details, resolvedAfterMs: Math.round(headerMs) },
                },
                { source: 'http', level, title, message, details },
            );
        } catch {
            // Observation must never surface as an application error.
        }
    }

    function observeError(error, meta) {
        const pendingInfo = takePending(meta);
        const preferredEntryId = pendingInfo?.entryId || null;

        try {
            if (!isActive()) return;
            if (runtime?.unloading) return;

            const name = error?.name || '';
            const signal = meta.signal;
            const markedUserAbort = signal ? state.userAbortedSignals.has(signal) : false;
            const userAbort = name === 'AbortError' && (markedUserAbort || isRecentUserAbort());
            const timedOut = name === 'TimeoutError' || signal?.reason?.name === 'TimeoutError';

            if (userAbort && !settings.captureUserAborts) {
                noteResolvedSlow(preferredEntryId, meta, null);
                return;
            }

            let message;
            let level = 'error';
            let title = '请求失败';

            if (userAbort) {
                level = 'info';
                title = '用户主动中止请求';
                message = '请求被用户主动停止。';
            } else if (timedOut) {
                title = '请求超时';
                message = '请求超时。';
            } else if (name === 'AbortError') {
                title = '请求被中断';
                message = '请求被中断，可能是代理或后端超时。';
            } else if (name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(String(error?.message || ''))) {
                title = '网络错误';
                message = String(error?.message || 'Failed to fetch');
            } else {
                const summary = error && typeof error === 'object' ? errorFromData(error) : null;
                message = summary?.message || String(error?.message || error || '未知错误');
            }

            const details = {
                method: meta.method,
                path: meta.path,
                requestId: meta.requestId,
                model: meta.model,
                stream: meta.stream,
                messageCount: meta.messageCount,
                errorName: name || null,
                stack: error?.stack || null,
                durationMs: Math.round(performance.now() - meta.start),
                streamStage: userAbort ? 'user-abort' : 'network-error',
            };

            updateOrAdd(
                preferredEntryId,
                { source: 'network', level, title, message, details },
                { source: 'network', level, title, message, details },
            );
        } catch {
            // Observation must never surface as an application error.
        }
    }

    // ---------------------------------------------------------------------
    // SSE sniffing
    // ---------------------------------------------------------------------
    function extractSseData(frame) {
        const lines = frame.split(/\r\n|\r|\n/);
        let data = '';
        for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            let value = line.slice(5);
            if (value.startsWith(' ')) value = value.slice(1);
            data += (data ? '\n' : '') + value;
        }
        return data || null;
    }

    function looksLikeErrorText(text) {
        return ERROR_TEXT_PATTERN.test(text);
    }

    function reportStreamError(streamState, meta, summary, raw) {
        if (!isActive()) return;
        const message = redactText(summary?.message || '流式响应返回错误', 1000);
        const details = {
            path: meta.path,
            method: meta.method,
            requestId: meta.requestId,
            model: meta.model,
            messageCount: meta.messageCount,
            stream: true,
            bodyExcerpt: excerptBody(raw, 4096),
            streamStage: 'stream-error',
            errorCode: summary?.code ?? null,
            errorType: summary?.type ?? null,
        };

        const entry = updateOrAdd(
            streamState.errorEntryId,
            { source: 'sse', level: 'error', title: '流式响应错误', message, details },
            { source: 'sse', level: 'error', title: '流式响应错误', message, details },
        );
        streamState.errorEntryId = entry?.id || null;
    }

    /**
     * Reads a clone of an SSE response in the background.
     * @param {Response} response
     * @param {object} meta
     * @param {string|null} preferredEntryId
     */
    function sniffSse(response, meta, preferredEntryId) {
        let clone;
        try {
            clone = response.clone();
        } catch {
            return;
        }
        if (!clone.body) return;

        let reader;
        try {
            reader = clone.body.getReader();
        } catch {
            return;
        }

        const streamState = {
            meta,
            lastDataAt: Date.now(),
            stalledAt: null,
            stallEntryId: null,
            errorEntryId: preferredEntryId || null,
            bytes: 0,
            ended: false,
        };
        state.streams.set(meta.requestId, streamState);

        const idleMs = Math.max(0, Number(settings.streamIdleSec) || 0) * 1000;
        const idleTimer =
            idleMs > 0
                ? setInterval(() => {
                      try {
                          if (streamState.ended || !settings.watchStreamIdle || !isActive()) return;
                          const idle = Date.now() - streamState.lastDataAt;
                          if (idle < idleMs || streamState.stallEntryId) return;
                          const entry = store.add({
                              source: 'sse',
                              level: 'warn',
                              title: '流式响应停滞',
                              message: `超过 ${Math.round(idleMs / 1000)} 秒未收到任何数据，可能后端超时或连接中断`,
                              details: {
                                  method: meta.method,
                                  path: meta.path,
                                  requestId: meta.requestId,
                                  model: meta.model,
                                  stream: true,
                                  streamStage: 'idle',
                              },
                          });
                          streamState.stallEntryId = entry?.id || null;
                          streamState.stalledAt = Date.now();
                      } catch {
                          // Ignore watchdog errors.
                      }
                  }, Math.min(5000, Math.max(1000, idleMs / 4)))
                : null;

        const decoder = new TextDecoder();
        let buffer = '';

        (async () => {
            try {
                while (!streamState.ended) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    streamState.bytes += value?.byteLength || 0;
                    if (streamState.bytes > SSE_TOTAL_LIMIT) break;

                    const text = decoder.decode(value, { stream: true });
                    if (!text) continue;

                    streamState.lastDataAt = Date.now();
                    if (streamState.stallEntryId && streamState.stalledAt) {
                        const stalledFor = Date.now() - streamState.stalledAt;
                        store.update(streamState.stallEntryId, {
                            level: 'info',
                            message: `流式响应停滞 ${formatDuration(stalledFor)} 后恢复`,
                        });
                        streamState.stallEntryId = null;
                        streamState.stalledAt = null;
                    }

                    buffer += text;
                    if (buffer.length > SSE_BUFFER_LIMIT) {
                        buffer = buffer.slice(-Math.floor(SSE_BUFFER_LIMIT / 2));
                    }

                    const frames = buffer.split(/\r\n\r\n|\n\n|\r\r/);
                    buffer = frames.pop() ?? '';

                    for (const frame of frames) {
                        const data = extractSseData(frame);

                        if (data === null) {
                            // Some backends write raw JSON into an SSE response
                            // after headers have already been sent.
                            const raw = frame.trim();
                            if (!raw || raw.startsWith(':') || raw === '[DONE]') continue;
                            let parsed = null;
                            try {
                                parsed = JSON.parse(raw);
                            } catch {
                                // Not JSON.
                            }
                            if (parsed) {
                                const summary = errorFromData(parsed);
                                if (summary) reportStreamError(streamState, meta, summary, raw);
                            } else if (looksLikeErrorText(raw)) {
                                reportStreamError(streamState, meta, { message: redactText(raw, 800) }, raw);
                            }
                            continue;
                        }

                        if (data === '[DONE]') {
                            streamState.ended = true;
                            break;
                        }

                        let parsed = null;
                        try {
                            parsed = JSON.parse(data);
                        } catch {
                            // Not JSON.
                        }

                        if (parsed) {
                            const summary = errorFromData(parsed);
                            if (summary) reportStreamError(streamState, meta, summary, data);
                        } else if (looksLikeErrorText(data)) {
                            reportStreamError(streamState, meta, { message: redactText(data.trim(), 800) }, data);
                        }
                    }
                }
            } catch {
                // Stream observation is best-effort.
            } finally {
                streamState.ended = true;
                if (idleTimer) clearInterval(idleTimer);
                state.streams.delete(meta.requestId);
                try {
                    await reader.cancel();
                } catch {
                    // Ignore.
                }
                if (streamState.stallEntryId) {
                    store.update(streamState.stallEntryId, {
                        level: 'warn',
                        message: '流式响应停滞，随后连接已结束',
                    });
                }
            }
        })();
    }

    // ---------------------------------------------------------------------
    // fetch hook
    // ---------------------------------------------------------------------
    function installFetchHook() {
        const originalFetch = window.fetch;
        if (typeof originalFetch !== 'function') return;

        function stelpFetch(...args) {
            const promise = Reflect.apply(originalFetch, this, args);
            try {
                const meta = makeMeta(args);
                if (meta) {
                    state.pending.set(meta.requestId, meta);
                    promise.then(
                        (response) => {
                            observeResponse(response, meta).catch(() => {});
                        },
                        (error) => {
                            observeError(error, meta);
                        },
                    );
                }
            } catch {
                // Never let observation affect the real request.
            }
            return promise;
        }

        stelpFetch.__stelpWrapped = true;
        window.fetch = stelpFetch;
    }

    // ---------------------------------------------------------------------
    // toastr hook
    // ---------------------------------------------------------------------
    function installToastrHook() {
        try {
            const toastr = globalThis.toastr;
            if (!toastr || toastr.__stelpWrapped) return;

            for (const type of ['error', 'warning']) {
                const original = toastr[type];
                if (typeof original !== 'function') continue;

                toastr[type] = function stelpToastr(message, title, optionsOverride) {
                    try {
                        if (isActive() && settings.captureToastr) {
                            const related = correlateRequest();
                            store.add({
                                source: 'toastr',
                                level: type === 'warning' ? 'warn' : 'error',
                                title: title || (type === 'warning' ? '警告' : '错误'),
                                message: String(message ?? ''),
                                details: {
                                    toastrTitle: title || null,
                                    toastrType: type,
                                    toastrTimeOut: optionsOverride?.timeOut ?? toastr.options?.timeOut ?? null,
                                    requestId: related?.requestId || null,
                                    path: related?.path || null,
                                    method: related?.method || null,
                                    model: related?.model || null,
                                    stream: related?.stream ?? null,
                                },
                            });
                        }
                    } catch {
                        // Never break the toast.
                    }
                    return Reflect.apply(original, this, arguments);
                };
            }

            Object.defineProperty(toastr, '__stelpWrapped', { value: true, configurable: true });
        } catch {
            // Toastr capture is optional.
        }
    }

    // ---------------------------------------------------------------------
    // window / console hooks
    // ---------------------------------------------------------------------
    function reasonMessage(reason) {
        if (typeof reason === 'string') return reason;
        if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
        if (reason && typeof reason === 'object') {
            const summary = errorFromData(reason);
            if (summary) return summary.message;
            return safeStringify(reason, 2000);
        }
        return String(reason ?? '未知错误');
    }

    function installWindowHooks() {
        window.addEventListener('error', (event) => {
            try {
                if (!isActive() || !settings.captureWindowError) return;
                if (!event?.error) return; // Resource load errors have no Error object.
                const message = event.message || event.error?.message || '脚本错误';
                if (NOISE_PATTERN.test(message)) return;
                store.add({
                    source: 'js',
                    level: 'error',
                    title: '未捕获脚本错误',
                    message,
                    details: {
                        errorName: event.error?.name || null,
                        stack: event.error?.stack || null,
                        filename: event.filename || null,
                        line: event.lineno ?? null,
                        col: event.colno ?? null,
                    },
                });
            } catch {
                // Ignore.
            }
        });

        window.addEventListener('unhandledrejection', (event) => {
            try {
                if (!isActive() || !settings.captureUnhandled) return;
                if (runtime?.unloading) return;

                const reason = event?.reason;
                const name = reason?.name || '';
                const userAbort = name === 'AbortError' && isRecentUserAbort();

                if (userAbort && !settings.captureUserAborts) return;

                const message = reasonMessage(reason);
                if (NOISE_PATTERN.test(message)) return;

                let level = 'error';
                let title = '未处理的 Promise 拒绝';
                if (userAbort) {
                    level = 'info';
                    title = '用户主动中止请求';
                } else if (name === 'AbortError') {
                    title = '请求被中断';
                }

                store.add({
                    source: 'unhandled',
                    level,
                    title,
                    message,
                    details: {
                        errorName: name || null,
                        stack: reason?.stack || null,
                        bodyExcerpt: reason && typeof reason === 'object' ? safeStringify(reason, 2000) : null,
                    },
                });
            } catch {
                // Ignore.
            }
        });
    }

    function recordConsole(level, args) {
        try {
            const parts = args.map((arg) => {
                if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack || ''}`;
                if (arg && typeof arg === 'object') return safeStringify(arg, 2000);
                return String(arg);
            });
            const message = parts.join(' ').trim();
            if (!message || NOISE_PATTERN.test(message) || message.startsWith('[STELP]')) return;
            store.add({
                source: 'console',
                level,
                title: level === 'error' ? 'console.error' : 'console.warn',
                message,
                details: { consoleLevel: level },
            });
        } catch {
            // Ignore.
        }
    }

    function installConsoleHook() {
        try {
            if (!globalThis.console || console.__stelpWrapped) return;
            const originalError = console.error;
            const originalWarn = console.warn;

            console.error = function stelpConsoleError(...args) {
                try {
                    if (isActive() && settings.captureConsoleError) recordConsole('error', args);
                } catch {
                    // Ignore.
                }
                return Reflect.apply(originalError, this, args);
            };

            console.warn = function stelpConsoleWarn(...args) {
                try {
                    if (isActive() && settings.captureConsoleWarn) recordConsole('warn', args);
                } catch {
                    // Ignore.
                }
                return Reflect.apply(originalWarn, this, args);
            };

            Object.defineProperty(console, '__stelpWrapped', { value: true, configurable: true });
        } catch {
            // Console capture is optional.
        }
    }

    // ---------------------------------------------------------------------
    // Pending watchdog
    // ---------------------------------------------------------------------
    function startWatchdog() {
        setInterval(() => {
            try {
                if (!isActive() || !settings.watchPending) return;
                const limitMs = Math.max(1, Number(settings.pendingTimeoutSec) || 60) * 1000;
                const now = Date.now();

                for (const meta of state.pending.values()) {
                    if (now - meta.startedAt > MAX_PENDING_AGE_MS) {
                        state.pending.delete(meta.requestId);
                        continue;
                    }
                    if (meta.warned || now - meta.startedAt < limitMs) continue;

                    meta.warned = true;
                    const seconds = Math.round((now - meta.startedAt) / 1000);
                    const entry = store.add({
                        source: 'watchdog',
                        level: 'warn',
                        title: '请求超时警告',
                        message: `${meta.path} 超过 ${seconds} 秒仍未返回响应头，可能后端超时`,
                        details: {
                            method: meta.method,
                            path: meta.path,
                            requestId: meta.requestId,
                            model: meta.model,
                            stream: meta.stream,
                            messageCount: meta.messageCount,
                            status: null,
                            streamStage: 'waiting',
                        },
                    });
                    meta.entryId = entry?.id || null;
                }
            } catch {
                // Ignore watchdog errors.
            }
        }, PENDING_CHECK_MS);
    }

    // ---------------------------------------------------------------------
    // Install
    // ---------------------------------------------------------------------
    patchAbortController();
    installFetchHook();
    installToastrHook();
    installWindowHooks();
    installConsoleHook();
    startWatchdog();

    const onPageHide = () => {
        runtime.unloading = true;
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);

    const cleanup = () => {
        window.removeEventListener('pagehide', onPageHide);
        window.removeEventListener('beforeunload', onPageHide);
        for (const streamState of state.streams.values()) {
            streamState.ended = true;
        }
        state.streams.clear();
        state.pending.clear();
    };

    const handle = { state, cleanup };
    window.__stelpCaptureInstalled = handle;
    return handle;
}
