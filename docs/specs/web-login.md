# Spec — 自包含网页登录

> 状态：已实现；离线 E2E 覆盖；真实账号冒烟见 README。
> 实现：`src/douyinLogin.ts`（默认）、`src/webLogin.ts`（备用）、`src/loginPage.ts`、`src/auth.ts`

## 1. 目标

在不依赖豆包电脑版、不读取任何 App 文件的前提下，让用户用本人账号完成网页登录，得到可用于 `www.doubao.com` 的会话 Cookie，并加密落盘。

默认形态是**用 Playwright 打开豆包登录 → 抖音官方授权页**：用户看到真正的抖音二维码 / 验证码登录页；换票由豆包官方页面完成，插件只提取会话 Cookie。

## 2. 默认：抖音 OAuth（Playwright）

### 2.1 浏览器流程

1. `playwright-core` 启动系统 Edge/Chrome（`DOUBAO_BROWSER_CHANNEL` 可指定；不下载额外 Chromium）
2. 打开 `https://www.doubao.com/chat/`
3. 自动点击「登录」→「抖音一键登录」→「同意」协议
4. 浏览器进入 `https://open.douyin.com/platform/oauth/connect?...` 官方授权页
5. 用户在页面上扫码，或选择「验证码授权」
6. 抖音回跳 `https://www.doubao.com/auth/callback?code=...&state=...`
7. 豆包官方页面自行完成 code 换票，写入 `sessionid` 等 Cookie
8. 插件从 `BrowserContext.cookies()` 提取 `doubao.com` Cookie，关闭浏览器
9. 用提取的 Cookie 尽力查 `/passport/account/info/v2/`，然后加密落盘

### 2.2 为什么不能用 localhost 回调

抖音对 `redirect_uri` 做白名单校验。实测 `http://127.0.0.1:19100/douyin/callback` 在扫码授权后提示：

> 非法重定向链接

即使把 `redirect_uri` 改回官方 callback 并截获 `code`，重放豆包 passport 的
`/passport/web/auth/bind_with_mobile_login/` 也会返回 `error_code:22「非法应用」`
（缺少官方页面的 CSRF / 设备上下文）。因此插件不在 Node 侧重放 code，而是让豆包官方页面完成换票，只提取 Cookie。

### 2.3 状态

```
idle
  └─ run() → 启动浏览器 → 等待抖音授权
        ├─ 检测到 sessionid / sid_tt / uid_tt → confirmed(done)
        ├─ 浏览器关闭 / 选择器失败 / 换票失败 → error(done)
        └─ 超时（默认 5 分钟）→ error(done)
```

### 2.4 逆向参考：官方 callback 的 code 换票（不由插件执行）

豆包 callback chunk 的实际逻辑是 `passportApi.authLoginAutoBindMobile({...}, 'aweme_v2')`：

```
POST /passport/web/auth/bind_with_mobile_login/
  code=<code>&platform_app_id=8949&platform=aweme_v2
→ Set-Cookie: sessionid / uid_tt / ...
（若返回 profile_key，再 POST /passport/web/auth/login/）
```

该链路依赖官方页面的 CSRF / 设备上下文；插件仅在测试中使用等价的 mock。

## 3. 备用：豆包扫码（`DOUBAO_LOGIN_FLOW=doubao`）

| 步骤 | 请求 | 关键参数 / 头 |
|---|---|---|
| 首页 | `GET {authBaseUrl}/` | `User-Agent`, `Referer: /chat/login` |
| CSRF | `GET {authBaseUrl}/passport/safe/csrf_token/?aid=497858` | 若首页已下发可跳过 |
| 二维码 | `GET {authBaseUrl}/passport/web/get_qrcode/?next=<baseUrl>&aid=497858` | `x-tt-passport-csrf-token` |
| 轮询 | `GET {authBaseUrl}/passport/web/check_qrconnect/?next=<baseUrl>&token=<token>&aid=497858` | `x-tt-passport-csrf-token` |
| 回跳 | `GET {redirect_url}` | 手动跟随，吸收每一跳 `Set-Cookie` |
| 账号 | `GET {baseUrl}/passport/account/info/v2/?<account params>` | 尽力；失败不阻断 |

状态机：`new → scanned → confirmed`；`expired` / `refused` / 连续 5 次错误可刷新；`done` 后幂等。
本机登录页 `GET /` 展示二维码，`/api/status` 轮询，`POST /api/refresh` 刷新，`GET /qr.png` 返回 PNG。

## 4. Cookie 与账号

- 成功以 `sessionid`（或 `sid_tt` / `uid_tt`）落地为准
- `uid` 优先取账号接口；其次 `uid_tt` / `uid_tt_ss`；都失败则留空，不阻断
- Cookie 记录包含 `domain` / `path` / `expiresAt` / `secure` / `hostOnly`
- 账号接口可能要求 `a_bogus`；失败只影响展示

## 5. 错误处理

| 现象 | 状态 | 可恢复 |
|---|---|---|
| 系统没有 Edge/Chrome / Playwright 启动失败 | error(done) | 安装浏览器或设 `DOUBAO_BROWSER_CHANNEL` |
| 豆包登录弹窗选择器失效 | error(done) | 更新选择器；或用 `DOUBAO_LOGIN_FLOW=doubao` |
| 用户关闭浏览器 / 拒绝授权 | error(done 或超时) | 重新 `pnpm log-in` |
| 等待 Cookie 超时 | error(done) | 重新 `pnpm log-in` |
| 登录后 Cookie 为空 | error(done) | 检查是否真的完成授权 |
| 豆包扫码二维码过期 / 拒绝 | expired / error | 页面刷新 |
| 账号接口失败 | 忽略 | — |

## 6. 安全要求

- 不打印 code / Cookie / state 明文
- Playwright 使用临时 BrowserContext，登录结束立即关闭，不保留 profile
- 凭证加密落盘；日志只输出 Cookie 名称 / 数量
- 不读取豆包电脑版任何文件
- 不把 OAuth code 或 Cookie 发回页面 / 第三方

## 7. 验收

- 离线 E2E：默认官方 redirect_uri、Playwright 截获 callback、code 换会话（mock）、state / 错误 / 超时、备用豆包扫码状态机
- 真实账号：`pnpm log-in` 打开豆包登录 → 抖音官方授权页 → 扫码/验证码 → `pnpm check-auth` 显示 `loggedIn=true` → `pnpm smoke -- --yes` 收到回复
- 仓库中无二维码图片 / Cookie 明文
