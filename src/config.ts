import dotenv from 'dotenv';
import os from 'node:os';
import path from 'node:path';

dotenv.config();

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function envInt(key: string, fallback: number): number {
  const v = parseInt(env(key, String(fallback)), 10);
  return Number.isFinite(v) ? v : fallback;
}

/** 自包含凭证文件默认落在用户数据目录，不进仓库 */
function detectCredentialPath(): string {
  const base =
    process.env.XDG_DATA_HOME ||
    (process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : path.join(os.homedir(), '.local', 'share'));
  return path.join(base.replace(/\/+$/, ''), 'xrp-doubao', 'doubao-credential.json');
}

/**
 * 豆包网页端的模式菜单（逆向自 /chat 页面 SSR 的 menu_item_list）。
 * model_item_key 是上游真正识别的模型键；mode_id 区分对话（1）与工作任务（3）。
 */
export interface DoubaoModelPreset {
  id: string;
  name: string;
  itemId: number;
  /** 网页菜单的 menu_type，同时也是 need_deep_think / ext.use_deep_think 的值 */
  menuType: number;
  modelItemKey: string;
  modeId: string;
  agentMode: number;
  reasoningEffort: 3 | 4 | 5;
  deepThink: boolean;
  /** 网页端 model_config.model_extra_params */
  modelExtraParams?: Record<string, string>;
}

export const MODEL_PRESETS: Record<string, DoubaoModelPreset> = {
  'doubao-fast': {
    id: 'doubao-fast',
    name: '豆包 · 快速',
    itemId: 0,
    menuType: 0,
    modelItemKey: '0',
    modeId: '1',
    agentMode: 2,
    reasoningEffort: 3,
    deepThink: false,
  },
  'doubao-expert': {
    id: 'doubao-expert',
    name: '豆包 · 专家',
    itemId: 3,
    menuType: 3,
    modelItemKey: '3',
    modeId: '1',
    agentMode: 2,
    reasoningEffort: 4,
    deepThink: true,
    modelExtraParams: { total_window_size: '256000' },
  },
  'doubao-work': {
    id: 'doubao-work',
    name: '豆包 · 工作任务 Auto',
    itemId: 9,
    menuType: 9,
    modelItemKey: '9',
    modeId: '3',
    agentMode: 1,
    reasoningEffort: 5,
    deepThink: false,
    modelExtraParams: { total_window_size: '256000' },
  },
  'doubao-work-pro': {
    id: 'doubao-work-pro',
    name: '豆包 · 工作任务 Pro',
    itemId: 5,
    menuType: 5,
    modelItemKey: '5',
    modeId: '3',
    agentMode: 1,
    reasoningEffort: 5,
    deepThink: false,
    modelExtraParams: { total_window_size: '256000' },
  },
  'doubao-2.1-lite': {
    id: 'doubao-2.1-lite',
    name: '豆包 2.1 Lite',
    itemId: 10001,
    menuType: 10001,
    modelItemKey: 'seed-lite-7b',
    modeId: '3',
    agentMode: 1,
    reasoningEffort: 5,
    deepThink: false,
    modelExtraParams: { memory_profile: '256k', total_window_size: '256000' },
  },
};

/** 面向客户端的短别名（会作为独立模型注册） */
export const MODEL_ALIASES: Record<string, string> = {
  doubao: 'doubao-fast',
  'doubao-pro': 'doubao-expert',
  'doubao-think': 'doubao-expert',
};

export const DEFAULT_MODEL = 'doubao-fast';

export function resolveModelPreset(id: string | undefined): DoubaoModelPreset {
  const name = (id || '').trim();
  if (!name) return MODEL_PRESETS[DEFAULT_MODEL];
  if (MODEL_PRESETS[name]) return MODEL_PRESETS[name];
  const alias = MODEL_ALIASES[name];
  if (alias && MODEL_PRESETS[alias]) return MODEL_PRESETS[alias];
  return MODEL_PRESETS[DEFAULT_MODEL];
}

export function defaultModelIds(): string[] {
  return [...Object.keys(MODEL_PRESETS), ...Object.keys(MODEL_ALIASES)];
}

export interface Settings {
  port: number;
  loginPort: number;

  // —— 豆包网关 ——
  baseUrl: string;
  authBaseUrl: string;
  aid: string;
  desktopAid: string;
  pcVersion: string;
  botId: string;
  userAgent: string;
  chatMode: 'auto' | 'chat' | 'samantha';
  homePath: string;
  chatPath: string;
  legacyChatPath: string;
  accountPath: string;
  /** 网页登录 */
  qrPath: string;
  qrCheckPath: string;
  csrfPath: string;

  // —— 自包含凭证 ——
  credentialPath: string;
  storeMode: 'auto' | 'dpapi' | 'aes' | 'plain';
  authSecret: string;

  // —— 登录行为 ——
  loginFlow: 'douyin' | 'doubao';
  douyinOauthBaseUrl: string;
  douyinClientKey: string;
  douyinScope: string;
  douyinOptionalScope: string;
  /** 抖音开放平台白名单内的回调；不能用 localhost（会被判“非法重定向链接”） */
  douyinRedirectUri: string;
  /** Playwright 浏览器通道：空 = 按平台自动选择 */
  browserChannel: string;
  loginHeadless: boolean;
  loginTimeoutMs: number;
  loginPollMs: number;
  autoLogin: boolean;

  // —— 请求 ——
  requestTimeoutMs: number;

  // —— 附件上传（ImageX）——
  uploadEnabled: boolean;
  maxAttachmentBytes: number;
  maxAttachments: number;
  allowPrivateUrls: boolean;
  uploadTimeoutMs: number;
  prepareUploadPath: string;
  preHandlePath: string;
  topPath: string;
  uploadTenantId: string;
  uploadSceneId: string;

  // —— 会话清理 ——
  autoDeleteConversation: boolean;
  cleanupTimeoutMs: number;

  // —— 思考展示 ——
  emitThinkingSummary: boolean;

  // —— 模型注册 ——
  availableModels: string[];

  // —— 灾备凭证 ——
  cookiesEnv: string;
  uidEnv: string;

  // —— 设备标识（可选覆盖）——
  deviceIdEnv: string;
  webIdEnv: string;
  fpEnv: string;

  // —— xrl-router ——
  xrlRouterUrl: string;
  debug: boolean;
}

export const settings: Settings = {
  port: parseInt(env('DOUBAO_PORT', '19071'), 10),
  loginPort: parseInt(env('DOUBAO_LOGIN_PORT', '19100'), 10),

  baseUrl: env('DOUBAO_BASE_URL', 'https://www.doubao.com').replace(/\/+$/, ''),
  authBaseUrl: env('DOUBAO_AUTH_BASE_URL', env('DOUBAO_BASE_URL', 'https://www.doubao.com')).replace(/\/+$/, ''),
  aid: env('DOUBAO_AID', '497858'),
  desktopAid: env('DOUBAO_DESKTOP_AID', '582478'),
  pcVersion: env('DOUBAO_PC_VERSION', '3.42.5'),
  botId: env('DOUBAO_BOT_ID', '7338286299411103781'),
  userAgent: env(
    'DOUBAO_USER_AGENT',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  ),
  chatMode: (env('DOUBAO_CHAT_MODE', 'auto') as Settings['chatMode']),
  homePath: env('DOUBAO_HOME_PATH', '/'),
  chatPath: env('DOUBAO_CHAT_PATH', '/chat/completion'),
  legacyChatPath: env('DOUBAO_LEGACY_CHAT_PATH', '/samantha/chat/completion'),
  accountPath: env('DOUBAO_ACCOUNT_PATH', '/passport/account/info/v2/'),
  qrPath: env('DOUBAO_QR_PATH', '/passport/web/get_qrcode/'),
  qrCheckPath: env('DOUBAO_QR_CHECK_PATH', '/passport/web/check_qrconnect/'),
  csrfPath: env('DOUBAO_CSRF_PATH', '/passport/safe/csrf_token/'),

  credentialPath: env('DOUBAO_CREDENTIAL_PATH', detectCredentialPath()),
  storeMode: (env('DOUBAO_STORE_MODE', 'auto') as Settings['storeMode']),
  authSecret: env('DOUBAO_AUTH_SECRET', ''),

  loginFlow: (env('DOUBAO_LOGIN_FLOW', 'douyin') as Settings['loginFlow']),
  douyinOauthBaseUrl: env('DOUBAO_DOUYIN_OAUTH_BASE_URL', 'https://open.douyin.com').replace(/\/+$/, ''),
  douyinClientKey: env('DOUBAO_DOUYIN_CLIENT_KEY', 'aw4293rjg7ggbx9m'),
  douyinScope: env('DOUBAO_DOUYIN_SCOPE', 'user_info,mobile'),
  douyinOptionalScope: env('DOUBAO_DOUYIN_OPTIONAL_SCOPE', 'mobile,1'),
  douyinRedirectUri: env('DOUBAO_DOUYIN_REDIRECT_URI', 'https://www.doubao.com/auth/callback'),
  browserChannel: env('DOUBAO_BROWSER_CHANNEL', ''),
  loginHeadless: envBool('DOUBAO_LOGIN_HEADLESS', false),
  loginTimeoutMs: parseInt(env('DOUBAO_LOGIN_TIMEOUT_MS', String(5 * 60_000)), 10),
  loginPollMs: parseInt(env('DOUBAO_LOGIN_POLL_MS', '1500'), 10),
  autoLogin: envBool('DOUBAO_AUTO_LOGIN', false),

  requestTimeoutMs: parseInt(env('DOUBAO_REQUEST_TIMEOUT_MS', '600000'), 10),

  uploadEnabled: envBool('DOUBAO_UPLOAD', true),
  maxAttachmentBytes: Math.max(1, envInt('DOUBAO_MAX_ATTACHMENT_MB', 20)) * 1024 * 1024,
  maxAttachments: Math.max(1, envInt('DOUBAO_MAX_ATTACHMENTS', 10)),
  allowPrivateUrls: envBool('DOUBAO_ALLOW_PRIVATE_URLS', false),
  uploadTimeoutMs: Math.max(1000, envInt('DOUBAO_UPLOAD_TIMEOUT_MS', 120000)),
  prepareUploadPath: env('DOUBAO_PREPARE_UPLOAD_PATH', '/alice/resource/prepare_upload'),
  preHandlePath: env('DOUBAO_PRE_HANDLE_PATH', '/alice/message/pre_handle_v2_without_conv'),
  topPath: env('DOUBAO_TOP_PATH', '/top/v1'),
  uploadTenantId: env('DOUBAO_UPLOAD_TENANT_ID', '5'),
  uploadSceneId: env('DOUBAO_UPLOAD_SCENE_ID', '5'),

  autoDeleteConversation: envBool('DOUBAO_AUTO_DELETE_CONVERSATION', true),
  cleanupTimeoutMs: Math.max(1000, envInt('DOUBAO_CLEANUP_TIMEOUT_MS', 10000)),

  emitThinkingSummary: envBool('DOUBAO_THINKING_SUMMARY', true),

  availableModels: (process.env.DOUBAO_MODELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  cookiesEnv: env('DOUBAO_COOKIES', ''),
  uidEnv: env('DOUBAO_UID', ''),

  deviceIdEnv: env('DOUBAO_DEVICE_ID', ''),
  webIdEnv: env('DOUBAO_WEB_ID', ''),
  fpEnv: env('DOUBAO_FP', ''),

  xrlRouterUrl: env('XRL_ROUTER_URL', 'http://localhost:19068'),
  debug: envBool('DOUBAO_DEBUG', false),
};
