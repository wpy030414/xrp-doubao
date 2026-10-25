# xrp-doubao

> 豆包（Doubao）网页通道的 xrl-router 插件 — **唯一登录方式为自包含网页 OAuth**（直接打开抖音官方授权页，本地回调换票），把豆包网页端的私有 SSE 对话接口包装成 OpenAI Chat Completions 兼容服务。

```
OpenAI / Anthropic 客户端 → xrl-router :19068 → 本插件 :19071 → www.doubao.com
                                      ↑ 本地回调 :19100（仅登录期间）
```

## 这是什么？

- xrl-router 的豆包通道插件，纯转发 / 协议适配层
- **自包含登录**：`pnpm log-in` 直接打开抖音官方授权页（`open.douyin.com`），用户在页面上扫码或验证码授权；抖音回跳本机 `127.0.0.1:19100/douyin/callback`，插件用一次性 `code` 调豆包 passport 换取会话 Cookie，再加密落盘
- 本机**不需要安装或读取豆包电脑版**，也不读取任何 App 凭证文件；抖音授权页本身支持扫码与短信验证码两种方式
- 凭证本地静态加密存储（Windows 用 DPAPI，跨平台用 passphrase AES），不落明文、不进 git
- 通过 WebSocket 向 xrl-router 注册（V24 契约，无 `keys`），由 Router 统一做鉴权、路由、密钥轮转
- 支持流式 / 非流式、`reasoning_content`（思考链）、模型模式映射、主端点失败回退 `/samantha`、风控状态上报

## 前置要求

- Node.js ≥ 20、pnpm
- **不需要豆包电脑版**；只需要一个能登录抖音 / 豆包网页的账号
- xrl-router 已运行（默认 `http://localhost:19068`）

## 快速开始

```bash
pnpm install
cp .env.example .env   # 可选：默认值已能跑通
pnpm log-in             # 直接打开抖音官方授权页，授权后本地回调换票并加密落盘
pnpm check-auth        # 验证凭证、Cookie 名称、账号信息（不打印 Cookie 值）
pnpm serve             # 启动插件，监听 19071 并连接 xrl-router
```

`pnpm log-in` 会：

1. 生成一次性 `state`，打开抖音官方授权页
   `https://open.douyin.com/platform/oauth/connect?client_key=aw4293rjg7ggbx9m&redirect_uri=http://127.0.0.1:19100/douyin/callback&...`
2. 页面展示**真正的抖音授权二维码**（也支持页面上的“验证码授权”）
3. 抖音授权后回跳本机 `/douyin/callback?code=...&state=...`
4. 校验 `state`，用 `code` 调 `www.doubao.com/passport/web/auth/bind_with_mobile_login/`
   换取豆包会话 Cookie；必要时走 `profile_key` 二次登录
5. 用 DPAPI / AES 加密写入本地凭证文件

备用登录形态：设置 `DOUBAO_LOGIN_FLOW=doubao` 可改回“本机展示豆包网页登录二维码”的流程。

首次注册后，插件 provider 在 Router 中默认是 **disabled / pending** 状态，需要确认一次：

```bash
curl -X POST http://localhost:19068/api/plugins/plugin-doubao/confirm
```

或在 Router 的插件管理界面里点击启用。确认后 `/v1/models` 即可看到模型。

### 验证

```bash
curl http://127.0.0.1:19071/health

curl -s http://127.0.0.1:19071/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"doubao-fast","messages":[{"role":"user","content":"Say ok."}],"max_tokens":20}'

curl -sN http://127.0.0.1:19071/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"doubao-expert","stream":true,"messages":[{"role":"user","content":"Say ok."}]}'
```

真实账号冒烟（会消耗一次额度，必须显式确认）：

```bash
pnpm smoke -- --yes --model doubao-fast
```

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DOUBAO_PORT` | `19071` | 插件 HTTP 端口 |
| `XRL_ROUTER_URL` | `http://localhost:19068` | xrl-router 地址（WS 自动换成 `ws://`） |
| `DOUBAO_BASE_URL` | `https://www.doubao.com` | 对话 / 账号网关 |
| `DOUBAO_AUTH_BASE_URL` | 同上 | 登录网关（同源 passport 接口） |
| `DOUBAO_AID` | `497858` | 网页端 aid（登录、`/chat/completion`） |
| `DOUBAO_DESKTOP_AID` | `582478` | `/samantha` 回退端点 aid |
| `DOUBAO_PC_VERSION` | `3.42.5` | 网页端版本参数 |
| `DOUBAO_BOT_ID` | `7338286299411103781` | 默认 bot id |
| `DOUBAO_CHAT_MODE` | `auto` | `auto`（主端点失败回退）/ `chat` / `samantha` |
| `DOUBAO_LOGIN_FLOW` | `douyin` | `douyin`（直接打开抖音官方授权页）/ `doubao`（本机展示豆包扫码页） |
| `DOUBAO_DOUYIN_OAUTH_BASE_URL` | `https://open.douyin.com` | 抖音 OAuth 授权域 |
| `DOUBAO_DOUYIN_CLIENT_KEY` | `aw4293rjg7ggbx9m` | 豆包使用的抖音开放平台 client_key |
| `DOUBAO_DOUYIN_SCOPE` | `user_info,mobile` | 授权 scope |
| `DOUBAO_DOUYIN_OPTIONAL_SCOPE` | `mobile,1` | 可选 scope |
| `DOUBAO_LOGIN_PORT` | `19100` | 本地 OAuth 回调 / 登录页端口；占用时自动改用随机端口 |
| `DOUBAO_LOGIN_TIMEOUT_MS` | `300000` | 授权等待超时 |
| `DOUBAO_LOGIN_POLL_MS` | `1500` | 备用豆包扫码流程的轮询间隔 |
| `DOUBAO_AUTO_LOGIN` | `0` | 无登录态时服务是否自动打开授权页；默认关闭，改用 `pnpm log-in` |
| `DOUBAO_CREDENTIAL_PATH` | 用户数据目录 | 自包含凭证文件（加密；不进 git） |
| `DOUBAO_STORE_MODE` | `auto` | 存储形态：`auto` / `dpapi` / `aes` / `plain` |
| `DOUBAO_AUTH_SECRET` | 空 | AES 模式 passphrase；设置后 `auto` 优先用 AES（跨平台可迁移） |
| `DOUBAO_MODELS` | 空 | 逗号分隔的模型别名白名单；留空 = 注册内置模型 |
| `DOUBAO_REQUEST_TIMEOUT_MS` | `600000` | 上游请求超时 |
| `DOUBAO_COOKIES` | 空 | 灾备 Cookie 头（`sessionid=...; ttwid=...`），无本地凭证时使用 |
| `DOUBAO_UID` | 空 | 灾备账号 uid（仅展示） |
| `DOUBAO_DEVICE_ID` / `DOUBAO_WEB_ID` / `DOUBAO_FP` | 空 | 覆盖设备指纹；留空则登录时生成并随凭证保存 |
| `DOUBAO_DEBUG` | `0` | 打印登录 / 回退调试日志（不含凭证值） |

## 登录与凭证

1. `pnpm log-in` 生成 `state` 并直接打开抖音官方授权页；用户在页面上扫码或使用短信验证码授权
2. 抖音回跳 `http://127.0.0.1:19100/douyin/callback?code=...&state=...`；插件校验 `state`
3. 用 `code` 调 `www.doubao.com/passport/web/auth/bind_with_mobile_login/` 换取 `sessionid` / `ttwid` / `passport_csrf_token` 等 Cookie；若返回 `profile_key`，再走 `/passport/web/auth/login/` 二次登录
4. Cookie 与设备指纹经 DPAPI（Windows，绑定本机本用户）或 passphrase AES-256-GCM 加密，原子写入 `DOUBAO_CREDENTIAL_PATH`
5. 运行时会话获取顺序：**内存缓存 → 本地凭证存储 → `DOUBAO_COOKIES` 灾备 →（默认不触发登录，提示 `pnpm log-in`）**
6. 豆包登录**不返回 refresh token**；会话失效只能重新授权。插件不会静默复用或刷新他人凭证
7. 服务态默认**不静默弹浏览器**：需要无人值守自动登录时设 `DOUBAO_AUTO_LOGIN=1`

存储形态选择（`DOUBAO_STORE_MODE=auto`）：Windows 用 DPAPI；设了 `DOUBAO_AUTH_SECRET` 则用 AES（可跨机迁移）；两者都没有时明文落盘并告警（文件权限 0600，仅建议临时用）。

### 没有手机 App 怎么办？

默认的抖音官方授权页同时提供「扫码授权」和「验证码授权」（手机号短信），不强制安装 App。若你只想用豆包自己的登录链路，可设置 `DOUBAO_LOGIN_FLOW=doubao`，插件会在本机展示豆包网页登录二维码（可用豆包 / 抖音 App 扫）。两条链路都不读取豆包电脑版；`DOUBAO_COOKIES` 仅作为临时灾备。

## 模型注册

豆包网页端的模式菜单来自 `/chat` 页面 SSR 的 `menu_item_list`。内置映射：

| 客户端模型别名 | 网页端模式 | `model_item_key` | `agent_mode` | `mode_id` | 思考链 |
|---|---|---|---|---|---|
| `doubao-fast` | 快速 | `0` | 2 | 1 | 否 |
| `doubao-expert` | 专家 | `3` | 2 | 1 | 是 |
| `doubao-work` | 工作任务 Auto | `9` | 1 | 3 | 否 |
| `doubao-work-pro` | 工作任务 Pro | `5` | 1 | 3 | 否 |
| `doubao-2.1-lite` | 豆包 2.1 Lite | `seed-lite-7b` | 1 | 3 | 否 |
| `doubao` / `doubao-pro` / `doubao-think` | 别名 | — | — | — | — |

- `reasoning_effort`（`low` / `medium` / `high` 或 3/4/5）会映射到上游的思考强度；专家模式默认 4，快速默认 3
- 注册时 `display_name` 直接使用模型别名：Router 以 `display_name` 作为客户端可调用的路由键
- 若需固定模型集合，设置 `DOUBAO_MODELS=doubao-fast,doubao-expert`

## 协议行为

- 上游主端点 `/chat/completion` 与回退端点 `/samantha/chat/completion` 都是 SSE
- 插件对 OpenAI 消息做**无状态压平**：system + 历史轮次 + 工具结果编码为一条豆包用户消息；客户端每次带完整 history 即可获得多轮效果
- thinking 映射为 `reasoning_content`；正文映射为 `content`
- 流式分片保持 `finish_reason: null`，只有结束分片是 `stop`；不输出空 `tool_calls` 数组
- 主端点 404 / 非 SSE / 风控时，`auto` 模式自动回退 `/samantha`，并在响应头 `X-Doubao-Mode` 标明实际通道
- 错误映射：
  - 登录失效（401 / 710012001）→ OpenAI `authentication_error`，提示重新 `pnpm log-in`
  - 风控 / 验证码（710022004）→ HTTP 429 + `needs_captcha: true`；`/health` 同步暴露，`POST /admin/reset-captcha` 清除标记
  - 其他上游错误 → 502（或上游 4xx/5xx）

### 能力边界

- **只支持文本输入**；`image_url` / 音频 / 文件输入会返回 400
- **不实现 OpenAI tools / function calling**：豆包网页端没有稳定的原生 tool_call 协议，插件不伪造该语义
- **不做 Anthropic Messages API**：由 xrl-router 做协议转换
- **不做账号池 / 密钥轮转 / 本地推理**

## 脚本

| 命令 | 作用 |
|---|---|
| `pnpm log-in` | 打开抖音官方授权页，本地回调换票，加密落盘 |
| `pnpm serve` | 启动插件（19071）并连接 xrl-router |
| `pnpm check-auth` | 诊断凭证、Cookie 名称 / 长度、账号信息（不打印 Cookie 值） |
| `pnpm log-out -- --yes` | 删除本地加密凭证 |
| `pnpm smoke -- --yes` | 真实账号发一条短消息，验证登录与对话链路（消耗额度） |
| `pnpm test` | 离线 E2E：登录、Cookie、模型映射、流式 / 非流式、错误映射、插件注册 |
| `pnpm typecheck` | TypeScript 类型检查 |

## 故障排查

| 现象 | 处理 |
|---|---|
| Router 报 `Model not found or not available` | 用模型别名（如 `doubao-fast`）作为 `model`；确认 `plugin-doubao` 已 confirm/enabled |
| 插件启动后 Router 中模型不可用 | provider 初始为 disabled，执行一次 `/api/plugins/plugin-doubao/confirm` |
| `pnpm serve` 提示无有效登录态 | 运行 `pnpm log-in` 完成抖音授权，或设 `DOUBAO_AUTO_LOGIN=1` |
| 401 / 710012001 | 会话已失效；`pnpm log-in` 重新授权 |
| 429 / 710022004 | 触发风控人机验证；先在浏览器打开 `https://www.doubao.com` 完成验证，再试；必要时重新登录 |
| 主端点总是回退 `/samantha` | 上游 `/chat/completion` 可能要求 `a_bogus`；`auto` 回退是预期行为，可设 `DOUBAO_CHAT_MODE=samantha` 固定 |
| 换到别的机器 / 用户凭证解不开 | DPAPI 绑定本机本用户；需迁移就用 `DOUBAO_STORE_MODE=aes` + `DOUBAO_AUTH_SECRET` |
| 端口被旧实例占用 | 启动时自动结束占用 `19071` 的旧进程（排除自身） |
| 登录回调端口被占用 | 自动改用随机端口，终端会打印实际回调 URL |
| 豆包升级后请求异常 | 更新 `DOUBAO_PC_VERSION` / `DOUBAO_BOT_ID`，或调整 `DOUBAO_CHAT_MODE` |

## 安全说明

- 插件只登录并使用**训练员本人**的豆包账号，不抓取、不复用他人凭证
- 登录授权页由抖音官方托管（`open.douyin.com`），插件不经手账号口令；本地只接收一次性 `code`
- 凭证静态加密（DPAPI / AES）落盘；日志与诊断脚本不打印 Cookie / OAuth code / state 明文
- `.env` 与凭证文件均已 gitignore，切勿提交任何密钥
- 豆包网页登录没有 refresh token；插件不会尝试刷新或延长会话，失效即要求重新登录
- `DOUBAO_COOKIES` 等价于账号密码，只建议临时使用；不要提交到仓库或写进命令行历史

## 延伸阅读

- [AGENTS.md](./AGENTS.md) — 项目边界与 Agent 约定
- [docs/PRD.md](./docs/PRD.md) — 功能语义与验收标准
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — 架构、模块、数据流
- [docs/DECISIONS.md](./docs/DECISIONS.md) — 设计决策与取舍
- [docs/DOUBAO_REVERSE.md](./docs/DOUBAO_REVERSE.md) — 网关、登录、SSE 与风控逆向记录
- [docs/specs/web-login.md](./docs/specs/web-login.md) — 网页登录规格
- [docs/specs/openai-bridge.md](./docs/specs/openai-bridge.md) — OpenAI 桥接规格
