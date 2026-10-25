/**
 * server.ts — Hono HTTP 入口与 xrl-router 插件启动。
 *
 * HTTP：OpenAI Chat Completions 兼容（POST /v1/chat/completions）
 * WS  ：注册 / 心跳 / 重连（V24 契约，无 keys）
 */

import { serve } from '@hono/node-server';
import { spawn } from 'node:child_process';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { settings } from './config';
import { forwardChatCompletions } from './openai';
import { getAuthStatus, initTokenManager } from './auth';
import { getNeedsCaptcha, resetCaptcha } from './doubaoClient';
import { PluginClient, PLUGIN_ID, registeredModels } from './pluginClient';

export function createApp(): Hono {
  const app = new Hono();
  app.use('*', cors());

  app.get('/', (c) =>
    c.json({
      version: '0.1.0',
      service: PLUGIN_ID,
      status: 'running',
      backend: 'doubao',
      chat_mode: settings.chatMode,
      models: registeredModels().map((m) => m.display_name),
      endpoints: {
        chat: '/v1/chat/completions',
        health: '/health',
        resetCaptcha: '/admin/reset-captcha',
      },
    }),
  );

  app.get('/health', (c) =>
    c.json({
      status: 'healthy',
      backend: 'doubao',
      plugin_mode: true,
      base_url: settings.baseUrl,
      chat_mode: settings.chatMode,
      needs_captcha: getNeedsCaptcha(),
      models: registeredModels().map((m) => m.display_name),
      auth: getAuthStatus(),
    }),
  );

  app.post('/admin/reset-captcha', (c) => {
    resetCaptcha();
    return c.json({ ok: true, needs_captcha: false });
  });

  app.post('/v1/chat/completions', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { message: '请求体必须是合法 JSON', type: 'invalid_request_error' } }, 400);
    }
    return forwardChatCompletions(body, c);
  });

  return app;
}

/** 释放被旧实例占用的端口（排除自身 PID） */
async function killPortProcess(port: number): Promise<void> {
  const isWindows = process.platform === 'win32';
  const selfPid = String(process.pid);
  return new Promise((resolve) => {
    if (isWindows) {
      const netstat = spawn('netstat', ['-ano']);
      let output = '';
      netstat.stdout.on('data', (d) => {
        output += d.toString();
      });
      netstat.on('close', () => {
        const pids: string[] = [];
        for (const line of output.split('\n')) {
          if (line.includes(`:${port}`) && line.includes('LISTENING')) {
            const parts = line.trim().split(/\s+/);
            const pid = parts[parts.length - 1];
            if (pid && pid !== selfPid && !pids.includes(pid)) pids.push(pid);
          }
        }
        if (pids.length === 0) return resolve();
        const taskkill = spawn('taskkill', ['/F', '/PID', ...pids]);
        taskkill.on('close', () => resolve());
      });
      netstat.on('error', () => resolve());
    } else {
      const lsof = spawn('lsof', ['-ti', `:${port}`]);
      let pids = '';
      lsof.stdout.on('data', (d) => {
        pids += d.toString();
      });
      lsof.stderr.on('data', () => {});
      lsof.on('close', (code) => {
        if (code === 0 && pids.trim()) {
          const pidList = pids.trim().split('\n').filter((p) => p.trim() && p.trim() !== selfPid);
          if (pidList.length === 0) return resolve();
          const kill = spawn('kill', ['-9', ...pidList]);
          kill.on('close', () => resolve());
        } else {
          resolve();
        }
      });
      lsof.on('error', () => resolve());
    }
  });
}

export interface StartedServer {
  port: number;
  close: () => Promise<void>;
  pluginClient: PluginClient | null;
}

/** 启动服务（测试可传 port=0） */
export async function startServer(opts: { port?: number; connectRouter?: boolean } = {}): Promise<StartedServer> {
  initTokenManager();
  const port = opts.port ?? settings.port;
  if (port !== 0) await killPortProcess(port);
  const app = createApp();

  const server = await new Promise<any>((resolve, reject) => {
    let settled = false;
    const s = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
      settled = true;
      resolve(s);
      console.log(`[doubao] listening on http://localhost:${info.port} (pid ${process.pid})`);
      console.log(`[doubao] chat mode: ${settings.chatMode}; models: ${registeredModels().length}`);
    });
    s.on('error', (err: any) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });

  const actualPort: number = server.address()?.port ?? port;
  const pluginClient = opts.connectRouter === false ? null : new PluginClient(actualPort);

  const close = async () => {
    pluginClient?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { port: actualPort, close, pluginClient };
}

/** 进程入口：启动并处理信号 */
export async function runServer(): Promise<void> {
  const started = await startServer();
  const shutdown = async () => {
    await started.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
