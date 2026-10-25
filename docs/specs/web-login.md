# Spec — 自包含网页登录

> 状态：已实现；离线 E2E 覆盖；真实账号冒烟见 README。
> 实现：`src/douyinLogin.ts`（默认）、`src/webLogin.ts`（备用）、`src/loginPage.ts`、`src/auth.ts`

## 1. 目标

在不依赖豆包电脑版、不读取任何 App 文件的前提下，让用户用本人账号完成网页登录，得到可用于 `www.doubao.com` 的会话 Cookie，并加密落盘。

默认形态是**直接打开抖音官方 OAuth 授权页**：用户看到的是真正的抖音授权二维码 / 验证码登录页，本机只接收回调。

## 2. 默认：抖音 OAuth

### 2.1 授权 URL

```
https://open.douyin.com/platform/oauth/connect
  ?client_key=aw4293rjg7ggbx9m
  &client_id=aw4293rjg7ggbx9m
  &redirect_uri=http%3A%2F%2F127.0.0.1%3A<port>%2Fdouyin%2Fcallback
  &response_type=code
  &scope=user_info%2Cmobile
  &optionalScope=mobile%2C1
  &state=<base64(JSON)>
```

`state` 包含 `platform:"aweme_v2"`、`type:"login"`、`navigatePath`、`timestamp`、`csrfToken`。插件生成并在回调时严格比对。

### 2.2 页面与回调

- 浏览器打开上述 URL；页面由抖音托管，展示 `aweme://authorizedy?...` 二维码，也提供短信验证码授权
- 抖音授权完成后回跳 `http://127.0.0.1:<port>/douyin/callback?code=...&state=...`
- 本地服务器只在 `127.0.0.1` 监听；`GET /` 显示“打开抖音授权页”，`GET /douyin/callback` 处理结果，`GET /api/status` 返回状态
- state 不匹配、缺少 code、用户拒绝授权 → 失败页 + 终端错误

### 2.3 code 换豆包会话

1. `GET https://www.doubao.com/passport/safe/csrf_token/?aid=497858` 取 CSRF
2. `POST /passport/web/auth/bind_with_mobile_login/`（form）：
   ```
   code=<code>&platform_app_id=8949&platform=aweme_v2
   ```
   并带 `x-tt-passport-csrf-token` 与完整 passport query 参数
3. 若响应含 `profile_key`：`POST /passport/web/auth/login/`：
   ```
   profile_key=<profile_key>&platform_app_id=8949
   ```
4. 若仍无会话 Cookie：尝试 `POST /passport/web/auth/get_oauth_token/`，并用 `/passport/account/info/v2/` 复核
5. 成功以 `sessionid` / `sid_tt` / `uid_tt` 等 Cookie 落地为准；账号信息失败不阻断

### 2.4 状态

```
idle → new（等待抖音授权）
  ├─ 回调 code + state 匹配 → scanned（换票中）→ confirmed(done)
  ├─ 回调 error / state 不匹配 / 换票失败 → error(done)
  └─ 超时（默认 5 分钟）→ error(done)
```

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
| 抖音回调缺 code / state 不匹配 | error(done) | 重新 `pnpm log-in` |
| 用户拒绝授权 | error(done) | 重新 `pnpm log-in` |
| `bind_with_mobile_login` 返回 `profile_key` | 自动走 `/auth/login/` | — |
| 换票返回“非法应用”等 | error(done) | 检查 code / 重新授权 |
| 超时 | error(done) | 重新 `pnpm log-in` |
| 豆包扫码二维码过期 / 拒绝 | expired / error | 页面刷新 |
| 账号接口失败 | 忽略 | — |

## 6. 安全要求

- 不打印 code / Cookie / state 明文
- 本地服务器只绑定 `127.0.0.1`
- 回调 state 必须与本次登录一致
- 凭证加密落盘；日志只输出 Cookie 名称 / 数量
- 不读取豆包电脑版任何文件
- 不把 OAuth code 或 Cookie 发回浏览器页面

## 7. 验收

- 离线 E2E：抖音 OAuth URL、state 校验、本地回调、code 换会话、profile_key 回退、超时、失败分支；备用豆包扫码状态机
- 真实账号：`pnpm log-in` 打开抖音官方授权页 → 扫码/验证码 → `pnpm check-auth` 显示 `loggedIn=true` → `pnpm smoke -- --yes` 收到回复
- 仓库中无二维码图片 / Cookie 明文
