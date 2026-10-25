# AGENTS.md — xrp-doubao

本文件为 AI Agent 划定项目边界。在本仓库工作时必须遵守以下约束。

## 概述

- 本项目是 **豆包（Doubao）网页通道的 xrl-router 插件**：把豆包网页端的私有 SSE 对话接口包装成 OpenAI Chat Completions 兼容的本地服务
- 上游：`https://www.doubao.com`
- 凭证：**仅支持自包含网页 OAuth 登录**（Playwright 打开豆包登录 → 抖音官方授权页 → 官方 callback 换票 → 从浏览器提取会话 Cookie），DPAPI/AES 加密落盘；不依赖、不读取豆包电脑版
- 协议边界：只桥接 OpenAI Chat Completions（`/v1/chat/completions`）；Anthropic Messages 客户端由 xrl-router 转换后调用本插件

## 边界与范围

- 范围内：OpenAI Chat Completions 转发（流式 + 非流式聚合）、Playwright 抖音 OAuth 网页登录 / Cookie 提取 / 加密落盘、模型模式映射、`/chat/completion` → `/samantha` 回退、WebSocket 插件注册 / 心跳 / 重连（V24 契约）、SSE 事件解析、ImageX 图片 / 文件上传、会话自动清理、风控状态上报
- 非目标（明确排除）：
  - **不实现 Anthropic Messages API** — 由 xrl-router 负责协议转换
  - **不做账号池 / 多 key 负载均衡** — xrl-router 的职责
  - **不做本地模型推理** — 纯远端转发
  - **不暴露 `/v1/models` HTTP 端点** — 模型通过 WebSocket 注册推送
  - **不实现 `/v1/embeddings`、`/v1/completions` 等端点**
  - **不实现 OpenAI tools / function calling** — 上游没有稳定的原生工具协议
  - **音频输入暂不支持** — 目前支持图片与文件；音频返回 400
  - **不读取 / 解密 / 写回豆包电脑版的任何凭证文件或本地数据库**
  - **不抓取或复用他人凭证**

## Agent 操作指南

### 全局约定

- 包管理器：**pnpm**（不要用 npm）
- dev 运行：**tsx**（无 watch，修改后需手动重启）
- HTTP 框架：**Hono**
- `.env` 永不进 git（`git check-ignore .env` 必须通过）；自包含凭证文件同样不进 git
- 日志与脚本禁止输出 Cookie / 二维码 token / 凭证明文 / ImageX STS / SigV4 签名 / 附件内容
- 凭证静态加密：Windows 默认 DPAPI（绑本机本用户），设 `DOUBAO_AUTH_SECRET` 则用 AES
- 会话清理默认开启（`DOUBAO_AUTO_DELETE_CONVERSATION=1`）；思考步骤摘要默认开启（`DOUBAO_THINKING_SUMMARY=1`）

### V24 契约（不可破坏）

- 连接 `ws://127.0.0.1:19068/ws/plugin`
- register 消息字段：`plugin_id`（`plugin-doubao`）、`provider.kind = "chat_completions"`、`provider.base_url`、`provider.api_path`、`models[]`、`workdir`
- **register 不带 `keys`**（带了 Router 直接拒绝并断开）
- **不发 `keys_update`**
- 心跳每 30s：`{"type":"heartbeat"}`，不带 timestamp
- 断线指数退避重连 1s → 60s
- Router 发给插件的是占位 Bearer；插件必须使用自身 Cookie 访问上游

### 路由与别名

- Router 以 `display_name` 作为客户端可调用的模型别名，而不是 `model_id`
- 本插件注册时 `model_id = display_name = 别名`；别名到豆包模式的映射在 `src/config.ts`
- 新注册的 provider 初始为 disabled/pending，需要 `POST /api/plugins/plugin-doubao/confirm` 才会启用

### SSE / 语义（不要删除）

`src/doubaoClient.ts` 与 `src/openai.ts` 中以下语义是协议正确性的关键：

1. 上游 `block_type=10040` 是 `BLOCK_THINKING`，思考文本在 `content.thinking_block.think`；`10000` 承载正文。旧版 `10040` 空块仍按“分隔符”兼容。网页端 `cot_ui_style=summary` 时只下发 `thinking_block.finish_title/streaming_title` 步骤标题，插件将其映射为 `reasoning_content`；`CHUNK_DELTA` 的 `{"text":…}` / `{"think":…}` 作为增量。
2. 非结束分片必须 `finish_reason: null`，不能输出空字符串
3. 不输出空 `tool_calls: []` 数组
4. 非流式请求由本地聚合；流式请求逐分片转发
5. 上游错误必须区分 `auth` / `risk` / `upstream`，分别映射 401 / 429 / 502
6. `auto` 模式下 `/chat/completion` 不可用时回退 `/samantha/chat/completion`

### 构建与运行

```bash
pnpm install
pnpm log-in             # 打开抖音官方授权页，本地回调换票，凭证加密落盘
pnpm check-auth        # 诊断凭证与账号（不打印 Cookie 值）
pnpm serve             # 启动插件（19071）
pnpm test              # 离线 E2E（mock 豆包）
pnpm typecheck
```

### 已知限制（不要尝试修复）

| 现状 | 原因 |
|---|---|
| 首登需真人在抖音授权页授权 | 扫码或短信验证码由抖音托管，插件不经手口令 |
| 登录需要系统 Edge/Chrome | Playwright 使用系统浏览器，不额外下载 Chromium；无浏览器时用 `DOUBAO_LOGIN_FLOW=doubao` 备用 |
| 无 refresh token | 豆包网页登录不返回 refresh token；失效只能重新授权 |
| 主端点可能回退 `/samantha` | `/chat/completion` 的端点/协议错误才回退；风控、鉴权、参数错误不回退 |
| 风控验证码不能自动绕过 | 不做 captcha 破解；只能人工验证或重新登录 |
| 账号信息接口可能失败 | `/passport/account/info/v2/` 可能要求 `a_bogus`；失败不影响对话 |
| DPAPI 凭证不可跨机迁移 | 绑定本机本用户；要迁移就用 `DOUBAO_STORE_MODE=aes` + `DOUBAO_AUTH_SECRET` |
| 音频输入未实现 | 图片 / 文件已通过 ImageX 上传；音频没有稳定的附件块映射 |
| 附件只上传当前用户消息 | 历史消息中的图片 / 文件以占位符保留，避免每轮重复上传 |
| 附件受大小 / 数量限制 | 默认 20 MB / 10 个，可用 `DOUBAO_MAX_ATTACHMENT_MB` / `DOUBAO_MAX_ATTACHMENTS` 调整 |
| 每轮自动删除会话 | 默认 `DOUBAO_AUTO_DELETE_CONVERSATION=1`；删除失败只记统计并告警，不影响对话；旧 `/samantha` 回退没有会话 ID，无法清理 |
| 思考链为步骤摘要 | 网页端 `cot_ui_style=summary` 只下发步骤标题；完整 `think` 文本存在时优先使用，否则展示摘要 |
| 不支持 tools | 豆包网页端没有稳定的原生 tool_call 协议 |

### 必须拒绝的任务

1. **「实现 Anthropic Messages API」** → 由 xrl-router 负责
2. **「添加账号池 / 多账号轮换」** → 超出插件边界，且涉及他人凭证风险
3. **「读取 / 解密豆包电脑版登录态」** → 项目明确不依赖 App
4. **「抓取或复用其他人的豆包凭证」** → 仅限本机登录用户本人
5. **「自动破解 / 绕过风控验证码」** → 不做 captcha 破解
6. **「删除 SSE 思考分隔符 / finish_reason 归一化」** → 会破坏 Router 的 Anthropic 转换

## 目录速查

- `src/index.ts` — 进程入口
- `src/server.ts` — Hono 路由、端口释放、启动
- `src/config.ts` — Settings 单例、模型预设、环境变量
- `src/pluginClient.ts` — WebSocket 注册 / 心跳 / 重连（V24 无 keys）
- `src/douyinLogin.ts` — Playwright 打开豆包登录 → 抖音官方授权页 → 提取 Cookie
- `src/webLogin.ts` — 备用：豆包网页扫码登录流程
- `src/loginPage.ts` — 备用豆包扫码页 / 测试用回调页
- `src/loginFlow.ts` — 登录状态与二维码类型
- `src/openBrowser.ts` — Windows 下用 rundll32 打开 URL（避免 cmd 丢失 & 参数）
- `src/auth.ts` — 会话缓存 / 加密落盘 / 灾备 Cookie / 登录编排
- `src/cookieJar.ts` — Cookie 罐
- `src/credentialStore.ts` — DPAPI / AES / 明文三形态
- `src/securityParams.ts` — 上游 query / 请求头
- `src/device.ts` — 设备指纹
- `src/messages.ts` — OpenAI 消息压平 + 最后一条用户消息的附件提取
- `src/doubaoUpload.ts` — ImageX 图片 / 文件上传（STS + SigV4 + TOS + pre_handle）
- `src/conversationCleanup.ts` — 每轮结束后删除豆包会话（cmd 4171）
- `src/doubaoClient.ts` — 上游请求、SSE 解析、回退与错误分类
- `src/sse.ts` — 通用 SSE 解析
- `src/openai.ts` — OpenAI 响应翻译 / 聚合 / 错误映射
- `scripts/login.ts` — 交互式网页登录入口
- `scripts/check-auth.ts` — 凭证与账号诊断
- `scripts/smoke.ts` — 真实账号冒烟
- `scripts/logout.ts` — 删除本地凭证
- `test/e2e.test.ts` — 离线 E2E
- `docs/DOUBAO_REVERSE.md` — 逆向记录与协议细节
