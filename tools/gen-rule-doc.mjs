/**
 * 从 diagnose.js 的 RULES 表生成 docs/DIAGNOSIS.md，避免文档与实现漂移。
 *
 * 用法：node tools/gen-rule-doc.mjs
 * 说明：仓库根目录没有 package.json（避免 SillyTavern 安装时跑 npm install），
 *      所以 .js 会被 Node 当成 CJS。这里复制成临时 .mjs 再动态 import。
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = path.join(root, 'diagnose.js');
const tmp = path.join(tmpdir(), `stelp-diagnose-${process.pid}.mjs`);

const code = await readFile(src, 'utf8');
await writeFile(tmp, code, 'utf8');

const { describeRules, RULE_COUNT } = await import(pathToFileURL(tmp).href);
await rm(tmp, { force: true });

const rules = describeRules().sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));

const conf = (w) => (w >= 90 ? '高' : w >= 75 ? '中' : '低');

const lines = [
    '# 诊断规则表',
    '',
    `> 由 \`tools/gen-rule-doc.mjs\` 从 \`diagnose.js\` 自动生成，请勿手工编辑。共 **${RULE_COUNT}** 条。`,
    '',
    '判定流程：上下文构建 → 全部规则打分 → 取最高分为「结论」→ 合并 ≥70 分的次级规则 → 置信度 = `权重 ≥90 高 / ≥75 中 / 其余低`。',
    '',
    '| # | id | 权重 | 置信度 | 标签 | 结论 |',
    '|---:|---|---:|---|---|---|',
];

rules.forEach((rule, index) => {
    const summary = rule.summary.replace(/\|/g, '\\|');
    lines.push(`| ${index + 1} | \`${rule.id}\` | ${rule.weight} | ${conf(rule.weight)} | ${rule.tags.join(' / ')} | ${summary} |`);
});

lines.push(
    '',
    '## 上下文对象（`test(ctx)` 可用的字段）',
    '',
    '| 字段 | 含义 |',
    '|---|---|',
    '| `ctx.status` | HTTP 状态码（number，无则 0） |',
    '| `ctx.text` | 消息 + 响应体 + 错误类型/码 + 堆栈 + 相关消息的合并小写文本 |',
    '| `ctx.has(...words)` | 在上面这段文本里找任一关键字 |',
    '| `ctx.stage` | `http-error` / `network-error` / `stream-error` / `idle` / `waiting` / `user-abort` / `status-check` / `success-error-payload` / `esa-block` / `resolved` |',
    '| `ctx.path` / `ctx.model` / `ctx.stream` / `ctx.messageCount` | 请求侧元数据 |',
    '| `ctx.name` / `ctx.code` / `ctx.type` | 异常名、错误码、错误类型 |',
    '| `ctx.duration` / `ctx.resolved` | 响应头耗时 / 最终耗时（ms） |',
    '| `ctx.source` / `ctx.level` / `ctx.count` | 记录来源、级别、聚合次数 |',
    '| `ctx.header(name)` | 取诊断响应头（`retry-after`、`cf-ray`、`x-ratelimit-*` 等） |',
    '',
    '## 新增规则',
    '',
    '在 `diagnose.js` 的 `RULES` 数组追加：',
    '',
    '```js',
    '{',
    "    id: 'my-rule',",
    '    weight: 90,',
    "    tags: ['分类'],",
    "    test: (c) => c.status === 418 || c.has('teapot'),",
    "    summary: '一句话结论',",
    "    causes: ['可能原因 1'],",
    "    fixes: ['处置建议 1'],",
    '}',
    '```',
    '',
    '然后执行 `node tools/gen-rule-doc.mjs` 重新生成本文件。',
    '',
);

await mkdir(path.join(root, 'docs'), { recursive: true });
await writeFile(path.join(root, 'docs', 'DIAGNOSIS.md'), lines.join('\n'), 'utf8');
console.log(`docs/DIAGNOSIS.md 已生成：${rules.length} 条规则`);
