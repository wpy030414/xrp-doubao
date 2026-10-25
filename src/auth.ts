/**
 * auth.ts — 自包含凭证管理（不依赖豆包电脑版）。
 *
 * 获取顺序：
 *   1) 内存缓存
 *   2) 本地加密凭证（DPAPI / AES / 明文）
 *   3) DOUBAO_COOKIES 灾备
 *   4) 网页扫码登录（默认仅 pnpm log-in；服务态需 DOUBAO_AUTO_LOGIN=1）
 *
 * 豆包网页登录不返回 refresh token；会话失效时只能重新扫码。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { settings } from './config';
import { CookieJar } from './cookieJar';
import * as store from './credentialStore';
import { generateDeviceIdentity, normalizeDeviceIdentity, type DeviceIdentity } from './device';
import { DoubaoWebLogin, queryDoubaoAccount } from './webLogin';
import { DouyinOAuthLogin } from './douyinLogin';
import { startLoginServer, type LoginServer } from './loginPage';
import { openExternal } from './openBrowser';
import type { DoubaoAuthState, StoredSession } from './types';

let cached: DoubaoAuthState | null = null;
let loginInFlight: Promise<DoubaoAuthState> | null = null;
let lastAuthError = '';

function storeOpts() {
  return { file: settings.credentialPath, mode: settings.storeMode, secret: settings.authSecret || undefined };
}

function normalizeSession(input: any): StoredSession | null {
  if (!input || typeof input !== 'object') return null;
  let cookies = input.cookies;
  if (!Array.isArray(cookies)) {
    // 兼容只保存了 name→value 映射的旧格式
    if (cookies && typeof cookies === 'object') {
      const jar = new CookieJar();
      jar.seedCookieHeader(
        Object.entries(cookies)
          .filter(([, v]) => typeof v === 'string')
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
      );
      cookies = jar.toJSON();
    } else {
      cookies = [];
    }
  }
  if (!Array.isArray(cookies) || cookies.length === 0) return null;
  return {
    cookies,
    device: normalizeDeviceIdentity(input.device),
    uid: typeof input.uid === 'string' ? input.uid : '',
    nickname: typeof input.nickname === 'string' ? input.nickname : '',
    savedAt: typeof input.savedAt === 'number' ? input.savedAt : Date.now(),
    expiresAt: typeof input.expiresAt === 'number' ? input.expiresAt : undefined,
  };
}

/** 读本地凭证存储；缺失或损坏返回 null */
export function readStore(): DoubaoAuthState | null {
  try {
    const blob = store.readBlob(settings.credentialPath);
    if (!blob) return null;
    const raw = store.open<StoredSession>(storeOpts(), blob);
    const session = normalizeSession(raw);
    if (!session) return null;
    return { ...session, source: 'store' };
  } catch (e: any) {
    console.warn(`[doubao] 读取本地凭证失败: ${e.message}`);
    return null;
  }
}

/** 原子写本地凭证存储（加密形态自动选择） */
export function writeStore(state: DoubaoAuthState): void {
  try {
    const session: StoredSession = {
      cookies: state.cookies,
      device: state.device,
      uid: state.uid,
      nickname: state.nickname,
      savedAt: state.savedAt,
      expiresAt: state.expiresAt,
    };
    const rec = store.seal(storeOpts(), session);
    store.writeBlob(settings.credentialPath, rec.blob);
  } catch (e: any) {
    console.warn(`[doubao] 写入本地凭证失败: ${e.message}`);
  }
}

function loadFromEnv(): DoubaoAuthState | null {
  if (!settings.cookiesEnv) return null;
  const jar = new CookieJar();
  jar.seedCookieHeader(settings.cookiesEnv);
  if (jar.size() === 0) return null;
  const device = normalizeDeviceIdentity({
    deviceId: settings.deviceIdEnv || undefined,
    webId: settings.webIdEnv || undefined,
    fp: settings.fpEnv || undefined,
  });
  return {
    cookies: jar.toJSON(),
    device,
    uid: settings.uidEnv,
    nickname: '',
    savedAt: Date.now(),
    source: 'env',
  };
}

export function jarOf(state: Pick<DoubaoAuthState, 'cookies'>): CookieJar {
  return CookieJar.fromJSON(state.cookies);
}

export interface InteractiveLoginOptions {
  /** 是否自动打开登录页（默认 true） */
  openBrowser?: boolean;
  onLoginPage?: (url: string) => void;
  signal?: AbortSignal;
}

function abortPromise(signal?: AbortSignal): Promise<never> | null {
  if (!signal) return null;
  return new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Error('登录已取消'));
    signal.addEventListener('abort', () => reject(new Error('登录已取消')), { once: true });
  });
}

function persistLogin(session: StoredSession): DoubaoAuthState {
  const auth: DoubaoAuthState = { ...session, source: 'web' };
  writeStore(auth);
  cached = auth;
  lastAuthError = '';
  const kind = store.describeKind(store.readBlob(settings.credentialPath));
  console.log(
    `登录成功：uid=${auth.uid || '<空>'} 账号=${auth.nickname || '未知'} Cookie=${auth.cookies.length} 条`,
  );
  console.log(`凭证已加密保存到 ${settings.credentialPath}（存储形态 ${kind}）`);
  return auth;
}

/** 抖音 OAuth：Playwright 打开官方授权页，截获回调 code 后换票 */
async function interactiveDouyinLogin(opts: InteractiveLoginOptions): Promise<DoubaoAuthState> {
  if (opts.openBrowser === false) {
    throw new Error(
      '抖音 OAuth 登录需要打开浏览器窗口以捕获回调；请去掉 --no-browser，' +
        '或设置 DOUBAO_LOGIN_FLOW=doubao 使用本机扫码页。',
    );
  }
  const flow = new DouyinOAuthLogin();
  console.log('\n=== 抖音授权登录 ===');
  console.log(`正在打开浏览器（${Math.round(settings.loginTimeoutMs / 60000)} 分钟内有效）…`);
  console.log('浏览器会自动进入豆包登录弹窗 → 抖音官方授权页。');
  console.log('请在抖音页面扫码，或在页面上选择验证码授权。');
  console.log('授权完成后插件从浏览器上下文取出豆包会话并加密落盘。');
  console.log('本流程不读取豆包电脑版的任何文件或凭证。\n');

  opts.onLoginPage?.(`${settings.douyinOauthBaseUrl}/platform/oauth/connect`);
  const state = await flow.run({ timeoutMs: settings.loginTimeoutMs, signal: opts.signal });
  if (state.status !== 'confirmed') {
    throw new Error(state.error ? `${state.message}（${state.error}）` : state.message);
  }
  const session = flow.getSession();
  if (!session) throw new Error('登录成功但未获得会话');
  return persistLogin(session);
}

/** 豆包扫码：本机展示豆包网页登录二维码 */
async function interactiveDoubaoQrLogin(opts: InteractiveLoginOptions): Promise<DoubaoAuthState> {
  const flow = new DoubaoWebLogin();
  const qr = await flow.begin();
  let server: LoginServer | null = null;
  let qrFile: string | null = null;
  try {
    server = await startLoginServer(flow, settings.loginPort);
    console.log('\n=== 豆包网页登录 ===');
    console.log(`请在浏览器打开登录页（${Math.round(settings.loginTimeoutMs / 60000)} 分钟内有效）：`);
    console.log(`  ${server.url}\n`);
    console.log('用手机端豆包 / 抖音扫描页面中的二维码，并确认登录。');
    console.log('本流程不读取豆包电脑版的任何文件或凭证。\n');

    try {
      qrFile = path.join(os.tmpdir(), `xrp-doubao-login-qr-${process.pid}.png`);
      fs.writeFileSync(qrFile, Buffer.from(qr.qrBase64, 'base64'), { mode: 0o600 });
      console.log(`二维码图片（备用）：${qrFile}\n`);
    } catch {
      qrFile = null;
    }

    opts.onLoginPage?.(server.url);
    if (opts.openBrowser !== false) openExternal(server.url);

    const abort = abortPromise(opts.signal);
    flow.startPolling();
    const state = await (abort ? Promise.race([flow.waitForDone(), abort]) : flow.waitForDone());
    if (state.status !== 'confirmed') {
      throw new Error(state.error ? `${state.message}（${state.error}）` : state.message);
    }
    const session = flow.getSession();
    if (!session) throw new Error('登录成功但未获得会话');
    return persistLogin(session);
  } finally {
    flow.stopPolling();
    if (server) await server.close().catch(() => {});
    if (qrFile) {
      try {
        fs.unlinkSync(qrFile);
      } catch {
        /* 忽略 */
      }
    }
  }
}

/**
 * 交互式网页登录：默认直接打开抖音官方授权页；DOUBAO_LOGIN_FLOW=doubao 时改用豆包扫码页。
 * 不读取豆包电脑版，不依赖本机安装的豆包 App。
 */
export async function interactiveLogin(opts: InteractiveLoginOptions = {}): Promise<DoubaoAuthState> {
  if (loginInFlight) return loginInFlight;
  loginInFlight = (async () => {
    if (settings.loginFlow === 'doubao') return interactiveDoubaoQrLogin(opts);
    return interactiveDouyinLogin(opts);
  })().finally(() => {
    loginInFlight = null;
  });
  return loginInFlight;
}

/**
 * 获取有效会话：缓存 → 本地存储 → 灾备 Cookie →（可选）网页登录。
 */
export async function getSession(): Promise<DoubaoAuthState> {
  if (cached) return cached;
  const fromStore = readStore();
  if (fromStore) {
    cached = fromStore;
    return cached;
  }
  const fromEnv = loadFromEnv();
  if (fromEnv) {
    cached = fromEnv;
    return cached;
  }
  if (!settings.autoLogin) {
    throw new Error(
      '无有效登录态。请先运行 `pnpm log-in` 完成网页扫码登录，' +
        '或在 .env 设置 DOUBAO_AUTO_LOGIN=1 允许服务自动发起登录。',
    );
  }
  return interactiveLogin();
}

/** 会话失效时调用：清缓存；autoLogin 开启则重新扫码 */
export async function forceRelogin(reason = '会话已失效'): Promise<DoubaoAuthState> {
  cached = null;
  lastAuthError = reason;
  if (!settings.autoLogin) {
    throw new Error(`${reason}，请运行 \`pnpm log-in\` 重新扫码登录`);
  }
  return interactiveLogin();
}

export function markAuthError(reason: string): void {
  lastAuthError = reason;
  cached = null;
}

export function getCachedAuth(): DoubaoAuthState | null {
  return cached;
}

export function getLastAuthError(): string {
  return lastAuthError;
}

export interface AuthStatus {
  loggedIn: boolean;
  uid?: string;
  nickname?: string;
  source?: string;
  cookieCount: number;
  cookieNames: string[];
  savedAt?: string;
  credentialPath: string;
  storeKind: string;
  deviceId?: string;
  lastError?: string;
}

export function getAuthStatus(): AuthStatus {
  const kind = store.describeKind(store.readBlob(settings.credentialPath));
  let state: DoubaoAuthState | null = cached;
  if (!state) {
    state = readStore() ?? loadFromEnv();
  }
  if (!state) {
    return {
      loggedIn: false,
      cookieCount: 0,
      cookieNames: [],
      credentialPath: settings.credentialPath,
      storeKind: kind,
      ...(lastAuthError ? { lastError: lastAuthError } : {}),
    };
  }
  const jar = jarOf(state);
  return {
    loggedIn: jar.size() > 0,
    uid: state.uid || undefined,
    nickname: state.nickname || undefined,
    source: state.source,
    cookieCount: jar.size(),
    cookieNames: jar.names(),
    savedAt: new Date(state.savedAt).toISOString(),
    credentialPath: settings.credentialPath,
    storeKind: kind,
    deviceId: state.device.deviceId,
    ...(lastAuthError ? { lastError: lastAuthError } : {}),
  };
}

/** 启动期无阻塞探测：填充缓存但不触发登录 */
export function initTokenManager(): void {
  cached = readStore() ?? loadFromEnv();
}

/** 采纳外部凭据（诊断 / 测试用） */
export function adoptCredential(state: DoubaoAuthState): void {
  cached = state;
}

/** 用已有会话查账号信息（诊断用，不抛错） */
export async function fetchAccountInfo(state?: DoubaoAuthState): Promise<{ uid: string; nickname: string } | null> {
  const s = state ?? cached ?? readStore() ?? loadFromEnv();
  if (!s) return null;
  return queryDoubaoAccount(jarOf(s), { baseUrl: settings.baseUrl });
}

/** 构造一个测试/灾备可用的 State（不落盘） */
export function makeState(input: {
  cookieHeader: string;
  uid?: string;
  nickname?: string;
  device?: Partial<DeviceIdentity>;
  source?: DoubaoAuthState['source'];
  /** 灾备 Cookie 播种所用的 URL；默认 https://www.doubao.com/ */
  baseUrl?: string;
}): DoubaoAuthState {
  const jar = new CookieJar();
  jar.seedCookieHeader(input.cookieHeader, input.baseUrl || 'https://www.doubao.com/');
  return {
    cookies: jar.toJSON(),
    device: normalizeDeviceIdentity(input.device),
    uid: input.uid || '',
    nickname: input.nickname || '',
    savedAt: Date.now(),
    source: input.source || 'env',
  };
}

export { generateDeviceIdentity };
