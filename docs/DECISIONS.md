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



## D-2 不生成 `a_bogus`，用 `/samantha` 回退

**决策**：`/chat/completion` 请求不带 `a_bogus`；失败时 `auto` 模式回退 `/samantha/chat/completion`。

**原因**：
- `a_bogus` 是字节风控签名，算法随版本变化，纯 JS 复现维护成本高
- 登录 Cookie + 完整设备参数在实测中可访问主端点；不是所有请求都需要签名
- `/samantha` 端点在社区实现中稳定可用，足以承载文本对话

**代价**：主端点被风控时延迟增加；两条链路都失败时只能等待验证 / 重新登录。

**放弃的方案**：内嵌 `a_bogus` 纯算实现 / 无头浏览器 hook。两者都会显著增加复杂度和被风控概率。

## D-3 无状态消息压平，不维护 conversation_id 映射

**决策**：把 OpenAI `messages` 压平成一条豆包用户消息，每次请求创建新会话。

**原因**：
- 插件是 HTTP 无状态服务；客户端（Claude Code / OpenAI SDK）每次都带完整 history
- 维护跨请求 conversation_id 需要进程内会话表、并发隔离、过期清理，且 Router 重启后丢失
- 压平后行为可预测，便于 E2E

**代价**：多轮对话的 token 效率略低；豆包侧不会保存对话历史。

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

## D-7 只支持文本，明确拒绝图片 / 文件

**决策**：`image_url` / 音频 / 文件输入返回 400；不实现 tools / function calling。

**原因**：
- 豆包图片 / 文件需要先上传到其对象存储，再以 `block_type=10052` 引用，链路复杂且易变
- 豆包网页端没有稳定的原生 tool_call 协议；伪造 tool_call 会污染 OpenAI 语义
- 明确失败优于静默丢弃

**代价**：Claude Code 等依赖 tool_use 的客户端无法通过本插件完成工具调用。

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
