# DECISIONS — xrp-doubao

> 记录影响结构、协议或安全边界的设计决策，以及被放弃的替代方案。

## D-1 默认用 Playwright 打开豆包登录 → 抖音官方授权页，提取会话 Cookie

**决策**：`pnpm log-in` 用 `playwright-core` + 系统 Edge/Chrome 打开豆包聊天页，自动点击「登录 → 抖音一键登录 → 同意」，进入 `open.douyin.com` 官方授权页；用户扫码或短信验证码授权后，豆包官方 callback 自行完成 code 换票，插件从浏览器上下文提取 `sessionid` 等 Cookie。备用 `DOUBAO_LOGIN_FLOW=doubao` 保留豆包扫码登录。

**原因**：
- 用户要求“运行脚本登录时直接弹出抖音网页”，官方页面的二维码才是真正的抖音授权二维码（解码为 `aweme://authorizedy?...`）
- 官方页面的 `redirect_uri` 必须是豆包白名单里的 `https://www.doubao.com/auth/callback`；改成 localhost 会被抖音提示“非法重定向链接”
- 因此换票必须由豆包官方页面在浏览器内完成；插件只提取登录后的 Cookie，不重放 code
- Playwright 使用系统浏览器，不下载额外 Chromium；不读取豆包电脑版
- 抖音页面同时支持扫码与短信验证码，用户不必安装豆包 App

**代价**：需要本机有 Edge/Chrome；登录时会弹出一个自动化浏览器窗口；浏览器关闭后不保留 profile。

**放弃的方案**：
- 自己绘制二维码：用户无法确认是否为真正的抖音授权码，已改为官方页面
- localhost 回调 + code 换票：实测抖音授权时提示“非法重定向链接”；即使截获 code，重放 `bind_with_mobile_login` 也返回 `code=22 非法应用`
- 直接重放官方 callback 的 code：缺少官方页面的 CSRF / 设备上下文，换票失败
- 修改系统 hosts / 代理拦截官方 callback：侵入性强、易碎，不适合插件

### D-1.1 保留豆包扫码登录作为备用

**决策**：`DOUBAO_LOGIN_FLOW=doubao` 时仍走豆包网页登录弹窗的 `get_qrcode` / `check_qrconnect`。

**原因**：部分环境可能没有 Edge/Chrome 或 Playwright 无法启动；豆包扫码链路是官方同款，作为兜底。



## D-2 不生成 `a_bogus`，只对端点/协议错误回退

**决策**：`/chat/completion` 请求不带 `a_bogus`；`auto` 模式仅在 404 / 非 SSE / 网络或协议错误时回退 `/samantha/chat/completion`。风控（710022xxx）、鉴权（401 / 710012xxx）、参数（400 / 422）错误直接返回，不静默回退；带附件的请求一律不回退。

**原因**：
- `a_bogus` 是字节风控签名，算法随版本变化，纯 JS 复现维护成本高
- 登录 Cookie + 完整设备参数在实测中可访问主端点
- 旧端点没有 `model_item_key` / `mode_id` / `reasoning_effort`，回退会丢失模型选择与思考语义
- 附件只在 `/chat/completion` 的 10052 块中生效，回退会静默丢附件

**代价**：主端点被风控时不再有兜底，客户端会收到明确的 429 / 401；需要人工验证或重新登录。

**放弃的方案**：内嵌 `a_bogus` 纯算实现 / 无头浏览器 hook；两者都会显著增加复杂度和被风控概率。

## D-3 无状态消息压平，不维护 conversation_id 映射

**决策**：把 OpenAI `messages` 压平成一条豆包用户消息，每次请求创建新会话。

**原因**：
- 插件是 HTTP 无状态服务；客户端（Claude Code / OpenAI SDK）每次都带完整 history
- 维护跨请求 conversation_id 需要进程内会话表、并发隔离、过期清理，且 Router 重启后丢失
- 压平后行为可预测，便于 E2E

**代价**：多轮对话的 token 效率略低；豆包侧会为每轮创建会话（`need_create_conversation:true` + 新的 `local_conversation_id` 是上游要求），账号最近会话里可见。实测置空并设 `need_create_conversation:false` 会被 `710020202 common invalid param` 拒绝；因此改为创建后立即删除（见 D-13）。

**放弃的方案**：按 `local_conversation_id` 维护状态。更接近网页体验，但引入服务端状态和串话风险。

## D-4 Cookie 罐 + 加密凭证文件

**决策**：用自实现的最小 Cookie 罐保存 domain/path/expiry；凭证整包 DPAPI/AES 加密。

**原因**：
- Node `fetch` 不自动持久化 Cookie
- 登录回跳跨多个路径，需要收集每一跳 `Set-Cookie`
- 凭证不仅是 `sessionid`，还有 `ttwid` / `passport_csrf_token` / `uid_tt` 等，整包保存最简单
- DPAPI 绑本机本用户；AES 支持迁移

**代价**：DPAPI 凭证不可跨机；AES 需要用户保管 passphrase。

**放弃的方案**：明文 `.env` / cookie jar 文件。泄露风险高，不符合项目安全边界。

## D-5 端口 19071 / 插件 ID `plugin-doubao`

**决策**：插件监听 19071，Plugin ID `plugin-doubao`；登录页 19100。

**原因**：与现有 xrp-* 插件端口（19065 / 19067 / 19069 / 19070）错开；ID 与插件名一致，便于 Router 确认。

## D-6 内置模型预设，不动态抓取目录

**决策**：在 `config.ts` 内置 5 个模型预设 + 3 个别名；`DOUBAO_MODELS` 可裁剪。

**原因**：
- 豆包没有公开的模型目录 API；模型键藏在 `/chat` 页面 SSR 的 `menu_item_list` 中
- 登录后菜单可能随订阅 / 灰度变化，动态解析 SSR 易碎
- 预设足够覆盖快速 / 专家 / 工作任务，且可用环境变量覆盖

**代价**：豆包新增模型时需要更新预设。

**放弃的方案**：每次启动抓取 `/chat` 并解析 `menu_item_list`。更动态，但依赖 HTML 结构，且游客 / 登录视角不同。

## D-7 只支持文本（已被 D-11 取代）

**原决策**：`image_url` / 音频 / 文件输入返回 400；不实现 tools / function calling。

**原因**：当时认为图片 / 文件需要对象存储上传、链路复杂且易变。

**为何改变**：2026-10-25 已完整抓出 ImageX 上传链路，并用纯 HTTP 验证通过；用户明确要求支持图片 / 文件。音频仍未实现。tools / function calling 仍不实现。

## D-11 图片 / 文件通过 ImageX 上传

**决策**：`messages` 中最后一条用户消息的图片 / 文件先上传到豆包 ImageX，再以 `block_type:10052` 的 `attachment_block` 发送；图片 `type:1`，文件 `type:3`。

**链路**：
1. `POST /alice/resource/prepare_upload`（图片 `resource_type:2`，文件 `:1`）拿 STS
2. `GET /top/v1?Action=ApplyImageUpload`（SigV4）
3. `POST https://<upload_host>/upload/v1/<StoreUri>`（`Authorization: SpaceKey/...`，CRC32）
4. `POST /top/v1?Action=CommitImageUpload`（SessionKey）
5. `POST /alice/message/pre_handle_v2_without_conv`

**原因**：
- 这是网页端的真实链路，纯 HTTP 可复现，不需要 a_bogus
- 图片与文件共用同一条链路，只差 `resource_type` 与 SessionKey
- 上传成功后再发消息，附件与文本分属两个 `messages[]` 项，与网页端一致

**代价 / 限制**：
- 只上传当前用户消息的附件；历史附件以 `[图片]` / `[文件：…]` 占位，避免每轮重复上传
- 默认 20 MB / 10 个附件；可配置
- 远程 URL 附件会由插件下载后上传；默认拒绝内网 / localhost 地址，防止 SSRF
- 附件请求不回退 `/samantha`；失败直接报错

**放弃的方案**：
- 用 Playwright 在上传时驱动浏览器：太重，且违背“浏览器只用于登录”的架构
- 只支持 data URL、不支持远程 URL：会漏掉大量 OpenAI 客户端用法
- 回退时静默丢附件：语义错误，用户无法察觉

## D-12 思考块按 `content.thinking_block.think` 解析

**决策**：`block_type:10040` 是 `BLOCK_THINKING`，正文文本在 `content.thinking_block.think`；旧版无 `thinking_block` 的 10040 仍按分隔符兼容。

**原因**：
- 网页前端渲染读取的是 `content_obj.think`（即 `thinking_block.think`）
- 把 10040 当分隔符会在第二个流式思考分片上把状态翻回正文，且完全读不到思考文本
- `need_deep_think` / `ext.use_deep_think` 必须取菜单 `menu_type`（0/3/9/5/10001），不是 0/1

**代价**：需要同时兼容旧 delimiter 协议；用“10040 是否带 `thinking_block`”区分两条路径。

**补充（2026-10-25 真机）**：网页端 `cot_ui_style=summary` 时，`10040` 只带 `finish_title` / `streaming_title` 步骤标题，不带完整 `think`；插件把这些标题映射为 `reasoning_content`（`DOUBAO_THINKING_SUMMARY=1` 默认开启）。完整 `think` 存在时优先使用。

## D-13 每轮结束后自动删除会话

**决策**：在 `/chat/completion` 的 SSE 结束后，异步调用 `/im/conversation/batch_del_user_conv` 删除本轮 `ack_client_meta.conversation_id`；默认开启，`DOUBAO_AUTO_DELETE_CONVERSATION=0` 可关闭。

**请求**：
- `POST /im/conversation/batch_del_user_conv?<web params>`
- `Content-Type: application/json; encoding=utf-8`（少了 `encoding=utf-8` 会返回 `712012002 不支持编码类型`）
- `cmd:4171`，`uplink_body.batch_delete_user_conversation_uplink_body { conversation_id:[id], delete_all:false, conversation_type:3 }`

**原因**：
- 上游要求每轮创建会话；不删除会同步到豆包客户端
- 删除在响应结束后异步执行，不阻塞客户端
- 实测真实会话返回 `status_code:0`；空会话可能返回 `712010703 调用下游服务器失败`，因此对 712010703 与网络错误重试一次

**代价 / 限制**：
- 进程立即退出时后台删除可能丢失
- 旧 `/samantha` 回退没有 conversation_id，无法清理
- 删除失败只记录统计与警告，不影响对话内容；统计见 `/health` 的 `conversation_cleanup`

## D-8 错误三分法

**决策**：`auth` / `risk` / `upstream` 三类错误，分别映射 401 / 429 / 502。

**原因**：
- 登录失效需要用户重新扫码；风控需要人工验证；上游故障可以重试
- 三者混淆会导致客户端做错误重试（例如对 401 无限重试）

**代价**：需要维护错误码表；未知错误归入 upstream。

## D-9 没有 refresh token

**决策**：不实现 token 刷新；会话失效直接要求 `pnpm log-in`。

**原因**：豆包网页登录只下发会话 Cookie，没有 refresh token / 续期端点。

**代价**：长期运行时需要定期重新扫码；这是上游限制，不是插件缺陷。

## D-10 离线 mock E2E 覆盖语义，真实账号只做冒烟

**决策**：`pnpm test` 不访问真实豆包；真实账号验证用 `pnpm log-in` + `pnpm smoke -- --yes`。

**原因**：
- 真实账号测试消耗额度、受风控影响、不可重复
- mock 可以精确覆盖状态机、错误分支、SSE 边界
- 语义正确性（登录、thinking、finish_reason、错误映射）可以在离线环境完整验证

**代价**：上游协议变化只能通过真实冒烟发现；因此保留 `check-auth` 与 `smoke` 脚本。
