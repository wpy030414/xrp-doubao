# PRD — xrp-doubao

> Version: 0.1.0 | Last updated: 2026-10-25
>
> 本文定义“做什么、为什么、怎样算做对”。实现细节见 `ARCHITECTURE.md` 与 `specs/`。

## 1. 背景

豆包（Doubao）网页端提供了对话、思考链、工作任务等能力，但它使用私有 SSE 协议与网页会话 Cookie，无法被 OpenAI 兼容客户端直接调用。xrl-router 已有统一的插件体系，可以把豆包包装成一个可路由的供应商。

与 xrp-workbuddy 的关键差异：

- 豆包网页登录存在两种官方链路：**抖音 OAuth 授权页**（默认，`open.douyin.com`，本地回调）与豆包自带扫码登录；两者都没有 refresh token。
- 抖音 OAuth 的 `client_key`、授权页、二维码与 callback 都能从豆包网页登录弹窗中观测到；本插件直接复用官方页面，不自己伪造二维码。
- 豆包对话协议是私有 SSE，需要把内容块 / 思考分隔符翻译成 OpenAI chunk。
- 网页端请求带一整套设备参数；主端点可能要求 `a_bogus`，需要可回退的兼容端点。

## 2. 目标

1. **自包含网页 OAuth 登录**：直接打开抖音官方授权页，本机接收回调 `code`，用 code 调豆包 passport 换会话 Cookie；不依赖、不读取豆包电脑版。
2. **OpenAI Chat Completions 兼容**：支持流式与非流式；正文 + `reasoning_content`。
3. **模型模式映射**：快速 / 专家 / 工作任务 / 2.1 Lite 等模式可通过模型别名选择，思考强度可调。
4. **凭证安全**：Cookie 与设备指纹静态加密；日志不泄露凭证。
5. **xrl-router V24 插件**：无 `keys` 注册、30s 心跳、指数退避重连。
6. **可诊断、可恢复**：登录失效、风控、主端点不可用都有明确状态与回退路径。
7. **高覆盖率 E2E**：离线 mock 覆盖登录状态机、协议翻译、错误映射、插件注册。

## 3. 非目标

- 不实现 Anthropic Messages API（由 xrl-router 负责）
- 不做账号池、多账号轮换、密钥轮转
- 不做本地推理
- 音频输入暂不支持（图片 / 文件已支持）
- 不实现 OpenAI tools / function calling
- 不绕过风控验证码
- 不读取、解密、写回豆包电脑版凭证
- 不抓取或复用他人凭证

## 4. 用户故事

1. 作为本机用户，我运行 `pnpm log-in`，浏览器直接打开抖音官方授权页；我扫码或输入短信验证码授权后，抖音回跳本机，凭证自动加密保存。
2. 作为本机用户，我运行 `pnpm serve`，xrl-router 中出现 `plugin-doubao` 的模型；我用 OpenAI 客户端调用 `doubao-fast` 得到流式回答。
3. 作为 Claude Code 用户，我通过 xrl-router 的 Anthropic 转换调用本插件，正文与 thinking 块正确出现。
4. 作为运维者，我调用 `/health` 看到登录状态、模型列表、`needs_captcha`；风控时我完成浏览器验证后调用 `/admin/reset-captcha`。
5. 作为迁移者，我设置 `DOUBAO_STORE_MODE=aes` + `DOUBAO_AUTH_SECRET`，把凭证带到另一台机器。

## 5. 功能需求

### FR-1 抖音 OAuth 网页登录

- 默认 `DOUBAO_LOGIN_FLOW=douyin`：Playwright 启动系统 Edge/Chrome，自动打开豆包登录弹窗 → 抖音官方授权页
- 用户扫码或短信验证码授权；抖音回跳豆包官方 callback，由豆包页面自行完成 code 换票
- 插件从浏览器上下文提取 `sessionid` 等 Cookie；关闭浏览器，不保留 profile
- 超时（默认 5 分钟）返回明确错误
- 备用 `DOUBAO_LOGIN_FLOW=doubao`：本机展示豆包网页登录二维码，轮询确认
- 不读取任何豆包电脑版文件

### FR-2 凭证

- 内存缓存 → 本地加密存储 → `DOUBAO_COOKIES` 灾备
- DPAPI / AES / 明文三形态；原子写、0600
- 会话失效只能重新登录（无 refresh token）
- `pnpm log-out -- --yes` 删除

### FR-3 对话

- 接受 OpenAI messages（system / user / assistant / tool）
- 无状态压平为一条豆包用户消息；客户端带完整 history 即可多轮
- 最后一条用户消息中的图片 / 文件通过 ImageX 上传，作为 `block_type:10052` 附件块发送；音频暂不支持
- 模型别名映射到 `model_item_key` / `agent_mode` / `mode_id` / `need_deep_think` / 思考强度
- 上游流式；客户端非流式时本地聚合
- thinking → `reasoning_content`；正文 → `content`；`cot_ui_style=summary` 时把步骤标题映射为 reasoning
- 每轮结束后异步删除本轮豆包会话（`DOUBAO_AUTO_DELETE_CONVERSATION=1` 默认）
- 非结束分片 `finish_reason=null`；结束分片 `stop`
- 不输出空 `tool_calls: []`

### FR-4 回退与错误

- 主端点仅在 404 / 非 SSE / 网络等端点或协议错误时回退 `/samantha/chat/completion`
- 风控（710022xxx）、鉴权（401 / 710012xxx）、参数（400 / 422）错误不回退；带附件请求不回退
- 401 / 710012001 → 401 `authentication_error`
- 710022004 → 429 + `needs_captcha`
- 其他 → 502 或上游状态
- 流中错误以 SSE error 事件返回

### FR-5 插件注册

- V24：`plugin_id=plugin-doubao`、`provider.kind=chat_completions`、无 `keys`
- 模型 `display_name` 唯一，且等于 `model_id`
- 30s 心跳；断线 1s → 60s 退避

### FR-6 诊断

- `/health`：登录状态、Cookie 名称 / 数量、模型、`needs_captcha`
- `pnpm check-auth`：不打印 Cookie 值
- `pnpm smoke -- --yes`：真实账号短消息

## 6. 验收标准与语义对齐

### 6.1 登录语义

| 检查点 | 语义 |
|---|---|
| 授权页是抖音官方页面 | `open.douyin.com/platform/oauth/connect`，二维码解码为 `aweme://authorizedy?...` |
| 不能自造 redirect_uri | 抖音只接受豆包白名单 callback；localhost 会提示“非法重定向链接” |
| 换票由官方页面完成 | 插件不重放 code，只从浏览器上下文提取会话 Cookie |
| 登录成功以 `sessionid` 等会话 Cookie 落地为准 | 不以“授权页 200”或“页面跳回”误判 |
| 超时 / 拒绝可重试 | 不静默失败 |
| 不读取电脑版 | 代码中不存在 App 文件路径 / 解密逻辑 |

### 6.2 对话语义

| 检查点 | 语义 |
|---|---|
| OpenAI messages 压平 | system 作为指令；历史轮次带角色标签；最后一条用户消息是提问 |
| `reasoning_content` | 只承载思考链；正文不混入 |
| `finish_reason` | 只在最终 chunk 出现 `stop`；中间为 `null` |
| 非流式 | 与流式内容一致，聚合后一次性返回 |
| 回退 | 只在端点 / 协议错误时回退；风控、鉴权、参数错误与附件请求不回退；响应头标明实际通道与回退原因 |
| 附件 | 图片 / 文件上传后以 10052 附件块发送；历史附件占位；音频 400 |
| 会话清理 | 每轮结束后删除本轮会话；失败只记统计；旧 `/samantha` 无 id 不清理 |
| 思考摘要 | 完整 `think` 优先；`cot_ui_style=summary` 时步骤标题进入 `reasoning_content` |
| 错误 | 登录失效 ≠ 风控 ≠ 上游故障；分别映射 401 / 429 / 502 |

### 6.3 E2E 覆盖矩阵

| 场景 | 覆盖 |
|---|---|
| Cookie 罐域 / 路径 / 过期 | `test/e2e.test.ts` |
| 凭证 AES / plain 往返 | 同上 |
| 登录 new → scanned → confirmed → Cookie → 账号 | 同上 |
| Playwright 打开豆包登录 → 抖音授权页 → 提取 Cookie | 同上 |
| 官方 redirect_uri / 拒绝 localhost / 超时 | 同上 |
| 备用豆包扫码登录 / 登录页二维码 / 状态 / 刷新 | 同上 |
| 登录超时 | 同上 |
| 认证状态 / 账号查询 / 强制重登 | 同上 |
| 流式正文 + thinking + usage + 模型映射 | 同上 |
| thinking_block / 旧 delimiter 兼容 | 同上 |
| 图片 / 文件上传（data URL / 远程 URL / 大小与数量限制） | 同上 |
| 会话自动清理 / 删除失败重试 / 统计 | 同上 |
| 主端点 404 / HTML → 回退；风控 / 400 → 不回退 | 同上 |
| 风控 / 登录失效分类 | 同上 |
| OpenAI HTTP 流式 / 非流式 / 错误 / 校验 | 同上 |
| V24 注册载荷无 keys | 同上 |
| 消息压平 / 图片与文件提取 | 同上 |
| SSE 解析 | 同上 |

## 7. 成功标准

- `pnpm typecheck` 与 `pnpm test` 全绿
- 真实账号 `pnpm log-in` 能拿到会话 Cookie；`pnpm smoke -- --yes` 能收到回复
- xrl-router `/v1/models` 能看到 `doubao-fast` 等模型；流式 / 非流式调用成功
- 401 / 429 / 502 在客户端表现为明确错误，不静默失败
- 仓库中不存在凭证明文、`.env`、二维码图片或 App 凭证文件
