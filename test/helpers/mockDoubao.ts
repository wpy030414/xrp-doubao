/**
 * mockDoubao.ts — 离线 E2E 用的豆包网关替身。
 *
 * 覆盖：网页登录（首页 / CSRF / 二维码 / 轮询 / 回跳 / 账号）、
 * /chat/completion 与 /samantha/chat/completion 的正常与错误分支。
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';

export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=';

export type ChatBehavior = 'ok' | 'risk' | 'auth' | 'legacyOnly' | 'nonSSE' | 'http401';
export type QrMode = 'normal' | 'expired' | 'refused' | 'alwaysNew';

export interface MockState {
  qrPolls: number;
  qrMode: QrMode;
  chatBehavior: ChatBehavior;
  accountValid: boolean;
  chatRequests: Array<{ url: string; cookie: string; body: any }>;
  legacyRequests: Array<{ url: string; cookie: string; body: any }>;
  loginRequests: string[];
}

export interface MockDoubao {
  url: string;
  port: number;
  state: MockState;
  close: () => Promise<void>;
  reset: () => void;
}

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) controller.enqueue(encoder.encode(ev));
      controller.close();
    },
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export async function startMockDoubao(): Promise<MockDoubao> {
  const state: MockState = {
    qrPolls: 0,
    qrMode: 'normal',
    chatBehavior: 'ok',
    accountValid: true,
    chatRequests: [],
    legacyRequests: [],
    loginRequests: [],
  };
  const reset = () => {
    state.qrPolls = 0;
    state.qrMode = 'normal';
    state.chatBehavior = 'ok';
    state.accountValid = true;
    state.chatRequests = [];
    state.legacyRequests = [];
    state.loginRequests = [];
  };

  const app = new Hono();

  app.get('/', (c) => {
    state.loginRequests.push('home');
    const res = c.redirect('/chat/');
    // Hono 的 redirect 不便追加多个 Set-Cookie，这里用 header 直接设置
    res.headers.append('Set-Cookie', 'ttwid=mock-ttwid; Path=/; HttpOnly');
    return res;
  });
  app.get('/chat/', (c) => c.html('<html><body>mock chat</body></html>'));

  app.get('/passport/safe/csrf_token/', (c) => {
    state.loginRequests.push('csrf');
    return json(
      { data: { passport_csrf_token: 'mock-csrf' }, message: 'success' },
      200,
      { 'Set-Cookie': 'passport_csrf_token=mock-csrf; Path=/' },
    );
  });

  app.get('/passport/web/get_qrcode/', (c) => {
    state.loginRequests.push('qrcode');
    if (c.req.query('aid') !== '497858') {
      return json({ data: { error_code: 1, description: 'bad aid' }, message: 'error' });
    }
    return json({
      data: {
        error_code: 0,
        token: 'mock-qr-token',
        qrcode: `data:image/png;base64,${TINY_PNG_BASE64}`,
        expire_time: Math.floor(Date.now() / 1000) + 120,
      },
      message: 'success',
    });
  });

  app.get('/passport/web/check_qrconnect/', (c) => {
    state.loginRequests.push('check');
    if (state.qrMode === 'expired') {
      return json({
        data: { error_code: 0, status: 'expired', description: '二维码已过期' },
        message: 'success',
      });
    }
    if (state.qrMode === 'refused') {
      return json({
        data: { error_code: 0, status: 'refused', description: 'refused' },
        message: 'success',
      });
    }
    if (state.qrMode === 'alwaysNew') {
      return json({ data: { error_code: 0, status: 'new' }, message: 'success' });
    }
    state.qrPolls += 1;
    if (state.qrPolls === 1) {
      return json({ data: { error_code: 0, status: 'new' }, message: 'success' });
    }
    if (state.qrPolls === 2) {
      return json({ data: { error_code: 0, status: 'scanned' }, message: 'success' });
    }
    return json({
      data: {
        error_code: 0,
        status: 'confirmed',
        redirect_url: '/passport/web/web_login_success',
        user_data: { user_id: '12345' },
      },
      message: 'success',
    });
  });

  app.get('/passport/web/web_login_success', (c) => {
    state.loginRequests.push('login-success');
    const res = c.redirect('/chat/');
    res.headers.append('Set-Cookie', 'sessionid=mock-session; Path=/; HttpOnly');
    res.headers.append('Set-Cookie', 'uid_tt=12345; Path=/');
    res.headers.append('Set-Cookie', 'passport_csrf_token=mock-csrf; Path=/');
    return res;
  });

  app.get('/passport/account/info/v2/', (c) => {
    state.loginRequests.push('account');
    if (state.accountValid && (c.req.header('cookie') || '').includes('sessionid=mock-session')) {
      return json({ data: { user_id: 12345, user_name: '测试用户' }, message: 'success' });
    }
    return json({ data: { error_code: 13, user_id: 0, description: '会话过期' }, message: 'error' });
  });

  app.post('/chat/completion', async (c) => {
    let body: any = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    state.chatRequests.push({ url: c.req.url, cookie: c.req.header('cookie') || '', body });
    const behavior = state.chatBehavior;
    if (behavior === 'legacyOnly') {
      return json({ code: 404, msg: 'not found' }, 404);
    }
    if (behavior === 'http401') {
      return json({ code: 710012001, msg: '登录已过期' }, 401);
    }
    if (behavior === 'nonSSE') {
      return json({ code: 710022004, msg: 'rate limited', extra: { decision: '{"type":"verify"}' } });
    }
    if (behavior === 'auth') {
      return sseResponse([
        'event: STREAM_ERROR\n',
        'data: {"error_code":710012001,"error_msg":"登录已过期"}\n\n',
      ]);
    }
    if (behavior === 'risk') {
      return sseResponse([
        'event: STREAM_ERROR\n',
        'data: {"error_code":710022004,"error_msg":"rate limited","extra":{"decision":"{\\"type\\":\\"verify\\"}"}}\n\n',
      ]);
    }
    return sseResponse([
      ': heartbeat\n\n',
      'data: {"content_block":[{"block_type":10040,"content":{}}]}\n\n',
      'data: {"content_block":[{"block_type":10000,"content":{"text_block":{"text":"思考中"}}}]}\n\n',
      'data: {"content_block":[{"block_type":10040,"content":{}}]}\n\n',
      'data: {"content_block":[{"block_type":10000,"content":{"text_block":{"text":"你好"}}}]}\n\n',
      'data: {"content_block":[{"block_type":10000,"content":{"text_block":{"text":"，世界"}}}]}\n\n',
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n',
      'data: [DONE]\n\n',
    ]);
  });

  app.post('/samantha/chat/completion', async (c) => {
    let body: any = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    state.legacyRequests.push({ url: c.req.url, cookie: c.req.header('cookie') || '', body });
    const behavior = state.chatBehavior;
    if (behavior === 'risk') {
      return sseResponse([
        'event: message\n',
        'data: {"event_type":2005,"event_data":{"error_code":710022004,"description":"rate limited"}}\n\n',
      ]);
    }
    if (behavior === 'auth' || behavior === 'http401') {
      return json({ code: 710012001, msg: '登录已过期' }, 401);
    }
    return sseResponse([
      'event: message\n',
      'data: {"event_type":2001,"event_data":{"message":{"content_type":2008,"content":"{\\"think\\":\\"先想一下\\"}"}}}\n\n',
      'event: message\n',
      'data: {"event_type":2001,"event_data":{"message":{"content_type":2001,"content":"{\\"text\\":\\"回退回答\\"}"}}}\n\n',
      'event: message\n',
      'data: {"event_type":2003,"event_data":{}}\n\n',
    ]);
  });

  const server: any = await new Promise((resolve, reject) => {
    let settled = false;
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => {
      settled = true;
      resolve(s);
    });
    s.on('error', (e: any) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
  });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    port,
    state,
    reset,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
