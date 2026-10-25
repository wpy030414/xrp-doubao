/**
 * loginPage.ts — 登录期间由本机托管的极小网页。
 *
 * 页面只负责展示二维码、轮询本机状态、提供刷新按钮；
 * 真正的豆包登录请求全部由服务端完成，页面不接触任何凭证。
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { DoubaoWebLogin } from './webLogin';

export function createLoginPage(flow: DoubaoWebLogin): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const qr = flow.getQr();
    const qrTag = qr
      ? `<img class="qr" src="${qr.qrDataUrl}" alt="豆包登录二维码" />`
      : `<div class="qr placeholder">正在获取二维码…</div>`;
    return c.html(renderHtml(qrTag));
  });

  app.get('/api/status', async (c) => {
    const state = await flow.pollOnce();
    return c.json({
      ...state,
      hasQr: Boolean(flow.getQr()),
      expireAt: flow.getQr()?.expireAt,
    });
  });

  app.post('/api/refresh', async (c) => {
    try {
      await flow.refresh();
      flow.startPolling();
      return c.json({ ok: true, ...flow.getState() });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  app.get('/qr.png', (c) => {
    const qr = flow.getQr();
    if (!qr) return c.text('no qr', 404);
    return new Response(Buffer.from(qr.qrBase64, 'base64'), {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
        'Content-Disposition': 'inline; filename="doubao-login-qr.png"',
      },
    });
  });

  app.get('/favicon.ico', (c) => c.body(null, 204));
  return app;
}

export interface LoginServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * 启动登录页。端口被占用时自动改用随机端口（port=0）。
 */
export async function startLoginServer(flow: DoubaoWebLogin, port = 19100): Promise<LoginServer> {
  const app = createLoginPage(flow);
  try {
    return await listen(app, port);
  } catch (e: any) {
    if (port !== 0 && /EADDRINUSE|address already in use/i.test(String(e?.message || e))) {
      console.warn(`[doubao] 登录页端口 ${port} 被占用，改用随机端口`);
      return await listen(app, 0);
    }
    throw e;
  }
}

function listen(app: Hono, port: number): Promise<LoginServer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = serve(
      {
        fetch: app.fetch,
        port,
        hostname: '127.0.0.1',
      },
      (info) => {
        settled = true;
        const actual = info.port;
        resolve({
          url: `http://127.0.0.1:${actual}/`,
          port: actual,
          close: () =>
            new Promise<void>((done) => {
              server.close(() => done());
            }),
        });
      },
    );
    server.on('error', (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

function renderHtml(qrTag: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>豆包网页登录 · xrp-doubao</title>
<style>
  :root { color-scheme: dark; --bg:#0b0d12; --panel:#141821; --line:#242b38; --text:#eef2f8; --muted:#8e99ad; --accent:#3b82f6; --ok:#22c55e; --warn:#f59e0b; --bad:#ef4444; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:radial-gradient(1200px 700px at 50% -10%, #1a2333 0%, var(--bg) 60%); color:var(--text); font:14px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif; }
  main { width:min(440px, 92vw); background:linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,0)) var(--panel); border:1px solid var(--line); border-radius:18px; padding:28px; box-shadow:0 24px 80px rgba(0,0,0,.5); }
  h1 { font-size:20px; margin:0 0 4px; letter-spacing:.02em; }
  .sub { color:var(--muted); margin:0 0 20px; font-size:13px; }
  .qrbox { position:relative; display:flex; align-items:center; justify-content:center; background:#fff; border-radius:14px; padding:14px; min-height:240px; }
  .qr { width:212px; height:212px; display:block; image-rendering:pixelated; }
  .placeholder { color:#64748b; font-size:13px; }
  .status { display:flex; align-items:center; gap:9px; margin:18px 0 6px; font-weight:600; }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 4px rgba(59,130,246,.15); flex:none; }
  .dot.scanned { background:var(--warn); box-shadow:0 0 0 4px rgba(245,158,11,.15); }
  .dot.confirmed { background:var(--ok); box-shadow:0 0 0 4px rgba(34,197,94,.15); }
  .dot.expired, .dot.error { background:var(--bad); box-shadow:0 0 0 4px rgba(239,68,68,.15); }
  .hint { color:var(--muted); font-size:12.5px; min-height:20px; }
  .account { margin-top:10px; padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:rgba(255,255,255,.03); display:none; }
  .account b { color:var(--ok); }
  .row { display:flex; gap:10px; margin-top:18px; }
  button { flex:1; border:1px solid var(--line); background:#1c2330; color:var(--text); border-radius:10px; padding:10px 14px; font-size:13.5px; cursor:pointer; transition:.15s; }
  button:hover { border-color:#3a465c; background:#222b3b; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.primary:hover { filter:brightness(1.08); }
  footer { margin-top:18px; color:#6b768a; font-size:11.5px; line-height:1.5; }
  code { background:#0f141d; border:1px solid var(--line); border-radius:5px; padding:1px 5px; font-size:11.5px; }
</style>
</head>
<body>
<main>
  <h1>豆包网页登录</h1>
  <p class="sub">用手机端豆包 / 抖音扫码确认。本流程不读取豆包电脑版，也不依赖本机安装的任何豆包客户端。</p>
  <div class="qrbox" id="qrbox">${qrTag}</div>
  <div class="status"><span class="dot" id="dot"></span><span id="statusText">等待扫码</span></div>
  <div class="hint" id="hint">二维码约 2 分钟有效；过期后可刷新。</div>
  <div class="account" id="account"></div>
  <div class="row">
    <button id="refresh">刷新二维码</button>
    <button class="primary" id="close" disabled>登录完成</button>
  </div>
  <footer>
    凭证仅保存在本机，经 DPAPI / AES 加密；不会写入仓库，也不会回传任何第三方。
    登录接口：<code>www.doubao.com/passport</code>（同源代理到 accounts.doubao.com）。
  </footer>
</main>
<script>
(() => {
  const dot = document.getElementById('dot');
  const statusText = document.getElementById('statusText');
  const hint = document.getElementById('hint');
  const account = document.getElementById('account');
  const qrbox = document.getElementById('qrbox');
  const refreshBtn = document.getElementById('refresh');
  const closeBtn = document.getElementById('close');
  let finished = false;

  function render(s) {
    dot.className = 'dot ' + (s.status || '');
    statusText.textContent = s.message || s.status || '';
    if (s.status === 'confirmed') {
      finished = true;
      closeBtn.disabled = false;
      closeBtn.textContent = '登录完成';
      if (s.uid || s.nickname) {
        account.style.display = 'block';
        account.innerHTML = '<b>已登录</b>　' + escapeHtml(s.nickname || '') + (s.uid ? '　uid=' + escapeHtml(s.uid) : '');
      }
      hint.textContent = '会话已加密保存，可以关闭本页并运行 pnpm serve。';
      const img = qrbox.querySelector('img');
      if (img) img.style.opacity = '.25';
    } else if (s.status === 'expired' || s.status === 'error') {
      hint.textContent = s.error ? ('原因：' + s.error + '。请刷新二维码重试。') : (s.message || '请刷新二维码重试。');
    } else if (s.status === 'scanned') {
      hint.textContent = '已扫码，请在手机上点「确认登录」。';
    } else if (s.status === 'new') {
      hint.textContent = '等待扫码；二维码约 2 分钟有效。';
    }
  }
  function escapeHtml(v) {
    return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  async function tick() {
    if (finished) return;
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      const s = await res.json();
      render(s);
    } catch (e) {
      hint.textContent = '本机服务连接中断，请重试。';
    }
    setTimeout(tick, 1000);
  }
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    hint.textContent = '正在刷新二维码…';
    try { await fetch('/api/refresh', { method: 'POST' }); location.reload(); }
    catch (e) { hint.textContent = '刷新失败，请重试。'; refreshBtn.disabled = false; }
  });
  closeBtn.addEventListener('click', () => window.close());
  tick();
})();
</script>
</body>
</html>`;
}
