import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startMockDoubao, type MockDoubao } from './helpers/mockDoubao';

let mock: MockDoubao;
let tmpDir: string;
let mods: any;

const DEVICE = {
  deviceId: '7000000000000000001',
  webId: '7000000000000000002',
  fp: 'verify_tests_abcd_efgh_ijkl_mnopqrstuvwx',
};

before(async () => {
  mock = await startMockDoubao();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-doubao-test-'));
  process.env.DOUBAO_BASE_URL = mock.url;
  process.env.DOUBAO_AUTH_BASE_URL = mock.url;
  process.env.DOUBAO_CREDENTIAL_PATH = path.join(tmpDir, 'credential.json');
  process.env.DOUBAO_STORE_MODE = 'plain';
  process.env.DOUBAO_LOGIN_POLL_MS = '30';
  process.env.DOUBAO_LOGIN_TIMEOUT_MS = '3000';
  process.env.DOUBAO_PORT = '0';
  process.env.DOUBAO_AUTO_LOGIN = '0';
  process.env.DOUBAO_CHAT_MODE = 'auto';
  process.env.DOUBAO_DEVICE_ID = DEVICE.deviceId;
  process.env.DOUBAO_WEB_ID = DEVICE.webId;
  process.env.DOUBAO_FP = DEVICE.fp;
  process.env.DOUBAO_DEBUG = '0';
  process.env.XRL_ROUTER_URL = 'http://127.0.0.1:1';

  mods = {
    webLogin: await import('../src/webLogin'),
    douyinLogin: await import('../src/douyinLogin'),
    loginPage: await import('../src/loginPage'),
    auth: await import('../src/auth'),
    client: await import('../src/doubaoClient'),
    server: await import('../src/server'),
    plugin: await import('../src/pluginClient'),
    store: await import('../src/credentialStore'),
    cookie: await import('../src/cookieJar'),
    messages: await import('../src/messages'),
    sse: await import('../src/sse'),
    config: await import('../src/config'),
  };
});

after(async () => {
  if (mock) await mock.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedSession() {
  const state = mods.auth.makeState({
    cookieHeader: 'sessionid=mock-session; passport_csrf_token=mock-csrf; ttwid=mock-ttwid',
    uid: '12345',
    nickname: '测试用户',
    device: DEVICE,
    source: 'store',
    baseUrl: mock.url,
  });
  mods.auth.writeStore(state);
  mods.auth.adoptCredential(state);
  return state;
}

function makeFlow(opts: any = {}) {
  return new mods.webLogin.DoubaoWebLogin({
    baseUrl: mock.url,
    authBaseUrl: mock.url,
    aid: '497858',
    device: DEVICE,
    pollIntervalMs: 10,
    timeoutMs: 3000,
    ...opts,
  });
}

async function collectChunks(client: any, request: any) {
  const chunks: any[] = [];
  let mode = '';
  for await (const d of client.chat({ ...request, onMode: (m: string) => { mode = m; } })) {
    chunks.push(d);
  }
  return { chunks, mode };
}

test('CookieJar：域 / 路径 / 过期 / 序列化', () => {
  const { CookieJar } = mods.cookie;
  const jar = new CookieJar();
  jar.setCookie('a=1; Path=/', 'https://www.doubao.com/chat/');
  jar.setCookie('b=2; Path=/x', 'https://www.doubao.com/x/y');
  assert.equal(jar.get('a'), '1');
  assert.match(jar.getCookieHeader('https://www.doubao.com/x/y'), /a=1/);
  assert.match(jar.getCookieHeader('https://www.doubao.com/x/y'), /b=2/);
  assert.doesNotMatch(jar.getCookieHeader('https://www.doubao.com/y'), /b=2/);
  assert.equal(jar.getCookieHeader('http://www.doubao.com/'), 'a=1');

  jar.setCookie('secure=1; Path=/; Secure', 'https://www.doubao.com/');
  assert.doesNotMatch(jar.getCookieHeader('http://www.doubao.com/'), /secure=1/);
  assert.match(jar.getCookieHeader('https://www.doubao.com/'), /secure=1/);

  jar.setCookie('a=; Path=/; Max-Age=0', 'https://www.doubao.com/');
  assert.equal(jar.get('a'), undefined);

  const seeded = new CookieJar();
  seeded.seedCookieHeader('x=1; y=2');
  assert.equal(seeded.get('x'), '1');
  const copy = CookieJar.fromJSON(seeded.toJSON());
  assert.equal(copy.get('y'), '2');
  assert.ok(seeded.describe().every((c: any) => c.length > 0));
});

test('credentialStore：AES / plain 往返与删除', () => {
  const { seal, open, describeKind, deleteBlob } = mods.store;
  const aesFile = path.join(tmpDir, 'aes.bin');
  const opts = { file: aesFile, mode: 'aes', secret: 'test-secret' };
  const sealed = seal(opts, { hello: '世界' });
  assert.equal(sealed.kind, 'aes');
  assert.match(sealed.blob, /^aes:v1:/);
  assert.deepEqual(open(opts, sealed.blob), { hello: '世界' });
  assert.equal(describeKind(sealed.blob), 'aes');

  const plainOpts = { file: path.join(tmpDir, 'plain.bin'), mode: 'plain' as const };
  const plain = seal(plainOpts, { a: 1 });
  assert.equal(plain.kind, 'plain');
  assert.deepEqual(open(plainOpts, plain.blob), { a: 1 });
  assert.equal(deleteBlob(path.join(tmpDir, 'does-not-exist.bin')), false);
});

test('登录 E2E：二维码 → 扫码 → 确认 → Cookie → 账号', async () => {
  mock.reset();
  const flow = makeFlow();
  const qr = await flow.begin();
  assert.equal(qr.token, 'mock-qr-token');
  assert.match(qr.qrDataUrl, /^data:image\/png;base64,/);
  assert.ok(qr.qrBase64.length > 10);

  const s1 = await flow.pollOnce();
  assert.equal(s1.status, 'new');
  assert.equal(s1.done, false);
  const s2 = await flow.pollOnce();
  assert.equal(s2.status, 'scanned');
  const s3 = await flow.pollOnce();
  assert.equal(s3.status, 'confirmed');
  assert.equal(s3.done, true);
  assert.equal(s3.uid, '12345');
  assert.equal(s3.nickname, '测试用户');

  const session = flow.getSession();
  assert.ok(session);
  const jar = mods.cookie.CookieJar.fromJSON(session!.cookies);
  assert.equal(jar.get('sessionid'), 'mock-session');
  assert.equal(jar.get('ttwid'), 'mock-ttwid');
  assert.ok(jar.names().includes('passport_csrf_token'));

  // 已完成后重复轮询是幂等的
  const s4 = await flow.pollOnce();
  assert.equal(s4.status, 'confirmed');
  assert.equal(s4.done, true);
});

test('登录页：二维码 / 状态轮询 / 刷新', async () => {
  mock.reset();
  const flow = makeFlow();
  await flow.begin();
  const { startLoginServer } = await import('../src/loginPage');
  const page = await startLoginServer(flow, 0);
  try {
    const html = await (await fetch(page.url)).text();
    assert.match(html, /豆包网页登录/);
    assert.match(html, /data:image\/png;base64,/);
    assert.match(html, /等待扫码/);

    const img = await fetch(page.url + 'qr.png');
    assert.equal(img.status, 200);
    assert.match(img.headers.get('content-type') || '', /image\/png/);

    let status = await (await fetch(page.url + 'api/status')).json();
    assert.equal(status.status, 'new');
    status = await (await fetch(page.url + 'api/status')).json();
    assert.equal(status.status, 'scanned');
    status = await (await fetch(page.url + 'api/status')).json();
    assert.equal(status.status, 'confirmed');
    assert.equal(status.uid, '12345');

    mock.reset();
    const refreshed = await (await fetch(page.url + 'api/refresh', { method: 'POST' })).json();
    assert.equal(refreshed.ok, true);
    assert.equal(flow.getQr()?.token, 'mock-qr-token');
  } finally {
    flow.stopPolling();
    await page.close();
  }
});

test('登录页：二维码过期可刷新，不误判登录完成', async () => {
  mock.reset();
  mock.state.qrMode = 'expired';
  const flow = makeFlow();
  await flow.begin();
  const expired = await flow.pollOnce();
  assert.equal(expired.status, 'expired');
  assert.equal(expired.done, false);

  mock.state.qrMode = 'normal';
  mock.state.qrPolls = 0;
  await flow.refresh();
  assert.equal(flow.getState().status, 'new');
  assert.equal((await flow.pollOnce()).status, 'new');
  assert.equal((await flow.pollOnce()).status, 'scanned');
  assert.equal((await flow.pollOnce()).status, 'confirmed');
});

test('登录超时：waitForDone 返回 error 而不是永久挂起', async () => {
  mock.reset();
  mock.state.qrMode = 'alwaysNew';
  const flow = makeFlow({ timeoutMs: 120 });
  await flow.begin();
  try {
    const state = await flow.waitForDone(120);
    assert.equal(state.done, true);
    assert.equal(state.status, 'error');
  } finally {
    flow.stopPolling();
  }
});

test('抖音 OAuth：默认 redirect_uri 使用豆包官方 callback（不能用 localhost）', async () => {
  const flow = new mods.douyinLogin.DouyinOAuthLogin({
    baseUrl: mock.url,
    oauthBaseUrl: 'https://open.douyin.com',
    clientKey: 'aw4293rjg7ggbx9m',
    device: DEVICE,
    aid: '497858',
  });
  const url = await flow.begin();
  assert.ok(url.includes(`redirect_uri=${encodeURIComponent('https://www.doubao.com/auth/callback')}`));
  assert.ok(!url.includes('127.0.0.1'));
  assert.equal(flow.getRedirectUri(), 'https://www.doubao.com/auth/callback');
});

test('抖音 OAuth：Playwright 打开授权页并截获官方 callback', async (t) => {
  mock.reset();
  const oauthServer = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (u.pathname === '/platform/oauth/connect') {
      const state = u.searchParams.get('state') || '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<html><body><script>location.href='/auth/callback?code=mock-douyin-code&state='+encodeURIComponent(${JSON.stringify(state)})</script></body></html>`,
      );
      return;
    }
    res.writeHead(404);
    res.end('callback should be intercepted');
  });
  await new Promise<void>((resolve) => oauthServer.listen(0, '127.0.0.1', () => resolve()));
  const port = (oauthServer.address() as any).port as number;
  const oauthBase = `http://127.0.0.1:${port}`;
  const flow = new mods.douyinLogin.DouyinOAuthLogin({
    baseUrl: mock.url,
    oauthBaseUrl: oauthBase,
    clientKey: 'aw4293rjg7ggbx9m',
    redirectUri: `${oauthBase}/auth/callback`,
    device: DEVICE,
    aid: '497858',
    timeoutMs: 8000,
    headless: true,
  });
  try {
    const url = await flow.begin();
    assert.ok(url.startsWith(`${oauthBase}/platform/oauth/connect?`));
    const captured = await flow.captureCode(8000);
    const state = await flow.handleCallback(captured.code, captured.state);
    assert.equal(state.status, 'confirmed');
    assert.equal(state.uid, '12345');
    assert.ok(flow.getSession()?.cookies.some((c: any) => c.name === 'sessionid'));
  } catch (e: any) {
    if (/无法启动浏览器|browserType\.launch/.test(e.message)) {
      t.skip(`系统浏览器不可用：${e.message}`);
      return;
    }
    throw e;
  } finally {
    await new Promise<void>((resolve) => oauthServer.close(() => resolve()));
  }
});

test('抖音 OAuth：官方授权 URL + 本地回调 + code 换会话', async () => {
  mock.reset();
  const flow = new mods.douyinLogin.DouyinOAuthLogin({
    baseUrl: mock.url,
    oauthBaseUrl: 'https://open.douyin.com',
    clientKey: 'aw4293rjg7ggbx9m',
    device: DEVICE,
    aid: '497858',
    timeoutMs: 1000,
  });
  const server = await mods.loginPage.startDouyinLoginServer(flow, 0);
  try {
    const oauthUrl = await flow.begin();
    assert.match(oauthUrl, /^https:\/\/open\.douyin\.com\/platform\/oauth\/connect\?/);
    assert.match(oauthUrl, /client_key=aw4293rjg7ggbx9m/);
    const redirect = encodeURIComponent(`http://127.0.0.1:${server.port}/douyin/callback`);
    assert.ok(oauthUrl.includes(`redirect_uri=${redirect}`));
    assert.match(oauthUrl, /state=/);

    const waiting = flow.waitForCallback(1000);
    const state = await flow.handleCallback('mock-douyin-code', flow.getStateToken());
    assert.equal(state.status, 'confirmed');
    assert.equal(state.uid, '12345');
    assert.equal(state.nickname, '测试用户');
    assert.equal((await waiting).status, 'confirmed');
    const session = flow.getSession();
    assert.ok(session);
    assert.ok(session!.cookies.some((c: any) => c.name === 'sessionid' && c.value === 'mock-session'));
    assert.ok(mock.state.loginRequests.includes('bind:mock-douyin-code'));
  } finally {
    await server.close();
  }
});

test('抖音 OAuth：本地 /douyin/callback 页面完成登录', async () => {
  mock.reset();
  const flow = new mods.douyinLogin.DouyinOAuthLogin({
    baseUrl: mock.url,
    oauthBaseUrl: 'https://open.douyin.com',
    device: DEVICE,
    aid: '497858',
    timeoutMs: 1000,
  });
  const server = await mods.loginPage.startDouyinLoginServer(flow, 0);
  try {
    await flow.begin();
    const cb = await fetch(
      `${server.url}douyin/callback?code=mock-douyin-code&state=${encodeURIComponent(flow.getStateToken())}`,
    );
    assert.equal(cb.status, 200);
    const html = await cb.text();
    assert.match(html, /抖音授权完成/);
    assert.match(html, /12345/);
    assert.equal(flow.getState().status, 'confirmed');
  } finally {
    await server.close();
  }
});

test('抖音 OAuth：state 不匹配 / 非法 code / profile_key 回退 / 超时', async () => {
  mock.reset();
  const make = () =>
    new mods.douyinLogin.DouyinOAuthLogin({
      baseUrl: mock.url,
      oauthBaseUrl: 'https://open.douyin.com',
      device: DEVICE,
      aid: '497858',
      timeoutMs: 1000,
    });

  const flow1 = make();
  const s1 = await flow1.handleCallback('mock-douyin-code', 'wrong-state');
  assert.equal(s1.status, 'error');
  assert.equal(s1.done, true);

  const flow2 = make();
  const server2 = await mods.loginPage.startDouyinLoginServer(flow2, 0);
  try {
    await flow2.begin();
    const s2 = await flow2.handleCallback('bad-code', flow2.getStateToken());
    assert.equal(s2.status, 'error');
    assert.match(s2.message, /非法应用/);
  } finally {
    await server2.close();
  }

  mock.reset();
  const flow3 = make();
  const server3 = await mods.loginPage.startDouyinLoginServer(flow3, 0);
  try {
    await flow3.begin();
    const s3 = await flow3.handleCallback('mock-douyin-needs-profile', flow3.getStateToken());
    assert.equal(s3.status, 'confirmed');
    assert.ok(mock.state.loginRequests.includes('login:mock-profile-key'));
    assert.equal(flow3.getSession()?.cookies.some((c: any) => c.name === 'sessionid'), true);
  } finally {
    await server3.close();
  }

  const flow4 = make();
  const s4 = await flow4.waitForCallback(50);
  assert.equal(s4.status, 'error');
  assert.equal(s4.done, true);
});

test('认证状态：写入 / 读取 / 账号信息 / 强制重登提示', async () => {
  mock.reset();
  const state = seedSession();
  const got = await mods.auth.getSession();
  assert.equal(got.uid, '12345');
  const status = mods.auth.getAuthStatus();
  assert.equal(status.loggedIn, true);
  assert.equal(status.uid, '12345');
  assert.ok(status.cookieNames.includes('sessionid'));

  const account = await mods.auth.fetchAccountInfo(state);
  assert.equal(account?.uid, '12345');

  await assert.rejects(() => mods.auth.forceRelogin('测试失效'), /pnpm log-in/);
});

test('对话 E2E：流式文本 + thinking + usage + 模型映射', async () => {
  mock.reset();
  const state = seedSession();
  const client = new mods.client.DoubaoClient(state);
  const { chunks, mode } = await collectChunks(client, {
    model: 'doubao-expert',
    reasoningEffort: 'high',
    messages: [
      { role: 'system', content: '你是测试助手。' },
      { role: 'user', content: '第一轮' },
      { role: 'assistant', content: '第一轮回答' },
      { role: 'user', content: '第二轮' },
    ],
  });
  assert.equal(mode, 'web');
  const reasoning = chunks.map((c: any) => c.reasoning || '').join('');
  const text = chunks.map((c: any) => c.text || '').join('');
  assert.equal(reasoning, '思考中');
  assert.equal(text, '你好，世界');
  const usage = chunks.find((c: any) => c.usage)?.usage;
  assert.equal(usage.total_tokens, 7);

  assert.equal(mock.state.chatRequests.length, 1);
  const req = mock.state.chatRequests[0];
  assert.match(req.cookie, /sessionid=mock-session/);
  assert.match(req.url, /aid=497858/);
  assert.match(req.url, /device_id=7000000000000000001/);
  assert.equal(req.body.option.model_config.model_item_key, '3');
  assert.equal(req.body.option.model_config.reasoning_effort, 5);
  assert.equal(req.body.option.need_deep_think, 1);
  const prompt = req.body.messages[0].content_block[0].content.text_block.text;
  assert.match(prompt, /系统指令/);
  assert.match(prompt, /用户：第一轮/);
  assert.match(prompt, /助手：第一轮回答/);
  assert.match(prompt, /用户：第二轮/);
  assert.match(prompt, /请针对最后一条用户消息作答/);
});

test('对话回退：/chat/completion 404 → /samantha/chat/completion', async () => {
  mock.reset();
  mock.state.chatBehavior = 'legacyOnly';
  const state = seedSession();
  const client = new mods.client.DoubaoClient(state);
  const { chunks, mode } = await collectChunks(client, {
    model: 'doubao-fast',
    messages: [{ role: 'user', content: '你好' }],
  });
  assert.equal(mode, 'legacy');
  const text = chunks.map((c: any) => c.text || '').join('');
  const reasoning = chunks.map((c: any) => c.reasoning || '').join('');
  assert.equal(text, '回退回答');
  assert.equal(reasoning, '先想一下');
  assert.equal(mock.state.chatRequests.length, 1);
  assert.equal(mock.state.legacyRequests.length, 1);
  assert.match(mock.state.legacyRequests[0].url, /aid=582478/);
});

test('对话回退：主端点返回 JSON 错误（非 SSE）→ 回退', async () => {
  mock.reset();
  mock.state.chatBehavior = 'nonSSE';
  const state = seedSession();
  const client = new mods.client.DoubaoClient(state);
  const { chunks, mode } = await collectChunks(client, {
    model: 'doubao-fast',
    messages: [{ role: 'user', content: '你好' }],
  });
  assert.equal(mode, 'legacy');
  assert.equal(chunks.map((c: any) => c.text || '').join(''), '回退回答');
});

test('错误分类：风控 / 登录失效', async () => {
  mock.reset();
  mock.state.chatBehavior = 'risk';
  const state = seedSession();
  const client = new mods.client.DoubaoClient(state);
  await assert.rejects(
    () => collectChunks(client, { model: 'doubao-fast', messages: [{ role: 'user', content: 'hi' }] }),
    (e: any) => e.kind === 'risk' && e.needsCaptcha === true,
  );
  assert.equal(mods.client.getNeedsCaptcha(), true);
  mods.client.resetCaptcha();
  assert.equal(mods.client.getNeedsCaptcha(), false);

  mock.reset();
  mock.state.chatBehavior = 'auth';
  await assert.rejects(
    () => collectChunks(client, { model: 'doubao-fast', messages: [{ role: 'user', content: 'hi' }] }),
    (e: any) => e.kind === 'auth',
  );
});

test('OpenAI HTTP E2E：非流式 / 流式 / 错误映射 / 健康检查', async () => {
  mock.reset();
  seedSession();
  const started = await mods.server.startServer({ port: 0, connectRouter: false });
  const base = `http://127.0.0.1:${started.port}`;
  try {
    const health = await (await fetch(base + '/health')).json();
    assert.equal(health.status, 'healthy');
    assert.equal(health.backend, 'doubao');
    assert.equal(health.auth.loggedIn, true);
    assert.ok(health.models.includes('doubao-fast'));

    const nonStream = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'doubao-fast',
        messages: [{ role: 'user', content: '你好' }],
      }),
    });
    assert.equal(nonStream.status, 200);
    const json: any = await nonStream.json();
    assert.equal(json.object, 'chat.completion');
    assert.equal(json.choices[0].message.content, '你好，世界');
    assert.equal(json.choices[0].message.reasoning_content, '思考中');
    assert.equal(json.choices[0].finish_reason, 'stop');
    assert.equal(json.usage.total_tokens, 7);

    const stream = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'doubao-fast',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: '你好' }],
      }),
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type') || '', /text\/event-stream/);
    const raw = await stream.text();
    assert.doesNotMatch(raw, /"finish_reason":""/);
    assert.doesNotMatch(raw, /"tool_calls":\[\]/);
    assert.match(raw, /"reasoning_content":"思考中"/);
    assert.match(raw, /"content":"你好"/);
    assert.match(raw, /"content":"，世界"/);
    assert.match(raw, /"finish_reason":"stop"/);
    assert.match(raw, /"usage":\{"prompt_tokens":3/);
    assert.match(raw, /data: \[DONE\]/);
    const chunks = raw
      .split('\n')
      .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
      .map((l) => JSON.parse(l.slice(6)));
    const contentChunks = chunks.filter((c) => c.choices?.[0]?.delta?.content);
    assert.ok(contentChunks.length >= 2);
    assert.ok(contentChunks.every((c) => c.choices[0].finish_reason === null));
    const usageChunk = chunks.find((c) => Array.isArray(c.choices) && c.choices.length === 0);
    assert.equal(usageChunk.usage.total_tokens, 7);

    // 风控 → 429 + needs_captcha
    mock.state.chatBehavior = 'risk';
    const risk = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'doubao-fast', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(risk.status, 429);
    const riskJson: any = await risk.json();
    assert.equal(riskJson.error.type, 'rate_limit_error');
    assert.equal(riskJson.error.needs_captcha, true);
    const health2 = await (await fetch(base + '/health')).json();
    assert.equal(health2.needs_captcha, true);
    await fetch(base + '/admin/reset-captcha', { method: 'POST' });
    const health3 = await (await fetch(base + '/health')).json();
    assert.equal(health3.needs_captcha, false);

    // 登录失效 → 401
    mock.state.chatBehavior = 'auth';
    const auth = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'doubao-fast', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(auth.status, 401);
    const authJson: any = await auth.json();
    assert.equal(authJson.error.type, 'authentication_error');

    // 输入校验
    const bad = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'doubao-fast', messages: [] }),
    });
    assert.equal(bad.status, 400);

    const img = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'doubao-fast',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x' } }] }],
      }),
    });
    assert.equal(img.status, 400);
    const imgJson: any = await img.json();
    assert.match(imgJson.error.message, /只支持文本/);
  } finally {
    await started.close();
  }
});

test('插件注册载荷：V24 无 keys，display_name 唯一', () => {
  const payload = mods.plugin.buildRegisterPayload();
  assert.equal(payload.type, 'register');
  assert.equal(payload.plugin_id, 'plugin-doubao');
  assert.equal(payload.provider.kind, 'chat_completions');
  assert.equal(payload.keys, undefined);
  assert.equal(payload.provider.keys, undefined);
  assert.ok(payload.models.some((m: any) => m.display_name === 'doubao-fast'));
  assert.ok(payload.models.some((m: any) => m.display_name === 'doubao'));
  assert.ok(payload.models.every((m: any) => m.model_id === m.display_name));
  assert.ok(payload.base_url === undefined);
  assert.match(payload.provider.base_url, /^http:\/\/localhost:/);
});

test('消息压平：单轮 / system / 多轮 / 图片拒绝', () => {
  const { flattenMessages, UnsupportedMessageError } = mods.messages;
  assert.equal(flattenMessages([{ role: 'user', content: 'hi' }]).prompt, 'hi');
  assert.equal(
    flattenMessages([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]).prompt,
    'sys\n\nhi',
  );
  const multi = flattenMessages([
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
  ]).prompt;
  assert.match(multi, /用户：u1/);
  assert.match(multi, /助手：a1/);
  assert.match(multi, /用户：u2/);
  assert.throws(
    () => flattenMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }]),
    UnsupportedMessageError,
  );
  assert.throws(() => flattenMessages([]), UnsupportedMessageError);
});

test('SSE 解析：注释 / event / 多行 data / 尾事件', async () => {
  const { iterateSse } = mods.sse;
  const raw =
    ': heartbeat\n\n' +
    'event: message\n' +
    'data: hello\n' +
    'data: world\n\n' +
    'data: [DONE]\n\n';
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(raw.slice(0, 20)));
      controller.enqueue(enc.encode(raw.slice(20)));
      controller.close();
    },
  });
  const events: any[] = [];
  for await (const ev of iterateSse(stream)) events.push(ev);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'message');
  assert.equal(events[0].data, 'hello\nworld');
  assert.equal(events[1].data, '[DONE]');
});
