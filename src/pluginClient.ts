/**
 * pluginClient.ts — 连接 xrl-router 的 WebSocket 客户端（V24 契约）。
 *
 * - 启动时注册（不带 keys）
 * - 每 30s 心跳；断线指数退避重连（1s → 60s）
 * - 容忍 Router 未就绪
 */

import { WebSocket } from 'ws';
import { defaultModelIds, settings } from './config';

export const PLUGIN_ID = 'plugin-doubao';
const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

export interface RegisteredModel {
  model_id: string;
  display_name: string;
  tier: string;
}

export function registeredModels(): RegisteredModel[] {
  const ids = settings.availableModels.length > 0 ? settings.availableModels : defaultModelIds();
  return ids.map((id) => ({ model_id: id, display_name: id, tier: 'custom' }));
}

export function buildRegisterPayload(): any {
  return {
    type: 'register',
    plugin_id: PLUGIN_ID,
    provider: {
      kind: 'chat_completions',
      base_url: `http://localhost:${settings.port}`,
      api_path: '/v1/chat/completions',
    },
    models: registeredModels(),
    workdir: process.cwd(),
  };
}

export class PluginClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private started = false;

  constructor() {
    void this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  private connect(): void {
    const wsUrl = settings.xrlRouterUrl.replace(/^http/, 'ws') + '/ws/plugin';
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      console.log('[PluginClient] Connected to xrl-router');
      this.reconnectAttempts = 0;
      this.sendRegister();
      this.startHeartbeat();
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data.toString());
    });

    this.ws.on('close', () => {
      console.log('[PluginClient] Disconnected from xrl-router');
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    this.ws.on('error', (error) => {
      console.error('[PluginClient] WebSocket error:', error.message);
    });
  }

  private sendRegister(): void {
    const payload = buildRegisterPayload();
    this.send(payload);
    console.log(`[PluginClient] Registered ${payload.models.length} models as ${PLUGIN_ID}`);
  }

  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'error') {
        console.error(`[PluginClient] Router error: ${msg.reason}`);
      }
    } catch {
      /* 无法解析的消息忽略 */
    }
  }

  private send(message: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'heartbeat' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts), RECONNECT_MAX_MS);
    console.log(`[PluginClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  public close(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
