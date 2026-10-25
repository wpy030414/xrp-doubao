/**
 * openai.ts — OpenAI Chat Completions ↔ 豆包上游的翻译层。
 *
 * - 上游始终流式；客户端要非流式时本地聚合。
 * - thinking 映射为 reasoning_content；正文映射为 content。
 * - SSE 分片保持 finish_reason=null，结束分片才给 stop，避免 Router 提前关闭块。
 * - 错误在响应头发出前可回 4xx/5xx；流中错误以 SSE error 事件返回。
 */

import type { Context } from 'hono';
import { DEFAULT_MODEL, settings } from './config';
import { DoubaoClient, DoubaoUpstreamError, type ChatDelta, type ChatMode } from './doubaoClient';
import { forceRelogin, getSession, markAuthError } from './auth';
import { UnsupportedMessageError } from './messages';
import type { DoubaoAuthState } from './types';

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function errorType(status: number): string {
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 400) return 'invalid_request_error';
  return 'upstream_error';
}

function jsonError(c: Context, status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return c.json({ error: { message, type: errorType(status), ...extra } }, status as any);
}

function mapUpstreamError(e: unknown): { status: number; message: string; extra?: Record<string, unknown> } {
  if (e instanceof UnsupportedMessageError) {
    return { status: 400, message: e.message };
  }
  if (e instanceof DoubaoUpstreamError) {
    if (e.kind === 'auth') {
      markAuthError(e.message);
      return {
        status: 401,
        message: `${e.message}；请重新运行 \`pnpm log-in\` 扫码登录。`,
        extra: { code: e.code, upstream_status: e.status },
      };
    }
    if (e.kind === 'risk') {
      return {
        status: 429,
        message:
          `${e.message}；请先在浏览器打开 https://www.doubao.com 完成人机验证，` +
          '或稍后重试；必要时重新 `pnpm log-in`。',
        extra: { code: e.code, needs_captcha: true, upstream_status: e.status },
      };
    }
    return {
      status: e.status && e.status >= 400 ? Math.min(e.status, 599) : 502,
      message: e.message,
      extra: { code: e.code, upstream_status: e.status },
    };
  }
  if (e instanceof Error && e.name === 'AbortError') {
    return { status: 499, message: '请求已取消' };
  }
  return { status: 502, message: e instanceof Error ? e.message : String(e) };
}

function reasoningEffortOf(body: any): number | string | undefined {
  return body?.reasoning_effort ?? body?.extra_body?.reasoning_effort ?? body?.thinking?.effort;
}

interface StartedChat {
  iterator: AsyncGenerator<ChatDelta>;
  first: IteratorResult<ChatDelta>;
  mode?: ChatMode;
  session: DoubaoAuthState;
}

async function startChat(
  session: DoubaoAuthState,
  body: any,
  signal: AbortSignal,
): Promise<StartedChat> {
  let mode: ChatMode | undefined;
  const client = new DoubaoClient(session);
  const iterator = client.chat({
    model: typeof body.model === 'string' ? body.model : DEFAULT_MODEL,
    messages: body.messages,
    stream: body.stream === true,
    reasoningEffort: reasoningEffortOf(body),
    signal,
    onMode: (m) => {
      mode = m;
    },
  });
  const first = await iterator.next();
  return { iterator, first, mode, session };
}

/**
 * 处理 OpenAI Chat Completions 请求。
 * 首个上游分片在返回响应前取出，因此鉴权/风控错误仍能映射为正确的 HTTP 状态。
 */
export async function forwardChatCompletions(body: any, c: Context): Promise<Response> {
  if (!body || typeof body !== 'object') {
    return jsonError(c, 400, '请求体必须是 JSON 对象');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonError(c, 400, 'messages 不能为空');
  }

  const model = typeof body.model === 'string' && body.model ? body.model : DEFAULT_MODEL;
  const isStream = body.stream === true;
  const includeUsage = body.stream_options?.include_usage === true;

  const ac = new AbortController();
  const onClientAbort = () => ac.abort();
  c.req.raw.signal.addEventListener('abort', onClientAbort);
  const timer = setTimeout(() => ac.abort(), settings.requestTimeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    c.req.raw.signal.removeEventListener('abort', onClientAbort);
  };

  let session: DoubaoAuthState;
  try {
    session = await getSession();
  } catch (e: any) {
    cleanup();
    return jsonError(c, 401, e.message);
  }

  let started: StartedChat;
  try {
    started = await startChat(session, body, ac.signal);
  } catch (e: any) {
    if (e instanceof DoubaoUpstreamError && e.kind === 'auth' && settings.autoLogin) {
      try {
        const next = await forceRelogin(e.message);
        started = await startChat(next, body, ac.signal);
      } catch (retryError: any) {
        cleanup();
        const mapped = mapUpstreamError(retryError);
        return jsonError(c, mapped.status, mapped.message, mapped.extra);
      }
    } else {
      cleanup();
      const mapped = mapUpstreamError(e);
      return jsonError(c, mapped.status, mapped.message, mapped.extra);
    }
  }

  // 非流式：聚合全部增量
  if (!isStream) {
    try {
      const content: string[] = [];
      const reasoning: string[] = [];
      let usage: any;
      const consume = (d: ChatDelta) => {
        if (d.text) content.push(d.text);
        if (d.reasoning) reasoning.push(d.reasoning);
        if (d.usage) usage = d.usage;
      };
      if (!started.first.done) consume(started.first.value);
      for await (const d of started.iterator) {
        if (d.done) break;
        consume(d);
      }
      const message: any = { role: 'assistant', content: content.join('') };
      const r = reasoning.join('');
      if (r) message.reasoning_content = r;
      return c.json({
        id: `chatcmpl-${uuid()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        ...(usage ? { usage } : {}),
      });
    } catch (e: any) {
      cleanup();
      const mapped = mapUpstreamError(e);
      return jsonError(c, mapped.status, mapped.message, mapped.extra);
    } finally {
      cleanup();
    }
  }

  const encoder = new TextEncoder();
  const id = `chatcmpl-${uuid()}`;
  const created = Math.floor(Date.now() / 1000);
  let roleSent = false;
  let usage: any;
  let finished = false;

  const chunk = (delta: any, finishReason: string | null = null, withUsage?: any) => {
    const obj: any = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta,
          logprobs: null,
          finish_reason: finishReason,
        },
      ],
    };
    if (withUsage !== undefined) obj.usage = withUsage;
    return `data: ${JSON.stringify(obj)}\n\n`;
  };

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => controller.enqueue(encoder.encode(s));
      const emitDelta = (d: ChatDelta) => {
        if (d.usage) usage = d.usage;
        if (!d.text && !d.reasoning) return;
        const delta: any = {};
        if (!roleSent) {
          delta.role = 'assistant';
          roleSent = true;
        }
        if (d.reasoning) delta.reasoning_content = d.reasoning;
        if (d.text) delta.content = d.text;
        send(chunk(delta));
      };
      try {
        if (!started.first.done) emitDelta(started.first.value);
        for await (const d of started.iterator) {
          if (d.done) break;
          emitDelta(d);
        }
        if (!roleSent) send(chunk({ role: 'assistant' }));
        send(chunk({}, 'stop'));
        if (includeUsage && usage) {
          const usageChunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [],
            usage,
          };
          send(`data: ${JSON.stringify(usageChunk)}\n\n`);
        }
        send('data: [DONE]\n\n');
        finished = true;
      } catch (e: any) {
        const mapped = mapUpstreamError(e);
        if (!finished) {
          try {
            send(`data: ${JSON.stringify({ error: { message: mapped.message, type: errorType(mapped.status), ...(mapped.extra || {}) } })}\n\n`);
            send('data: [DONE]\n\n');
          } catch {
            /* controller 可能已关闭 */
          }
        }
      } finally {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      ac.abort();
      cleanup();
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Doubao-Mode': started.mode || 'auto',
    },
  });
}
