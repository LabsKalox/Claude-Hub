/**
 * Web Push (VAPID) para o iPhone.
 *
 * O conteúdo do push é só informativo: título, texto e a URL a abrir.
 * Um push nunca carrega poder de decisão — aprovar exige abrir a PWA,
 * que se autentica com o token do dispositivo.
 *
 * O que vai para o log e para a auditoria: quantos envios, o código HTTP e o
 * motivo devolvido pelo serviço de push, e o host desse serviço. Nunca o
 * endereço completo da inscrição, as chaves p256dh/auth nem a chave privada.
 */
import webpush from 'web-push';
import { DEFAULT_VAPID_SUBJECT, LEGACY_VAPID_SUBJECT, isValidVapidSubject, type HubConfig } from '@claude-hub/claude-bridge';
import type { Audit } from './audit.js';
import type { Db } from './db.js';

export interface PushPayload {
  kind: 'approval' | 'completed' | 'waiting' | 'error' | 'test';
  title: string;
  body: string;
  /** Caminho dentro da PWA a abrir ao tocar. */
  url: string;
  /** Agrupa/substitui notificações do mesmo assunto. */
  tag: string;
}

export interface PushFailure {
  /** Código HTTP do serviço de push; null quando nem houve resposta (rede). */
  status: number | null;
  /** Motivo como o serviço informou (ex.: "BadJwtToken"), ou o erro de rede. */
  reason: string;
  /** Host do serviço de push (ex.: web.push.apple.com). */
  host: string;
  deviceId: string | null;
}

export interface PushResult {
  at: number;
  kind: PushPayload['kind'];
  /** Inscrições para as quais o envio foi tentado. */
  targets: number;
  delivered: number;
  /** Inscrições vencidas (404/410), apagadas do hub. */
  removed: number;
  failures: PushFailure[];
}

export interface PushSender {
  readonly publicKey: string | null;
  send(payload: PushPayload, onlyDeviceId?: string): Promise<PushResult>;
}

export { DEFAULT_VAPID_SUBJECT, LEGACY_VAPID_SUBJECT, isValidVapidSubject };

/**
 * O subject usado nos envios, por ordem: o que o usuário definiu (se válido),
 * o endereço https do hub, o padrão. As chaves não entram nisso: trocar o
 * subject não invalida nenhuma inscrição.
 */
export function resolveVapidSubject(stored: string | null | undefined, publicUrl: string | null | undefined): string {
  const custom = stored && stored !== LEGACY_VAPID_SUBJECT && stored !== DEFAULT_VAPID_SUBJECT ? stored : null;
  if (custom && isValidVapidSubject(custom)) return custom;
  if (publicUrl) {
    try {
      const origin = new URL(publicUrl).origin;
      if (isValidVapidSubject(origin)) return origin;
    } catch {
      /* URL pública inválida: cai no padrão */
    }
  }
  return DEFAULT_VAPID_SUBJECT;
}

export function ensureVapid(cfg: HubConfig): NonNullable<HubConfig['vapid']> {
  if (cfg.vapid) {
    // Migração: mesmas chaves (as inscrições continuam valendo), subject válido.
    return isValidVapidSubject(cfg.vapid.subject) ? cfg.vapid : { ...cfg.vapid, subject: DEFAULT_VAPID_SUBJECT };
  }
  const keys = webpush.generateVAPIDKeys();
  return { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: DEFAULT_VAPID_SUBJECT };
}

/** Motivo de uma recusa, como o serviço de push escreveu — curto e sem nada sensível. */
export function failureReason(err: unknown): { status: number | null; reason: string } {
  const e = err as { statusCode?: unknown; body?: unknown; code?: unknown; message?: unknown };
  const status = typeof e?.statusCode === 'number' ? e.statusCode : null;
  const body = typeof e?.body === 'string' ? e.body.trim() : '';
  if (status !== null) {
    let reason = body;
    try {
      const parsed = JSON.parse(body) as { reason?: unknown; message?: unknown };
      if (typeof parsed.reason === 'string') reason = parsed.reason;
      else if (typeof parsed.message === 'string') reason = parsed.message;
    } catch {
      /* corpo não é JSON: usa o texto */
    }
    return { status, reason: (reason || 'sem motivo informado').replace(/\s+/g, ' ').slice(0, 200) };
  }
  const code = typeof e?.code === 'string' ? e.code : '';
  const message = typeof e?.message === 'string' ? e.message : 'falha de rede';
  return { status: null, reason: (code || message).replace(/\s+/g, ' ').slice(0, 200) };
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'endereço inválido';
  }
}

type Transport = (subscription: webpush.PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<unknown>;

export interface WebPushOptions {
  log?: (msg: string) => void;
  audit?: Audit;
  /** Só para testes: troca a chamada de rede. */
  transport?: Transport;
}

const LAST_KEY = 'push.last';

/** Último envio registrado (sobrevive ao reinício do hub). */
export function lastPushResult(db: Db): PushResult | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(LAST_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as PushResult;
  } catch {
    return null;
  }
}

export class WebPushSender implements PushSender {
  readonly publicKey: string;
  private readonly log: (msg: string) => void;
  private readonly audit: Audit | null;
  private readonly transport: Transport;

  constructor(
    private readonly db: Db,
    private readonly vapid: NonNullable<HubConfig['vapid']>,
    readonly subject: string,
    options: WebPushOptions = {},
  ) {
    this.publicKey = vapid.publicKey;
    this.log = options.log ?? (() => {});
    this.audit = options.audit ?? null;
    this.transport = options.transport ?? ((sub, payload, opts) => webpush.sendNotification(sub, payload, opts));
  }

  async send(payload: PushPayload, onlyDeviceId?: string): Promise<PushResult> {
    const rows = (
      onlyDeviceId
        ? this.db.prepare('SELECT endpoint, device_id, json FROM push_subscriptions WHERE device_id = ?').all(onlyDeviceId)
        : this.db.prepare('SELECT endpoint, device_id, json FROM push_subscriptions').all()
    ) as unknown as Array<{ endpoint: string; device_id: string; json: string }>;
    const result: PushResult = { at: Date.now(), kind: payload.kind, targets: rows.length, delivered: 0, removed: 0, failures: [] };
    await Promise.all(
      rows.map(async (row) => {
        try {
          await this.transport(JSON.parse(row.json) as webpush.PushSubscription, JSON.stringify(payload), {
            vapidDetails: { subject: this.subject, publicKey: this.vapid.publicKey, privateKey: this.vapid.privateKey },
            TTL: payload.kind === 'approval' ? 300 : 3600,
            urgency: payload.kind === 'approval' ? 'high' : 'normal',
            timeout: 10_000,
          });
          result.delivered++;
        } catch (err) {
          const { status, reason } = failureReason(err);
          if (status === 404 || status === 410) {
            // Inscrição vencida ou removida no aparelho.
            this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(row.endpoint);
            result.removed++;
          }
          result.failures.push({ status, reason, host: hostOf(row.endpoint), deviceId: row.device_id });
        }
      }),
    );
    this.report(result);
    return result;
  }

  private report(result: PushResult): void {
    // Sem nenhuma inscrição não houve envio: não há o que registrar.
    if (result.targets === 0) return;
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(LAST_KEY, JSON.stringify(result));
    if (result.delivered > 0) {
      this.log(`push.sent tipo=${result.kind} entregues=${result.delivered}/${result.targets}`);
      this.audit?.record({ at: result.at, actor: 'hub', action: 'push.sent', detail: `tipo=${result.kind} entregues=${result.delivered}/${result.targets}` });
    }
    for (const f of result.failures) {
      const detail = `tipo=${result.kind} dispositivo=${f.deviceId ?? '?'} serviço=${f.host} status=${f.status ?? 'sem resposta'} motivo=${f.reason}${
        f.status === 404 || f.status === 410 ? ' (inscrição vencida, removida)' : ''
      }`;
      this.log(`push.failed ${detail}`);
      this.audit?.record({ at: result.at, actor: 'hub', action: 'push.failed', detail });
    }
  }
}

export function isValidSubscription(sub: unknown): sub is { endpoint: string; keys: { p256dh: string; auth: string } } {
  if (!sub || typeof sub !== 'object') return false;
  const s = sub as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  return (
    typeof s.endpoint === 'string' &&
    /^https:\/\//.test(s.endpoint) &&
    s.endpoint.length < 2048 &&
    typeof s.keys?.p256dh === 'string' &&
    typeof s.keys?.auth === 'string'
  );
}

/** Host do serviço de push de uma inscrição, para log e auditoria. */
export function subscriptionHost(sub: { endpoint: string }): string {
  return hostOf(sub.endpoint);
}
