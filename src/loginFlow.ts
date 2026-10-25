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

/** 登录流程的公共只读视图（登录页 / 脚本使用） */
export interface LoginFlowView {
  readonly mode: 'douyin' | 'doubao';
  readonly title: string;
  readonly hint: string;
  getState(): WebLoginState;
  getSession(): StoredSession | null;
  refresh(): Promise<unknown>;
}
