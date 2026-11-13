/**
 * DOM-only UI for the error log panel and its settings drawer.
 * No innerHTML is used for untrusted values.
 */

import { formatBytes, formatDuration, MAX_BODY_CHARS } from './store.js';
import { diagnose, RULE_COUNT } from './diagnose.js';

const CONF_CLASS = { 高: 'high', 中: 'mid', 低: 'low' };

const SOURCE_LABELS = {
    http: 'HTTP',
    network: '网络',
    watchdog: '超时',
    sse: '流式',
    toastr: '提示',
    js: '脚本',
    unhandled: '异常',
    console: '控制台',
};

const FILTERS = [
    ['all', '全部'],
    ['error', '错误'],
    ['warn', '警告'],
    ['info', '信息'],
];

const MAX_VISIBLE = 50;

/** @param {string} tag @param {string} [className] @param {string} [text] @returns {HTMLElement} */
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
}

/** @param {number} value @param {number} min @param {number} max @returns {number} */
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/** @param {number} ts @returns {string} */
function formatTime(ts) {
    const date = new Date(ts);
    const now = new Date();
    const time = date.toLocaleTimeString('zh-CN', { hour12: false });
    return date.toDateString() === now.toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

/** @param {object} entry @returns {string} */
function statusText(entry) {
    const details = entry.details || {};
    if (details.streamStage === 'status-check') return 'CONN';
    if (details.streamStage === 'success-error-payload') return `${details.status ?? 200} ERR`;
    if (details.status) return String(details.status);
    switch (entry.source) {
        case 'network':
            return 'NET';
        case 'watchdog':
            return 'TIMEOUT';
        case 'sse':
            return 'STREAM';
        case 'toastr':
            return 'TOAST';
        case 'js':
        case 'unhandled':
            return 'JS';
        case 'console':
            return 'LOG';
        default:
            return String(entry.level || 'ERR').toUpperCase();
    }
}

/** @param {object} entry @returns {string} */
function statusClass(entry) {
    const status = Number(entry.details?.status);
    if (status >= 500) return 'stelp-status-5xx';
    if (status >= 400) return 'stelp-status-4xx';
    if (entry.level === 'warn') return 'stelp-status-warn';
    if (entry.level === 'info') return 'stelp-status-info';
    return 'stelp-status-error';
}

/** @param {string} text @returns {Promise<boolean>} */
export async function copyText(text) {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // Fall through to the execCommand path (HTTP origins).
    }

    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', 'readonly');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '0';
        textarea.style.opacity = '0';
        document.body.append(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        textarea.remove();
        return ok;
    } catch {
        return false;
    }
}

/**
 * Mounts the floating panel.
 * @param {{store: import('./store.js').ErrorStore, settings: object, runtime: {paused: boolean, unloading: boolean}}} options
 * @returns {object} Panel handle
 */
export function mountPanel({ store, settings, runtime }) {
    document.getElementById('stelp-panel')?.remove();
    document.getElementById('stelp-notice')?.remove();

    const root = el('div', 'stelp-panel');
    root.id = 'stelp-panel';

    const header = el('div', 'stelp-header');
    const titleWrap = el('div', 'stelp-title-wrap');
    const title = el('span', 'stelp-title', '错误日志');
    const unreadBadge = el('span', 'stelp-unread', '0');
    titleWrap.append(title, unreadBadge);

    const actions = el('div', 'stelp-actions');
    const pauseButton = makeIconButton('pause', 'fa-pause', '暂停捕获');
    const copyButton = makeIconButton('copy', 'fa-copy', '复制全部诊断信息');
    const clearButton = makeIconButton('clear', 'fa-trash-can', '清空');
    const collapseButton = makeIconButton('collapse', 'fa-chevron-left', '收起');
    actions.append(pauseButton, copyButton, clearButton, collapseButton);
    header.append(titleWrap, actions);

    const filters = el('div', 'stelp-filters');
    for (const [key, label] of FILTERS) {
        const button = el('button', 'stelp-filter', label);
        button.type = 'button';
        button.dataset.filter = key;
        filters.append(button);
    }

    const list = el('div', 'stelp-list');
    const footer = el('div', 'stelp-footer');
    const footerText = el('span', 'stelp-footer-text', '');
    const reloadButton = el('button', 'stelp-reload', '重载页面');
    reloadButton.type = 'button';
    reloadButton.title = 'SillyTavern 前端卡死时重载页面（未保存的生成内容可能丢失）';
    reloadButton.addEventListener('click', () => {
        if (window.confirm('重载页面？未保存的生成内容可能丢失。')) {
            window.location.reload();
        }
    });
    footer.append(footerText, reloadButton);

    const tab = el('div', 'stelp-tab');
    tab.append(
        el('div', 'stelp-tab-icon fa-solid fa-triangle-exclamation'),
        el('div', 'stelp-tab-label', '错误日志'),
        el('div', 'stelp-tab-badge', '0'),
    );
    const tabBadge = tab.querySelector('.stelp-tab-badge');

    const inlineToast = el('div', 'stelp-inline-toast');
    root.append(header, filters, list, footer, tab, inlineToast);
    document.body.append(root);

    let filter = 'all';
    let flashId = null;
    let toastTimer = null;
    let visibleLimit = MAX_VISIBLE;
    let renderTimer = null;
    let noticeTimer = null;
    let lastNoticeAt = 0;
    const expandedIds = new Set();

    function showToast(message) {
        inlineToast.textContent = message;
        inlineToast.classList.add('visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => inlineToast.classList.remove('visible'), 1800);
    }

    function scheduleRender() {
        if (renderTimer) return;
        renderTimer = setTimeout(() => {
            renderTimer = null;
            render();
        }, 200);
    }

    function hideNotice() {
        document.getElementById('stelp-notice')?.classList.remove('visible');
    }

    function showNotice(entry) {
        if (!settings.notifyOnError || !entry || entry.level === 'info') return;

        const now = Date.now();
        if (now - lastNoticeAt < 800) return;
        lastNoticeAt = now;

        let notice = document.getElementById('stelp-notice');
        if (!notice) {
            notice = el('div', 'stelp-notice');
            notice.id = 'stelp-notice';
            notice.addEventListener('click', () => {
                const id = notice.dataset.entryId;
                notice.classList.remove('visible');
                setCollapsed(false);
                if (id) {
                    expandedIds.add(id);
                    flashId = id;
                    render();
                    const target = list.querySelector(`.stelp-entry[data-id="${id}"]`);
                    target?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
                }
            });
            document.body.append(notice);
        }

        notice.dataset.entryId = entry.id;
        const countText = entry.count > 1 ? ` ×${entry.count}` : '';
        notice.replaceChildren(
            el('div', 'stelp-notice-title', `错误 · ${entry.title}${countText}`),
            el('div', 'stelp-notice-message', `${entry.message || '点击查看详情'}（点击查看）`),
        );
        notice.classList.add('visible');
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(hideNotice, 5000);
    }

    function applyCollapsed() {
        const collapsed = !!store.ui.collapsed;
        root.classList.toggle('stelp-collapsed', collapsed);
        collapseButton.title = collapsed ? '展开' : '收起';
        const icon = collapseButton.querySelector('i');
        if (icon) icon.className = `fa-solid ${collapsed ? 'fa-chevron-right' : 'fa-chevron-left'}`;
    }

    function setCollapsed(value, { persist = true } = {}) {
        store.ui.collapsed = !!value;
        if (!value) store.markAllRead();
        applyCollapsed();
        if (persist) store.saveUi();
        render();
    }

    function applyPosition() {
        const maxX = Math.max(0, window.innerWidth - 48);
        const maxY = Math.max(0, window.innerHeight - 48);
        if (Number.isFinite(store.ui.x)) root.style.left = `${clamp(store.ui.x, 0, maxX)}px`;
        if (Number.isFinite(store.ui.y)) root.style.top = `${clamp(store.ui.y, 0, maxY)}px`;
    }

    function resetPosition() {
        store.ui.x = null;
        store.ui.y = null;
        root.style.left = '';
        root.style.top = '';
        setCollapsed(false);
        store.saveUi();
    }

    function initDrag() {
        let dragging = false;
        let startX = 0;
        let startY = 0;
        let originLeft = 0;
        let originTop = 0;

        header.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 || event.target.closest('button')) return;
            const rect = root.getBoundingClientRect();
            dragging = true;
            startX = event.clientX;
            startY = event.clientY;
            originLeft = rect.left;
            originTop = rect.top;
            try {
                header.setPointerCapture(event.pointerId);
            } catch {
                // Optional.
            }
            event.preventDefault();
        });

        header.addEventListener('pointermove', (event) => {
            if (!dragging) return;
            const left = clamp(originLeft + event.clientX - startX, 0, Math.max(0, window.innerWidth - root.offsetWidth));
            const top = clamp(originTop + event.clientY - startY, 0, Math.max(0, window.innerHeight - 48));
            root.style.left = `${left}px`;
            root.style.top = `${top}px`;
        });

        const finish = () => {
            if (!dragging) return;
            dragging = false;
            const rect = root.getBoundingClientRect();
            store.ui.x = Math.round(rect.left);
            store.ui.y = Math.round(rect.top);
            store.saveUi();
        };

        header.addEventListener('pointerup', finish);
        header.addEventListener('pointercancel', finish);
        window.addEventListener('resize', applyPosition);
    }

    function addKV(container, key, value) {
        if (value === null || value === undefined || value === '') return;
        const row = el('div', 'stelp-kv');
        row.append(el('span', 'stelp-k', key), el('span', 'stelp-v', String(value)));
        container.append(row);
    }

    function addPre(container, label, value) {
        if (!value) return;
        container.append(el('div', 'stelp-detail-label', label));
        const pre = el('pre', 'stelp-pre');
        pre.textContent = value;
        container.append(pre);
    }

    function buildDiagnosisBlock(entry) {
        if (settings.showDiagnosis === false) return null;

        let result;
        try {
            result = diagnose(entry);
        } catch {
            return null;
        }
        if (!result) return null;

        const wrap = el('div', `stelp-diag stelp-diag-${CONF_CLASS[result.confidence] || 'low'}`);

        const head = el('div', 'stelp-diag-head');
        head.append(
            el('span', 'stelp-diag-icon fa-solid fa-stethoscope'),
            el('span', 'stelp-diag-title', '原因分析'),
            el('span', 'stelp-diag-conf', `置信度 ${result.confidence}`),
        );
        for (const tag of result.tags) head.append(el('span', 'stelp-diag-tag', tag));
        wrap.append(head);

        wrap.append(el('div', 'stelp-diag-summary', result.summary));

        if (result.causes.length) {
            wrap.append(el('div', 'stelp-diag-label', '可能原因'));
            const list = el('ul', 'stelp-diag-list');
            for (const item of result.causes) list.append(el('li', '', item));
            wrap.append(list);
        }

        if (result.fixes.length) {
            wrap.append(el('div', 'stelp-diag-label', '处置建议'));
            const list = el('ul', 'stelp-diag-list stelp-diag-fixes');
            for (const item of result.fixes) list.append(el('li', '', item));
            wrap.append(list);
        }

        return wrap;
    }

    function buildDetails(entry) {
        const details = entry.details || {};
        const box = el('div', 'stelp-detail-body');

        const diagnosis = buildDiagnosisBlock(entry);
        if (diagnosis) box.append(diagnosis);

        const info = el('div', 'stelp-detail-grid');
        const request = [details.method, details.path].filter(Boolean).join(' ');
        addKV(info, '请求', request);
        if (details.status) addKV(info, '状态', `${details.status} ${details.statusText || ''}`.trim());
        if (details.errorCode) addKV(info, '错误码', String(details.errorCode));
        if (details.errorType) addKV(info, '错误类型', String(details.errorType));
        if (details.durationMs !== null && details.durationMs !== undefined) addKV(info, '耗时', formatDuration(details.durationMs));
        if (details.resolvedAfterMs) addKV(info, '最终耗时', formatDuration(details.resolvedAfterMs));
        if (details.model) addKV(info, '模型', details.model);
        if (details.stream !== null && details.stream !== undefined) addKV(info, '流式', String(details.stream));
        if (details.messageCount !== null && details.messageCount !== undefined) addKV(info, '消息数', String(details.messageCount));
        if (entry.sources?.length) addKV(info, '来源', entry.sources.join(' + '));
        if (entry.count > 1) {
            const span = entry.lastTs > entry.ts ? ` / 持续 ${formatDuration(entry.lastTs - entry.ts)}` : '';
            addKV(info, '重复', `×${entry.count}${span}`);
        }
        if (details.toastrTitle) addKV(info, 'Toastr', `${details.toastrTitle}${details.toastrType ? ` (${details.toastrType})` : ''}`);
        if (details.errorName) addKV(info, '异常', details.errorName);
        if (details.filename) addKV(info, '位置', `${details.filename}:${details.line ?? '?'}:${details.col ?? '?'}`);
        box.append(info);

        if (Array.isArray(details.relatedMessages) && details.relatedMessages.length) {
            addPre(box, '相关消息', details.relatedMessages.join('\n'));
        }
        if (details.bodyExcerpt) {
            const note = details.bodyTruncated
                ? `（已截断，显示 ${formatBytes(MAX_BODY_CHARS)}${details.bodyTotalBytes ? ` / 总 ${formatBytes(details.bodyTotalBytes)}` : ''}）`
                : '';
            addPre(box, `响应内容${note}`, details.bodyExcerpt);
        }
        if (details.headers && Object.keys(details.headers).length) {
            addPre(box, '响应头', Object.entries(details.headers).map(([key, value]) => `${key}: ${value}`).join('\n'));
        }
        if (details.stack) addPre(box, '堆栈', details.stack);

        const copyButton = el('button', 'menu_button stelp-detail-copy', '复制本条');
        copyButton.type = 'button';
        copyButton.dataset.act = 'copy-entry';
        box.append(copyButton);

        return box;
    }

    function renderEntry(entry) {
        const item = el('div', `stelp-entry stelp-level-${entry.level}`);
        item.dataset.id = entry.id;
        if (entry.unread) item.classList.add('stelp-unread');
        if (flashId === entry.id) item.classList.add('stelp-flash');

        const head = el('div', 'stelp-entry-head');
        const source = el('span', `stelp-badge stelp-source stelp-source-${entry.source}`, SOURCE_LABELS[entry.source] || entry.source);
        const status = el('span', `stelp-badge stelp-status ${statusClass(entry)}`, statusText(entry));
        const time = el('span', 'stelp-time', formatTime(entry.ts));
        const count = el('span', 'stelp-count', entry.count > 1 ? `×${entry.count}` : '');
        const chevron = el('span', 'stelp-chevron fa-solid fa-chevron-down');
        head.append(source, status, time, count, chevron);

        const title = el('div', 'stelp-entry-title', entry.title || '错误');
        const message = el('div', 'stelp-entry-message', entry.message || '');
        const details = el('div', 'stelp-entry-details');
        details.hidden = true;

        const children = [head, title, message];

        if (settings.diagInline !== false) {
            let result = null;
            try {
                result = diagnose(entry);
            } catch {
                result = null;
            }
            if (result) {
                const inline = el(
                    'div',
                    `stelp-entry-diag stelp-entry-diag-${CONF_CLASS[result.confidence] || 'low'}`,
                    result.summary,
                );
                inline.title = `置信度 ${result.confidence}${result.tags.length ? ` · ${result.tags.join(' / ')}` : ''}（点击本条展开完整分析）`;
                children.push(inline);
            }
        }

        if (expandedIds.has(entry.id)) {
            details.append(buildDetails(entry));
            details.hidden = false;
            item.classList.add('stelp-expanded');
        }

        children.push(details);
        item.append(...children);
        return item;
    }

    function render() {
        const counts = store.getCounts();

        unreadBadge.textContent = counts.unread > 99 ? '99+' : String(counts.unread);
        unreadBadge.classList.toggle('stelp-hidden', counts.unread === 0);
        const tabCount = counts.unread > 0 ? counts.unread : counts.total;
        tabBadge.textContent = tabCount > 99 ? '99+' : String(tabCount);
        tabBadge.classList.toggle('stelp-hidden', counts.total === 0);

        pauseButton.title = runtime.paused ? '恢复捕获' : '暂停捕获';
        const pauseIcon = pauseButton.querySelector('i');
        if (pauseIcon) pauseIcon.className = `fa-solid ${runtime.paused ? 'fa-play' : 'fa-pause'}`;
        root.classList.toggle('stelp-paused', !!runtime.paused);

        for (const button of filters.querySelectorAll('.stelp-filter')) {
            button.classList.toggle('active', button.dataset.filter === filter);
        }

        const entries = store.getFiltered(filter);
        const visible = entries.slice(0, visibleLimit);
        const previousScroll = list.scrollTop;
        const atTop = previousScroll <= 4;
        list.replaceChildren();

        if (!entries.length) {
            list.append(el('div', 'stelp-empty', '暂无错误，监控中…'));
        } else {
            for (const entry of visible) list.append(renderEntry(entry));
            if (entries.length > visible.length) {
                const remaining = entries.length - visible.length;
                const more = el('button', 'stelp-show-more', `显示更多（剩余 ${remaining} 条）`);
                more.type = 'button';
                more.addEventListener('click', () => {
                    visibleLimit += MAX_VISIBLE;
                    render();
                });
                list.append(more);
            }
        }

        list.scrollTop = atTop ? 0 : previousScroll;

        footerText.textContent = `共 ${counts.total} 条 · 显示 ${Math.min(visible.length, entries.length)} 条 · 最多保留 ${store.maxEntries} 条`;
        applyCollapsed();
    }

    function handleStoreEvent(event) {
        if (event?.reason === 'add' && event.entry) {
            const isMobileView = typeof window !== 'undefined' && window.innerWidth <= 768;
            if (settings.autoExpandOnError && !isMobileView && event.entry.level !== 'info' && store.ui.collapsed) {
                setCollapsed(false);
            }
            flashId = event.entry.id;
            showNotice(event.entry);
            const flashed = flashId;
            setTimeout(() => {
                if (flashId === flashed) {
                    flashId = null;
                    scheduleRender();
                }
            }, 1600);
        }
        if (event?.reason === 'clear') {
            expandedIds.clear();
            visibleLimit = MAX_VISIBLE;
            hideNotice();
        }
        scheduleRender();
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------
    actions.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-act]');
        if (!button) return;

        switch (button.dataset.act) {
            case 'pause':
                runtime.paused = !runtime.paused;
                render();
                showToast(runtime.paused ? '已暂停捕获' : '已恢复捕获');
                break;
            case 'copy': {
                const ok = await copyText(store.formatAll());
                showToast(ok ? '已复制全部诊断信息' : '复制失败，请手动选择文本');
                break;
            }
            case 'clear':
                if (!store.entries.length) {
                    showToast('暂无记录');
                    break;
                }
                if (window.confirm('确定清空所有错误日志？')) {
                    store.clear();
                    showToast('已清空');
                }
                break;
            case 'collapse':
                setCollapsed(true);
                break;
        }
    });

    filters.addEventListener('click', (event) => {
        const button = event.target.closest('.stelp-filter');
        if (!button) return;
        filter = button.dataset.filter || 'all';
        visibleLimit = MAX_VISIBLE;
        render();
    });

    list.addEventListener('click', async (event) => {
        const entryElement = event.target.closest('.stelp-entry');
        if (!entryElement) return;

        if (event.target.closest('[data-act="copy-entry"]')) {
            const entry = store.entries.find((item) => item.id === entryElement.dataset.id);
            if (!entry) return;
            const ok = await copyText(store.formatEntry(entry));
            showToast(ok ? '已复制本条诊断信息' : '复制失败，请手动选择文本');
            return;
        }

        if (event.target.closest('.stelp-entry-details')) return;

        const id = entryElement.dataset.id;
        const details = entryElement.querySelector('.stelp-entry-details');
        if (!details) return;

        const expanded = entryElement.classList.toggle('stelp-expanded');
        if (expanded) {
            if (!details.dataset.built) {
                const entry = store.entries.find((item) => item.id === id);
                if (entry) {
                    details.append(buildDetails(entry));
                    details.dataset.built = '1';
                }
            }
            expandedIds.add(id);
            details.hidden = false;
        } else {
            expandedIds.delete(id);
            details.hidden = true;
        }
    });

    tab.addEventListener('click', () => setCollapsed(false));

    initDrag();
    applyPosition();
    applyCollapsed();
    render();

    return {
        root,
        render,
        handleStoreEvent,
        setCollapsed,
        resetPosition,
        showToast,
    };
}

/** @param {string} act @param {string} icon @param {string} title @returns {HTMLButtonElement} */
function makeIconButton(act, icon, title) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'stelp-icon-btn';
    button.dataset.act = act;
    button.title = title;
    button.setAttribute('aria-label', title);
    const node = document.createElement('i');
    node.className = `fa-solid ${icon}`;
    button.append(node);
    return button;
}

/**
 * Mounts the settings drawer inside the Extensions panel.
 * @param {{context: object, settings: object, store: import('./store.js').ErrorStore, panel?: object, onTest: () => void}} options
 */
export function mountSettings({ context, settings, store, panel, onTest, onFloodTest }) {
    const mount = () => {
        if (document.getElementById('stelp-settings')) return true;
        const container = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
        if (!container) return false;

        const drawer = el('div', 'inline-drawer');
        const toggle = el('div', 'inline-drawer-toggle inline-drawer-header');
        toggle.append(el('b', '', '错误日志面板'), el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));

        const content = el('div', 'inline-drawer-content');
        content.id = 'stelp-settings';
        content.append(
            el(
                'div',
                'stelp-settings-note',
                `错误会固定保留在左侧面板中，直到手动清空。每条错误都会自动给出中文原因分析（内置 ${RULE_COUNT} 条规则），列表里显示一行结论，展开看完整的原因与处置建议。同类 5xx/524 会在 60 秒内合并为 ×N；默认只渲染最近 50 条。扩展加载前的早期错误无法捕获。`,
            ),
        );

        const save = () => {
            try {
                context.saveSettingsDebounced?.();
            } catch {
                // Best-effort only.
            }
        };

        const addCheckbox = (id, label, key, onChange) => {
            const labelNode = el('label', 'checkbox_label stelp-setting-row');
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.id = id;
            input.checked = !!settings[key];
            input.addEventListener('change', () => {
                settings[key] = input.checked;
                save();
                onChange?.(input.checked);
            });
            labelNode.append(input, el('span', '', label));
            content.append(labelNode);
        };

        const addNumber = (id, label, key, min, max, onChange) => {
            const row = el('label', 'stelp-setting-row stelp-number-row');
            const input = document.createElement('input');
            input.type = 'number';
            input.id = id;
            input.className = 'text_pole';
            input.min = String(min);
            input.max = String(max);
            input.value = String(settings[key]);
            input.addEventListener('change', () => {
                let value = Number(input.value);
                if (!Number.isFinite(value)) value = Number(settings[key]);
                value = clamp(Math.round(value), min, max);
                input.value = String(value);
                settings[key] = value;
                save();
                onChange?.(value);
            });
            row.append(el('span', '', label), input);
            content.append(row);
        };

        addCheckbox('stelp_enabled', '启用错误日志面板', 'enabled');
        addCheckbox('stelp_capture_http', '捕获 HTTP 错误', 'captureHttp');
        addCheckbox('stelp_capture_toastr', '捕获 Toastr 消息', 'captureToastr');
        addCheckbox('stelp_capture_sse', '捕获流式（SSE）错误', 'captureSse');
        addCheckbox('stelp_capture_success_errors', '检测 200 响应中的错误载荷', 'captureSuccessErrors');
        addCheckbox('stelp_capture_status_checks', '捕获连接状态检查失败', 'captureStatusChecks');
        addCheckbox('stelp_capture_window_error', '捕获脚本错误', 'captureWindowError');
        addCheckbox('stelp_capture_unhandled', '捕获未处理的 Promise 拒绝', 'captureUnhandled');
        addCheckbox('stelp_capture_console_error', '捕获 console.error（可能较多）', 'captureConsoleError');
        addCheckbox('stelp_capture_console_warn', '捕获 console.warn', 'captureConsoleWarn');
        addCheckbox('stelp_capture_user_aborts', '记录用户主动中止', 'captureUserAborts');

        content.append(el('div', 'stelp-settings-section', `原因分析（${RULE_COUNT} 条规则）`));
        addCheckbox('stelp_show_diagnosis', '显示中文原因分析（结论 / 原因 / 处置）', 'showDiagnosis', () => panel?.render?.());
        addCheckbox('stelp_diag_inline', '折叠列表中直接显示一行结论', 'diagInline', () => panel?.render?.());

        addNumber('stelp_pending_timeout', '无响应超时（秒）', 'pendingTimeoutSec', 1, 3600);
        addNumber('stelp_stream_idle', '流式空闲超时（秒，0 关闭）', 'streamIdleSec', 0, 3600);
        addNumber('stelp_max_entries', '最大保留条数', 'maxEntries', 10, 1000, () => store.trim());

        addCheckbox('stelp_watch_pending', '启用无响应超时提醒', 'watchPending');
        addCheckbox('stelp_watch_stream', '启用流式空闲提醒', 'watchStreamIdle');
        addCheckbox('stelp_persist', '持久化到浏览器存储', 'persist', () => store.saveNow());
        addCheckbox('stelp_default_collapsed', '启动时收起', 'defaultCollapsed');
        addCheckbox('stelp_auto_expand', '有错误时自动展开', 'autoExpandOnError');
        addCheckbox('stelp_notify', '出现新错误时顶部弹出提示', 'notifyOnError');

        const buttons = el('div', 'stelp-settings-buttons');
        const testButton = el('button', 'menu_button', '插入测试记录');
        testButton.type = 'button';
        testButton.addEventListener('click', () => onTest?.());

        const floodButton = el('button', 'menu_button', '插入错误风暴（20 条 524）');
        floodButton.type = 'button';
        floodButton.addEventListener('click', () => onFloodTest?.());

        const copyButton = el('button', 'menu_button', '复制全部诊断信息');
        copyButton.type = 'button';
        copyButton.addEventListener('click', async () => {
            const ok = await copyText(store.formatAll());
            panel?.showToast?.(ok ? '已复制全部诊断信息' : '复制失败，请手动选择文本');
        });

        const resetButton = el('button', 'menu_button', '重置面板位置');
        resetButton.type = 'button';
        resetButton.addEventListener('click', () => panel?.resetPosition?.());

        buttons.append(testButton, floodButton, copyButton, resetButton);
        content.append(buttons);

        drawer.append(toggle, content);
        container.append(drawer);
        return true;
    };

    if (mount()) return;

    let tries = 0;
    const timer = setInterval(() => {
        tries++;
        if (mount() || tries > 30) clearInterval(timer);
    }, 500);
}
