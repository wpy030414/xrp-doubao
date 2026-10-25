# Spec — 豆包网页扫码登录

> 状态：已实现；离线 E2E 覆盖；真实账号冒烟见 README。
> 实现：`src/webLogin.ts`、`src/loginPage.ts`、`src/auth.ts`

## 1. 目标

在不依赖豆包电脑版、不读取任何 App 文件的前提下，让用户用本人账号完成网页登录，得到可用于 `www.doubao.com` 的会话 Cookie，并加密落盘。

## 2. 端点与参数

| 步骤 | 请求 | 关键参数 / 头 |
|---|---|---|
| 首页 | `GET {authBaseUrl}/` | `User-Agent`, `Referer: /chat/login` |
| CSRF | `GET {authBaseUrl}/passport/safe/csrf_token/?aid=497858` | 若首页已下发 `passport_csrf_token` 可跳过 |
| 二维码 | `GET {authBaseUrl}/passport/web/get_qrcode/?next=<baseUrl>&aid=497858` | `x-tt-passport-csrf-token: <csrf>` |
| 轮询 | `GET {authBaseUrl}/passport/web/check_qrconnect/?next=<baseUrl>&token=<token>&aid=497858` | `x-tt-passport-csrf-token` |
| 回跳 | `GET {redirect_url}` | 手动跟随，吸收每一跳 `Set-Cookie` |
| 账号 | `GET {baseUrl}/passport/account/info/v2/?<account params>` | 尽力；失败不阻断 |

`authBaseUrl` 默认等于 `baseUrl`（`https://www.doubao.com`）。

## 3. 状态机

```
idle
  └─ begin() → new
        ├─ poll: new      → new
        ├─ poll: scanned  → scanned
        ├─ poll: confirmed→ [跟随回跳 + 账号] → confirmed(done)
        ├─ poll: expired  → expired（可 refresh）
        ├─ poll: refused  → error（可 refresh）
        └─ 连续 5 次网络/协议错误 → error（可 refresh）

refresh()：expired/error 后重新 begin() → new；不结束外层 waitForDone
waitForDone(timeout)：confirmed 或超时 → done；超时返回 error
```

- `expired` / 可恢复的 `error` 的 `done=false`，登录页显示“刷新二维码”，脚本继续等待
- `confirmed` 只在拿到至少一条 Cookie 后成立
- `done=true` 后 `pollOnce()` 幂等返回当前状态

## 4. 本机登录页

- 监听 `127.0.0.1:{DOUBAO_LOGIN_PORT}`；端口占用时改用随机端口
- `GET /`：内联 HTML，展示二维码 data URI、状态、账号、刷新按钮
- `GET /api/status`：触发一次 `pollOnce()` 并返回状态 JSON：
  ```json
  {"status":"new|scanned|confirmed|expired|error","message":"…","done":false,
   "uid":"…","nickname":"…","error":"…","hasQr":true,"expireAt":1792900000000}
  ```
- `POST /api/refresh`：申请新二维码并重启轮询
- `GET /qr.png`：返回二维码 PNG
- 页面不包含任何豆包凭证，也不把 Cookie 发回浏览器

## 5. Cookie 与账号

- 登录成功以 `sessionid`（或其它会话 Cookie）落地为准
- `uid` 优先取账号接口；其次 `uid_tt` / `uid_tt_ss`；都失败则留空，不阻断
- Cookie 记录包含 `domain` / `path` / `expiresAt` / `secure` / `hostOnly`
- 账号接口可能要求 `a_bogus`；失败只影响展示

## 6. 错误处理

| 现象 | 状态 | 可恢复 |
|---|---|---|
| `get_qrcode` 非 0 / 缺 token / 缺图片 | begin 抛错 | 重新 `pnpm log-in` |
| `check_qrconnect` 过期 / 拒绝 | expired / error | 页面刷新 |
| 连续 5 次网络 / 协议错误 | error | 页面刷新 |
| `confirmed` 但无 Cookie | error（done） | 重新登录 |
| 超时 | error（done） | 重新 `pnpm log-in` |
| 账号接口失败 | 忽略 | — |

## 7. 安全要求

- 不打印二维码 token / Cookie 值
- 二维码 PNG 仅写入临时文件（0600），登录结束删除
- 凭证加密落盘；日志只输出 Cookie 名称 / 数量
- 不读取豆包电脑版任何文件
- 不把登录页暴露到 0.0.0.0，只绑定 127.0.0.1

## 8. 验收

- 离线 E2E：`new → scanned → confirmed`、Cookie 落地、账号 uid、过期刷新、超时、登录页 API
- 真实账号：`pnpm log-in` 后 `pnpm check-auth` 显示 `loggedIn=true`；`pnpm smoke -- --yes` 收到回复
- 仓库中无二维码图片 / Cookie 明文
