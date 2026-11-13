# 诊断规则表

> 由 `tools/gen-rule-doc.mjs` 从 `diagnose.js` 自动生成，请勿手工编辑。共 **47** 条。

判定流程：上下文构建 → 全部规则打分 → 取最高分为「结论」→ 合并 ≥70 分的次级规则 → 置信度 = `权重 ≥90 高 / ≥75 中 / 其余低`。

| # | id | 权重 | 置信度 | 标签 | 结论 |
|---:|---|---:|---|---|---|
| 1 | `esa-block` | 99 | 高 | ESA / 边缘拦截 | 请求在阿里云 ESA 边缘就被拦截了，根本没有到达 SillyTavern 或模型供应商。 |
| 2 | `auth-401-key` | 98 | 高 | 鉴权 / API Key | API Key 被上游判定为无效：请求已经到达供应商，但鉴权没过。 |
| 3 | `cf-challenge` | 97 | 高 | Cloudflare / 人机验证 | API 请求被 Cloudflare 的人机验证页拦住了，返回的是 HTML 挑战页而不是 JSON。 |
| 4 | `ctx-length` | 97 | 高 | 上下文超长 | 上下文超出模型上限：发过去的历史 + 注入内容比模型能吃下的 token 多。 |
| 5 | `quota` | 97 | 高 | 配额 / 余额 | 账户额度/余额不足：请求被供应商或中转站直接拒绝，与网络无关。 |
| 6 | `cf-524` | 96 | 高 | Cloudflare / 超时 | Cloudflare 等了 100 秒没拿到源站响应，主动返回 524——请求到了你的服务器，但上游模型迟迟没吐出第一个字节。 |
| 7 | `rate-429` | 96 | 高 | 限流 / 重试 | 触发速率/并发限制（429）：这是最「良性」的错误，退避后重试通常就能过。 |
| 8 | `region-403` | 96 | 高 | 地区限制 | 供应商不支持当前出口 IP 所在的国家/地区（403 unsupported_country_region_territory）。 |
| 9 | `gw-502` | 95 | 高 | 网关 / 反代 | 反向代理（Caddy / Nginx / 中转站）拿不到有效响应，502 是网关侧的错误，不是模型的错误。 |
| 10 | `cf-522-523` | 94 | 高 | Cloudflare / 回源失败 | Cloudflare 连不上你的源站（522 连接超时 / 523 源站不可达），这一层跟模型供应商无关。 |
| 11 | `gw-504` | 94 | 高 | 网关 / 超时 | 网关等后端超时（504）：反代的读超时到了，源站还没返回。 |
| 12 | `status-check` | 94 | 高 | 连接检查 | ST 的「连接状态检查」失败（HTTP 200 但 body 里带 error）：端点存在，但当前配置用不了。 |
| 13 | `cf-521-525-526` | 93 | 高 | Cloudflare / SSL | Cloudflare 与源站之间的 TLS 握手/证书校验失败（521 拒绝连接、525 握手失败、526 证书无效）。 |
| 14 | `model-invalid` | 93 | 高 | 模型 / 路由 | 模型名/模型路由不存在：上游找不到你请求的这个模型。 |
| 15 | `sse-error` | 93 | 高 | 流式 / 中途报错 | 流式响应中途出错：HTTP 头已经 200，但 SSE 帧里带着错误对象。 |
| 16 | `gw-503` | 92 | 高 | 网关 / 过载 | 服务不可用：要么上游供应商过载/维护，要么中转站没有可用渠道。 |
| 17 | `moderation` | 92 | 高 | 内容审查 | 请求被内容安全策略拦截（审查/风控），模型根本没开始生成。 |
| 18 | `net-fetch-failed` | 92 | 高 | 网络 / 连接中断 | 浏览器连不上目标（Failed to fetch）：请求在传输层就失败了，没有拿到任何 HTTP 响应。 |
| 19 | `overloaded` | 92 | 高 | 过载 | 上游过载：供应商/中转站当前处理不过来。 |
| 20 | `cf-530` | 90 | 高 | Cloudflare / DNS | Cloudflare 解析不出源站地址（530），通常是 DNS 记录问题。 |
| 21 | `http-404` | 90 | 高 | 端点 / 路由 | 端点不存在（404）：URL 路径不对，请求没打到真正的接口上。 |
| 22 | `http-413` | 90 | 高 | 体积超限 | 请求体过大（413）：反代或供应商在读完 body 之前就拒绝了。 |
| 23 | `net-conn-reset` | 90 | 高 | 网络 / 连接重置 | TCP 层就断了：连接被重置/拒绝/无法解析，请求根本没到应用层。 |
| 24 | `param-max-tokens` | 90 | 高 | 参数 | 参数超出模型允许范围：max_tokens（输出长度）超过了该模型的上限。 |
| 25 | `sse-idle` | 90 | 高 | 流式 / 停滞 | 流式连接长时间收不到任何数据：连接还在，但没有 token 到达。 |
| 26 | `auth-401-plain` | 88 | 中 | 鉴权 | 请求未通过鉴权（401），但响应体没有给出具体原因。 |
| 27 | `js-json-html` | 88 | 中 | 前端 / 返回值异常 | 前端在解析 JSON 时拿到了 HTML/空内容：说明响应不是 API 的 JSON，而是错误页。 |
| 28 | `param-roles` | 88 | 中 | 参数 / 消息结构 | 消息角色结构不合法：上游要求 user/assistant 交替，但请求里出现了连续相同角色。 |
| 29 | `sse-waiting` | 88 | 中 | 超时 / 无响应 | 请求发出后长时间没有返回响应头：上游在排队或链路卡住。 |
| 30 | `success-error-payload` | 88 | 中 | 上游错误 / HTTP 200 | 上游把错误包装在 HTTP 200 里返回：表面成功，实际是错误载荷。 |
| 31 | `gw-500` | 86 | 中 | 服务端 / 崩溃 | 服务端内部错误（5xx）：请求格式本身能被接受，但处理过程中崩了。 |
| 32 | `net-cert` | 86 | 中 | 证书 | TLS 证书校验失败：浏览器不信任目标站点的证书。 |
| 33 | `param-unsupported` | 86 | 中 | 参数 / 能力不支持 | 该模型不支持请求里的某个能力/参数（图片、工具调用、response_format、stream_options 等）。 |
| 34 | `http-422` | 85 | 中 | 参数校验 | 参数校验失败（422）：字段类型或必填项不符合接口定义。 |
| 35 | `http-408` | 84 | 中 | 超时 | 服务器等待请求数据超时（408）：连接建立了但请求没发完。 |
| 36 | `net-h2` | 84 | 中 | HTTP/2 | HTTP/2 协议错误：浏览器与反代在 h2 协商/帧处理上不兼容。 |
| 37 | `perm-403` | 84 | 中 | 权限 | 访问被拒绝（403），原因需要结合响应体判断。 |
| 38 | `http-405` | 82 | 中 | 方法 | 方法不被允许（405）：该路径不接受 POST，通常是反代或静态站点接了这个请求。 |
| 39 | `http-415` | 80 | 中 | 内容类型 | Content-Type 不被接受（415）：上游要求 application/json，收到的不是。 |
| 40 | `sse-abort` | 80 | 中 | 中断 | 请求被主动中断：连接在完成前被关闭。 |
| 41 | `empty-output` | 78 | 中 | 空响应 | 拿到了 200 但内容为空：模型没有产出实际 token。 |
| 42 | `http-400` | 78 | 中 | 请求错误 | 请求格式不合法（400）：上游读懂了请求，但拒绝按这个格式处理。 |
| 43 | `js-typeerror` | 76 | 中 | 前端脚本 | 前端脚本读到了 undefined/null 的属性：多半是数据结构与预期不符。 |
| 44 | `http-499` | 74 | 低 | 中断 | 客户端提前关闭了连接（499，Nginx 定义）：服务端还在处理，浏览器已经不等了。 |
| 45 | `js-not-function` | 74 | 低 | 前端脚本 | 调用了不存在的方法/变量：典型的新旧版本 API 不匹配。 |
| 46 | `storage-quota` | 72 | 低 | 浏览器存储 | 浏览器存储写满：localStorage/IndexedDB 配额耗尽。 |
| 47 | `js-tokenizer` | 68 | 低 | Tokenizer | tokenizer 相关错误：本地无法正确计数 token。 |

## 上下文对象（`test(ctx)` 可用的字段）

| 字段 | 含义 |
|---|---|
| `ctx.status` | HTTP 状态码（number，无则 0） |
| `ctx.text` | 消息 + 响应体 + 错误类型/码 + 堆栈 + 相关消息的合并小写文本 |
| `ctx.has(...words)` | 在上面这段文本里找任一关键字 |
| `ctx.stage` | `http-error` / `network-error` / `stream-error` / `idle` / `waiting` / `user-abort` / `status-check` / `success-error-payload` / `esa-block` / `resolved` |
| `ctx.path` / `ctx.model` / `ctx.stream` / `ctx.messageCount` | 请求侧元数据 |
| `ctx.name` / `ctx.code` / `ctx.type` | 异常名、错误码、错误类型 |
| `ctx.duration` / `ctx.resolved` | 响应头耗时 / 最终耗时（ms） |
| `ctx.source` / `ctx.level` / `ctx.count` | 记录来源、级别、聚合次数 |
| `ctx.header(name)` | 取诊断响应头（`retry-after`、`cf-ray`、`x-ratelimit-*` 等） |

## 新增规则

在 `diagnose.js` 的 `RULES` 数组追加：

```js
{
    id: 'my-rule',
    weight: 90,
    tags: ['分类'],
    test: (c) => c.status === 418 || c.has('teapot'),
    summary: '一句话结论',
    causes: ['可能原因 1'],
    fixes: ['处置建议 1'],
}
```

然后执行 `node tools/gen-rule-doc.mjs` 重新生成本文件。
