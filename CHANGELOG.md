# 更新日志

遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 1.2.2

- 诊断建议不再假设部署方式：去掉写死的 Docker / 容器 / Caddyfile / dmesg / ss 命令，改为「按你的部署方式去看运行日志/进程状态」这类通用表述（17 处规则文案）。
- README 新增「日志在哪儿？」小节，明确本扩展不指定日志路径，避免误以为必须用某种部署方式。
- 卸载步骤标注 Docker 仅为示例。
## 1.2.1

- 测试样例中的真实域名替换为 `example.com`，README 中的服务器绝对路径改为占位符，便于公开分发。
- 新增 `docs/DIAGNOSIS.md` 规则表与生成脚本 `tools/gen-rule-doc.mjs`。
- `diagnose.js` 新增 `describeRules()` 导出，供文档生成与调试使用。

## 1.2.0

- **新增中文原因分析**：`diagnose.js`，47 条规则，输出「结论 + 可能原因 + 处置建议 + 标签 + 置信度」。
  覆盖 HTTP 4xx/5xx、Cloudflare 520–530、ESA 边缘拦截、人机验证页、SSE 中途报错/停滞、
  `Failed to fetch` 与 `ERR_CONNECTION_*`、上下文超长、模型不存在、余额不足、限流、参数不支持、
  HTML 当 JSON 解析、连接状态检查失败等。
- 列表每条错误增加一行结论；详情顶部增加「原因分析」卡片；复制内容自动带上分析。
- 新增设置项 `showDiagnosis`、`diagInline`。
- 控制台暴露 `STELP.diagnose(entry)` / `STELP.formatDiagnosis()` / `STELP.ruleCount`。

## 1.1.1

- 错误风暴聚合：相同状态码 + 接口 + 消息在 60 秒内合并为 `×N`。
- 流式停滞检测与恢复后耗时回填。
- 移动端默认不自动展开面板；详情懒构建；渲染 200ms 节流。
- `200` 响应里的错误载荷、`/status` 连接检查失败分别标记 `200 ERR` / `CONN`。

## 1.1.0

- 增加 SSE 嗅探、看门狗超时提醒、`unhandledrejection` 捕获。
- 密钥形状脱敏（`sk-`、`Bearer`、`api_key=` 等）。
- localStorage 持久化记录与面板位置。

## 1.0.0

- 首个可用版本：固定显示 HTTP 非 2xx 与 Toastr 错误，左侧悬浮面板。
