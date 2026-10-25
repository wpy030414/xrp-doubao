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
                                                                                      │  - 本地回调 :19100（临时） │
                                                                                      └────────────┬─────────────┘
                                                                                                   │ Cookie + SSE
                                                                                                   ▼
                                                                                      ┌──────────────────────────┐
                                                                                      │ www.doubao.com            │
                                                                                      │ /chat/completion          │
                                                                                      │ /samantha/chat/completion │
                                                                                      │ /alice/resource/prepare_upload │
                                                                                      │ /top/v1 (ImageX SigV4)    │
                                                                                      │ /alice/message/pre_handle_v2_without_conv │
                                                                                      │ /im/conversation/batch_del_user_conv │
                                                                                      │ /passport/...             │
                                                                                      └──────────────────────────┘
```

登录期间，插件在 `127.0.0.1:19100` 托管一个 OAuth 回调服务器（默认）；浏览器直接打开抖音官方授权页，页面与二维码都由 `open.douyin.com` 托管。备用流程 `DOUBAO_LOGIN_FLOW=doubao` 才在本机展示豆包扫码页。

## 2. 设计原则

| 原则 | 说明 |
|---|---|
| **纯翻译层** | 只做 OpenAI ↔ 豆包网页协议转换，不引入业务逻辑、不做 prompt engineering |
| **凭证自持** | Router 不再管理密钥，对插件只发占位凭证；插件用自身 Cookie 访问上游 |
| **无状态** | 每个对话请求独立；不维护服务端会话表，客户端带完整 history |
| **无 App 依赖** | 不读取 / 解密 / 写回豆包电脑版文件；默认直接打开抖音官方授权页，本地只接收 OAuth 回调 |
| **错误透明** | 登录失效、风控、上游故障分别映射；不静默重试成空响应 |
| **可回退** | 只在 404 / 非 SSE / 网络等端点或协议错误时回退 `/samantha`；风控、鉴权、参数错误与带附件请求不回退 |
| **凭据最小暴露** | 日志 / 诊断只输出 Cookie 名称与长度；凭证加密落盘 |

## 3. 源码结构

```
src/
├── index.ts              # 进程入口：runServer()
├── server.ts             # Hono 路由 / 端口释放 / 启动 / 优雅退出
├── config.ts             # Settings 单例、模型预设、别名
├── pluginClient.ts       # WS 注册（V24 无 keys）/ 心跳 / 重连
├── douyinLogin.ts        # 抖音 OAuth 授权页 + 本地回调 + code 换会话（默认）
├── webLogin.ts           # 备用：豆包网页扫码登录状态机
├── loginPage.ts          # 抖音回调页 / 豆包扫码页（HTML + /api/status）
├── loginFlow.ts          # 登录状态 / 二维码类型
├── auth.ts               # 会话缓存 / 加密落盘 / 灾备 Cookie / 登录编排
├── cookieJar.ts          # Cookie 罐（domain/path/expiry）
├── credentialStore.ts    # DPAPI / AES / 明文
├── device.ts             # device_id / web_id / fp 生成
├── securityParams.ts     # 上游 query / 请求头
├── messages.ts           # OpenAI messages → 豆包单条文本 + 当前消息附件
├── doubaoUpload.ts       # ImageX 图片 / 文件上传（STS + SigV4 + TOS + pre_handle）
├── conversationCleanup.ts # 每轮结束后删除会话（cmd 4171，异步）
├── sse.ts                # 通用 SSE 解析
├── doubaoClient.ts       # 上游请求、SSE 解析、错误分类、回退
├── openai.ts             # OpenAI chunk / 非流式聚合 / 错误映射
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

### 4.1 登录（默认：Playwright + 抖音官方授权页）

```
pnpm log-in
  → auth.interactiveLogin()
      → new DouyinOAuthLogin()
      → flow.run()
          → launchLoginBrowser()              // playwright-core + 系统 Edge/Chrome
          → goto www.doubao.com/chat/
          → 自动点击 登录 → 抖音一键登录 → 同意
          → 浏览器进入 open.douyin.com 官方授权页
          → 用户扫码 / 短信验证码授权
          → 抖音回跳 https://www.doubao.com/auth/callback
          → 豆包官方页面自行完成 code 换票并写 sessionid
          → 插件从 BrowserContext 提取 doubao.com Cookie
          → GET /passport/account/info/v2/ (尽力)
      → auth.writeStore(session)              (DPAPI / AES)
```

- 不能把 `redirect_uri` 改为 localhost：抖音会在授权时报“非法重定向链接”；因此换票由豆包官方页面完成，插件只提取 Cookie。
- 浏览器仅用于登录；关闭后不保留 profile。

备用（`DOUBAO_LOGIN_FLOW=doubao`）：

```
auth.interactiveLogin()
  → new DoubaoWebLogin() → begin() → startLoginServer(flow, 19100)
  → openExternal(本机登录页) → 手机扫码
  → 轮询 check_qrconnect → confirmed → 跟随 redirect_url → Cookie
  → auth.writeStore(session)
```

### 4.2 对话

```
POST /v1/chat/completions
  → openai.forwardChatCompletions()
      → auth.getSession()                 (缓存 / 存储 / 灾备)
      → DoubaoClient.chat()
          → messages.flattenMessages()        (文本 + 最后一条用户消息的附件)
          → doubaoUpload.uploadAttachments()  (有附件时)
              → POST /alice/resource/prepare_upload
              → GET  /top/v1?Action=ApplyImageUpload   (SigV4)
              → POST https://<upload_host>/upload/v1/<StoreUri>
              → POST /top/v1?Action=CommitImageUpload  (SigV4)
              → POST /alice/message/pre_handle_v2_without_conv
          → POST /chat/completion (SSE)
              → sse.iterateSse()
              → parseWebEvent()               (10040 thinking_block / 10000 正文 / CHUNK_DELTA)
          → SSE 结束后：conversationCleanup.deleteConversation()  (异步，不阻塞响应)
          (仅 404 / 非 SSE / 网络错误且无附件) → POST /samantha/chat/completion
      → 流式：逐 delta 转 OpenAI chunk
      → 非流式：聚合为 chat.completion
```

### 4.3 附件上传

```
messages.flattenMessages()
  → 当前用户消息中的 image_url / file / input_file
  → doubaoUpload.uploadAttachments()
      → data URL 直接解码；远程 URL 先做 SSRF 检查再下载
      → 每个附件：prepare_upload → ApplyImageUpload(SigV4) → TOS → CommitImageUpload(SigV4) → pre_handle
  → buildAttachmentBlock(): block_type=10052，图片 type=1，文件 type=3
  → /chat/completion 的 messages[0]（附件）+ messages[1]（文本）
```

- 附件消息共用一个 `local_message_id`，每个附件有自己的 `identifier`
- 只有最后一条用户消息的附件会上传；历史附件在压平文本里保留 `[图片]` / `[文件：…]` 占位
- 上传失败按 auth / risk / upstream 分类；附件请求不回退 `/samantha`
- 默认限制：20 MB / 10 个；远程 URL 默认拒绝内网 / localhost

### 4.4 会话清理

```
SSE 结束 / 客户端断开
  → state.conversationId (来自 SSE_ACK)
  → conversationCleanup.deleteConversation()   (fire-and-forget)
      → POST /im/conversation/batch_del_user_conv
        Content-Type: application/json; encoding=utf-8
        cmd 4171 / conversation_type 3
      → 712010703 或网络错误重试一次
  → /health.conversation_cleanup: { enabled, attempted, deleted, failed, lastResult, lastCode, lastAt }
```

- 删除不阻塞对话响应；失败只记录警告与统计
- `DOUBAO_AUTO_DELETE_CONVERSATION=0` 可关闭；`DOUBAO_CLEANUP_TIMEOUT_MS` 控制超时
- 旧 `/samantha` 回退没有 conversation_id，无法清理

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
- 主端点仅在 404 / 非 SSE / 网络等端点或协议错误时回退 `/samantha`；鉴权、风控、参数错误与带附件请求不回退
- 回退成功时响应头带 `X-Doubao-Fallback: 1` 与 URL 编码的 `X-Doubao-Fallback-Reason`

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
