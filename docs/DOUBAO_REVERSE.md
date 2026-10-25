# 豆包网页端逆向记录

> 观测时间：2026-10-25；本机豆包电脑版版本：2.32.6（Chromium 147）。
> 本文记录本插件依赖的豆包网页端行为，仅用于**本人账号**的互操作实验。
>
> 凭证来源：**仅自包含网页扫码登录**（见第 2 节）——不依赖豆包电脑版，不读取任何 App 文件。
> 电脑版仅作为“网页端版本 / 登录页行为”的观测对象，不作为运行依赖。

## 1. 端点

| 用途 | 方法与路径 | 说明 |
|---|---|---|
| 首页 / 基础 Cookie | `GET https://www.doubao.com/` | 302 到 `/chat/`，下发 `ttwid` |
| CSRF | `GET /passport/safe/csrf_token/?aid=497858` | 返回 `passport_csrf_token` |
| 二维码 | `GET /passport/web/get_qrcode/?next=...&aid=497858` | 返回 PNG + 一次性 token |
| 轮询确认 | `GET /passport/web/check_qrconnect/?next=...&token=...&aid=497858` | `new` / `scanned` / `confirmed` / `expired` / `refused` |
| 登录回跳 | `redirect_url`（通常是 `/passport/web/web_login_success`） | 下发 `sessionid` 等会话 Cookie |
| 账号信息 | `GET /passport/account/info/v2/` | 浏览器会带 `a_bogus`；本插件不带，失败不阻断 |
| 主对话 | `POST /chat/completion?<web params>` | SSE，支持模型模式 / 思考链 |
| 回退对话 | `POST /samantha/chat/completion?<desktop params>` | SSE，旧版 / 兼容端点 |

网页端自身通过 `www.doubao.com/passport/...` 同源代理访问 `accounts.doubao.com` 的 passport 服务。
本插件统一请求 `www.doubao.com`，避免跨域 Cookie 与额外域名。

## 2. 自包含网页扫码登录（已实测）

流程与豆包网页登录弹窗一致：

```
GET  /                                   → Set-Cookie: ttwid
GET  /passport/safe/csrf_token/?aid=497858 → passport_csrf_token
GET  /passport/web/get_qrcode/?next=...&aid=497858
     headers: x-tt-passport-csrf-token: <csrf>
     → { data: { error_code:0, token:"<...>_lq", qrcode:"data:image/png;base64,...",
                 expire_time:<unix seconds>, qrcode_index_url:"..." }, message:"success" }
GET  /passport/web/check_qrconnect/?next=...&token=...&aid=497858
     → new → scanned → confirmed
     confirmed 时 data.redirect_url 指向登录回跳
GET  {redirect_url}                      → Set-Cookie: sessionid / uid_tt / passport_csrf_token ...
```

关键观察：

1. **纯 HTTP 可用**：CSRF + 二维码 + 轮询不需要浏览器 JS 或 `a_bogus`；本插件因此不需要 Playwright / 无头浏览器。
2. `qrcode` 是 `data:image/png;base64,...` 形式的 PNG；`token` 每次不同，后缀会变化（实测见过 `_lf` / `_lq`）。
3. `expire_time` 是 **Unix 秒**；二维码约 2 分钟有效。
4. `check_qrconnect` 在二维码过期时可能返回 `status:"expired"`，也可能返回非 0 `error_code` + 描述；插件两者都识别。
5. 手机确认后，`confirmed` 响应携带 `redirect_url`；**必须跟随回跳**才能收集完整会话 Cookie（`sessionid` 等）。
6. 登录 Cookie 落在 `www.doubao.com` / `.doubao.com`；`sessionid` 是 HttpOnly。
7. 登录页由豆包官方托管，插件不经手手机号、验证码或密码。

登录前浏览器常见 Cookie 名称（只记录名称）：

```
ttwid, passport_csrf_token, passport_csrf_token_default, odin_tt, hook_slardar_session_id, s_v_web_id
```

登录后预期新增（以实际账号为准）：

```
sessionid, sessionid_ss, sid_tt, uid_tt, uid_tt_ss, sid_guard, passport_auth_status, passport_auth_status_ss
```

## 3. 设备指纹与请求头

网页端每次请求的 query 带一组伪设备参数。插件在登录时生成一次并随凭证保存：

| 参数 | 形态 | 说明 |
|---|---|---|
| `device_id` | 19 位数字，首位 7 | 设备标识 |
| `web_id` / `tea_uuid` | 同上 | 网页 / 埋点标识 |
| `fp` | `verify_<8>_<4>_<4>_<4>_<12>` | 浏览器指纹串 |
| `web_tab_id` | UUID | 每次请求重新生成 |

`/chat/completion` 的 query（实测）：

```
aid=497858&real_aid=497858&device_id=...&tea_uuid=...&web_id=...
&device_platform=web&doubao_device_platform=web
&pc_version=3.42.5&doubao_pc_version=3.42.5
&pkg_type=release_version&version_code=20800&language=zh
&region=CN&sys_region=CN&samantha_web=1&web_platform=browser
&use-olympus-account=1&fp=verify_...&web_tab_id=...&tz_name=Asia%2FShanghai
&a_bogus=<浏览器生成>
```

插件不生成 `a_bogus`；登录 Cookie + 上述参数在纯 HTTP 下可用。若上游要求签名，`auto` 模式回退 `/samantha`。

请求头（节选）：

```
Accept: text/event-stream
Content-Type: application/json
Origin: https://www.doubao.com
Referer: https://www.doubao.com/chat/
User-Agent: Mozilla/5.0 ... Chrome/147.0.0.0 ...
agw-js-conv: str
x-flow-trace: 00-<32hex>-<16hex>-01
x-tt-passport-csrf-token: <passport_csrf_token>
Cookie: sessionid=...; ttwid=...; ...
```

## 4. `/chat/completion` 请求体

浏览器实测（节选，模型相关字段保留）：

```json
{
  "client_meta": {
    "local_conversation_id": "local_2461682161224671",
    "conversation_id": "",
    "bot_id": "7338286299411103781",
    "last_section_id": "",
    "last_message_index": null,
    "local_permissions": [
      {"permission_name": "ACCESS_COARSE_LOCATION", "status": 3},
      {"permission_name": "ACCESS_FINE_LOCATION", "status": 3},
      {"permission_name": "ACCESS_BACKGROUND_LOCATION", "status": 3}
    ]
  },
  "messages": [{
    "local_message_id": "17cc6eb0-...",
    "content_block": [{
      "block_type": 10000,
      "content": {
        "text_block": {"text": "你好", "icon_url": "", "icon_url_dark": "", "summary": ""},
        "pc_event_block": ""
      },
      "block_id": "dd1ef5b5-...",
      "parent_id": "",
      "meta_info": [],
      "extra_info": {},
      "append_fields": []
    }],
    "message_status": 0
  }],
  "option": {
    "create_time_ms": 1792903610778,
    "answer_with_suggest": false,
    "agent_mode": 2,
    "need_deep_think": 0,
    "unique_key": "fbab5c53-...",
    "need_create_conversation": true,
    "conversation_init_option": {"need_ack_conversation": true},
    "conversation_init_ext": {
      "model_item_key": "0",
      "reasoning_effort": "3",
      "mode_id": "1"
    },
    "model_config": {
      "model_item_key": "0",
      "model_extra_params": {},
      "reasoning_effort": 3
    },
    "aggregate_params": {
      "mention_skill_list": "[]",
      "mention_plugin_list": "[]",
      "mention_ext": "[{}]",
      "conversation_mode": "1",
      "mode_id": "1",
      "model_item_key": "0",
      "agent_mode": "2",
      "reasoning_effort": "3",
      "provider_id": ""
    },
    "conversation_mode": 1,
    "support_lazy_fetch_stream": true,
    "sse_recv_event_options": {"support_chunk_delta": true}
  },
  "user_context": [],
  "ext": {
    "agent_mode": "2",
    "use_deep_think": "0",
    "sub_conv_firstmet_type": "1",
    "general_task_param": "{\"server_do_compare\":true}",
    "conversation_init_option": "{\"need_ack_conversation\":true}",
    "commerce_credit_config_enable": "0"
  }
}
```

### 4.1 模型菜单（`/chat` SSR 的 `menu_item_list`）

实测（游客视角，登录后可能多出 Pro 模型）：

| 名称 | `item_id` | `model_item_key` | `agent_mode` | `mode_id` | 默认思考强度 |
|---|---:|---|---:|---:|---:|
| 快速 | 0 | `0` | 2 | 1 | 3 |
| 专家 | 3 | `3` | 2 | 1 | 4 |
| 工作任务 Auto | 9 | `9` | 1 | 3 | 5 |
| 工作任务 Pro | 5 | `5` | 1 | 3 | 5 |
| 豆包 2.1 Lite | 10001 | `seed-lite-7b` | 1 | 3 | 5 |

- `agent_mode=2` 对应聊天，`agent_mode=1` 对应办公 / 工作任务
- `mode_id=1` 对应对话，`mode_id=3` 对应工作任务
- `reasoning_effort` 取 3/4/5（低 / 中 / 高）
- 任务类模型可能需要登录 / 订阅；插件按客户端传入的模型别名映射

## 5. SSE 协议

### 5.1 `/chat/completion`

服务端返回 `text/event-stream`。实测事件：

```
: heartbeat

data: {"content_block":[...]}

data: {"patch_op":[{"patch_value":{"content_block":[...]}}]}

event: SSE_ACK
data: {"ack_client_meta":{"conversation_id":"..."}}

event: SSE_HEARTBEAT
data: {}

event: STREAM_ERROR
data: {"error_code":710022004,"error_msg":"rate limited","extra":{"decision":"{\"type\":\"verify\"}"}}

data: [DONE]
```

内容块：

| `block_type` | 含义 | 插件处理 |
|---:|---|---|
| 10000 | 文本块（思考 / 正文） | 按状态机写入 `reasoning_content` 或 `content` |
| 10040 | 思考分隔符 | 第一次切到 thinking，第二次切回正文 |
| 10001 / 2001 / 2003 | 文本兼容块 | 作为正文 |
| 2008 | 思考文本 | `content.think` → reasoning |
| 10024 | 通用工具块 | 忽略（当前不映射 tool_calls） |
| 10025 | 搜索结果块 | 忽略 |
| 10101 | loading 块 | 忽略 |
| 10052 | 附件块 | 忽略 |

插件同时兼容 `content_block`、`patch_op.patch_value.content_block`、`patch_op.patch_value.content`（JSON 字符串）三种承载方式。

### 5.2 `/samantha/chat/completion`

旧版 / 兼容端点，请求体：

```json
{
  "messages": [{
    "content": "{\"text\":\"你好\"}",
    "content_type": 2001,
    "attachments": [],
    "references": []
  }],
  "completion_option": {
    "is_regen": false,
    "with_suggest": false,
    "need_create_conversation": true,
    "launch_stage": 1,
    "is_ai_playground": false,
    "memory_type": 2,
    "message_from": 0,
    "use_deep_think": true,
    "use_auto_cot": true
  },
  "evaluate_option": {"web_ab_params": ""},
  "local_conversation_id": "local_...",
  "local_message_id": "...",
  "bot_id": "7338286299411103781"
}
```

响应事件：

```
event: message
data: {"event_type":2001,"event_data":{"message":{"content_type":2008,"content":"{\"think\":\"...\"}"}}}

event: message
data: {"event_type":2001,"event_data":{"message":{"content_type":2001,"content":"{\"text\":\"...\"}"}}}

event: message
data: {"event_type":2003,"event_data":{}}
```

`event_type`：2001 CMPL / 2002 ACK / 2003 FIN / 2005 ERR / 2010 VERBOSE。
`content_type`：2001 文本 / 2002 推荐问题 / 2008 思考 / 10000 文本 / 10040 思考分隔。

## 6. 错误与风控

| 现象 | 含义 | 插件处理 |
|---|---|---|
| HTTP 401 / 403 | Cookie 失效 | `authentication_error` → 401，提示重新登录 |
| `error_code: 710012001` | 登录已过期 | 同上 |
| `error_code: 710022004` | 触发人机验证 / 风控 | HTTP 429 + `needs_captcha: true`；`/health` 暴露 |
| `710022002` 等 71002200x | 风控 / 限流 | 按风控处理 |
| 非 SSE JSON 错误 | 端点不可用 / 参数错误 | `auto` 模式回退 `/samantha` |
| 200 but 空流 | 上游异常 | 返回空正文 + stop（调用方可重试） |

`710022004` 的处理边界：插件**不破解、不自动绕过验证码**；只上报状态，等待用户在浏览器完成验证或重新登录。

## 7. 验证方法

1. **浏览器网络抓包**：用 Playwright 打开 `www.doubao.com/chat/`，点击登录，观测登录弹窗的 `get_qrcode` / `check_qrconnect` 请求与响应（见 `docs/` 中的实验记录）。
2. **纯 HTTP 复现**：直接请求 CSRF、二维码、轮询端点，确认无需浏览器 JS / `a_bogus`。
3. **社区实现交叉验证**：`/samantha` 请求结构、`aid=582478` 参数组合与公开逆向项目一致；本仓库只采用协议事实，不复制其代码。
4. **离线 E2E**：`pnpm test` 用 mock 豆包覆盖登录状态机、Cookie、模型映射、流式 / 非流式、回退、错误映射。
5. **真实账号冒烟**：`pnpm smoke -- --yes`（消耗一次额度）。

## 8. 已知限制

- 不生成 `a_bogus`；主端点若被风控，回退 `/samantha`。两条链路都失败时只能等待验证 / 重新登录
- `/passport/account/info/v2/` 可能要求 `a_bogus`；账号信息失败不影响对话
- 豆包网页登录没有 refresh token；会话 Cookie 过期只能重新扫码
- 上游协议、模型键、`pc_version` 可能随豆包升级变化；参数均可通过环境变量覆盖
- 只支持文本；图片 / 文件 / 音频输入未实现
- 不实现 OpenAI tools / function calling；不伪造 tool_call 语义
- 不读取、不解密、不写回豆包电脑版的任何文件

## 9. 安全边界

- 仅使用当前机器、当前登录用户自己的豆包账号
- 不记录、不打印 Cookie / 二维码 token / 容量证明文
- `.env` 与自包含凭证文件均不进版本控制
- 二维码是登录凭据，等同于临时密码；不要截图外传
