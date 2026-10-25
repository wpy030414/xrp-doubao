/**
 * douyinLogin.ts — 直接打开抖音官方 OAuth 授权页的登录流程。
 *
 * 与豆包自带的“扫码登录二维码”不同，这里走的是抖音开放平台的 OAuth：
 *   1) 打开 https://open.douyin.com/platform/oauth/connect?client_key=aw4293rjg7ggbx9m&...
 *      （页面由抖音托管，展示真正的抖音扫码授权二维码）
 *   2) redirect_uri 指向本机 http://127.0.0.1:<port>/douyin/callback
 *   3) 抖音授权后回跳 code + state
 *   4) 插件用 code 调豆包 passport 的 bind_with_mobile_login / login 换取会话 Cookie
 *   5) 凭证加密落盘
 *
 * 全程不需要豆包电脑版；用户只需在自动打开的抖音网页里扫码授权。
 */

import crypto from 'node:crypto';
import type { Browser, BrowserContext } from 'playwright-core';
import { settings } from './config';
import { CookieJar } from './cookieJar';
import { generateDeviceIdentity, type DeviceIdentity } from './device';
import { queryDoubaoAccount } from './webLogin';
import type { StoredSession } from './types';
import type { WebLoginState } from './loginFlow';

export interface DouyinOAuthOptions {
  baseUrl?: string;
  oauthBaseUrl?: string;
  clientKey?: string;
  scope?: string;
  optionalScope?: string;
  redirectUri?: string;
  device?: DeviceIdentity;
  aid?: string;
  timeoutMs?: number;
  headless?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function abortPromise(signal?: AbortSignal): Promise<never> | null {
  if (!signal) return null;
  return new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Error('登录已取消'));
    signal.addEventListener('abort', () => reject(new Error('登录已取消')), { once: true });
  });
}

/**
 * 启动登录用浏览器。playwright-core 不自带浏览器，这里优先用系统 Edge / Chrome。
 * 可用 DOUBAO_BROWSER_CHANNEL 指定通道（msedge / chrome / chromium）。
 */
async function launchLoginBrowser(headless: boolean): Promise<Browser> {
  const { chromium } = await import('playwright-core');
  const base = {
    headless,
    args: ['--no-first-run', '--no-default-browser-check'],
  };
  const candidates = settings.browserChannel
    ? [settings.browserChannel]
    : process.platform === 'win32'
      ? ['msedge', 'chrome']
      : ['chrome', 'chromium', 'msedge'];
  let lastError: any = null;
  for (const channel of candidates) {
    try {
      return await chromium.launch({ ...base, channel });
    } catch (e: any) {
      lastError = e;
    }
  }
  // 最后尝试 Playwright 自带 Chromium（若用户已安装 browser）
  try {
    return await chromium.launch(base);
  } catch (e: any) {
    lastError = e;
  }
  throw new Error(
    `无法启动浏览器：请安装 Microsoft Edge 或 Google Chrome，` +
      `或设置 DOUBAO_BROWSER_CHANNEL。${lastError?.message ? `（${lastError.message}）` : ''}`,
  );
}

function pickString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** 在任意 JSON / JSON 字符串里找 profile_key（passport 二次绑定需要） */
function findProfileKey(value: unknown, depth = 0): string {
  if (depth > 6 || value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s || (s[0] !== '{' && s[0] !== '[')) return '';
    try {
      return findProfileKey(JSON.parse(s), depth + 1);
    } catch {
      return '';
    }
  }
  if (typeof value !== 'object') return '';
  const obj = value as Record<string, unknown>;
  if (typeof obj.profile_key === 'string' && obj.profile_key.trim()) return obj.profile_key.trim();
  for (const key of Object.keys(obj)) {
    const found = findProfileKey(obj[key], depth + 1);
    if (found) return found;
  }
  return '';
}

function describeApiError(json: any, fallback: string): string {
  if (!json || typeof json !== 'object') return fallback;
  const data = json.data?.data ?? json.data ?? json;
  const desc = pickString(
    data?.description,
    data?.message,
    data?.error_msg,
    json.message,
    json.msg,
    json.description,
  );
  const code = data?.error_code ?? json.error_code ?? json.code;
  if (desc && code !== undefined) return `${desc}（code=${code}）`;
  return desc || (code !== undefined ? `code=${code}` : fallback);
}

export class DouyinOAuthLogin {
  readonly mode = 'douyin' as const;
  readonly title = '抖音授权登录';
  readonly hint =
    '已打开抖音官方授权网页。请用抖音 App 扫码授权；授权完成后会自动回到本机并加密保存豆包会话。';

  readonly baseUrl: string;
  readonly oauthBaseUrl: string;
  readonly clientKey: string;
  readonly scope: string;
  readonly optionalScope: string;
  readonly aid: string;
  readonly timeoutMs: number;
  readonly device: DeviceIdentity;
  readonly headless: boolean;

  private redirectUri: string;
  private oauthState = '';
  private oauthUrl = '';
  private jar = new CookieJar();
  private state: WebLoginState = { status: 'idle', message: '未开始', done: false };
  private session: StoredSession | null = null;
  private waiters: Array<(s: WebLoginState) => void> = [];

  constructor(opts: DouyinOAuthOptions = {}) {
    this.baseUrl = (opts.baseUrl || settings.baseUrl).replace(/\/+$/, '');
    this.oauthBaseUrl = (opts.oauthBaseUrl || settings.douyinOauthBaseUrl).replace(/\/+$/, '');
    this.clientKey = opts.clientKey || settings.douyinClientKey;
    this.scope = opts.scope || settings.douyinScope;
    this.optionalScope = opts.optionalScope || settings.douyinOptionalScope;
    this.redirectUri = opts.redirectUri || settings.douyinRedirectUri;
    this.aid = opts.aid || settings.aid;
    this.timeoutMs = opts.timeoutMs ?? settings.loginTimeoutMs;
    this.device = opts.device || generateDeviceIdentity();
    this.headless = opts.headless ?? settings.loginHeadless;
  }

  /** 由本地回调服务器在监听成功后调用 */
  setRedirectUri(uri: string): void {
    this.redirectUri = uri;
  }

  getRedirectUri(): string {
    return this.redirectUri;
  }

  getOauthUrl(): string {
    return this.oauthUrl;
  }

  /** 测试 / 诊断：当前 state 原文 */
  getStateToken(): string {
    return this.oauthState;
  }

  getState(): WebLoginState {
    return { ...this.state };
  }

  getSession(): StoredSession | null {
    return this.session ? { ...this.session, cookies: this.session.cookies.map((c) => ({ ...c })) } : null;
  }

  getJar(): CookieJar {
    return this.jar;
  }

  /** 生成授权 URL */
  async begin(): Promise<string> {
    if (!this.redirectUri) throw new Error('抖音登录回调地址尚未初始化');
    this.jar = new CookieJar();
    this.session = null;
    this.oauthState = Buffer.from(
      JSON.stringify({
        entry: '',
        trackMeta: {
          login_entrance: 'sign_in',
          is_from_ug: '0',
          is_from_share: '0',
          trigger_platform: 'web',
          trigger_app: 'doubao',
        },
        autoClose: true,
        platform: 'aweme_v2',
        navigatePath: `/chat/?from_login=1&origin_landing=${encodeURIComponent(`${this.baseUrl}/chat/`)}`,
        type: 'login',
        timestamp: Date.now(),
        csrfToken: crypto.randomUUID(),
      }),
    ).toString('base64');

    const u = new URL('/platform/oauth/connect', this.oauthBaseUrl);
    u.searchParams.set('client_key', this.clientKey);
    u.searchParams.set('client_id', this.clientKey);
    u.searchParams.set('redirect_uri', this.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', this.scope);
    u.searchParams.set('optionalScope', this.optionalScope);
    u.searchParams.set('state', this.oauthState);
    this.oauthUrl = u.toString();
    this.setState({ status: 'new', message: '等待抖音授权', done: false });
    return this.oauthUrl;
  }

  /**
   * 用 Playwright 打开抖音官方授权页，拦截官方 callback 请求拿到 code。
   *
   * 注意：不能把 redirect_uri 改成 localhost —— 抖音会在授权时提示
   * “非法重定向链接”。这里使用豆包白名单内的官方 callback，并在浏览器
   * 发出该请求时截获 URL；随后立即关闭浏览器，由 Node 端换票。
   */
  async captureCode(
    timeoutMs = this.timeoutMs,
    signal?: AbortSignal,
  ): Promise<{ code: string; state: string }> {
    if (!this.oauthUrl) await this.begin();
    const browser = await launchLoginBrowser(this.headless);
    let timer: NodeJS.Timeout | null = null;
    try {
      const context = await browser.newContext({
        userAgent: settings.userAgent,
        locale: 'zh-CN',
        viewport: { width: 1280, height: 900 },
      });
      const page = await context.newPage();
      let resolveCapture!: (v: { code: string; state: string }) => void;
      const captured = new Promise<{ code: string; state: string }>((resolve) => {
        resolveCapture = resolve;
      });

      await page.route('**/auth/callback**', async (route) => {
        try {
          const u = new URL(route.request().url());
          const code = u.searchParams.get('code') || '';
          const state = u.searchParams.get('state') || '';
          const error = u.searchParams.get('error') || '';
          if (code || error) {
            resolveCapture({ code, state });
            await route.fulfill({
              status: 200,
              contentType: 'text/html; charset=utf-8',
              body:
                '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:24px">' +
                (code ? '授权完成，可以关闭此窗口。' : '授权未完成，请回到终端查看原因。') +
                '</body>',
            });
          } else {
            await route.continue();
          }
        } catch {
          await route.continue().catch(() => {});
        }
      });

      const abort = abortPromise(signal);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('登录超时，请重新运行 pnpm log-in')), timeoutMs);
      });
      const goto = page
        .goto(this.oauthUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        .catch((e: any) => {
          if (settings.debug) console.log(`[doubao-login] page.goto: ${e.message}`);
        });
      // 等页面加载，但不把它作为完成条件；用户可能在页面上停留很久
      await Promise.race([goto, captured, timeout]);
      return await Promise.race(abort ? [captured, timeout, abort] : [captured, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      await browser.close().catch(() => {});
    }
  }

  /**
   * 官方登录弹窗 → 抖音 OAuth 页 → 由豆包自己的 callback 完成换票 → 从浏览器上下文提取 Cookie。
   *
   * 这是最稳妥的链路：CSRF、state、code 换取全部由豆包官方页面自己完成，
   * 插件只负责把用户带到真正的抖音授权页，并在登录成功后取出会话 Cookie。
   */
  async captureViaLoginModal(timeoutMs = this.timeoutMs, signal?: AbortSignal): Promise<StoredSession> {
    const browser = await launchLoginBrowser(this.headless);
    try {
      const context = await browser.newContext({
        userAgent: settings.userAgent,
        locale: 'zh-CN',
        viewport: { width: 1280, height: 900 },
      });
      const page = await context.newPage();
      await page.goto(`${this.baseUrl}/chat/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(2500);

      // 关掉“下载电脑版”弹窗
      for (const sel of ['div[role="dialog"] button[aria-label="关闭"]', 'button:has-text("关闭")']) {
        const loc = page.locator(sel).first();
        if (await loc.count().catch(() => 0)) {
          await loc.click({ timeout: 1500 }).catch(() => {});
          await page.waitForTimeout(600);
          break;
        }
      }

      // 打开登录弹窗
      const login = page.getByText('登录', { exact: true }).first();
      await login.waitFor({ state: 'visible', timeout: 20_000 });
      await login.click({ timeout: 5_000 });
      await page.waitForTimeout(1500);

      // 抖音一键登录
      const douyin = page.getByText('抖音一键登录', { exact: true }).first();
      await douyin.waitFor({ state: 'visible', timeout: 15_000 });
      await douyin.click({ timeout: 5_000 });
      await page.waitForTimeout(1200);

      // 隐私 / 授权协议
      const agree = page.getByText('同意', { exact: true }).first();
      if (await agree.count().catch(() => 0)) {
        await agree.click({ timeout: 5_000 }).catch(() => {});
      }
      console.log('[doubao-login] 浏览器已进入抖音官方授权页，请扫码或选择验证码授权…');

      // 页面可能在同一 tab 跳到 open.douyin.com，也可能新开 tab；两者都等 Cookie
      await Promise.race([
        page.waitForURL(/open\.douyin\.com/, { timeout: 30_000 }).catch(() => {}),
        sleep(6000),
      ]);
      if (settings.debug) console.log('[doubao-login] 等待抖音授权完成…');

      const cookies = await this.waitForDoubaoCookies(context, timeoutMs, signal);
      const jar = new CookieJar();
      for (const c of cookies) {
        const domain = (c.domain || '').toLowerCase();
        if (!domain.endsWith('doubao.com')) continue;
        jar.set({
          name: c.name,
          value: c.value,
          domain: domain.replace(/^\./, ''),
          path: c.path || '/',
          expiresAt: typeof c.expires === 'number' && c.expires > 0 ? c.expires * 1000 : undefined,
          secure: c.secure === true,
          httpOnly: c.httpOnly === true,
          hostOnly: !domain.startsWith('.'),
          sameSite: typeof c.sameSite === 'string' ? c.sameSite : undefined,
        });
      }
      if (jar.size() === 0) throw new Error('登录成功但未获得任何 Cookie');
      const account = await queryDoubaoAccount(jar, { baseUrl: this.baseUrl });
      const uid = account?.uid || jar.get('uid_tt') || jar.get('uid_tt_ss') || '';
      return {
        cookies: jar.toJSON(),
        device: { ...this.device },
        uid,
        nickname: account?.nickname || '',
        savedAt: Date.now(),
      };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  private async waitForDoubaoCookies(
    context: BrowserContext,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Array<{ name: string; value: string; domain: string; path: string; expires?: number; secure?: boolean; httpOnly?: boolean; sameSite?: string }>> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (signal?.aborted) throw new Error('登录已取消');
      const cookies = await context.cookies();
      const hasSession = cookies.some(
        (c) =>
          (c.domain || '').includes('doubao.com') &&
          Boolean(c.value) &&
          ['sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt', 'uid_tt_ss'].includes(c.name),
      );
      if (hasSession) {
        await sleep(800);
        return context.cookies();
      }
      await sleep(1000);
    }
    throw new Error('等待抖音授权超时，请重新运行 pnpm log-in');
  }

  /** 完整登录：官方弹窗 → 抖音授权页 → 提取豆包会话 */
  async run(opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<WebLoginState> {
    try {
      this.setState({ status: 'new', message: '正在打开抖音授权页', done: false });
      const session = await this.captureViaLoginModal(opts.timeoutMs ?? this.timeoutMs, opts.signal);
      this.session = session;
      return this.finish({
        status: 'confirmed',
        message: '登录成功',
        uid: session.uid,
        nickname: session.nickname,
        done: true,
      });
    } catch (e: any) {
      return this.finish({ status: 'error', message: `登录失败：${e.message}`, done: true, error: e.message });
    }
  }

  /** 浏览器回跳后由本地服务器调用（备用 / 测试） */
  async handleCallback(code: string, state: string): Promise<WebLoginState> {
    if (!code) {
      return this.finish({ status: 'error', message: '抖音回调缺少 code', done: true, error: 'no-code' });
    }
    if (!state || state !== this.oauthState) {
      return this.finish({
        status: 'error',
        message: '抖音回调 state 不匹配（可能不是本次登录发起）',
        done: true,
        error: 'state-mismatch',
      });
    }
    this.setState({ status: 'scanned', message: '抖音授权成功，正在换取豆包会话…', done: false });
    try {
      const result = await this.exchangeCode(code);
      if (!result.ok) throw new Error(result.message);
      const account = await queryDoubaoAccount(this.jar, { baseUrl: this.baseUrl });
      const cookies = this.jar.toJSON();
      if (cookies.length === 0) throw new Error('换取成功但未获得任何 Cookie');
      const uid = account?.uid || this.jar.get('uid_tt') || this.jar.get('uid_tt_ss') || '';
      const nickname = account?.nickname || '';
      this.session = {
        cookies,
        device: { ...this.device },
        uid,
        nickname,
        savedAt: Date.now(),
      };
      return this.finish({ status: 'confirmed', message: '登录成功', uid, nickname, done: true });
    } catch (e: any) {
      return this.finish({
        status: 'error',
        message: `登录失败：${e.message}`,
        done: true,
        error: e.message,
      });
    }
  }

  /** 回调带 error（用户拒绝授权等） */
  failCallback(message: string): WebLoginState {
    return this.finish({ status: 'error', message, done: true, error: message });
  }

  /** 等待回调；超时返回 error 状态 */
  waitForCallback(timeoutMs = this.timeoutMs): Promise<WebLoginState> {
    if (this.state.done) return Promise.resolve(this.getState());
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(
          this.finish({
            status: 'error',
            message: '登录超时，请重新运行 pnpm log-in',
            done: true,
            error: 'timeout',
          }),
        );
      }, timeoutMs);
      this.waiters.push((s) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(s);
      });
    });
  }

  /** 重新生成 state / 授权 URL（用户可再次打开） */
  async refresh(): Promise<string> {
    return this.begin();
  }

  /** 用当前 Cookie 查账号（诊断用） */
  async fetchAccountInfo(): Promise<{ uid: string; nickname: string } | null> {
    return queryDoubaoAccount(this.jar, { baseUrl: this.baseUrl });
  }

  // ── 换取豆包会话 ──────────────────────────────────────────

  private async exchangeCode(code: string): Promise<{ ok: boolean; message: string; detail?: unknown }> {
    const csrf = await this.ensureCsrf();
    const bind = await this.postForm(
      '/passport/web/auth/bind_with_mobile_login/',
      { code, platform_app_id: '8949', platform: 'aweme_v2' },
      csrf,
    );
    if (settings.debug) {
      console.log(`[doubao-login] bind_with_mobile_login HTTP ${bind.status}`);
    }
    if (this.hasSession()) return { ok: true, message: 'ok', detail: bind.json };

    const profileKey = findProfileKey(bind.json) || findProfileKey(bind.text);
    let loginDetail: any = null;
    if (profileKey) {
      const login = await this.postForm(
        '/passport/web/auth/login/',
        { profile_key: profileKey, platform_app_id: '8949' },
        csrf,
      );
      loginDetail = login.json;
      if (settings.debug) console.log(`[doubao-login] auth/login HTTP ${login.status}`);
      if (this.hasSession()) return { ok: true, message: 'ok', detail: login.json };
    }

    // 某些账号会走 oauth_token 下发会话
    const oauth = await this.postForm(
      '/passport/web/auth/get_oauth_token/',
      { platform_app_id: '8949', code },
      csrf,
    );
    if (this.hasSession()) return { ok: true, message: 'ok', detail: oauth.json };

    // 兼容：用 code 直接走 login / doubao oauth token
    const loginWithCode = await this.postForm(
      '/passport/web/auth/login/',
      { code, platform_app_id: '8949', platform: 'aweme_v2' },
      csrf,
    );
    if (this.hasSession()) return { ok: true, message: 'ok', detail: loginWithCode.json };

    const doubaoOauth = await this.postForm(
      '/passport/doubao/get_oauth_token/',
      { code, platform_app_id: '8949' },
      csrf,
    );
    if (this.hasSession()) return { ok: true, message: 'ok', detail: doubaoOauth.json };

    // 最后用账号接口确认（有时会话 Cookie 名称不同）
    const account = await queryDoubaoAccount(this.jar, { baseUrl: this.baseUrl });
    if (account?.uid) return { ok: true, message: 'ok', detail: account };

    const message = describeApiError(bind.json, bind.text.slice(0, 300) || '豆包未返回会话');
    return {
      ok: false,
      message,
      detail: { bind: bind.json, login: loginDetail, oauth: oauth.json, loginWithCode: loginWithCode.json, doubaoOauth: doubaoOauth.json },
    };
  }

  private hasSession(): boolean {
    return Boolean(
      this.jar.get('sessionid') ||
        this.jar.get('sessionid_ss') ||
        this.jar.get('sid_tt') ||
        this.jar.get('uid_tt') ||
        this.jar.get('sid_guard'),
    );
  }

  private async ensureCsrf(): Promise<string> {
    let csrf = this.jar.get('passport_csrf_token') || this.jar.get('passport_csrf_token_default') || '';
    if (csrf) return csrf;
    const res = await this.requestDoubao(`/passport/safe/csrf_token/?aid=${encodeURIComponent(this.aid)}`, {
      method: 'GET',
    });
    const json = await res.json().catch(() => null);
    csrf =
      pickString(json?.data?.passport_csrf_token, json?.data?.csrf_token) ||
      this.jar.get('passport_csrf_token') ||
      this.jar.get('passport_csrf_token_default') ||
      '';
    if (!csrf) throw new Error('获取豆包 CSRF 失败');
    return csrf;
  }

  private exchangeQuery(): string {
    return new URLSearchParams({
      aid: this.aid,
      real_aid: this.aid,
      pkg_type: 'release_version',
      version_code: '20800',
      device_platform: 'web',
      language: 'zh',
      account_app_language: 'zh-CN',
      passport_jssdk_version: '4.4.6',
      passport_jssdk_type: 'normal',
      is_from_ttaccountsdk: '1',
      multi_login: '1',
      account_sdk_source: 'web',
      ts: String(Math.floor(Date.now() / 1000)),
    }).toString();
  }

  private async postForm(
    path: string,
    fields: Record<string, string>,
    csrf: string,
  ): Promise<{ status: number; text: string; json: any }> {
    const res = await this.requestDoubao(`${path}?${this.exchangeQuery()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-tt-passport-csrf-token': csrf,
      },
      body: new URLSearchParams(fields).toString(),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    return { status: res.status, text, json };
  }

  private async requestDoubao(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const cookie = this.jar.getCookieHeader(`${this.baseUrl}/`);
    const headers: Record<string, string> = {
      'User-Agent': settings.userAgent,
      'Accept': 'application/json, text/plain, */*',
      'Origin': this.baseUrl,
      'Referer': `${this.baseUrl}/auth/callback`,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers || {}),
    };
    const res = await fetch(url, {
      method: init.method || 'GET',
      headers,
      body: init.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    this.jar.absorb(res.headers, url);
    return res;
  }

  private setState(state: WebLoginState): void {
    this.state = state;
    if (settings.debug) console.log(`[doubao-login] ${state.status}: ${state.message}`);
  }

  private finish(state: WebLoginState): WebLoginState {
    this.setState(state);
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(this.getState());
    return this.getState();
  }
}
