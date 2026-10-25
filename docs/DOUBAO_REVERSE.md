# 豆包网页端逆向记录

> 观测时间：2026-10-25；本机豆包电脑版版本：2.32.6（Chromium 147）。
> 本文记录本插件依赖的豆包网页端行为，仅用于**本人账号**的互操作实验。
>
> 凭证来源：**仅自包含网页扫码登录**（见第 2 节）——不依赖豆包电脑版，不读取任何 App 文件。
> 电脑版仅作为“网页端版本 / 登录页行为”的观测对象，不作为运行依赖。

## 1. 端点

| 用途 | 方法与路径 | 说明 |
|---|---|---|
| 抖音授权页 | `GET https://open.douyin.com/platform/oauth/connect?...` | 直接打开官方页面，展示真正的抖音授权二维码 |
| 抖音二维码 | `GET https://open.douyin.com/oauth/get_qrcode/` | 页面内部使用；返回 base64 PNG + token |
| 抖音轮询 | `GET https://open.douyin.com/oauth/check_qrcode/` | `new` / `scanned` / `confirmed` / `expired`；confirmed 带 `redirect_url` |
| 本地回调 | `GET http://127.0.0.1:<port>/douyin/callback?code&state` | 抖音 OAuth 回跳本机 |
| code 换会话 | `POST /passport/web/auth/bind_with_mobile_login/` | 用抖音 code 换豆包 sessionid |
| 二次登录 | `POST /passport/web/auth/login/` | 返回 `profile_key` 时使用 |
| 首页 / 基础 Cookie | `GET https://www.doubao.com/` | 302 到 `/chat/`，下发 `ttwid` |
| CSRF | `GET /passport/safe/csrf_token/?aid=497858` | 返回 `passport_csrf_token` |
| 豆包扫码二维码 | `GET /passport/web/get_qrcode/?next=...&aid=497858` | 备用流程；返回 PNG + 一次性 token |
| 豆包扫码轮询 | `GET /passport/web/check_qrconnect/?next=...&token=...&aid=497858` | 备用流程 `new` / `scanned` / `confirmed` / `expired` / `refused` |
| 豆包扫码回跳 | `redirect_url`（通常是 `/passport/web/web_login_success`） | 下发 `sessionid` 等会话 Cookie |
| 账号信息 | `GET /passport/account/info/v2/` | 浏览器会带 `a_bogus`；本插件不带，失败不阻断 |
| 主对话 | `POST /chat/completion?<web params>` | SSE，支持模型模式 / 思考链 |
| 回退对话 | `POST /samantha/chat/completion?<desktop params>` | SSE，旧版 / 兼容端点 |

网页端自身通过 `www.doubao.com/passport/...` 同源代理访问 `accounts.doubao.com` 的 passport 服务。
本插件统一请求 `www.doubao.com`，避免跨域 Cookie 与额外域名。

## 2. 自包含网页 OAuth 登录（默认：Playwright 打开官方授权页）

默认登录不再由插件自己画二维码，而是用 Playwright 打开豆包聊天页 → 自动点开登录弹窗 → 进入抖音官方授权页：

```
Playwright（系统 Edge/Chrome）
  → https://www.doubao.com/chat/
  → 点击 登录 → 抖音一键登录 → 同意
  → 浏览器进入 https://open.douyin.com/platform/oauth/connect
      ?client_key=aw4293rjg7ggbx9m&client_id=aw4293rjg7ggbx9m
      &redirect_uri=https%3A%2F%2Fwww.doubao.com%2Fauth%2Fcallback
      &response_type=code&scope=user_info%2Cmobile&optionalScope=mobile%2C1
      &state=<base64(JSON)>   （state 由豆包登录弹窗生成）

抖音页面展示官方授权二维码（也提供“验证码授权”）：
  二维码解码结果：
  aweme://authorizedy?client_key=aw4293rjg7ggbx9m
    &scopes=user_info%2Cmobile&source=pc_auth
    &token=<一次性 token>&optional_scope_check=mobile...
  ← 这是真正的抖音 App 授权二维码，不是豆包下载码 / 豆包扫码登录码

用户授权后：
  https://www.doubao.com/auth/callback?code=...&state=...
  → 豆包官方页面自己完成 code 换票，写入 sessionid 等 Cookie
  → 插件从 BrowserContext 提取 Cookie，关闭浏览器
```

### 2.0 关键实测结论：redirect_uri 不能用 localhost

- 把 `redirect_uri` 改成 `http://127.0.0.1:19100/douyin/callback` 时，授权页能正常展示二维码，
  但用户扫码后抖音提示 **“非法重定向链接”**。
- 把 `redirect_uri` 改回 `https://www.doubao.com/auth/callback` 后，授权正常；回调落在豆包官方页面。
- 即使拦截官方 callback 拿到 `code`，在 Node 端重放
  `POST /passport/web/auth/bind_with_mobile_login/` 也会返回 `error_code:22「非法应用」`
  （缺少官方页面的 CSRF / 设备上下文）。因此本插件不重放 code，而是让官方页面完成换票后提取 Cookie。


### 2.1 授权页背后的接口（页面实测）

抖音授权页自己会调用：

```
GET https://open.douyin.com/oauth/get_qrcode/
    ?passport_jssdk_version=1.0.13&passport_jssdk_type=pro&aid=1128
    &client_key=aw4293rjg7ggbx9m&scope=user_info,mobile
    &next=https://www.doubao.com/auth/callback&state=<state>
    &jump_type=native&optional_scope_check=mobile&optional_scope_uncheck=
    &customize_params={"source":"pc_auth","not_skip_confirm":"true"}
    → { data: { qrcode:"<base64 PNG>", token:"<...>_lf", error_code:0 }, message:"success" }

GET https://open.douyin.com/oauth/check_qrcode/
    ?<同上>&token=<token>&timestamp=<ms>
    → { data: { status:"new"|"scanned"|"confirmed"|"expired",
                redirect_url:"https://www.doubao.com/auth/callback?code=...&state=..." } }
```

- 直接调用 `get_qrcode` 不需要 ttwid / `a_bogus`；二维码解码为 `aweme://authorizedy?...`。
- 官方页面在 `confirmed` 后会跳转 `redirect_url`（`https://www.doubao.com/auth/callback?code=...&state=...`）；插件不修改该地址，由豆包页面完成换票。
- `redirect_uri=localhost` 已被授权页接受（实测页面正常展示二维码），无需修改抖音开放平台配置。

### 2.2 code 换豆包会话（官方页面内部逻辑，插件不重放）

抖音回调只给 `code`。豆包网页 callback chunk（`web-auth_callback/page.c68b0cb1.js`）的实际逻辑是：

```js
passportApi.authLoginAutoBindMobile({
  platform_app_id: 8949,
  access_token: <query 里的 access_token>,
  code: <query 里的 code>,
  extra_params: <platform config.extraParams>
}, 'aweme_v2')
```

`authLoginAutoBindMobile` 先调：

```
POST https://www.doubao.com/passport/web/auth/bind_with_mobile_login/
  ?aid=497858&real_aid=497858&pkg_type=release_version&version_code=20800
  &device_platform=web&language=zh&account_app_language=zh-CN
  &passport_jssdk_version=4.4.6&passport_jssdk_type=normal
  &is_from_ttaccountsdk=1&multi_login=1&account_sdk_source=web&ts=<sec>
  x-tt-passport-csrf-token: <passport_csrf_token>
  Content-Type: application/x-www-form-urlencoded
  code=<code>&platform_app_id=8949&platform=aweme_v2
  → Set-Cookie: sessionid / uid_tt / ...
```

若返回 `profile_key`（需要二次校验 / 绑定），再调：

```
POST /passport/web/auth/login/
  profile_key=<profile_key>&platform_app_id=8949
```

> 实测（2026-10-25）：`bind_with_mobile_login` 用假 code 返回 `error_code:22「非法应用」`；用 Playwright 截获的真实 code 在 Node 端重放也返回同样的 22。官方页面在浏览器内执行同一请求时能成功，说明它依赖页面上下文（CSRF / 设备 / state）。因此插件让官方页面完成换票，只提取 Cookie。

### 2.3 备用：豆包扫码登录（`DOUBAO_LOGIN_FLOW=doubao`）

插件仍保留豆包网页登录弹窗同款流程：

```
GET  /                                   → Set-Cookie: ttwid
GET  /passport/safe/csrf_token/?aid=497858 → passport_csrf_token
GET  /passport/web/get_qrcode/?next=...&aid=497858
     → { data: { token:"<...>_lq", qrcode:"data:image/png;base64,...", expire_time } }
GET  /passport/web/check_qrconnect/?next=...&token=...&aid=497858
     → new → scanned → confirmed（confirmed 带 redirect_url）
GET  {redirect_url}                      → Set-Cookie: sessionid / uid_tt / passport_csrf_token ...
```

这个二维码解码后是 `https://zjsms.com/<short>/` → 302 →
`https://www.doubao.com/flow-account/scan-login?...token=...`，`get_qrcode` 的 `copywriting` 明确写着
“请使用「抖音 APP」扫码验证”。它也是官方登录码，但属于**豆包账号扫码验证**，不是抖音 OAuth 授权码。
两条链路都不读取豆包电脑版。

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
- `option.need_deep_think` 与 `ext.use_deep_think` 取所选菜单的 `menu_type`（快速 0、专家 3、工作任务 Auto 9、Pro 5、2.1 Lite 10001），**不是 0/1 布尔值**
- 登录态专家实测：`need_deep_think:3`、`ext.use_deep_think:"3"`、`model_item_key:"3"`、`model_config.model_extra_params.total_window_size:"256000"`
- 每轮请求都会创建会话：`need_create_conversation:true` + 新的 `local_conversation_id`；置空并设 false 会返回 `710020202 common invalid param`
- 任务类模型可能需要登录 / 订阅；插件按客户端传入的模型别名映射

## 5. SSE 协议

### 5.1 `/chat/completion`

服务端返回 `text/event-stream`。实测事件：

```
: heartbeat

event: SSE_HEARTBEAT
data: {}

event: SSE_ACK
data: {"ack_client_meta":{"conversation_id":"..."}}

event: FULL_MSG_NOTIFY
data: {"message":{...}}                       # 用户消息回显

event: STREAM_MSG_NOTIFY
data: {"content":{"content_block":[...]}}     # 首个增量

event: STREAM_CHUNK
data: {"message_id":"...","patch_op":[{"patch_value":{"content_block":[...]}}]}

event: CHUNK_DELTA
data: {"text":"..."}                           # 实测为正文增量；解析器兼容 {"think":"..."}

event: SSE_REPLY_END
data: {"end_type":1}                           # 正文结束；2/3 是推荐问题/流结束

event: STREAM_ERROR
data: {"error_code":710022004,"error_msg":"rate limited","extra":{"decision":"{\"type\":\"verify\"}"}}
```

内容块：

| `block_type` | 含义 | 插件处理 |
|---:|---|---|
| 10000 | 正文文本块 | `content.text_block.text` → `content` |
| 10040 | 思考块 `BLOCK_THINKING` | 完整思考在 `content.thinking_block.think`；`cot_ui_style=summary` 时只有 `finish_title/streaming_title` 步骤标题，插件映射为 reasoning；旧版空块仍按分隔符兼容 |
| 10001 / 2001 / 2003 | 文本兼容块 | 作为正文 |
| 2008 | 旧版思考文本 | `content.think` → reasoning |
| 10024 | 通用工具块 | 忽略（当前不映射 tool_calls） |
| 10025 | 搜索结果块 | 忽略 |
| 10101 | loading 块 | 忽略 |
| 10052 | 附件块 | 入参侧构造；出参侧当前忽略 |

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
`content_type`：2001 文本 / 2002 推荐问题 / 2008 思考 / 10000 文本 / 10040 思考（按思考文本处理）。

### 5.3 附件上传（ImageX）

图片与文件走同一条 ImageX 链路（2026-10-25 登录态实测）：

```
1) POST /alice/resource/prepare_upload
   { "tenant_id":"5", "scene_id":"5", "resource_type": 2 }   # 图片 2 / 文件 1
   → { service_id, upload_host, upload_auth_token:{ access_key, secret_key, session_token } }

2) GET /top/v1?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=<id>
       &NeedFallback=true&FileSize=<n>&FileExtension=.png&s=<random>
   SigV4；签名头：x-amz-date;x-amz-security-token
   → UploadAddress.StoreInfos[{ StoreUri, Auth, UploadID }] + UploadHosts[0]

3) POST https://<upload_host>/upload/v1/<StoreUri>
   Authorization: <Auth>；Content-CRC32: <crc32>；X-Storage-U: <uid>
   → { code: 2000 }

4) POST /top/v1?Action=CommitImageUpload&Version=2018-08-01&ServiceId=<id>
   { "SessionKey": "<base64 JSON>" }
   → Result.PluginResult[0]（ImageWidth / ImageHeight / ImageFormat / ImageSize / ImageMd5）

5) POST /alice/message/pre_handle_v2_without_conv
   { uplink_entity, bot_id, local_message_id }
   → { code:0, data:{ pre_generate_id } }
```

说明：

- `SessionKey` 图片为 `{accountType:"ImageX", fileType:"image", storeInfos:"<JSON string>", uploadHost, uri, ...}`；文件为 `{accountType:"ImageX", fileType:"object", uri, ...}`。
- SigV4 的 credential scope 是 `<date>/cn-north-1/imagex/aws4_request`；GET 的 payload hash 是空串 SHA-256，POST 是请求体 SHA-256。
- `pre_handle` 的 `entity_type`：图片 2、文件 1；文件的 `entity_content.file` 含 `file_name / key / md5 / file_type:1 / image.key / size`。
- 消息里的附件块是 `block_type:10052` 的 `content.attachment_block.attachments[]`：
  - 图片：`type:1` + `image:{name,uri,image_ori:{width,height,format}}`
  - 文件：`type:3` + `file:{uri,url,file_type:0,name,size}`
- 纯 HTTP（不生成 `a_bogus`）实测可完成 `prepare_upload → Apply → TOS → Commit → pre_handle`；STS 是短时凭证，只用于当前上传。
- 网页端在发送前调用 `pre_handle` 触发服务端解析；插件同样调用。实测 `/chat/completion` 消息体中未出现返回的 `pre_generate_id`。



### 5.4 会话删除（batch_del_user_conv）

`/chat/completion` 的 `SSE_ACK` 会返回 `ack_client_meta.conversation_id`。每轮结束后插件调用：

```
POST /im/conversation/batch_del_user_conv?<web params>
Content-Type: application/json; encoding=utf-8
{
  "cmd": 4171,
  "uplink_body": {
    "batch_delete_user_conversation_uplink_body": {
      "conversation_id": ["<id>"],
      "delete_all": false,
      "conversation_type": 3
    }
  },
  "sequence_id": "<uuid>",
  "channel": 2,
  "version": "1"
}
```

- 成功：`{ "cmd":4171, "status_code":0, "status_desc":"OK" }`
- `Content-Type` 少了 `encoding=utf-8` → `712012002 不支持编码类型`
- 空会话可能返回 `712010703 调用下游服务器失败`；插件对 712010703 与网络错误重试一次
- 旧 `/samantha` 回退没有 conversation_id，无法清理

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

1. **浏览器网络抓包**：用 Playwright 打开 `www.doubao.com/chat/`，点击登录，观测登录弹窗的 OAuth 跳转、`get_qrcode` / `check_qrconnect` 请求与响应。
2. **纯 HTTP 复现**：直接请求 CSRF、二维码、轮询端点，确认无需浏览器 JS / `a_bogus`。
3. **社区实现交叉验证**：`/samantha` 请求结构、`aid=582478` 参数组合与公开逆向项目一致；本仓库只采用协议事实，不复制其代码。
4. **离线 E2E**：`pnpm test` 用 mock 豆包覆盖登录状态机、Cookie、模型映射、流式 / 非流式、思考块与摘要、附件上传、会话清理、回退、错误映射；2026-10-25 为 25 条全绿。
5. **真实账号冒烟**：`pnpm smoke -- --yes`（消耗一次额度）。

### 7.1 真实账号验证结果（2026-10-25）

- `pnpm log-in`：Playwright 打开豆包登录弹窗 → 抖音官方授权页 → 用户扫码 → 豆包官方 callback 换票；插件提取 32 条 Cookie，DPAPI 落盘，uid / 昵称可读。
- `pnpm check-auth`：`loggedIn=true`；`/passport/account/info/v2/` 未带 `a_bogus` 也返回 uid / 昵称。
- `pnpm smoke -- --yes --model doubao-fast`：返回「收到」，`X-Doubao-Mode: web`。
- 登录态抓包（2026-10-25）：网页端真实请求为 `POST /chat/completion`；专家请求为 `need_deep_think:3`、`ext.use_deep_think:"3"`、`model_item_key:"3"`。
- 思考块：`block_type:10040` + `content.thinking_block`；网页端 `cot_ui_style=summary` 时只下发 `finish_title/streaming_title` 步骤标题（实测“解答量水问题 / 整理量水操作步骤”），不下发完整 CoT；插件把标题映射为 `reasoning_content`，完整 `think` 存在时优先。此前“10040 是分隔符”的解释有误。
- 正文增量：实测 `CHUNK_DELTA` 事件 `{"text":"..."}` 共 17 条；插件按正文增量处理。
- 附件：ImageX 链路（`prepare_upload → Apply → TOS → Commit → pre_handle`）已用纯 HTTP 验证通过（图片与 `.txt`），不依赖 `a_bogus`。
- 会话删除：真实 web 会话的 `batch_del_user_conv` 返回 `status_code:0`；fast / expert 各验证一次，`deleted=1`。
- 风控：同一账号的网页端与插件都可能收到 `710022004`，且与提示长度/语义有关；需要在浏览器完成人机验证。
- 旧 `/samantha` 回退：实测会把 CoT 混在正文里返回，且没有 conversation_id；不作为默认路径。
- 插件直连 HTTP：`/health` 正常；`/v1/chat/completions` 流式 / 非流式均返回正确 OpenAI 结构。
- `plugin-doubao` 已通过 WebSocket 注册并在 xrl-router 中 confirm 为 enabled。
- 失败记录：`redirect_uri=localhost` → 抖音提示“非法重定向链接”；Node 端重放官方 code → 豆包返回 `code=22 非法应用`。因此插件使用 Playwright 让官方页面完成换票。

## 8. 已知限制

- 不生成 `a_bogus`；主端点只在 404 / 非 SSE / 网络等协议或端点错误时回退 `/samantha`，风控与鉴权错误不回退
- `/passport/account/info/v2/` 可能要求 `a_bogus`；账号信息失败不影响对话
- 豆包网页登录没有 refresh token；会话 Cookie 过期只能重新扫码
- 上游协议、模型键、`pc_version` 可能随豆包升级变化；参数均可通过环境变量覆盖
- 图片 / 文件通过 ImageX 上传；附件只上传当前用户消息，历史附件以占位符保留
- 音频输入未实现
- 附件默认限制 20 MB / 10 个（`DOUBAO_MAX_ATTACHMENT_MB` / `DOUBAO_MAX_ATTACHMENTS` 可调）
- 每轮创建会话后自动删除（`DOUBAO_AUTO_DELETE_CONVERSATION=1` 默认）；删除失败只记统计；旧 `/samantha` 没有 conversation_id，无法清理
- 思考链通常为步骤摘要（`cot_ui_style=summary`）；完整 CoT 不由网页端下发，可用 `DOUBAO_THINKING_SUMMARY=0` 关闭摘要映射
- 真实网页请求即使带 `a_bogus` 也可能触发风控验证；插件不破解验证码
- 不实现 OpenAI tools / function calling；不伪造 tool_call 语义
- 不读取、不解密、不写回豆包电脑版的任何文件

## 9. 安全边界

- 仅使用当前机器、当前登录用户自己的豆包账号
- 不记录、不打印 Cookie / 二维码 token / 容量证明文
- `.env` 与自包含凭证文件均不进版本控制
- 二维码是登录凭据，等同于临时密码；不要截图外传
