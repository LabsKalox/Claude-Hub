'use client';
/**
 * Cliente do hub para a PWA e para a ilha web: guarda o token do dispositivo,
 * mantém o WebSocket aberto (com reconexão) e expõe o estado para o React.
 */
import { useSyncExternalStore } from 'react';
import {
  EMPTY_STATE,
  applyServerMessage,
  type Approval,
  type ApprovalDecision,
  type ClientState,
  type HubEvent,
  type HubSettings,
  type ServerMessage,
  type UsageStats,
} from '@claude-hub/shared';

import { PushStepError, enablePush as enablePushSteps, pushApiPresent, pushDiagnostics, registerServiceWorker, type PushStep } from './push';

export type Connection = 'unpaired' | 'connecting' | 'online' | 'offline';

export interface StoreState extends ClientState {
  connection: Connection;
}

const TOKEN_KEY = 'claude-hub.token';

function readToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export class HubError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

class HubStore {
  private state: StoreState = { ...EMPTY_STATE, connection: 'connecting' };
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = (): StoreState => this.state;

  private set(next: Partial<StoreState>): void {
    this.state = { ...this.state, ...next };
    for (const fn of this.listeners) fn();
  }

  /** Chamado uma vez no navegador. Aceita um token vindo no fragmento da URL (#token=…). */
  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    const fromHash = /[#&]token=([^&]+)/.exec(window.location.hash);
    if (fromHash?.[1]) {
      this.saveToken(decodeURIComponent(fromHash[1]));
      // Tira o token da barra de endereços e do histórico.
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    this.token = readToken();
    if (!this.token) {
      this.set({ connection: 'unpaired' });
      return;
    }
    this.connect();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.state.connection !== 'online') this.connect();
    });
    window.addEventListener('online', () => this.connect());
  }

  private saveToken(token: string | null): void {
    try {
      if (token) window.localStorage.setItem(TOKEN_KEY, token);
      else window.localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* armazenamento indisponível (modo privado) */
    }
    this.token = token;
  }

  private connect(): void {
    if (!this.token) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.set({ connection: this.state.ready ? 'offline' : 'connecting' });
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: this.token, client: 'web' }));
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'auth_error') {
        // Token revogado ou inválido: volta para o pareamento.
        this.saveToken(null);
        this.set({ ...EMPTY_STATE, connection: 'unpaired' });
        return;
      }
      if (msg.type === 'snapshot') {
        this.retry = 0;
        this.set({ ...applyServerMessage(this.state, msg), connection: 'online' });
        return;
      }
      if (msg.type === 'pong') return;
      this.set(applyServerMessage(this.state, msg));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (!this.token) return;
      this.set({ connection: 'offline' });
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 25_000);
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(path, {
      ...init,
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new HubError(res.status, typeof body.error === 'string' ? body.error : `http_${res.status}`);
    return body as T;
  }

  async pair(code: string, deviceName: string): Promise<void> {
    const r = await this.api<{ deviceToken: string }>('/api/pair', {
      method: 'POST',
      body: JSON.stringify({ code, deviceName }),
    });
    this.saveToken(r.deviceToken);
    this.started = true;
    this.connect();
  }

  unpair(): void {
    this.saveToken(null);
    this.ws?.close();
    this.set({ ...EMPTY_STATE, connection: 'unpaired' });
  }

  async decide(id: string, decision: ApprovalDecision): Promise<Approval> {
    const r = await this.api<{ approval: Approval }>(`/api/approvals/${encodeURIComponent(id)}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    });
    this.set(applyServerMessage(this.state, { type: 'approval', approval: r.approval }));
    return r.approval;
  }

  async getApproval(id: string): Promise<Approval> {
    return (await this.api<{ approval: Approval }>(`/api/approvals/${encodeURIComponent(id)}`)).approval;
  }

  async updateSettings(patch: Partial<HubSettings>): Promise<void> {
    const r = await this.api<{ settings: HubSettings }>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
    this.set({ settings: r.settings });
  }

  async events(sessionId?: string, limit = 100): Promise<HubEvent[]> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (sessionId) q.set('sessionId', sessionId);
    return (await this.api<{ events: HubEvent[] }>(`/api/events?${q}`)).events;
  }

  async approvalHistory(): Promise<Approval[]> {
    return (await this.api<{ approvals: Approval[] }>('/api/approvals?limit=50')).approvals;
  }

  async usage(): Promise<UsageStats> {
    return (await this.api<{ usage: UsageStats }>('/api/usage')).usage;
  }

  async dismissSession(id: string): Promise<void> {
    await this.api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  clearAlert(): void {
    this.set({ alert: null });
  }

  // ───────────────────────────── Notificações push ────────────────────────────

  pushSupport(): 'ok' | 'needs-install' | 'unsupported' | 'denied' {
    if (typeof window === 'undefined') return 'unsupported';
    if (!pushApiPresent()) {
      // No iPhone, push só existe com a PWA instalada na Tela de Início (iOS 16.4+).
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
      return ios ? 'needs-install' : 'unsupported';
    }
    if (Notification.permission === 'denied') return 'denied';
    return 'ok';
  }

  async pushEnabled(): Promise<boolean> {
    if (this.pushSupport() !== 'ok' || Notification.permission !== 'granted') return false;
    return (await pushDiagnostics()).subscribed;
  }

  /**
   * Ativa as notificações, avisando cada etapa. Precisa ser chamado direto do
   * toque do usuário (exigência do iOS): por isso não é `async` — o pedido de
   * permissão sai antes de qualquer espera.
   */
  enablePush(onProgress: (step: PushStep, stalledMessage?: string) => void): Promise<void> {
    return enablePushSteps({
      publicKey: async () => (await this.api<{ publicKey: string | null }>('/api/push/public-key')).publicKey,
      register: async (subscription) => {
        await this.api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription }) });
      },
      onProgress: (step, stalledMessage) => {
        onProgress(step, stalledMessage);
        if (stalledMessage) void this.reportPush(step, 'stalled', stalledMessage);
      },
    }).then(
      () => void this.reportPush('done', 'ok', ''),
      (err: unknown) => {
        if (err instanceof PushStepError) void this.reportPush(err.step, err.outcome, err.message);
        else void this.reportPush('support', 'failed', err instanceof Error ? err.message : String(err));
        throw err;
      },
    );
  }

  /** Conta ao hub onde "Ativar notificações" parou, para aparecer no diagnóstico do Mac. */
  private async reportPush(step: PushStep, outcome: 'ok' | 'failed' | 'stalled', detail: string): Promise<void> {
    try {
      const d = await pushDiagnostics();
      await this.api('/api/push/client-report', {
        method: 'POST',
        body: JSON.stringify({
          step,
          outcome,
          detail: d.registrationError ? `${detail} [registro do service worker: ${d.registrationError}]` : detail,
          permission: d.permission,
          serviceWorker: d.serviceWorker,
          standalone: d.standalone ? 'sim' : 'não',
          subscribed: d.subscribed ? 'sim' : 'não',
        }),
        signal: AbortSignal.timeout(6000),
      });
    } catch {
      /* o relato é só diagnóstico: nunca atrapalha a tela */
    }
  }

  /**
   * Ao abrir o app: registra o service worker (para já estar ativo no toque) e,
   * se este aparelho já tem inscrição, reenvia ao hub — cobre o caso em que a
   * Apple inscreveu mas o hub não chegou a receber.
   */
  async preparePush(): Promise<void> {
    if (!pushApiPresent()) return;
    try {
      const reg = await registerServiceWorker();
      if (Notification.permission !== 'granted' || !this.token) return;
      const subscription = await reg.pushManager.getSubscription();
      if (subscription) await this.api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: subscription.toJSON() }) });
    } catch {
      /* aparece em "Ativar notificações", com o motivo */
    }
  }

  async disablePush(): Promise<void> {
    const reg = await navigator.serviceWorker.getRegistration('/');
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
    await this.api('/api/push/subscribe', { method: 'DELETE' });
  }

  async testPush(): Promise<PushTestResult> {
    return this.api<PushTestResult>('/api/push/test', { method: 'POST' });
  }
}

export interface PushTestResult {
  delivered: number;
  /** Inscrições deste aparelho que o hub conhece. Ausente em hubs antigos. */
  targets?: number;
  failures?: Array<{ status: number | null; reason: string; host: string }>;
}

export const hub = new HubStore();

const SERVER_STATE: StoreState = { ...EMPTY_STATE, connection: 'connecting' };

export function useHub(): StoreState {
  return useSyncExternalStore(hub.subscribe, hub.getState, () => SERVER_STATE);
}
