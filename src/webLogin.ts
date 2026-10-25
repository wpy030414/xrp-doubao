/**
 * webLogin.ts — 豆包自包含网页扫码登录（纯 HTTP，不依赖豆包电脑版）。
 *
 * 流程（2026-10 实测，详见 docs/DOUBAO_REVERSE.md）：
 *   1) GET  https://www.doubao.com/                 收集 ttwid 等基础 Cookie
 *   2) GET  /passport/safe/csrf_token/?aid=497858   取 passport_csrf_token
 *   3) GET  /passport/web/get_qrcode/?next=...&aid=...  取二维码 PNG + 一次性 token
 *   4) GET  /passport/web/check_qrconnect/?token=...     每 1.5s 轮询
 *        new → scanned → confirmed（confirmed 带 redirect_url）
 *   5) 跟随 redirect_url，收集 sessionid 等会话 Cookie
 *   6) GET  /passport/account/info/v2/  尽力取 uid / nickname（失败不阻断）
 *
 * 插件不经手账号口令；二维码由用户用手机端豆包/抖音扫码确认。
 * 本机不需要安装豆包电脑版，也不读取任何豆包客户端文件。
 */

import { settings } from './config';
import { CookieJar } from './cookieJar';
import { generateDeviceIdentity, type DeviceIdentity } from './device';
import { loginHeaders, accountParams, toQuery } from './securityParams';
import type { StoredSession } from './types';

export type WebLoginStatus = 'idle' | 'new' | 'scanned' | 'confirmed' | 'expired' | 'error';

export interface WebLoginState {
  status: WebLoginStatus;
  message: string;
  uid?: string;
  nickname?: string;
  done: boolean;
  error?: string;
  expireAt?: number;
}

export interface QrCodePayload {
  token: string;
  qrDataUrl: string;
  qrBase64: string;
  expireAt: number;
}

export interface WebLoginOptions {
  baseUrl?: string;
  authBaseUrl?: string;
  aid?: string;
  device?: DeviceIdentity;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

interface ApiEnvelope {
  message?: string;
  data?: any;
  error_code?: number;
  description?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pickString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return String(v);
  }
  return '';
}

export class DoubaoWebLogin {
  readonly baseUrl: string;
  readonly authBaseUrl: string;
  readonly aid: string;
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;

  private jar = new CookieJar();
  private device: DeviceIdentity;
  private qr: QrCodePayload | null = null;
  private state: WebLoginState = { status: 'idle', message: '未开始', done: false };
  private session: StoredSession | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInFlight: Promise<WebLoginState> | null = null;
  private doneResolve: ((s: WebLoginState) => void) | null = null;
  private donePromise: Promise<WebLoginState>;
  private consecutiveErrors = 0;
  private startedAt = 0;

  constructor(opts: WebLoginOptions = {}) {
    this.baseUrl = (opts.baseUrl || settings.baseUrl).replace(/\/+$/, '');
    this.authBaseUrl = (opts.authBaseUrl || settings.authBaseUrl).replace(/\/+$/, '');
    this.aid = opts.aid || settings.aid;
    this.device = opts.device || generateDeviceIdentity();
    this.pollIntervalMs = opts.pollIntervalMs ?? settings.loginPollMs;
    this.timeoutMs = opts.timeoutMs ?? settings.loginTimeoutMs;
    this.donePromise = new Promise((resolve) => {
      this.doneResolve = resolve;
    });
  }

  getDevice(): DeviceIdentity {
    return { ...this.device };
  }

  getJar(): CookieJar {
    return this.jar;
  }

  getQr(): QrCodePayload | null {
    return this.qr ? { ...this.qr } : null;
  }

  getState(): WebLoginState {
    return { ...this.state };
  }

  getSession(): StoredSession | null {
    return this.session ? { ...this.session, cookies: this.session.cookies.map((c) => ({ ...c })) } : null;
  }

  /** 申请二维码；可在登录超时后重复调用刷新 */
  async begin(): Promise<QrCodePayload> {
    this.stopPolling();
    this.jar = new CookieJar();
    this.qr = null;
    this.session = null;
    this.consecutiveErrors = 0;
    this.startedAt = Date.now();
    this.setState({ status: 'idle', message: '正在获取二维码…', done: false });

    // 1) 首页：拿 ttwid 等基础 Cookie（首页可能 302 到 /chat/）
    const home = await this.fetchFollowing(`${this.authBaseUrl}${settings.homePath}`, {
      method: 'GET',
      headers: this.loginHeaders(),
    }).catch(() => null);
    await home?.body?.cancel().catch(() => {});

    // 2) CSRF
    let csrf = this.jar.get('passport_csrf_token') || this.jar.get('passport_csrf_token_default') || '';
    if (!csrf) {
      const csrfUrl = `${this.authBaseUrl}${settings.csrfPath}?aid=${encodeURIComponent(this.aid)}`;
      const res = await this.fetchFollowing(csrfUrl, { method: 'GET', headers: this.loginHeaders() });
      const json = parseJson(await res.text()) as ApiEnvelope | null;
      csrf =
        pickString(json?.data?.passport_csrf_token, json?.data?.csrf_token) ||
        this.jar.get('passport_csrf_token') ||
        this.jar.get('passport_csrf_token_default') ||
        '';
    }

    // 3) 二维码
    const qrUrl =
      `${this.authBaseUrl}${settings.qrPath}?` +
      toQuery({ next: this.baseUrl, aid: this.aid });
    const res = await this.fetchFollowing(qrUrl, { method: 'GET', headers: this.loginHeaders(csrf) });
    const text = await res.text();
    const json = parseJson(text) as ApiEnvelope | null;
    const data = json?.data ?? {};
    const code = Number(data.error_code ?? json?.error_code ?? -1);
    if (!res.ok || !json || json.message !== 'success' || code !== 0) {
      const desc = pickString(data.description, json?.description, json?.message) || `HTTP ${res.status}`;
      throw new Error(`获取二维码失败: ${desc}`);
    }
    const token = pickString(data.token);
    if (!token) throw new Error('获取二维码失败: 响应缺少 token');

    let qrBase64 = '';
    const qrRaw = pickString(data.qrcode, data.qrcode_url);
    if (qrRaw) {
      if (qrRaw.startsWith('data:')) {
        qrBase64 = qrRaw.slice(qrRaw.indexOf(',') + 1);
      } else if (/^https?:\/\//i.test(qrRaw)) {
        const img = await this.fetchFollowing(qrRaw, { method: 'GET', headers: { 'User-Agent': settings.userAgent } });
        qrBase64 = Buffer.from(await img.arrayBuffer()).toString('base64');
      } else {
        qrBase64 = qrRaw;
      }
    } else if (pickString(data.qrcode_index_url)) {
      const img = await this.fetchFollowing(pickString(data.qrcode_index_url), {
        method: 'GET',
        headers: { 'User-Agent': settings.userAgent },
      });
      qrBase64 = Buffer.from(await img.arrayBuffer()).toString('base64');
    }
    if (!qrBase64) throw new Error('获取二维码失败: 响应缺少二维码图片');

    const expireSeconds = Number(data.expire_time);
    const expireAt = Number.isFinite(expireSeconds) && expireSeconds > 0 ? expireSeconds * 1000 : Date.now() + 120_000;
    this.qr = {
      token,
      qrBase64,
      qrDataUrl: `data:image/png;base64,${qrBase64}`,
      expireAt,
    };
    this.setState({
      status: 'new',
      message: '等待扫码',
      done: false,
      expireAt,
    });
    return { ...this.qr };
  }

  /** 单次轮询；页面 / 脚本均可安全重复调用 */
  async pollOnce(): Promise<WebLoginState> {
    if (this.state.done) return this.getState();
    if (this.pollInFlight) return this.pollInFlight;
    this.pollInFlight = this.doPollOnce().finally(() => {
      this.pollInFlight = null;
    });
    return this.pollInFlight;
  }

  private async doPollOnce(): Promise<WebLoginState> {
    if (!this.qr) {
      return this.finish({ status: 'error', message: '二维码尚未获取', done: true, error: 'no-qr' });
    }
    try {
      const url =
        `${this.authBaseUrl}${settings.qrCheckPath}?` +
        toQuery({ next: this.baseUrl, token: this.qr.token, aid: this.aid });
      const res = await this.fetchFollowing(url, { method: 'GET', headers: this.loginHeaders() });
      const json = parseJson(await res.text()) as ApiEnvelope | null;
      const data = json?.data ?? {};
      const code = Number(data.error_code ?? json?.error_code ?? -1);

      if (!res.ok || !json || json.message !== 'success' || code !== 0) {
        const desc = pickString(data.description, json?.description, json?.message, `HTTP ${res.status}`);
        if (/expired|expire|过期|失效/i.test(desc)) {
          this.setState({
            status: 'expired',
            message: '二维码已过期，请刷新',
            done: false,
            error: 'expired',
            expireAt: this.qr?.expireAt,
          });
          return this.getState();
        }
        this.consecutiveErrors += 1;
        if (this.consecutiveErrors >= 5) {
          this.setState({
            status: 'error',
            message: `登录状态检查失败: ${desc}，请刷新二维码重试`,
            done: false,
            error: desc,
          });
          return this.getState();
        }
        this.setState({ ...this.state, message: `等待中（${desc}）` });
        return this.getState();
      }

      this.consecutiveErrors = 0;
      const status = String(data.status || '').toLowerCase();
      if (status === 'new') {
        this.setState({ ...this.state, status: 'new', message: '等待扫码', done: false });
        return this.getState();
      }
      if (status === 'scanned') {
        this.setState({ ...this.state, status: 'scanned', message: '已扫码，请在手机上确认登录', done: false });
        return this.getState();
      }
      if (status === 'confirmed' || status === 'login') {
        return await this.completeLogin(pickString(data.redirect_url, data.redirectUrl));
      }
      if (status === 'expired') {
        this.setState({
          status: 'expired',
          message: '二维码已过期，请刷新',
          done: false,
          error: 'expired',
          expireAt: this.qr?.expireAt,
        });
        return this.getState();
      }
      if (status === 'refused') {
        this.setState({
          status: 'error',
          message: '扫码已被拒绝，请刷新二维码重试',
          done: false,
          error: 'refused',
        });
        return this.getState();
      }
      this.setState({ ...this.state, message: `等待中（${status || '未知状态'}）` });
      return this.getState();
    } catch (e: any) {
      this.consecutiveErrors += 1;
      if (this.consecutiveErrors >= 5) {
        this.setState({
          status: 'error',
          message: `登录轮询失败: ${e.message}，请刷新二维码重试`,
          done: false,
          error: e.message,
        });
        return this.getState();
      }
      this.setState({ ...this.state, message: `网络波动，继续等待…` });
      return this.getState();
    }
  }

  /** 确认后：跟随回跳、收集 Cookie、尽力取账号信息 */
  private async completeLogin(redirectUrl: string): Promise<WebLoginState> {
    this.setState({ ...this.state, status: 'scanned', message: '登录成功，正在保存会话…', done: false });

    if (redirectUrl) {
      try {
        const followed = await this.fetchFollowing(redirectUrl, {
          method: 'GET',
          headers: this.loginHeaders(),
        });
        await followed.body?.cancel().catch(() => {});
      } catch {
        /* 回跳失败不阻断：Cookie 可能已在轮询响应中下发 */
      }
    }

    const account = await this.fetchAccountInfo();
    const uid = account?.uid || this.jar.get('uid_tt') || this.jar.get('uid_tt_ss') || '';
    const nickname = account?.nickname || '';
    const cookies = this.jar.toJSON();
    if (cookies.length === 0) {
      return this.finish({ status: 'error', message: '登录成功但未获得任何 Cookie', done: true, error: 'no-cookie' });
    }
    this.session = {
      cookies,
      device: this.getDevice(),
      uid,
      nickname,
      savedAt: Date.now(),
    };
    return this.finish({
      status: 'confirmed',
      message: '登录成功',
      uid,
      nickname,
      done: true,
      expireAt: this.qr?.expireAt,
    });
  }

  /** 用当前 Cookie 查账号信息（失败返回 null，不阻断登录） */
  async fetchAccountInfo(): Promise<{ uid: string; nickname: string } | null> {
    try {
      const url = `${this.baseUrl}${settings.accountPath}?${toQuery(accountParams())}`;
      const res = await this.fetchFollowing(url, {
        method: 'GET',
        headers: {
          ...this.loginHeaders(),
          'Referer': `${this.baseUrl}/chat/`,
        },
      });
      const json = parseJson(await res.text()) as ApiEnvelope | null;
      const data = json?.data?.data ?? json?.data;
      if (!res.ok || !json || !data) return null;
      const code = Number(data.error_code ?? json.error_code ?? 0);
      if (code !== 0) return null;
      const uid = pickString(data.user_id, data.uid, data.sec_user_id, data.userId);
      const nickname = pickString(data.user_name, data.nickname, data.name, data.unique_id);
      if (!uid && !nickname) return null;
      return { uid, nickname };
    } catch {
      return null;
    }
  }

  /** 开始后台轮询 */
  startPolling(): void {
    if (this.pollTimer) return;
    void this.pollOnce();
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** 阻塞等待登录完成（超时后返回 error 状态） */
  async waitForDone(timeoutMs = this.timeoutMs): Promise<WebLoginState> {
    this.startPolling();
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<WebLoginState>((resolve) => {
      timer = setTimeout(() => {
        resolve(
          this.finish({
            status: 'error',
            message: '登录超时，请重试',
            done: true,
            error: 'timeout',
          }),
        );
      }, timeoutMs);
    });
    try {
      return await Promise.race([this.donePromise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      this.stopPolling();
    }
  }

  /** 刷新二维码（旧二维码作废；不打断正在等待的登录流程；调用方负责重启轮询） */
  async refresh(): Promise<QrCodePayload> {
    this.stopPolling();
    return this.begin();
  }

  private setState(state: WebLoginState): void {
    this.state = state;
    if (settings.debug) {
      console.log(`[doubao-login] ${state.status}: ${state.message}`);
    }
  }

  private finish(state: WebLoginState): WebLoginState {
    this.setState(state);
    this.stopPolling();
    const resolve = this.doneResolve;
    this.doneResolve = null;
    resolve?.(this.getState());
    return this.getState();
  }

  private loginHeaders(csrf?: string): Record<string, string> {
    return loginHeaders(this.jar, csrf);
  }

  /** 手写重定向跟随：每一跳都吸收 Set-Cookie */
  private async fetchFollowing(
    url: string,
    init: { method?: string; headers?: Record<string, string> },
    maxHops = 10,
  ): Promise<Response> {
    let current = /^https?:\/\//i.test(url) ? url : new URL(url, `${this.authBaseUrl}/`).toString();
    for (let hop = 0; hop <= maxHops; hop++) {
      const cookie = this.jar.getCookieHeader(current);
      const headers: Record<string, string> = { ...(init.headers || {}) };
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(current, {
        method: init.method || 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      });
      this.jar.absorb(res.headers, current);
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop === maxHops) throw new Error('登录回跳次数过多');
        current = new URL(location, current).toString();
        continue;
      }
      return res;
    }
    throw new Error('登录回跳次数过多');
  }
}

/** 诊断用：用已有 Cookie 查账号（不抛错） */
export async function queryDoubaoAccount(
  jar: CookieJar,
  opts: { baseUrl?: string } = {},
): Promise<{ uid: string; nickname: string } | null> {
  const base = (opts.baseUrl || settings.baseUrl).replace(/\/+$/, '');
  try {
    const url = `${base}${settings.accountPath}?${toQuery(accountParams())}`;
    const cookie = jar.getCookieHeader(`${base}/`);
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': settings.userAgent,
        'Referer': `${base}/chat/`,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    const json = parseJson(await res.text()) as any;
    const data = json?.data?.data ?? json?.data;
    if (!res.ok || !data) return null;
    const code = Number(data.error_code ?? json.error_code ?? 0);
    if (code !== 0) return null;
    const uid = pickString(data.user_id, data.uid, data.sec_user_id);
    const nickname = pickString(data.user_name, data.nickname, data.name);
    if (!uid && !nickname) return null;
    return { uid, nickname };
  } catch {
    return null;
  }
}

/** 避免未使用告警：sleep 供后续扩展/测试使用 */
export { sleep };
