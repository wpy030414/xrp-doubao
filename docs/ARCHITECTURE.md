# ARCHITECTURE — xrp-doubao

> Version: 0.1.0 | Last updated: 2026-10-25
>
> 本文描述稳定的结构关系。代码改动若偏离此处描述，需同步更新。

## 1. 架构概览

```
┌────────────┐   OpenAI /v1/chat/completions   ┌──────────────┐   WS register (V24)   ┌──────────────────────────┐
│  Client    │ ──────────────────────────────> │  xrl-router  │ ────────────────────> │  plugin-doubao (Hono)     │
│ (Claude    │                                 │  :19068      │                       │  :19071                   │
│  Code等)   │ <────────────────────────────── │              │ <──────────────────── │  - OpenAI 翻译            │
└────────────┘        SSE / JSON               └──────────────┘                       │  - Cookie 凭证            │
                                                                                      │  - 登录页 :19100（临时）   │
                                                                                      └────────────┬─────────────┘
                                                                                                   │ Cookie + SSE
                                                                                                   ▼
                                                                                      ┌──────────────────────────┐
                                                                                      │ www.doubao.com            │
                                                                                      │ /chat/completion          │
                                                                                      │ /samantha/chat/completion │
                                                                                      │ /passport/...             │
                                                                                      └──────────────────────────┘
```

登录期间，插件在 `127.0.0.1:19100` 托管一个极小的登录页；页面只展示二维码和状态，不接触凭证。

## 2. 设计原则

| 原则 | 说明 |
|---|---|
| **纯翻译层** | 只做 OpenAI ↔ 豆包网页协议转换，不引入业务逻辑、不做 prompt engineering |
| **凭证自持** | Router 不再管理密钥，对插件只发占位凭证；插件用自身 Cookie 访问上游 |
| **无状态** | 每个对话请求独立；不维护服务端会话表，客户端带完整 history |
| **无 App 依赖** | 不读取 / 解密 / 写回豆包电脑版文件；登录页由官方 passport 接口驱动 |
| **错误透明** | 登录失效、风控、上游故障分别映射；不静默重试成空响应 |
| **可回退** | 主端点 `/chat/completion` 不可用时自动回退 `/samantha`，语义不变 |
| **凭据最小暴露** | 日志 / 诊断只输出 Cookie 名称与长度；凭证加密落盘 |

## 3. 源码结构

```
src/
├── index.ts              # 进程入口：runServer()
├── server.ts             # Hono 路由 / 端口释放 / 启动 / 优雅退出
├── config.ts             # Settings 单例、模型预设、别名
├── pluginClient.ts       # WS 注册（V24 无 keys）/ 心跳 / 重连
├── webLogin.ts           # 二维码登录状态机
├── loginPage.ts          # 本机登录页（HTML + /api/status + /qr.png）
├── auth.ts               # 会话缓存 / 加密落盘 / 灾备 Cookie / 登录编排
├── cookieJar.ts          # Cookie 罐（domain/path/expiry）
├── credentialStore.ts    # DPAPI / AES / 明文
├── device.ts             # device_id / web_id / fp 生成
├── securityParams.ts     # 上游 query / 请求头
├── messages.ts           # OpenAI messages → 豆包单条文本
├── sse.ts                # 通用 SSE 解析
├── doubaoClient.ts       # 上游请求、SSE 解析、错误分类、回退
├── openai.ts             # OpenAI chunk / 非流式聚合 / 错误映射
├── openai.ts             # 同上
└── types.ts              # StoredSession / DoubaoAuthState

scripts/
├── login.ts              # 交互式网页登录
├── check-auth.ts         # 凭证 / 账号诊断
├── smoke.ts              # 真实账号冒烟（--yes）
└── logout.ts             # 删除凭证（--yes）

test/
├── e2e.test.ts           # 离线 E2E
└── helpers/mockDoubao.ts # mock 豆包网关

docs/
├── PRD.md
├── ARCHITECTURE.md
├── DECISIONS.md
├── DOUBAO_REVERSE.md
└── specs/
    ├── web-login.md
    └── openai-bridge.md
```

## 4. 关键数据流

### 4.1 登录

```
pnpm log-in
  → auth.interactiveLogin()
      → new DoubaoWebLogin()
      → flow.begin()
          GET /                         (ttwid)
          GET /passport/safe/csrf_token (passport_csrf_token)
          GET /passport/web/get_qrcode  (token + PNG)
      → startLoginServer(flow, 19100)
      → openExternal(登录页)
      → flow.startPolling()
          GET /passport/web/check_qrconnect (每 1.5s)
          confirmed → 跟随 redirect_url → 收集 sessionid
                    → GET /passport/account/info/v2/ (尽力)
      → flow.waitForDone()
      → auth.writeStore(session)          (DPAPI / AES)
```

### 4.2 对话

```
POST /v1/chat/completions
  → openai.forwardChatCompletions()
      → auth.getSession()                 (缓存 / 存储 / 灾备)
      → DoubaoClient.chat()
          → messages.flattenMessages()
          → securityParams.webParams()
          → POST /chat/completion (SSE)
              → sse.iterateSse()
              → parseWebEvent()
          (失败且 auto) → POST /samantha/chat/completion
      → 流式：逐 delta 转 OpenAI chunk
      → 非流式：聚合为 chat.completion
```

## 5. 凭证存储

`DOUBAO_CREDENTIAL_PATH` 指向一个自描述密文文件：

```
dpapi:v1:<base64>                Windows CurrentUser DPAPI
aes:v1:<iv>:<tag>:<ciphertext>   DOUBAO_AUTH_SECRET → SHA-256 → AES-256-GCM
plain:v1:<base64>                仅非 Windows 且无密钥时的兜底（0600 + 告警）
```

明文载荷：

```json
{
  "cookies": [{"name":"sessionid","value":"...","domain":"www.doubao.com","path":"/","hostOnly":true}],
  "device": {"deviceId":"...","webId":"...","fp":"verify_..."},
  "uid": "12345",
  "nickname": "…",
  "savedAt": 1792900000000
}
```

- `cookies` 使用 `CookieJar` 的完整记录（domain / path / expiresAt / secure / hostOnly）
- 写入：临时文件 + rename；权限 0600
- 没有 refresh token；`savedAt` 仅用于展示，不作为会话有效期

## 6. 错误模型

```
DoubaoUpstreamError
  kind: auth    → HTTP 401 authentication_error；提示重新 pnpm log-in
  kind: risk    → HTTP 429 rate_limit_error；needs_captcha=true；/health 暴露
  kind: upstream→ HTTP 502（或上游 4xx/5xx）；保留 code / status
```

- 首个上游分片在响应头发出前取出，因此鉴权 / 风控错误仍能返回正确 HTTP 状态
- 流中错误以 `data: {"error":{...}}` + `[DONE]` 返回
- 主端点失败且 `DOUBAO_CHAT_MODE=auto` 时回退 `/samantha`；鉴权错误不回退

## 7. V24 插件契约

- WS：`ws://127.0.0.1:19068/ws/plugin`
- register：`plugin_id=plugin-doubao`、`provider.kind=chat_completions`、`base_url=http://localhost:19071`、`api_path=/v1/chat/completions`、`models[]`、`workdir`
- **无 `keys`**；不发 `keys_update`
- 心跳 30s；重连 1s → 60s
- Router 以 `display_name` 路由；插件 `model_id = display_name = 模型别名`

## 8. 测试架构

- `test/helpers/mockDoubao.ts`：本地 Hono 服务，模拟 passport 登录、`/chat/completion`、`/samantha/chat/completion`、错误分支
- `test/e2e.test.ts`：在 mock URL 上导入真实模块，覆盖登录状态机、Cookie、凭证存储、模型映射、流式 / 非流式、HTTP 错误、插件注册、消息压平、SSE 解析
- 测试通过环境变量把 `DOUBAO_BASE_URL` / `DOUBAO_AUTH_BASE_URL` 指向 mock，绝不访问真实豆包
- 真实账号验证由 `pnpm log-in` + `pnpm smoke -- --yes` 手动完成

## 9. 运行与部署

- 单进程 Node.js；无数据库、无 Redis、无 Playwright
- 插件端口 19071；登录页端口 19100（仅登录期间）
- 端口占用自动 kill（插件端口）或改用随机端口（登录页）
- 优雅退出：SIGTERM / SIGINT 关闭 WS 与 HTTP
