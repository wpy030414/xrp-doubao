import type { CookieRecord } from './cookieJar';
import type { DeviceIdentity } from './device';

export interface StoredSession {
  cookies: CookieRecord[];
  device: DeviceIdentity;
  uid: string;
  nickname: string;
  savedAt: number;
  /** 可选的会话过期时间（豆包 session Cookie 通常无显式过期时间） */
  expiresAt?: number;
}

export interface DoubaoAuthState extends StoredSession {
  source: 'env' | 'store' | 'web' | 'cache';
}
