# 错误日志面板 · ST-Error-Log-Panel

SillyTavern 第三方前端扩展。把一闪而过的报错**固定显示在页面左侧**，并且对每条错误自动给出**中文原因分析与处置建议** —— 不用再开 F12 猜 524、502、`Failed to fetch` 到底是谁的问题。

```
┌─ 错误日志 ───────────────────── ×12 ─┐
│ [全部] [错误] [警告] [信息]          │
│ ┌──────────────────────────────────┐ │
│ │ HTTP 524 上游超时      ×6   21:44 │ │
│ │ example.com | 524: A timeout occurred │ │
│ │ Cloudflare 等了 100 秒没拿到源站响应…│ │  ← 一行结论
│ └──────────────────────────────────┘ │
│ 共 12 条 · 最多保留 200 条   [重载页面]│
└──────────────────────────────────────┘
```

展开任意一条，最上方就是「原因分析」卡片：**结论 + 置信度 + 标签 + 可能原因 + 处置建议**。

---

## 目录

- [功能](#功能)
- [环境要求](#环境要求)
- [安装](#安装)
- [更新](#更新)
- [使用](#使用)
- [设置项](#设置项)
- [原因分析规则](#原因分析规则)
- [与其它扩展的兼容性](#与其它扩展的兼容性)
- [排错 FAQ](#排错-faq)
- [卸载](#卸载)
- [开发](#开发)
- [许可](#许可)

---

## 功能

| 能力 | 说明 |
|---|---|
| **中文原因分析** | 每条错误自动附带一句结论 + 可能原因 + 处置建议，内置 47 条规则，权重排序、可多规则叠加，命中不到给兜底建议 |
| **HTTP 错误** | 捕获所有同源 `/api/*` 的非 2xx 响应：状态码、接口、耗时、模型、响应体关键内容、诊断响应头（`retry-after` / `cf-ray` / `x-ratelimit-*`） |
| **Toastr 提示** | 包装 `toastr.error` / `toastr.warning`，原本 4 秒消失的错误会留在面板里；不使用 `toastr.subscribe`，不覆盖 ST 自己的订阅者 |
| **流式错误** | 后台嗅探 `text/event-stream`，捕获 SSE 帧里的 `error` / `detail` / `message`，以及直接写进流的原始错误 JSON |
| **超时提醒** | 请求超时未返回响应头先给警告；流式长时间无数据提示「流式响应停滞」，恢复后自动更新为耗时 |
| **未处理异常** | 捕获 `error` / `unhandledrejection`，可选 `console.error` / `console.warn` |
| **错误风暴聚合** | 相同状态码 + 接口 + 消息的重复失败在 60 秒内合并为 `×N`，不刷满面板 |
| **HTML 错误页摘要** | Cloudflare 524 / Caddy 502 等 HTML 错误页提取 `<title>` 作为主消息；ESA 的 `Denied by http_custom` 单独标记「ESA 边缘拦截」 |
| **200 里的错误** | `/api/backends/*` 在 HTTP 200 下返回 `{error/detail/message}` 时标记「上游错误载荷（HTTP 200）」；`/status` 返回 `{error:true}` 标记「连接状态检查失败」 |
| **去重合并** | 同一次失败被 fetch、toastr、unhandledrejection、SSE 同时报告时合并为一条 |
| **移动端友好** | 详情懒构建、默认只渲染最近 50 条、渲染 200ms 节流、移动端不自动展开 |
| **持久化** | 记录、折叠状态、面板位置存 localStorage，可一键关闭 |
| **脱敏** | `sk-...`、`Bearer ...`、`api_key=` 等常见密钥形状在写入存储前替换为 `***`，复制出去的诊断文本不含明文密钥 |
| **纯前端** | 不修改 SillyTavern 核心，不启用服务端插件，安装后刷新页面即生效 |

## 环境要求

| 项 | 要求 |
|---|---|
| SillyTavern | ≥ 1.12（已在 **1.19.0**（Docker）与 **1.17.0**（Windows 本地）上验证；依赖 `getContext()`、`extensionSettings`、inline-drawer 样式） |
| 浏览器 | Chrome / Edge / Firefox 最近版本（用到 `AbortController`、`ReadableStream` 等现代 API） |
| 运行时依赖 | **无**。纯 ESM 前端模块，不需要 `npm install`，不需要重启服务 |
| 部署形态 | Docker 镜像、源码/裸机 Node、Windows 本地运行均可 |
| 网络 | 安装时 SillyTavern 所在机器需能 `git clone` github.com |

安装位置（ST 的第三方扩展目录，由 ST 自动创建）：

```
<SillyTavern>/public/scripts/extensions/third-party/ST-Error-Log-Panel/
```

## 安装

**用 SillyTavern 自带的扩展安装器装，不需要下载、不需要解压、不需要手动放目录。**

1. 打开 SillyTavern 页面，点顶部工具栏的「扩展」图标（Extensions，插头形状）。
2. 在最上面的 **Install extension**（安装扩展）输入框里粘贴仓库地址：

```
https://github.com/gmnop/ST-Error-Log-Panel.git
```

3. 点右侧 **Install**，等提示 `Extension installed successfully`。
4. 回到页面按 **Ctrl + Shift + R** 硬刷新。

ST 会在 `third-party/` 下执行 `git clone`，目录名自动取仓库名 `ST-Error-Log-Panel`；`manifest.json` 位于仓库根目录，装完即被识别，无需重启服务。

### 安装成功自检

硬刷新后在浏览器控制台执行：

```js
STELP.ruleCount      // → 47
STELP.diagnose(STELP.store.entries[0])   // 对任意一条记录跑诊断
```

左侧出现悬浮面板（无错误时是一条窄标签），扩展抽屉里出现「错误日志面板」即安装完成。

## 更新

`manifest.json` 里 `auto_update: true`，扩展抽屉里该扩展会显示「更新」按钮，点一下即执行 `git pull` 拉取最新提交。

也可以在 SillyTavern 目录下手动更新：

```bash
git -C public/scripts/extensions/third-party/ST-Error-Log-Panel pull
```

## 使用

- **列表**：来源徽章（HTTP / 网络 / 超时 / 流式 / 提示 / 脚本）、状态码、时间、`×N` 次数；每行下面一行灰色小字是**该错误的一句话结论**。
- **展开详情**：原因分析卡片（置信度 + 标签 + 结论 + 可能原因 + 处置建议）→ 请求/状态/错误码/耗时/模型/流式/消息数/来源/重复 → 相关消息 → 响应内容 → 响应头 → 堆栈。
- **头部按钮**：暂停/恢复捕获、复制全部诊断、清空、收起。
- **过滤**：全部 / 错误 / 警告 / 信息。
- **交互**：拖动头部移动面板（位置记住）；点击顶部弹出的提示可直接定位到对应记录。
- **复制**：复制内容已脱敏，并**自带原因分析**，可以直接贴给别人排查。
- **设置抽屉**里还有「插入测试记录」「插入错误风暴（20 条 524）」用于验证聚合与渲染性能。

## 设置项

写在 `extensionSettings.stErrorLogPanel`（SillyTavern 的 `settings.json`），随 ST 一起保存。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `captureHttp` | `true` | 捕获非 2xx 响应 |
| `captureToastr` | `true` | 捕获 `toastr.error` / `warning` |
| `captureSse` | `true` | 嗅探流式响应里的错误帧 |
| `captureSuccessErrors` | `true` | 检测 HTTP 200 里的错误载荷 |
| `captureStatusChecks` | `true` | 记录 `/api/backends/*/status` 连接检查失败 |
| `captureWindowError` | `true` | 捕获未处理脚本错误 |
| `captureUnhandled` | `true` | 捕获未处理 Promise 拒绝 |
| `captureConsoleError` | `false` | 捕获 `console.error`（较吵，默认关） |
| `captureConsoleWarn` | `false` | 捕获 `console.warn` |
| `captureUserAborts` | `false` | 记录用户主动点「停止」 |
| `watchPending` | `true` | 无响应超时提醒 |
| `pendingTimeoutSec` | `60` | 多久没响应头算超时（秒） |
| `watchStreamIdle` | `true` | 流式空闲提醒 |
| `streamIdleSec` | `60` | 流式多久没数据算停滞（秒，0 关闭） |
| `maxEntries` | `200` | 最大保留条数（10–1000） |
| `persist` | `true` | 持久化到 localStorage |
| `defaultCollapsed` | `false` | 启动时收起 |
| `autoExpandOnError` | `true` | 有错误时自动展开（移动端不自动展开） |
| `notifyOnError` | `true` | 新错误时顶部弹出 5 秒提示 |
| `showDiagnosis` | `true` | 显示中文原因分析 |
| `diagInline` | `true` | 列表中直接显示一行结论 |

## 原因分析规则

判定流程：把记录摊平成上下文（状态码 / 消息 / 响应体 / 错误名 / 流式阶段 / 路径 / 模型 / 诊断响应头）→ 规则表打分 → 取最高分作为「结论」，≥70 分的第二、三条规则的原因与建议合并进来 → `≥90` 记为置信度高、`≥75` 中、其余低。

覆盖范围一览：HTTP 400/401/402/403/404/405/408/413/415/422/429/499/5xx、Cloudflare 520–530、阿里云 ESA 边缘拦截、人机验证页、SSE 中途报错/停滞/等响应头、`Failed to fetch` 与 `ERR_CONNECTION_*`、证书、HTTP/2、上下文超长、模型不存在 / 无可用渠道、余额不足、限流、参数不支持、roles 交替、HTML 当 JSON 解析、tokenizer、localStorage 满、200 里的错误载荷、连接状态检查失败……

完整规则表见 **[docs/DIAGNOSIS.md](docs/DIAGNOSIS.md)**（由 `tools/gen-rule-doc.mjs` 从代码生成，不会和实现漂移）。

## 与其它扩展的兼容性

- 目录自包含，只 import 自己目录内的文件，不引用 ST 核心或其它扩展。
- 命名空间独占：CSS/DOM 全部 `stelp-` 前缀，全局只有 `STELP` 和 `__stelpCaptureInstalled`。
- 但为了工作，它确实包装了 4 个全局对象，**全部透明透传**（参数原样、返回值原样）：

| 钩子 | 行为 |
|---|---|
| `window.fetch` | 只观测同源 `/api/*` 响应（clone 读一份），跨域请求直接放行，不改请求也不改响应 |
| `toastr.error` / `toastr.warning` | 记录后调用原函数，其它 toastr 方法不碰 |
| `AbortController.prototype.abort` | 只在 signal 上打「用户主动停止」标记 |
| `console.error` / `console.warn` | 默认关闭，需手动开 |

- 与同样包装 `window.fetch` 的扩展（例如 JS-Slash-Runner）是**链式叠加**关系：都 call through，不互相吞请求。
- 性能代价：流式响应会多 clone 一份读一遍（上限 8MB）。觉得有影响就点面板上的「暂停捕获」，观测会完全停止。

## 日志在哪儿？

本扩展**不假设你的部署方式**，也不会替你在诊断建议里写死某个日志路径 —— 不同人跑 SillyTavern 的方式差别很大（容器、源码 
ode server.js、Windows 双击启动、服务管理器托管…），写死一处只会误导。

所以看到「去看运行日志」时，请按你自己的方式找到它：启动 SillyTavern 的那个**终端窗口/控制台**、你所用平台的**日志面板**，或你配置的日志文件。同理，扩展给出的端口、反代、内存相关建议都只是通用方向，具体命令以你的环境为准。
## 排错 FAQ

**面板不出现？**
确认目录层级是 `third-party/ST-Error-Log-Panel/manifest.json`（少一层都不行），然后硬刷新；控制台执行 `STELP` 应返回对象，`undefined` 说明模块没加载——看 Console 里是否有 `[STELP]` 前缀的报错。

**装完显示英文名 / 版本号不对？**
`manifest.json` 必须能被 ST 解析（UTF-8、无 BOM、合法 JSON）。改完硬刷新。

**ST 里点安装报错？**
- `Could not resolve host` / `Recv failure: Connection was reset` / `RPC failed` → 是 SillyTavern 所在机器到 github.com 的 git 通道问题（国内网络常见）。确认 `git clone https://github.com/gmnop/ST-Error-Log-Panel.git` 能通，必要时给 ST 进程配代理后再装。
- `Repository not found` / `404` → 检查地址是否拼错（`gmnop/ST-Error-Log-Panel.git`），以及仓库是否已公开。

**面板里的错误和我 F12 看到的不一致？**
本扩展只观测**同源 `/api/*`**。浏览器直连第三方供应商的跨域请求不在此列（也看不到）。

**误报太多？**
设置里关掉 `captureConsoleError` / `captureUserAborts`，或把 `pendingTimeoutSec` 调大（长上下文模型首 token 很慢，60 秒容易误报）。

**记录把 localStorage 塞满了？**
关掉「持久化」或把「最大保留条数」降到 100。

## 卸载

```bash
# ① 删除扩展目录（唯一实体）
rm -rf <third-party>/ST-Error-Log-Panel

# ② 清掉 ST 设置里的孤儿键（可选）
#    先按你自己的方式把 SillyTavern 停下来，改完再启动（容器 / 终端 / 服务管理器均可）
python3 - <<'PY'
import json, shutil, time
p = '/path/to/data/default-user/settings.json'
shutil.copy(p, p + '.bak-' + time.strftime('%Y%m%d-%H%M%S'))
d = json.load(open(p, encoding='utf-8'))
d.get('extension_settings', {}).pop('stErrorLogPanel', None)
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=4)
PY

# ③ 浏览器端残留（F12 Console）
localStorage.removeItem('stErrorLogPanel');
localStorage.removeItem('stErrPanel.entries.v1');
localStorage.removeItem('stErrPanel.ui.v1');
location.reload();
```

## 开发

```
ST-Error-Log-Panel/
├─ manifest.json      # ST 扩展清单（必须在仓库根目录）
├─ index.js           # 入口：bootstrap、注入测试数据、挂 STELP
├─ capture.js         # 采集层：fetch / toastr / window / console / SSE / 看门狗
├─ store.js           # 数据层：去重合并、脱敏、持久化、文本导出
├─ diagnose.js        # 诊断层：47 条规则 + 上下文构建（纯函数，可在 Node 里单测）
├─ ui.js              # 视图层：悬浮面板、详情、设置抽屉
├─ style.css          # 样式（全部 #stelp-panel 作用域内）
├─ docs/DIAGNOSIS.md  # 规则表（生成物）
└─ tools/gen-rule-doc.mjs
```

新增一条诊断规则：在 `diagnose.js` 的 `RULES` 里加一项，然后重新生成文档。

```js
{
    id: 'my-rule',           // 唯一 id
    weight: 90,              // 越大越优先；≥90 高置信、≥75 中、其余低
    tags: ['分类'],           // 面板上的小徽章
    test: (c) => c.status === 418 || c.has('teapot'),
    summary: '一句话结论',
    causes: ['可能原因 1'],
    fixes: ['处置建议 1'],
}
```

```bash
node tools/gen-rule-doc.mjs     # 重新生成 docs/DIAGNOSIS.md
```

本地校验（无浏览器）：把 `diagnose.js` 复制成 `.mjs` 后在 Node 里直接 import，`diagnose(entry)` 返回纯数据。

## 许可

[MIT](LICENSE)
