/**
 * SillyTavern 错误日志面板
 *
 * A self-contained front-end extension that keeps HTTP / toastr / stream /
 * timeout failures visible in a floating panel on the left side of the page.
 */

import { ErrorStore, initSettings } from './store.js';
import { installCapture } from './capture.js';
import { mountPanel, mountSettings } from './ui.js';
import { diagnose, formatDiagnosis, RULE_COUNT } from './diagnose.js';

const runtime = { paused: false, unloading: false };

/** @type {ErrorStore|undefined} */
let store;
/** @type {ReturnType<typeof mountPanel>|undefined} */
let ui;
/** @type {object|undefined} */
let settings;

/**
 * Inserts three synthetic records so the UI can be verified without breaking
 * a real API connection.
 */
function injectTests() {
    if (!store) return;
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });

    store.add({
        source: 'http',
        level: 'error',
        title: 'HTTP 400 Bad Request',
        message: `示例错误 ${stamp}：invalid api key`,
        details: {
            status: 400,
            statusText: 'Bad Request',
            method: 'POST',
            path: '/api/backends/chat-completions/generate',
            durationMs: 1234,
            model: 'example-model',
            stream: true,
            messageCount: 12,
            requestId: 'demo-http',
            bodyExcerpt: '{\n  "error": {\n    "message": "invalid api key"\n  }\n}',
            headers: { 'x-request-id': 'demo-request' },
        },
    });

    store.add({
        source: 'watchdog',
        level: 'warn',
        title: '请求超时警告',
        message: `示例 ${stamp}：/api/backends/chat-completions/generate 超过 60 秒仍未返回响应头，可能后端超时`,
        details: {
            method: 'POST',
            path: '/api/backends/text-completions/generate',
            stream: true,
            requestId: 'demo-timeout',
            streamStage: 'waiting',
        },
    });

    store.add({
        source: 'toastr',
        level: 'error',
        title: 'Chat Completion API',
        message: `示例 ${stamp}：API returned an error`,
        details: {
            toastrTitle: 'Chat Completion API',
            toastrType: 'error',
            toastrTimeOut: 4000,
            requestId: 'demo-toastr',
        },
    });
}

/**
 * Simulates a burst of identical 524 responses to verify aggregation and
 * lazy rendering. All 20 attempts should collapse into one card with ×20.
 */
function injectFlood() {
    if (!store) return;
    const stamp = Date.now();
    for (let i = 0; i < 20; i++) {
        store.add({
            source: 'http',
            level: 'error',
            title: 'HTTP 524 上游超时',
            message: 'example.com | 524: A timeout occurred',
            details: {
                status: 524,
                statusText: '',
                method: 'POST',
                path: '/api/backends/chat-completions/generate',
                durationMs: 120000 + i * 1000,
                model: 'deepseek',
                stream: true,
                requestId: `flood-${stamp}-${i}`,
                bodyExcerpt:
                    '<html><head><title>example.com | 524: A timeout occurred</title></head><body>Cloudflare error page</body></html>',
                bodyTruncated: true,
                bodyTotalBytes: 46213,
            },
        });
    }
}

/** @param {number} attempt */
function boot(attempt = 0) {
    const context = globalThis.SillyTavern?.getContext?.();
    if (!context) {
        if (attempt < 100) {
            setTimeout(() => boot(attempt + 1), 100);
        } else {
            console.warn('[STELP] SillyTavern context unavailable, error panel not started.');
        }
        return;
    }

    settings = initSettings(context);
    store = new ErrorStore({
        settings,
        onChange: (event) => ui?.handleStoreEvent(event),
    });
    store.load();

    ui = mountPanel({ store, settings, runtime });
    mountSettings({ context, settings, store, panel: ui, onTest: injectTests, onFloodTest: injectFlood });
    installCapture({ store, settings, runtime });

    globalThis.STELP = {
        store,
        settings,
        runtime,
        ui,
        test: injectTests,
        flood: injectFlood,
        formatAll: () => store.formatAll(),
        diagnose,
        formatDiagnosis,
        ruleCount: RULE_COUNT,
    };

    console.debug(`[STELP] 错误日志面板已加载（原因分析规则 ${RULE_COUNT} 条）`);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot(), { once: true });
} else {
    boot();
}

window.addEventListener('pagehide', () => {
    runtime.unloading = true;
    store?.flush();
});

window.addEventListener('beforeunload', () => {
    runtime.unloading = true;
    store?.flush();
});

window.addEventListener('pageshow', () => {
    runtime.unloading = false;
});
