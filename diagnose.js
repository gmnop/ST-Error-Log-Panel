/**
 * 中文错误诊断引擎（ST-Error-Log-Panel / diagnose.js）
 *
 * 输入一条错误记录（或它的 details），输出面向 SillyTavern 用户的中文根因分析：
 * 一句结论 + 可能原因 + 处置建议 + 标签 + 置信度。
 *
 * 设计约束：
 *  - 纯函数，不碰 DOM / 浏览器全局，可在 Node 里直接单测。
 *  - 不做网络请求，不查表，不依赖 i18n，所有文案内联。
 *  - 规则是「权重排序后取前 N 条」，不是 if-else 瀑布：同一条错误可以同时命中
 *    「524 + Cloudflare」和「流式 + 时长过长」，两条原因一起给出。
 *  - 命中不到任何规则时也给出兜底建议，绝不返回空。
 */

const MAX_CAUSES = 6;
const MAX_FIXES = 6;
const EXTRA_RULE_MIN_WEIGHT = 70;
const MAX_EXTRA_RULES = 2;

/** @param {unknown} value @returns {string} */
function norm(value) {
    return String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/**
 * 把一条日志记录摊平成规则可直接判定的上下文。
 * @param {object} entry
 * @returns {object}
 */
export function buildContext(entry) {
    const details = entry?.details || {};
    const related = Array.isArray(details.relatedMessages) ? details.relatedMessages.join(' ') : '';
    const corpus = [
        entry?.title,
        entry?.message,
        details.bodyExcerpt,
        details.statusText,
        details.errorType,
        details.errorCode,
        details.toastrTitle,
        details.stack,
        related,
    ]
        .filter(Boolean)
        .join(' \n ');

    const headers = details.headers && typeof details.headers === 'object' ? details.headers : {};

    return {
        entry,
        details,
        status: Number(details.status) || 0,
        code: norm(details.errorCode),
        type: norm(details.errorType),
        name: norm(details.errorName),
        stage: norm(details.streamStage),
        path: norm(details.path),
        model: String(details.model || ''),
        duration: Number(details.durationMs) || 0,
        resolved: Number(details.resolvedAfterMs) || 0,
        messageCount: Number(details.messageCount) || 0,
        bodyTruncated: details.bodyTruncated === true,
        stream: details.stream === true,
        source: norm(entry?.source),
        level: norm(entry?.level),
        count: Number(entry?.count) || 1,
        text: norm(corpus),
        header(name) {
            const key = String(name).toLowerCase();
            for (const [k, v] of Object.entries(headers)) {
                if (String(k).toLowerCase() === key) return String(v ?? '');
            }
            return '';
        },
        has(...words) {
            return words.some((word) => this.text.includes(norm(word)));
        },
    };
}

/**
 * 规则表。weight 越大越具体（同时命中时排前面）。
 * test(ctx) 返回布尔；summary 是给用户看的一句人话结论。
 */
const RULES = [
    // ---------------------------------------------------------------- 边缘网关
    {
        id: 'esa-block',
        weight: 99,
        tags: ['ESA', '边缘拦截'],
        test: (c) => c.stage === 'esa-block' || c.has('denied by http_custom', 'performance & security by esa', 'x-tengine-error'),
        summary: '请求在阿里云 ESA 边缘就被拦截了，根本没有到达 SillyTavern 或模型供应商。',
        causes: [
            'ESA 的 WAF / 自定义规则命中了请求特征（常见于 POST + JSON + 长 body，或请求头带非常规 UA）',
            'ESA 的地区/境外 IP 封禁策略拒绝了当前出口 IP',
            'ESA 开启了「API 防护 / 频次控制」，聊天接口的高频流式请求被当成攻击',
        ],
        fixes: [
            'ESA 控制台 → 安全防护 → 查看该 RuleID 对应的规则，对 /api/backends/* 加白名单或跳过',
            '把域名解析改回直连源站（灰云），或在 ESA 中关闭该路径的 WAF',
            '临时验证：用 curl -sS -o /dev/null -w "%{http_code}" 直连服务器 IP 打同一个接口，能通即证明是边缘拦截',
        ],
    },
    {
        id: 'cf-challenge',
        weight: 97,
        tags: ['Cloudflare', '人机验证'],
        test: (c) =>
            c.has('just a moment', 'cf-mitigated', 'attention required', 'enable javascript and cookies', 'checking your browser'),
        summary: 'API 请求被 Cloudflare 的人机验证页拦住了，返回的是 HTML 挑战页而不是 JSON。',
        causes: [
            'Cloudflare 的 Security Level / Bot Fight Mode 把接口请求当成爬虫',
            '域名开了「Under Attack Mode」，所有请求都要过 JS 挑战',
            '前端把 HTML 挑战页当 JSON 解析，于是报 Unexpected token <',
        ],
        fixes: [
            'Cloudflare → Security → WAF 里为 /api/* 建 Skip 规则（跳过 Bot Fight、Managed Rules、Security Level）',
            '关闭 Under Attack Mode；或把该子域改为 DNS Only（灰云）',
            '长期方案：SillyTavern 走独立子域并且不经过 Cloudflare 代理',
        ],
    },
    {
        id: 'cf-524',
        weight: 96,
        tags: ['Cloudflare', '超时'],
        test: (c) => c.status === 524,
        summary: 'Cloudflare 等了 100 秒没拿到源站响应，主动返回 524——请求到了你的服务器，但上游模型迟迟没吐出第一个字节。',
        causes: [
            '模型推理时间超过 100 秒（长上下文、长思考链、reasoner 类模型、未开启流式最容易触发）',
            '开了流式但中间层缓冲了 SSE：Cloudflare 在收到首个字节前一直认为「无响应」',
            '上游中转站排队/卡死，反向代理没有及时返回响应头',
            'SillyTavern 到上游的网络链路慢，TLS 握手或 DNS 反复重试',
        ],
        fixes: [
            '在 SillyTavern 里开启「流式传输（Streaming）」，让首 token 尽快返回',
            '缩短上下文（降低 Context Size / 减少世界书注入 / 开消息裁剪），典型把 32k 降到 8k 内',
            'Cloudflare 免费版 100 秒是硬上限，长任务改用直连 IP 或 Cloudflare Tunnel 之外的入口',
            '检查反代是否开启了 proxy_buffering（Nginx 需关；Caddy 默认不缓冲但要确认没装 buffer 插件）',
        ],
    },
    {
        id: 'cf-522-523',
        weight: 94,
        tags: ['Cloudflare', '回源失败'],
        test: (c) => c.status === 522 || c.status === 523,
        summary: 'Cloudflare 连不上你的源站（522 连接超时 / 523 源站不可达），这一层跟模型供应商无关。',
        causes: [
            '源站 IP 变了或 DNS 记录指向了错误地址',
            '服务器防火墙 / 云安全组没有放行 Cloudflare 回源 IP 段的 80/443',
            '服务没起来，或反向代理没在监听，端口被别的程序占了',
            '源站只监听 127.0.0.1，而 Cloudflare 从公网回源',
        ],
        fixes: [
            '在服务器上 curl -I http://127.0.0.1 与 curl -I https://域名 分别验证本机与公网可达性',
            '确认 SillyTavern 与反向代理都在运行；再翻它们各自的运行日志，找同一时刻的回源报错',
            '安全组放行 Cloudflare 官方 IP 段，或临时把源站端口全放行做对比测试',
            '确认反向代理配置里写的上游端口，与 SillyTavern 实际监听的端口一致',
        ],
    },
    {
        id: 'cf-521-525-526',
        weight: 93,
        tags: ['Cloudflare', 'SSL'],
        test: (c) => c.status === 521 || c.status === 525 || c.status === 526,
        summary: 'Cloudflare 与源站之间的 TLS 握手/证书校验失败（521 拒绝连接、525 握手失败、526 证书无效）。',
        causes: [
            '源站证书过期、自签名，或证书链不完整',
            'Cloudflare SSL 模式设为 Full (strict) 但源站用的是自签证书',
            '源站只开了 HTTP，Cloudflare 却用 HTTPS 回源',
            '防火墙把 443 拦了，握手被重置',
        ],
        fixes: [
            'Cloudflare SSL/TLS 模式改为 Full（非 strict）做验证；正式环境换成 Let’s Encrypt 证书',
            '在服务器上 openssl s_client -connect 127.0.0.1:443 -servername 域名 检查证书链',
            '确认反向代理的 443 正常监听且证书路径正确',
        ],
    },
    {
        id: 'cf-530',
        weight: 90,
        tags: ['Cloudflare', 'DNS'],
        test: (c) => c.status === 530,
        summary: 'Cloudflare 解析不出源站地址（530），通常是 DNS 记录问题。',
        causes: ['源站 DNS 记录被删除/改错', 'CNAME 链断裂或指向了不存在的目标', 'Cloudflare 与源站之间的解析被污染'],
        fixes: ['检查 Cloudflare DNS 面板的 A/CNAME 记录', '在服务器上 dig +short 域名 验证解析结果', '源站 IP 变更后同步更新记录'],
    },
    {
        id: 'gw-502',
        weight: 95,
        tags: ['网关', '反代'],
        test: (c) => c.status === 502,
        summary: '反向代理（Caddy / Nginx / 中转站）拿不到有效响应，502 是网关侧的错误，不是模型的错误。',
        causes: [
            'SillyTavern 进程崩溃、正在重启，或被系统 OOM 杀掉',
            '反向代理配置里的上游地址/端口写错，或解析不到目标',
            '上游中转站本身挂了 / 返回了非法响应',
            '请求体太大，代理直接断开连接',
        ],
        fixes: [
            '确认 SillyTavern 进程还在；再看它的运行日志找崩溃栈（日志在哪取决于你的部署方式）',
            '看内存占用是否被打满（小内存机器跑长上下文很容易被 OOM 杀掉）',
            '检查反向代理的配置是否合法（按你用的反代找对应的校验/重载方式）',
            '若怀疑被系统杀进程，去系统日志里查同一时刻的 OOM 记录',
        ],
    },
    {
        id: 'gw-503',
        weight: 92,
        tags: ['网关', '过载'],
        test: (c) => c.status === 503 || c.has('no available channel', '无可用渠道', '当前分组上游负载已饱和', 'service unavailable'),
        summary: '服务不可用：要么上游供应商过载/维护，要么中转站没有可用渠道。',
        causes: [
            '模型供应商侧过载（高峰期、模型刚发布、区域性故障）',
            '中转站（one-api / new-api）里该模型的分组没有可用渠道或渠道全部被禁用',
            '健康检查失败，被反向代理摘除',
            '429/503 混用：部分中转把限流包装成 503',
        ],
        fixes: [
            '换一个模型或供应商做对照，确认是全局故障还是单个渠道',
            '中转站后台检查「渠道」状态、余额与分组倍率',
            '等 1–2 分钟重试；持续出现则在 ST 里换 Base URL',
            '确认 SillyTavern 进程健康、端口仍在监听',
        ],
    },
    {
        id: 'gw-504',
        weight: 94,
        tags: ['网关', '超时'],
        test: (c) => c.status === 504,
        summary: '网关等后端超时（504）：反代的读超时到了，源站还没返回。',
        causes: [
            'Nginx proxy_read_timeout（默认 60s）或 Caddy 上游超时先到',
            '上游模型首 token 太慢，尤其非流式长上下文',
            '反代到上游中转站的链路抖动',
            '请求排队：并发打满，后面的请求一直挂着',
        ],
        fixes: [
            'Nginx 调大：proxy_read_timeout 300s; proxy_send_timeout 300s;',
            'Caddy 用 reverse_proxy 时确认没有额外的 transport timeout 配置',
            'SillyTavern 开流式；非流式长文建议 300s 以上超时',
            '降低并发或换更快的模型做验证',
        ],
    },
    {
        id: 'gw-500',
        weight: 86,
        tags: ['服务端', '崩溃'],
        test: (c) => c.status === 500 || c.status === 501 || c.status === 505,
        summary: '服务端内部错误（5xx）：请求格式本身能被接受，但处理过程中崩了。',
        causes: [
            '上游供应商内部故障（模型服务异常、临时性 bug）',
            '中转站转换协议失败（OpenAI 格式 ↔ Claude/Gemini 格式不兼容）',
            'SillyTavern 后端异常（插件抛错、配置损坏）',
            '返回的是 HTML 错误页（nginx/caddy 默认 500 页），说明是反代而不是 ST 抛的',
        ],
        fixes: [
            '先重试一次，5xx 多数是瞬时故障',
            '去 SillyTavern 的运行日志里看服务端栈',
            '换模型/换渠道对照，确认是供应商侧还是本地侧',
            '若 body 里是 HTML，检查反代错误日志而不是 ST 日志',
        ],
    },

    // ---------------------------------------------------------------- 鉴权 / 配额
    {
        id: 'auth-401-key',
        weight: 98,
        tags: ['鉴权', 'API Key'],
        test: (c) =>
            (c.status === 401 || c.status === 403) &&
            c.has(
                'invalid_api_key',
                'incorrect api key',
                'api key not valid',
                'invalid authentication',
                'authenticationerror',
                'invalid x-api-key',
                '令牌无效',
                '无效的令牌',
                'token 无效',
                'key 无效',
            ),
        summary: 'API Key 被上游判定为无效：请求已经到达供应商，但鉴权没过。',
        causes: [
            'Key 填错、复制时带上了空格/引号/换行，或已被轮换作废',
            'Key 与 Base URL 不是同一家（例如 DeepSeek 的 key 去打 OpenAI 端点，必然 401）',
            '中转站要求的是它自己的令牌，而不是原始供应商 key',
            '请求头里既有 ST 的 Basic Auth 又有上游 Authorization，被反代改写掉了',
        ],
        fixes: [
            '在 ST「API 连接」里重新粘贴 key，注意首尾不要有空格，不要带 Bearer 前缀（ST 会自己加）',
            '核对 Base URL 与 key 的归属：官方 https://api.deepseek.com/v1、https://api.openai.com/v1 等',
            '用 curl 直接验证：curl -sS https://API_HOST/v1/models -H "Authorization: Bearer KEY"',
            '如果走 one-api/new-api，用「令牌」页生成的 sk-xxx 而不是渠道里的原始 key',
        ],
    },
    {
        id: 'auth-401-plain',
        weight: 88,
        tags: ['鉴权'],
        test: (c) => c.status === 401,
        summary: '请求未通过鉴权（401），但响应体没有给出具体原因。',
        causes: [
            'API Key 缺失、过期或被禁用',
            '反代层要求 HTTP Basic Auth（SillyTavern 自身或 Caddy basicauth），浏览器没带凭据',
            '反向代理没有把 Authorization 头透传给上游',
            '时钟偏差过大导致签名类鉴权失败',
        ],
        fixes: [
            '检查 ST 的「API 连接」是否真的保存了 key（改完要点连接/保存）',
            '若 ST 开了 Basic Auth，确认浏览器已登录；curl 测试加 -u 用户名:密码',
            '反代配置里确认 proxy_set_header Authorization $http_authorization; 没被丢弃',
            '服务器 date 与真实时间对比，偏差 > 5 分钟要校时',
        ],
    },
    {
        id: 'quota',
        weight: 97,
        tags: ['配额', '余额'],
        test: (c) =>
            c.status === 402 ||
            c.has(
                'insufficient_quota',
                'insufficient balance',
                'insufficient_user_quota',
                'exceeded your current quota',
                'credit balance is too low',
                'you exceeded your current quota',
                'quota exceeded',
                '余额不足',
                '额度不足',
                '欠费',
                'billing',
                'resource_exhausted',
            ),
        summary: '账户额度/余额不足：请求被供应商或中转站直接拒绝，与网络无关。',
        causes: [
            'API 账户余额耗尽或免费额度到期（DeepSeek 的 Insufficient Balance 最常见）',
            '中转站的令牌额度用尽或用户配额被限',
            '账单异常/欠费导致 key 被停用',
            '组织级月度额度打满（OpenAI 的 hard limit）',
        ],
        fixes: [
            '登录供应商后台充值；DeepSeek 在「充值」页确认到账',
            '中转站后台看令牌剩余额度与分组倍率',
            '换一个还有额度的 key 做验证，确认是额度而不是别的问题',
            '检查是否误用了免费试用 key（额度很小，长对话几次就没了）',
        ],
    },
    {
        id: 'region-403',
        weight: 96,
        tags: ['地区限制'],
        test: (c) => c.has('unsupported_country_region_territory', 'country, region, or territory not supported', '地区不支持'),
        summary: '供应商不支持当前出口 IP 所在的国家/地区（403 unsupported_country_region_territory）。',
        causes: [
            '服务器出口 IP 位于供应商封锁的地区',
            '走了代理但代理节点同样在被封地区',
            'Cloudflare WARP / 家宽 IP 被判定为高风险地区',
        ],
        fixes: [
            '让请求从受支持地区出口（换服务器区域或换代理节点）',
            '在服务器上 curl https://ipinfo.io 确认实际出口国家',
            '不要用「注册地可用但服务器所在地不可用」的组合',
        ],
    },
    {
        id: 'moderation',
        weight: 92,
        tags: ['内容审查'],
        test: (c) =>
            c.has(
                'content_policy_violation',
                'content_filter',
                'moderation',
                'flagged',
                'safety system',
                'responsible ai',
                'risk_control',
                '内容审核',
                '敏感内容',
                '违规',
            ),
        summary: '请求被内容安全策略拦截（审查/风控），模型根本没开始生成。',
        causes: [
            '提示词或历史消息命中供应商的敏感词/安全策略',
            '角色卡/世界书里的极端描写触发了 moderation',
            '中转站自带的风控关键词表拦截（比官方更严）',
            'Gemini 的 safetySettings 阈值过低',
        ],
        fixes: [
            '换更宽松的模型或降低 Gemini 的 safety 阈值（BLOCK_NONE）',
            '检查角色卡与预设里的敏感段落，改用隐喻/软描写',
            '把历史里被标记的那条消息删掉再试（ST 会把整段历史一起发）',
            '确认是官方拦截还是中转站拦截：看 body 里的 error.type 与来源域名',
        ],
    },
    {
        id: 'perm-403',
        weight: 84,
        tags: ['权限'],
        test: (c) => c.status === 403,
        summary: '访问被拒绝（403），原因需要结合响应体判断。',
        causes: [
            'Key 没有该模型/该接口的权限',
            'IP 不在白名单，或被供应商风控',
            '反代/WAF 规则拦截',
            '组织设置了模型访问限制',
        ],
        fixes: [
            '查看响应体里的 error.message 与 error.code',
            '供应商后台检查 key 的权限范围与 IP 白名单',
            '换 key / 换模型对照测试',
            '检查 Cloudflare、ESA、宝塔等 WAF 的拦截记录',
        ],
    },
    {
        id: 'rate-429',
        weight: 96,
        tags: ['限流', '重试'],
        test: (c) => c.status === 429,
        summary: '触发速率/并发限制（429）：这是最「良性」的错误，退避后重试通常就能过。',
        causes: [
            'RPM/TPM 超限：短时间连续生成、多标签页同时跑、群聊/多角色并发',
            '免费额度账户的并发上限极低（常见 1–3 并发）',
            '共享 IP 上其他人把额度打满（中转站尤其明显）',
            '上一轮请求还没结束就发了下一轮（ST 的「继续」连点）',
        ],
        fixes: [
            '按 Retry-After / x-ratelimit-reset 退避重试，不要立刻重发',
            '降低并发：关掉多余标签页、别同时跑群聊',
            '升级账户等级或换 key；中转站加额度',
            '在 ST 里开启流式并减少 max_tokens，缩短单次占用时间',
            '持续限流时换供应商做对照，确认不是本地重复请求导致',
        ],
    },

    // ---------------------------------------------------------------- 请求参数
    {
        id: 'ctx-length',
        weight: 97,
        tags: ['上下文超长'],
        test: (c) =>
            c.has(
                'context_length_exceeded',
                'maximum context length',
                'context length',
                'prompt is too long',
                'too many tokens',
                'reduce the length',
                'exceeds the maximum',
                'request too large',
                '上下文超长',
                '超过最大长度',
                '请求过长',
                'tokens exceed',
            ),
        summary: '上下文超出模型上限：发过去的历史 + 注入内容比模型能吃下的 token 多。',
        causes: [
            '聊天历史太长，ST 的 Context Size 设得比模型实际上限大',
            '世界书/角色卡/预设注入大量 token（尤其「常驻」条目）',
            '附件或图片 base64 占用巨大 token',
            'tokenizer 选错导致 ST 低估实际 token 数（Claude/Gemini 尤其明显）',
            'max_tokens 预留空间不足：输入已接近上限，输出预留又把总数顶爆',
        ],
        fixes: [
            '把 ST 的 Context Size 调到模型上限的 70–80%，给输出留余量',
            '开「消息裁剪 / 只保留最近 N 条」，或手动删掉老消息',
            '精简世界书：关掉不用的条目，缩短常驻条目',
            '换长上下文模型（128k/200k）作为对照',
            '把 max_tokens（Response Length）调小再试',
        ],
    },
    {
        id: 'model-invalid',
        weight: 93,
        tags: ['模型', '路由'],
        test: (c) =>
            c.has(
                'model_not_found',
                'does not exist',
                'invalid model',
                'unknown model',
                'no such model',
                'model is not supported',
                'no available channel',
                '无可用渠道',
                '模型不存在',
                '渠道不存在',
            ),
        summary: '模型名/模型路由不存在：上游找不到你请求的这个模型。',
        causes: [
            '模型 ID 拼错或大小写不符（deepseek-chat 不是 DeepSeek-Chat）',
            '中转站没有配置该模型的渠道，或渠道被禁用',
            'Base URL 指错了服务（OpenAI 的模型名打到 DeepSeek 端点）',
            '模型已下线/改名（如 gpt-4-32k 退役）',
        ],
        fixes: [
            '用 curl 拉模型列表核对：curl -sS BASE_URL/models -H "Authorization: Bearer KEY"',
            '在 ST 的模型下拉里重新选一次，避免手输残留旧值',
            '中转站后台确认该模型有可用渠道且分组可见',
            '核对 Base URL 末尾的 /v1 是否与供应商要求一致',
        ],
    },
    {
        id: 'param-max-tokens',
        weight: 90,
        tags: ['参数'],
        test: (c) => c.has('max_tokens', 'max output tokens', 'max_completion_tokens') && (c.status === 400 || c.status === 422),
        summary: '参数超出模型允许范围：max_tokens（输出长度）超过了该模型的上限。',
        causes: [
            'Response Length 设得比模型输出上限大（如 DeepSeek 输出上限 8k）',
            '预设里硬写了过大的 max_tokens',
            '换模型后没同步调整输出长度',
        ],
        fixes: [
            '把 Response Length 降到模型上限内（DeepSeek 8192、GPT-4o 16384 等）',
            '检查预设的「最大回复长度」覆盖值',
            '同时确认输入 + 输出不超过上下文窗口',
        ],
    },
    {
        id: 'param-roles',
        weight: 88,
        tags: ['参数', '消息结构'],
        test: (c) => c.has('roles must alternate', 'must alternate', 'role must be', 'invalid role', 'messages: roles'),
        summary: '消息角色结构不合法：上游要求 user/assistant 交替，但请求里出现了连续相同角色。',
        causes: [
            '世界书/作者注释注入到了错误的位置',
            '预设里有多条 system 或连续 user 消息',
            'ST 的「合并连续消息」选项被关闭，而供应商要求交替',
            '第三方扩展改写了 messages 数组',
        ],
        fixes: [
            'ST 设置里开启「Merge consecutive messages of the same role」',
            '检查预设的顺序段（Prompt Order）是否把 system 插到了中间',
            '临时禁用第三方扩展（Prompt-Template、JS-Slash-Runner 等）对照测试',
            '删掉最后一条失败的空 assistant 消息再重试',
        ],
    },
    {
        id: 'param-unsupported',
        weight: 86,
        tags: ['参数', '能力不支持'],
        test: (c) =>
            c.has(
                'does not support',
                'not supported',
                'unsupported parameter',
                'unsupported value',
                'is not supported for',
                '不支持该',
                '暂不支持',
            ),
        summary: '该模型不支持请求里的某个能力/参数（图片、工具调用、response_format、stream_options 等）。',
        causes: [
            'reasoner/思考类模型不支持 function calling、temperature、response_format',
            '多模态参数发给了纯文本模型',
            'stream_options.include_usage 被不支持的中转拒绝',
            '预设里带着只有某家供应商认识的字段',
        ],
        fixes: [
            '在该模型的预设里关闭对应功能（工具调用 / 图片 / JSON 模式）',
            '换支持该能力的模型做验证',
            '查看响应体 body 里的具体字段名，按字段关掉对应开关',
            '中转站不支持的话换官方端点',
        ],
    },
    {
        id: 'http-400',
        weight: 78,
        tags: ['请求错误'],
        test: (c) => c.status === 400,
        summary: '请求格式不合法（400）：上游读懂了请求，但拒绝按这个格式处理。',
        causes: [
            '参数类型/取值范围不对（temperature、top_p、max_tokens）',
            '消息结构或字段名不符合该供应商规范',
            '上下文或输出超限',
            '预设/扩展注入了供应商不认识的字段',
        ],
        fixes: [
            '展开本条记录看「响应内容」，body 里的 error.message 通常直接点名问题字段',
            '关闭第三方扩展或换默认预设对照',
            '换官方端点排除中转站的格式转换问题',
        ],
    },
    {
        id: 'http-404',
        weight: 90,
        tags: ['端点', '路由'],
        test: (c) => c.status === 404,
        summary: '端点不存在（404）：URL 路径不对，请求没打到真正的接口上。',
        causes: [
            'Base URL 少了或多了一层 /v1',
            'Base URL 末尾带斜杠导致 //chat/completions',
            'ST 版本较新用了 /api/backends/... 而反代只放行了旧路径',
            '中转站没有部署该接口（例如缺 /v1/chat/completions）',
        ],
        fixes: [
            'Base URL 规范写法：https://host/v1（不要带 /chat/completions，不要尾斜杠）',
            'curl -sS -o /dev/null -w "%{http_code}" BASE_URL/models 验证前缀是否正确',
            '反向代理里确认 /api/ 与根路径都转发给 SillyTavern',
            '对照供应商文档的 base_url 示例',
        ],
    },
    {
        id: 'http-405',
        weight: 82,
        tags: ['方法'],
        test: (c) => c.status === 405,
        summary: '方法不被允许（405）：该路径不接受 POST，通常是反代或静态站点接了这个请求。',
        causes: ['Base URL 指向了静态站点/首页而不是 API', '反代把 POST 改写成了 GET', 'CDN 对 /api 路径做了特殊处理'],
        fixes: ['确认 Base URL 指向的是 API 根而不是网站首页', '检查反代 location 配置', '用 curl -X POST 直接验证'],
    },
    {
        id: 'http-413',
        weight: 90,
        tags: ['体积超限'],
        test: (c) => c.status === 413,
        summary: '请求体过大（413）：反代或供应商在读完 body 之前就拒绝了。',
        causes: [
            '上下文太长，请求 JSON 几 MB',
            '附件/图片 base64 撑爆 body',
            'Nginx client_max_body_size（默认 1M）太小',
            '中转站有自己的 body 限制',
        ],
        fixes: [
            'Nginx 调大 client_max_body_size 32m;（Caddy 默认无限制，确认没有装 limit 插件）',
            '减少附件/图片，或改用 URL 引用而不是 base64',
            '裁剪聊天历史，降低上下文',
        ],
    },
    {
        id: 'http-415',
        weight: 80,
        tags: ['内容类型'],
        test: (c) => c.status === 415,
        summary: 'Content-Type 不被接受（415）：上游要求 application/json，收到的不是。',
        causes: ['反代改写了 Content-Type', '请求被当表单提交', '文件上传接口的 Content-Type 不匹配'],
        fixes: ['curl 测试时显式加 -H "Content-Type: application/json"', '检查反代是否 strip 了请求头', '确认 ST 版本与端点匹配'],
    },
    {
        id: 'http-422',
        weight: 85,
        tags: ['参数校验'],
        test: (c) => c.status === 422,
        summary: '参数校验失败（422）：字段类型或必填项不符合接口定义。',
        causes: ['字段类型不符（字符串传了数字）', '缺少必填字段', '枚举值不在允许范围内', 'FastAPI 风格后端的 detail 数组指出具体位置'],
        fixes: ['看 body 里的 detail[].loc / msg，直接定位字段', '换默认预设排除扩展注入', '对照接口文档核对字段'],
    },
    {
        id: 'http-408',
        weight: 84,
        tags: ['超时'],
        test: (c) => c.status === 408,
        summary: '服务器等待请求数据超时（408）：连接建立了但请求没发完。',
        causes: ['客户端上行太慢或中断', '反代超时设置过短', '网络抖动导致 body 传输中断'],
        fixes: ['重试', '检查本地上行网络', '调大反代的 client_body_timeout'],
    },
    {
        id: 'http-499',
        weight: 74,
        tags: ['中断'],
        test: (c) => c.status === 499,
        summary: '客户端提前关闭了连接（499，Nginx 定义）：服务端还在处理，浏览器已经不等了。',
        causes: ['用户点了停止生成', '前端超时/页面刷新', '反代超时后客户端先断', 'Tab 切到后台被浏览器节流'],
        fixes: ['确认是否手动点过停止', '避免在生成过程中刷新页面', '需要长任务时开流式并加长前端超时'],
    },

    // ---------------------------------------------------------------- 流式
    {
        id: 'sse-error',
        weight: 93,
        tags: ['流式', '中途报错'],
        test: (c) => c.stage === 'stream-error',
        summary: '流式响应中途出错：HTTP 头已经 200，但 SSE 帧里带着错误对象。',
        causes: [
            '上游在生成过程中过载/超时，只能把错误写进流里',
            '内容审查在生成中途触发（已输出的部分被截断）',
            '中转站在转发中途与上游断开',
            'token 额度在生成过程中被耗尽',
            '长度到达 max_tokens 后被上游以错误帧收尾',
        ],
        fixes: [
            '看本条「响应内容」里的 error 对象，通常写明 overloaded / rate_limit / content_filter',
            '重试；持续出现则换渠道或模型',
            '降低单次输出长度，避免中途触发限额',
            '检查反代是否在流中途掐断连接（超时设置）',
        ],
    },
    {
        id: 'sse-idle',
        weight: 90,
        tags: ['流式', '停滞'],
        test: (c) => c.stage === 'idle',
        summary: '流式连接长时间收不到任何数据：连接还在，但没有 token 到达。',
        causes: [
            '模型在做长思考（reasoner 类模型），首个 token 前可能安静很久',
            '中间层缓冲了 SSE（Nginx proxy_buffering on、部分 CDN、企业代理）',
            '上游卡死但仍保持 TCP 连接',
            'NAT/防火墙把空闲连接回收了',
        ],
        fixes: [
            'Nginx 关闭缓冲：proxy_buffering off; proxy_cache off; 并加 X-Accel-Buffering: no',
            'Cloudflare 场景确认没有开启「Rocket Loader / 自动压缩」干扰 SSE',
            '换非思考模型对照，确认是否只是首 token 慢',
            '把 ST 的流式空闲超时调大，避免误判',
        ],
    },
    {
        id: 'sse-waiting',
        weight: 88,
        tags: ['超时', '无响应'],
        test: (c) => c.stage === 'waiting',
        summary: '请求发出后长时间没有返回响应头：上游在排队或链路卡住。',
        causes: [
            '上游排队（高峰期、免费额度、超大上下文）',
            '模型冷启动或首次加载',
            '反代/中转站卡在自己的连接池',
            '目标端口不通，TCP 重传直到超时',
        ],
        fixes: [
            '再等一会儿；若最终返回，本条会自动变成「已响应」并显示总耗时',
            '开流式，让首字节尽早到达',
            '换模型/换供应商对照定位是本地还是上游',
            '在服务器上 curl -w "@curl-format" 直连上游测首字节时间',
        ],
    },
    {
        id: 'sse-abort',
        weight: 80,
        tags: ['中断'],
        test: (c) => c.stage === 'user-abort' || (c.name === 'aborterror' && c.stage !== 'stream-error'),
        summary: '请求被主动中断：连接在完成前被关闭。',
        causes: ['用户点了停止生成', '前端设置了 AbortSignal 超时', '反代/网关超时后主动断开', '页面刷新或切走导致连接被回收'],
        fixes: [
            '如果没点停止却出现，检查反代的读超时与 ST 的前端超时',
            '长任务改用流式，避免一次性等待',
            '查看服务器侧反代日志的时间点是否与失败时刻吻合',
        ],
    },

    // ---------------------------------------------------------------- 网络 / 前端
    {
        id: 'net-fetch-failed',
        weight: 92,
        tags: ['网络', '连接中断'],
        test: (c) =>
            c.has('failed to fetch', 'networkerror when attempting to fetch resource', 'load failed', 'network error') ||
            (c.name === 'typeerror' && c.source === 'network'),
        summary: '浏览器连不上目标（Failed to fetch）：请求在传输层就失败了，没有拿到任何 HTTP 响应。',
        causes: [
            'SillyTavern 服务重启/崩溃，或反代在响应前关闭连接',
            'TLS 证书不被信任（自签名 / 域名与证书不匹配）',
            '跨域（CORS）被拒：直连第三方供应商时常见',
            'HTTPS 页面请求 HTTP 接口（混合内容被浏览器拦截）',
            '响应体过大或超时，代理直接 reset',
            '浏览器扩展（广告拦截、脚本管理器）拦截了请求',
        ],
        fixes: [
            '确认 SillyTavern 还在运行；再看它的运行日志有没有崩溃',
            'F12 → Network 看该请求的 Status 是不是 (failed)，再到 Console 看具体错误码',
            '确认页面与接口同源（都走 https://域名），避免直连第三方跨域',
            '换无痕窗口/禁用扩展再试一次',
            '服务器侧 tcpdump 或反代日志确认连接是否建立',
        ],
    },
    {
        id: 'net-conn-reset',
        weight: 90,
        tags: ['网络', '连接重置'],
        test: (c) =>
            c.has(
                'err_connection_reset',
                'err_empty_response',
                'err_connection_closed',
                'err_connection_refused',
                'err_internet_disconnected',
                'err_name_not_resolved',
                'err_timed_out',
                'econnreset',
                'econnrefused',
                'socket hang up',
            ),
        summary: 'TCP 层就断了：连接被重置/拒绝/无法解析，请求根本没到应用层。',
        causes: [
            '服务刚重启，端口还没开始监听（ERR_CONNECTION_REFUSED）',
            '反代或上游主动 RST（body 太大、超时、WAF）',
            'DNS 解析失败（ERR_NAME_NOT_RESOLVED）',
            '本机网络中断或被公司网关拦截',
            'HTTP/2 与反代不兼容导致的连接被重置',
        ],
        fixes: [
            '确认 SillyTavern 正在监听你配置的那个端口',
            '看运行日志里同一时刻有没有重启/崩溃记录',
            'dig +short 域名 检查解析',
            '浏览器里降级到 HTTP/1.1 或换网络做对照',
        ],
    },
    {
        id: 'net-h2',
        weight: 84,
        tags: ['HTTP/2'],
        test: (c) => c.has('err_http2_protocol_error'),
        summary: 'HTTP/2 协议错误：浏览器与反代在 h2 协商/帧处理上不兼容。',
        causes: ['反代 h2 实现有 bug（老版本 Nginx）', '中间设备改写了 h2 帧', '大 body + h2 的流控问题'],
        fixes: ['Nginx 升级到较新版本，或对 /api/ 关闭 h2', 'Caddy 场景确认协议配置', '临时用 HTTP/1.1 验证'],
    },
    {
        id: 'net-cert',
        weight: 86,
        tags: ['证书'],
        test: (c) => c.has('err_cert_', 'certificate', 'ssl_error', 'net::err_ssl'),
        summary: 'TLS 证书校验失败：浏览器不信任目标站点的证书。',
        causes: ['证书过期', '自签名证书', '域名与证书 SAN 不匹配', '证书链不完整', '系统时间错误'],
        fixes: ['用 openssl s_client 检查证书有效期与链', '换成 Let’s Encrypt 证书并重启反代', '检查服务器与客户端时间'],
    },
    {
        id: 'js-json-html',
        weight: 88,
        tags: ['前端', '返回值异常'],
        test: (c) => c.has("unexpected token '<'", "failed to execute 'json'", 'json at position 0', 'unexpected end of json', 'is not valid json'),
        summary: '前端在解析 JSON 时拿到了 HTML/空内容：说明响应不是 API 的 JSON，而是错误页。',
        causes: [
            '反代/CDN 返回了 HTML 错误页（502/524/人机验证），前端仍按 JSON 解析',
            '接口被重定向到登录页（Basic Auth 未通过）',
            '上游返回空 body',
        ],
        fixes: [
            '展开本条看「响应内容」，确认是哪个错误页',
            '按对应状态码处理（502/524/验证页）',
            '确认 Basic Auth 已登录，避免 302 到登录页',
        ],
    },
    {
        id: 'js-typeerror',
        weight: 76,
        tags: ['前端脚本'],
        test: (c) => c.has('cannot read propert', 'cannot read properties of undefined', 'cannot read properties of null', 'undefined is not an object'),
        summary: '前端脚本读到了 undefined/null 的属性：多半是数据结构与预期不符。',
        causes: [
            '第三方扩展与当前 ST 版本不匹配',
            '接口返回了错误结构，代码却按成功结构取值',
            '预设/角色卡缺字段',
        ],
        fixes: [
            '逐个禁用第三方扩展定位（先关 Prompt-Template / JS-Slash-Runner / 记忆增强）',
            '硬刷新（Ctrl+Shift+R）清掉旧缓存',
            '升级扩展或回退到与 ST 1.19 匹配的版本',
        ],
    },
    {
        id: 'js-not-function',
        weight: 74,
        tags: ['前端脚本'],
        test: (c) => c.has('is not a function', 'is not defined'),
        summary: '调用了不存在的方法/变量：典型的新旧版本 API 不匹配。',
        causes: ['扩展调用了已被 ST 移除的 API', '加载顺序问题（依赖模块未就绪）', '缓存了旧版本脚本'],
        fixes: ['硬刷新页面', '升级/禁用相关扩展', '看堆栈里的文件名定位是哪个扩展'],
    },
    {
        id: 'js-tokenizer',
        weight: 68,
        tags: ['Tokenizer'],
        test: (c) => c.has('tokenizer', 'gettokencount', 'encoder', 'token count'),
        summary: 'tokenizer 相关错误：本地无法正确计数 token。',
        causes: ['模型不在 tokenizer 映射表里，回退失败', '分词模型文件下载失败', '模型名是自定义中转别名'],
        fixes: ['在 ST 里把 tokenizer 手动指到相近模型', '检查网络能否下载 tokenizer', '改用官方模型 ID'],
    },
    {
        id: 'storage-quota',
        weight: 72,
        tags: ['浏览器存储'],
        test: (c) => c.has('quotaexceeded', 'quota exceeded', 'storage is full', 'localstorage'),
        summary: '浏览器存储写满：localStorage/IndexedDB 配额耗尽。',
        causes: ['聊天记录/图片缓存太多', '扩展往 localStorage 塞了大对象', '浏览器隐私模式配额很小'],
        fixes: ['清理浏览器站点数据', '导出并删除老聊天', '本扩展里把「持久化」关掉或降低最大保留条数'],
    },

    // ---------------------------------------------------------------- 200 载荷 / 状态检查
    {
        id: 'status-check',
        weight: 94,
        tags: ['连接检查'],
        test: (c) => c.stage === 'status-check',
        summary: 'ST 的「连接状态检查」失败（HTTP 200 但 body 里带 error）：端点存在，但当前配置用不了。',
        causes: [
            'API Key 无效或没有该模型权限',
            'Base URL 指向了不存在的模型端点',
            '供应商要求先创建项目/开通模型（Gemini、Azure 常见）',
            '网络出口到该供应商被阻断',
        ],
        fixes: [
            '按「API 连接」页的提示重新保存 key 与 URL',
            '用 curl 打同一个 /models 或 /status 端点验证',
            '换官方端点对照，确认不是中转问题',
            '这是一条 warn 级记录：生成请求可能仍然可用，先看是否真的失败',
        ],
    },
    {
        id: 'success-error-payload',
        weight: 88,
        tags: ['上游错误', 'HTTP 200'],
        test: (c) => c.stage === 'success-error-payload',
        summary: '上游把错误包装在 HTTP 200 里返回：表面成功，实际是错误载荷。',
        causes: [
            '中转站统一用 200 包裹错误体（one-api/new-api 常见）',
            '流式接口在 headers 已发送后只能用 200 + error 帧',
            '供应商的兼容层把 4xx 改写成 200',
        ],
        fixes: [
            '以 body 里的 error.message / code 为准，按对应原因处理后重试',
            '把本条「响应内容」完整复制给中转站排查',
            '换官方端点确认是否只有中转这样返回',
        ],
    },
    {
        id: 'overloaded',
        weight: 92,
        tags: ['过载'],
        test: (c) => c.has('overloaded_error', 'overloaded', 'server is busy', '当前分组上游负载已饱和', '上游负载', '繁忙'),
        summary: '上游过载：供应商/中转站当前处理不过来。',
        causes: ['模型高峰期（新模型发布、白天工作时间）', '中转站渠道被打满', '免费额度通道被限速'],
        fixes: ['等 30–60 秒重试', '换备用模型或备用渠道', '提高账户等级或换供应商'],
    },
    {
        id: 'empty-output',
        weight: 78,
        tags: ['空响应'],
        test: (c) =>
            c.has('empty response', 'no content', 'empty message', '空响应', '返回为空') ||
            (c.status === 200 && c.stage === 'success-error-payload' && c.text.length < 40),
        summary: '拿到了 200 但内容为空：模型没有产出实际 token。',
        causes: [
            'max_tokens 太小，或 stop 序列立刻命中',
            'reasoner 模型只返回了 reasoning_content 而没有 content',
            '预设把 assistant 前缀写死，模型直接以 stop 收尾',
            '内容审查把输出清空了',
        ],
        fixes: ['调大 Response Length', '检查 stop strings 是否过宽', '换非思考模型对照', '看 body 里是否只有 reasoning_content'],
    },
];

/** 模型名相关的补充提示（追加到原因里，不单独成规则）。 */
function modelHints(ctx) {
    const hints = [];
    const model = norm(ctx.model);
    if (!model) return hints;
    if (/reasoner|r1|thinking|o1|o3|qwq/.test(model)) {
        hints.push('当前是思考类模型：首 token 前会长时间静默，且多数不支持 temperature / 工具调用，容易触发超时与参数错误');
    }
    if (/claude|sonnet|opus|haiku/.test(model)) {
        hints.push('Anthropic 系模型的 overloaded_error 与 529 多为供应商侧过载，重试或换区域端点最有效');
    }
    if (/gemini|gemma/.test(model)) {
        hints.push('Gemini 的 RESOURCE_EXHAUSTED 既可能是配额也可能是分钟级限流，且 safety 阈值默认较严');
    }
    if (/deepseek/.test(model)) {
        hints.push('DeepSeek 常见三类失败：Insufficient Balance（余额）、429（并发）、长上下文首 token 慢导致 524');
    }
    return hints;
}

/** @param {string[]} list @param {number} limit @returns {string[]} */
function dedupe(list, limit) {
    const seen = new Set();
    const output = [];
    for (const item of list) {
        const text = String(item || '').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        output.push(text);
        if (output.length >= limit) break;
    }
    return output;
}

/** 命中不到任何规则时的兜底。 */
function fallback(ctx) {
    return {
        id: 'unknown',
        weight: 0,
        confidence: '低',
        tags: ['待人工判断'],
        summary: '这条错误没有命中已知模式，先按「信息不足」处理：把详情里的响应内容与状态码一起看。',
        causes: [
            '响应体没有可识别的错误关键字（可能是自定义中转的私有格式）',
            '错误发生在扩展加载早期，缺少上下文',
            ctx.status ? `状态码 ${ctx.status} 未在本扩展的规则表里（可对照 HTTP 语义判断）` : '没有 HTTP 状态码，属于前端/网络层异常',
        ],
        fixes: [
            '点「复制本条」把完整诊断贴出来（已自动脱敏 key）',
            '同时看浏览器 F12 Console 与 Network 里同一时刻的请求',
            '对照同一时间点 SillyTavern 的运行日志',
            '如果是固定复现，把触发时的操作步骤一起记下来',
            '需要新增规则时改 diagnose.js 的 RULES 表即可',
        ],
    };
}

/**
 * 主入口：给一条记录产出中文诊断。
 * @param {object} entry
 * @returns {{id: string, weight: number, confidence: string, tags: string[], summary: string, causes: string[], fixes: string[]}}
 */
export function diagnose(entry) {
    const ctx = buildContext(entry);
    const hits = [];
    for (const rule of RULES) {
        let ok = false;
        try {
            ok = !!rule.test(ctx);
        } catch {
            ok = false;
        }
        if (ok) hits.push(rule);
    }

    if (!hits.length) return fallback(ctx);

    hits.sort((a, b) => b.weight - a.weight);
    const primary = hits[0];
    const extras = hits
        .slice(1)
        .filter((rule) => rule.weight >= EXTRA_RULE_MIN_WEIGHT)
        .slice(0, MAX_EXTRA_RULES);

    const causes = dedupe([...primary.causes, ...extras.flatMap((rule) => rule.causes)], MAX_CAUSES);
    const hints = modelHints(ctx);
    if (hints.length && causes.length < MAX_CAUSES) causes.push(hints[0]);

    const fixes = dedupe([...primary.fixes, ...extras.flatMap((rule) => rule.fixes)], MAX_FIXES);
    const tags = dedupe([...primary.tags, ...extras.flatMap((rule) => rule.tags)], 4);

    let confidence = '低';
    if (primary.weight >= 90) confidence = '高';
    else if (primary.weight >= 75) confidence = '中';

    return {
        id: primary.id,
        weight: primary.weight,
        confidence,
        tags,
        summary: primary.summary,
        causes,
        fixes,
    };
}

/**
 * 纯文本版本，用于「复制本条/复制全部」。
 * @param {ReturnType<typeof diagnose>} result
 * @returns {string}
 */
export function formatDiagnosis(result) {
    if (!result) return '';
    const lines = [`【原因分析 · 置信度${result.confidence}${result.tags.length ? ` · ${result.tags.join('/')}` : ''}】`];
    lines.push(`结论: ${result.summary}`);
    if (result.causes.length) {
        lines.push('可能原因:');
        result.causes.forEach((item, index) => lines.push(`  ${index + 1}) ${item}`));
    }
    if (result.fixes.length) {
        lines.push('处置建议:');
        result.fixes.forEach((item, index) => lines.push(`  ${index + 1}) ${item}`));
    }
    return lines.join('\n');
}

/** 规则数量，供设置面板显示。 */
export const RULE_COUNT = RULES.length;

/**
 * 规则元数据（不含判定函数），用于生成文档与调试。
 * @returns {{id: string, weight: number, tags: string[], summary: string}[]}
 */
export function describeRules() {
    return RULES.map((rule) => ({
        id: rule.id,
        weight: rule.weight,
        tags: [...rule.tags],
        summary: rule.summary,
    }));
}
