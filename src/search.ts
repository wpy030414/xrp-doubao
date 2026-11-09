/**
 * search.ts — 豆包联网搜索（web_search）专用端点。
 *
 * 豆包网页端没有“搜索开关”：是否联网由模型自己的意图判断（SSE ext 里的
 * llm_intention=browsing）。因此本模块通过 prompt 明确要求“联网搜索”，
 * 再读取上游 block_type=10025（search_query_result_block）拿到资料列表。
 *
 * 拿到 10025 后立即中断上游流（ChatRequest.stopAfterSearch），不生成正文：
 *   - 省 token / 省风控触发面
 *   - 返回的是“来源列表”，可直接作为 xrl-router search/ 层的引擎输入
 *
 * 若模型没有触发浏览意图（例如无需联网的问题），10025 不会出现，
 * 此时返回空 results + `searched: false`，由上层决定回退策略。
 */

import type { Context } from 'hono';
import { settings } from './config';
import {
  DoubaoClient,
  DoubaoUpstreamError,
  type SearchResult,
  type SearchSource,
} from './doubaoClient';
import { getSession, forceRelogin, markAuthError } from './auth';
import type { DoubaoAuthState } from './types';

export interface SearchResponse {
  query: string;
  /** 是否真的触发了联网搜索（上游是否下发了 10025） */
  searched: boolean;
  /** 上游摘要，例如「搜索 2 个关键词，参考 12 篇资料」 */
  summary?: string;
  /** 上游改写后的查询词 */
  queries?: string[];
  results: SearchSource[];
  mode: string;
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
  if (e instanceof DoubaoUpstreamError) {
    if (e.kind === 'auth') {
      markAuthError(e.message);
      return { status: 401, message: `${e.message}；请重新运行 \`pnpm log-in\` 扫码登录。`, extra: { code: e.code } };
    }
    if (e.kind === 'risk') {
      return { status: 429, message: `${e.message}；请先在浏览器完成人机验证。`, extra: { code: e.code, needs_captcha: true } };
    }
    return { status: e.status && e.status >= 400 ? Math.min(e.status, 599) : 502, message: e.message, extra: { code: e.code } };
  }
  if (e instanceof Error && e.name === 'AbortError') return { status: 499, message: '请求已取消' };
  return { status: 502, message: e instanceof Error ? e.message : String(e) };
}

/** 把查询包装成明确要求联网的 prompt，尽量把 llm_intention 拉向 browsing */
function buildSearchPrompt(query: string): string {
  return [
    '请联网搜索下面这个问题，只列出你检索到的网页资料（标题和链接），不要总结、不要作答。',
    '',
    `问题：${query}`,
  ].join('\n');
}

/** 客户端可以传 {
 *    query: string,
 *    messages?: OpenAI messages[]（有则从中取最后一条 user 文本）
 *  } */
function extractQuery(body: any): string {
  if (typeof body?.query === 'string' && body.query.trim()) return body.query.trim();
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== 'user') continue;
    const content = m.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
        .join('')
        .trim();
      if (text) return text;
    }
  }
  return '';
}

export async function runSearch(body: any, c: Context): Promise<Response> {
  const query = extractQuery(body);
  if (!query) {
    return jsonError(c, 400, '缺少查询：请提供 query 字段或在 messages 中给出 user 内容');
  }

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  c.req.raw.signal.addEventListener('abort', onAbort);
  const timer = setTimeout(() => ac.abort(), Math.min(settings.requestTimeoutMs, settings.searchTimeoutMs));
  const cleanup = () => {
    clearTimeout(timer);
    c.req.raw.signal.removeEventListener('abort', onAbort);
  };

  let session: DoubaoAuthState;
  try {
    session = await getSession();
  } catch (e: any) {
    cleanup();
    return jsonError(c, 401, e.message);
  }

  const messages = [{ role: 'user', content: buildSearchPrompt(query) }];
  let mode = 'web';
  const run = (s: DoubaoAuthState) => {
    const client = new DoubaoClient(s);
    return client.chat({
      model: typeof body?.model === 'string' && body.model ? body.model : settings.searchModel,
      messages,
      stream: true,
      reasoningEffort: 5,
      signal: ac.signal,
      stopAfterSearch: true,
      onMode: (m) => {
        mode = m;
      },
    });
  };

  let iterator: AsyncGenerator<any>;
  let first: IteratorResult<any> | undefined;

  try {
    iterator = run(session);
    // 先取第一片，让鉴权/风控错误能落成真实 HTTP 状态；该结果仍需参与后续合并
    first = await iterator.next();
  } catch (e: any) {
    if (e instanceof DoubaoUpstreamError && e.kind === 'auth' && settings.autoLogin) {
      try {
        const next = await forceRelogin(e.message);
        iterator = run(next);
        first = await iterator.next();
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

  const merged: SearchSource[] = [];
  let summary: string | undefined;
  let queries: string[] | undefined;
  let searched = false;

  const absorb = (d: any) => {
    if (!d || typeof d !== 'object') return;
    if (d.search) {
      searched = true;
      if (d.search.summary) summary = d.search.summary;
      if (d.search.queries?.length) queries = d.search.queries;
      merged.push(...d.search.sources);
    }
  };

  try {
    if (first && !first.done) {
      absorb(first.value);
      if (!first.value?.done) {
        for await (const d of iterator) {
          if (d.done) break;
          absorb(d);
        }
      }
    }
  } catch (e: any) {
    // 已在 headers 之前处理过错误；到这里多为流中断，按已拿到的结果返回
    if (merged.length === 0) {
      cleanup();
      const mapped = mapUpstreamError(e);
      return jsonError(c, mapped.status, mapped.message, mapped.extra);
    }
  } finally {
    cleanup();
  }

  const dedup = new Map<string, SearchSource>();
  for (const s of merged) {
    const key = s.docId || s.url;
    if (!dedup.has(key)) dedup.set(key, s);
  }
  const results = [...dedup.values()].sort((a, b) => a.index - b.index);

  const payload: SearchResponse = {
    query,
    searched,
    summary,
    queries,
    results,
    mode,
  };
  return c.json(payload);
}
