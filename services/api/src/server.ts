/**
 * Dois servidores HTTP, com superfícies diferentes:
 *
 *  - LOCAL  (127.0.0.1): hooks do Claude Code, app macOS, CLI e administração.
 *  - PÚBLICO (iPhone):   PWA + API de dispositivos pareados. Não expõe hooks
 *                        nem rotas administrativas.
 *
 * Separar por porta (e não por IP de origem) é o que mantém a divisão válida
 * mesmo atrás de um túnel como `tailscale serve`, em que tudo chega de 127.0.0.1.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import {
  APPROVAL_STATUSES,
  PROTOCOL_VERSION,
  type ApprovalStatus,
  type ClientMessage,
  type ServerMessage,
} from '@claude-hub/shared';
import { AGENT_USAGE_PATH, HOOK_PATH, OTEL_PATH, STATUSLINE_PATH, loadConfig, parseHookPayload, type HubConfig } from '@claude-hub/claude-bridge';
import { parseAgentUsage, type AgentUsageStore } from './agent-usage.js';
import type { CodexRolloutReader } from './codex-rollout.js';
import type { ConsumptionStore } from './consumption.js';
import type { Audit } from './audit.js';
import { bearer, safeEqual, type Auth } from './auth.js';
import type { Db } from './db.js';
import type { Hub } from './hub.js';
import { isValidSubscription, lastPushResult, subscriptionHost, type PushSender } from './push.js';

export const VERSION = '0.5.2';

export interface ServerDeps {
  hub: Hub;
  auth: Auth;
  audit: Audit;
  db: Db;
  push: PushSender | null;
  /** Linhas de push para o hub.log. */
  pushLog?: (msg: string) => void;
  consumption?: ConsumptionStore;
  /** Consumo do Codex e do OpenCode. */
  agentUsage?: AgentUsageStore;
  /** Leitor do arquivo de sessão do Codex (consumo, limites, plano, erro). */
  codexRollout?: CodexRolloutReader;
  config: HubConfig;
  /** Pasta com a PWA exportada (apps/web/out); opcional. */
  webDir?: string;
  logger?: boolean;
}

type Role = 'local' | 'public';
interface Actor {
  /** Identificador para auditoria: "mac" ou o id do dispositivo. */
  id: string;
  deviceId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

const short = (value: unknown, max: number): string =>
  (typeof value === 'string' ? value : typeof value === 'boolean' || typeof value === 'number' ? String(value) : '')
    .replace(/[\u0000-\u001f"]+/g, ' ')
    .trim()
    .slice(0, max);

/** Relato da PWA sobre "Ativar notificações", reduzido a campos curtos e sem nada sensível. */
export function clientPushReport(body: unknown): {
  step: string;
  outcome: 'ok' | 'failed' | 'stalled';
  permission: string;
  serviceWorker: string;
  standalone: string;
  subscribed: string;
  detail: string;
} | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const step = short(b.step, 24);
  const outcome = b.outcome === 'ok' || b.outcome === 'failed' || b.outcome === 'stalled' ? b.outcome : null;
  if (!/^[a-z-]{2,24}$/.test(step) || !outcome) return null;
  return {
    step,
    outcome,
    permission: short(b.permission, 16) || '?',
    serviceWorker: short(b.serviceWorker, 16) || '?',
    standalone: short(b.standalone, 8) || '?',
    subscribed: short(b.subscribed, 8) || '?',
    // Mensagens de erro do navegador podem citar o endereço da inscrição: corta URLs.
    detail: short(b.detail, 300).replace(/https?:\/\/\S+/g, '(url)'),
  };
}

function createApp(deps: ServerDeps, role: Role): FastifyInstance {
  const { hub, auth, audit, db, push, config } = deps;
  const pushLog = deps.pushLog ?? (() => {});
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 64 * 1024, trustProxy: false });

  app.addHook('onSend', async (_req, reply) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
  });

  /** Resolve quem está chamando, conforme a porta. */
  const identify = (token: string | null): Actor | null => {
    if (!token) return null;
    if (role === 'local') return safeEqual(token, config.localToken) ? { id: 'mac', deviceId: null } : null;
    const device = auth.deviceFromToken(token);
    return device ? { id: device.id, deviceId: device.id } : null;
  };

  const requireActor = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const now = Date.now();
    if (auth.authFailures.blocked(now)) {
      await reply.code(429).send({ error: 'muitas tentativas' });
      return;
    }
    const actor = identify(bearer(req.headers.authorization));
    if (!actor) {
      auth.authFailures.hit(now);
      await reply.code(401).send({ error: 'não autorizado' });
      return;
    }
    req.actor = actor;
  };

  app.get('/health', async () => ({ ok: true, version: VERSION, protocol: PROTOCOL_VERSION }));

  // ───────────────────────── API comum às duas portas ─────────────────────────
  app.register(async (api) => {
    api.addHook('preHandler', requireActor);

    api.get('/api/me', async (req) => ({ actor: req.actor?.id, role }));

    api.get('/api/sessions', async () => ({ sessions: hub.listSessions() }));

    api.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
      if (!hub.dismissSession(req.params.id)) return reply.code(404).send({ error: 'sessão não encontrada' });
      return { ok: true };
    });

    api.get<{ Querystring: { sessionId?: string; limit?: string; before?: string } }>('/api/events', async (req) => ({
      events: hub.listEvents({
        sessionId: req.query.sessionId,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        before: req.query.before ? Number(req.query.before) : undefined,
      }),
    }));

    api.get<{ Querystring: { status?: string; limit?: string } }>('/api/approvals', async (req) => {
      const status = (APPROVAL_STATUSES as readonly string[]).includes(req.query.status ?? '')
        ? (req.query.status as ApprovalStatus)
        : undefined;
      return { approvals: hub.listApprovals(status, req.query.limit ? Number(req.query.limit) : 100) };
    });

    api.get<{ Params: { id: string } }>('/api/approvals/:id', async (req, reply) => {
      const approval = hub.getApproval(req.params.id);
      if (!approval) return reply.code(404).send({ error: 'pedido não encontrado' });
      return { approval };
    });

    api.post<{ Params: { id: string }; Body: { decision?: unknown } }>(
      '/api/approvals/:id/decision',
      async (req, reply) => {
        const decision = req.body?.decision;
        if (decision !== 'allow' && decision !== 'deny') {
          return reply.code(400).send({ error: 'decision deve ser "allow" ou "deny"' });
        }
        const result = hub.decide(req.params.id, decision, (req.actor as Actor).id);
        if (!result.ok) {
          const code = result.reason === 'not_found' ? 404 : 409;
          return reply.code(code).send({ error: result.reason, approval: hub.getApproval(req.params.id) });
        }
        return { approval: result.approval };
      },
    );

    api.get('/api/settings', async () => ({ settings: hub.getSettings() }));
    api.put('/api/settings', async (req) => ({ settings: hub.updateSettings(req.body, (req.actor as Actor).id) }));

    api.get<{ Querystring: { since?: string } }>('/api/usage', async (req) => {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const requested = req.query.since ? Number(req.query.since) : startOfDay.getTime();
      const since = Number.isFinite(requested) ? requested : startOfDay.getTime();
      const base = hub.usage(since);
      const usage = deps.agentUsage ? { ...base, agents: deps.agentUsage.stats(since) } : base;
      if (!deps.consumption) return { usage };
      // As preferências são alteradas pela CLI/assistente: lê o estado atual a cada consulta.
      const stored = loadConfig({ create: false });
      return {
        usage: {
          ...usage,
          consumption: deps.consumption.consumption(since, stored?.consumption === true),
          limits: deps.consumption.getLimits(stored?.limits === true),
        },
      };
    });

    api.get<{ Querystring: { limit?: string } }>('/api/audit', async (req) => ({
      entries: audit.list(req.query.limit ? Number(req.query.limit) : 100),
    }));

    // Web Push — só faz sentido para dispositivos pareados.
    api.get('/api/push/public-key', async () => ({ publicKey: push?.publicKey ?? null }));

    api.post<{ Body: { subscription?: unknown } }>('/api/push/subscribe', async (req, reply) => {
      const deviceId = req.actor?.deviceId;
      if (!deviceId) return reply.code(403).send({ error: 'apenas dispositivos pareados' });
      const sub = req.body?.subscription;
      if (!isValidSubscription(sub)) return reply.code(400).send({ error: 'assinatura inválida' });
      const known = db.prepare('SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND device_id = ?').get(sub.endpoint, deviceId);
      db.prepare(
        `INSERT INTO push_subscriptions (endpoint, device_id, json, created_at) VALUES (?,?,?,?)
         ON CONFLICT(endpoint) DO UPDATE SET device_id = excluded.device_id, json = excluded.json`,
      ).run(sub.endpoint, deviceId, JSON.stringify(sub), Date.now());
      // A PWA reenvia a inscrição a cada abertura: só a primeira vez é novidade.
      if (!known) {
        const detail = `dispositivo=${deviceId} serviço=${subscriptionHost(sub)}`;
        pushLog(`push.subscribed ${detail}`);
        audit.record({ at: Date.now(), actor: deviceId, action: 'push.subscribed', detail });
      }
      return { ok: true };
    });

    api.delete('/api/push/subscribe', async (req, reply) => {
      const deviceId = req.actor?.deviceId;
      if (!deviceId) return reply.code(403).send({ error: 'apenas dispositivos pareados' });
      const removed = Number(db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(deviceId).changes);
      if (removed > 0) {
        const detail = `dispositivo=${deviceId} inscrições=${removed}`;
        pushLog(`push.unsubscribed ${detail}`);
        audit.record({ at: Date.now(), actor: deviceId, action: 'push.unsubscribed', detail });
      }
      return { ok: true };
    });

    api.post('/api/push/test', async (req, reply) => {
      const deviceId = req.actor?.deviceId;
      if (!deviceId || !push) return reply.code(403).send({ error: 'push indisponível' });
      const result = await push.send(
        { kind: 'test', title: 'Claude Hub', body: 'Notificações funcionando.', url: '/', tag: 'test' },
        deviceId,
      );
      // Para a tela dizer o motivo quando o serviço de push recusa.
      return {
        delivered: result.delivered,
        targets: result.targets,
        failures: result.failures.map((f) => ({ status: f.status, reason: f.reason, host: f.host })),
      };
    });

    // A PWA conta em que etapa de "Ativar notificações" parou: sem isso, do lado
    // do Mac não há como saber por que uma inscrição nunca chegou.
    api.post<{ Body: Record<string, unknown> }>('/api/push/client-report', async (req, reply) => {
      const deviceId = req.actor?.deviceId;
      if (!deviceId) return reply.code(403).send({ error: 'apenas dispositivos pareados' });
      const report = clientPushReport(req.body);
      if (!report) return reply.code(400).send({ error: 'relato inválido' });
      const detail = `dispositivo=${deviceId} etapa=${report.step} resultado=${report.outcome} permissão=${report.permission} sw=${report.serviceWorker} instalado=${report.standalone} inscrição=${report.subscribed}${report.detail ? ` detalhe="${report.detail}"` : ''}`;
      pushLog(`push.client ${detail}`);
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        `push.client.${deviceId}`,
        JSON.stringify({ at: Date.now(), ...report }),
      );
      // Sucesso já fica registrado como push.subscribed; na auditoria entram só os tropeços.
      if (report.outcome !== 'ok') audit.record({ at: Date.now(), actor: deviceId, action: 'push.client', detail });
      return { ok: true };
    });
  });

  // ─────────────────────────────── Porta pública ──────────────────────────────
  if (role === 'public') {
    app.post<{ Body: { code?: unknown; deviceName?: unknown } }>('/api/pair', async (req, reply) => {
      const result = auth.pair(String(req.body?.code ?? ''), String(req.body?.deviceName ?? 'iPhone'));
      if (!result.ok) {
        return reply
          .code(result.reason === 'rate_limited' ? 429 : 401)
          .send({ error: result.reason === 'rate_limited' ? 'muitas tentativas' : 'código inválido ou expirado' });
      }
      return { deviceId: result.deviceId, deviceToken: result.deviceToken };
    });
  }

  // ──────────────────────────────── Porta local ───────────────────────────────
  if (role === 'local') {
    // Entrada dos hooks do Claude Code. Token próprio, que não dá acesso a mais nada.
    app.post(HOOK_PATH, { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
      const token = bearer(req.headers.authorization);
      if (!token || !safeEqual(token, config.hookToken)) {
        return reply.code(401).send({ error: 'não autorizado' });
      }
      const payload = parseHookPayload(req.body);
      if (!payload) return reply.code(400).send({ error: 'payload de hook inválido' });

      const { held } = hub.ingestHook(payload);
      deps.codexRollout?.observe(payload);
      if (!held) return reply.code(200).send();

      // Pedido de permissão: segura a resposta até alguém decidir.
      let settled = false;
      const onClose = () => {
        if (!settled) held.abandon();
      };
      req.raw.socket.once('close', onClose);
      const output = await held.result;
      settled = true;
      req.raw.socket.off('close', onClose);
      // Sem decisão (expirou/cancelou): corpo vazio → o Claude Code pergunta no terminal.
      if (!output) return reply.code(200).send();
      return reply.code(200).send(output);
    });

    // Métricas do Claude Code (OpenTelemetry, OTLP/HTTP JSON) e JSON da linha de status.
    // Mesmo token dos hooks: só dá para enviar dados, nunca ler.
    const hookAuth = (req: FastifyRequest): boolean => {
      const token = bearer(req.headers.authorization);
      return Boolean(token && safeEqual(token, config.hookToken));
    };
    app.post(OTEL_PATH, { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
      if (!hookAuth(req)) return reply.code(401).send({ error: 'não autorizado' });
      deps.consumption?.ingestOtlpMetrics(req.body);
      return reply.code(200).send({});
    });
    app.post(STATUSLINE_PATH, { bodyLimit: 256 * 1024 }, async (req, reply) => {
      if (!hookAuth(req)) return reply.code(401).send({ error: 'não autorizado' });
      deps.consumption?.ingestStatusLine(req.body);
      return reply.code(200).send({});
    });
    app.post(AGENT_USAGE_PATH, { bodyLimit: 64 * 1024 }, async (req, reply) => {
      if (!hookAuth(req)) return reply.code(401).send({ error: 'não autorizado' });
      const report = parseAgentUsage(req.body);
      if (!report) return reply.code(400).send({ error: 'relatório de consumo inválido' });
      deps.agentUsage?.record(report);
      return reply.code(200).send({});
    });

    app.register(async (admin) => {
      admin.addHook('preHandler', requireActor);

      admin.post<{ Body: { baseUrl?: unknown } }>('/local/pairing', async (req) => {
        const { code, expiresAt } = auth.createPairing();
        const requested = typeof req.body?.baseUrl === 'string' ? req.body.baseUrl : null;
        const base = (requested && /^https?:\/\//.test(requested) ? requested : config.publicUrl)?.replace(/\/+$/, '');
        return { code, expiresAt, url: base ? `${base}/pair/?code=${code}` : null };
      });

      admin.get('/local/devices', async () => ({ devices: auth.listDevices() }));

      admin.delete<{ Params: { id: string } }>('/local/devices/:id', async (req, reply) => {
        if (!auth.revokeDevice(req.params.id, 'mac')) return reply.code(404).send({ error: 'dispositivo não encontrado' });
        return { ok: true };
      });

      admin.get('/local/audit/verify', async () => audit.verify());

      admin.get('/local/push', async () => {
        const devices = auth.listDevices().map((d) => {
          const subs = Number((db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE device_id = ?').get(d.id) as { n: number }).n);
          const raw = db.prepare('SELECT value FROM settings WHERE key = ?').get(`push.client.${d.id}`) as { value: string } | undefined;
          let lastClientReport: unknown = null;
          try {
            lastClientReport = raw ? JSON.parse(raw.value) : null;
          } catch {
            lastClientReport = null;
          }
          return { id: d.id, name: d.name, lastSeenAt: d.lastSeenAt, subscriptions: subs, lastClientReport };
        });
        return {
          configured: Boolean(push?.publicKey),
          subject: (push as { subject?: string } | null)?.subject ?? null,
          publicUrl: config.publicUrl,
          devices,
          last: lastPushResult(db),
        };
      });

      admin.get('/local/info', async () => ({
        version: VERSION,
        localPort: config.localPort,
        publicPort: config.publicPort,
        publicUrl: config.publicUrl,
        pushConfigured: Boolean(push?.publicKey),
        away: hub.isAway(),
        macConnected: hub.hasMacClient(),
        lastHookAt: hub.getLastHookAt(),
      }));
    });
  }

  // ───────────────────────────────── WebSocket ────────────────────────────────
  app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 } });
  app.register(async (ws) => {
    ws.get('/ws', { websocket: true }, (socket: WebSocket) => {
      let unsubscribe: (() => void) | null = null;
      let isMac = false;
      const send = (msg: ServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };
      // O token vai na primeira mensagem, nunca na URL (URLs acabam em logs).
      const authTimer = setTimeout(() => {
        send({ type: 'auth_error', reason: 'timeout' });
        socket.close(4401, 'auth timeout');
      }, 5000);

      socket.on('message', (raw) => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(raw)) as ClientMessage;
        } catch {
          return;
        }
        if (!unsubscribe) {
          if (msg.type !== 'auth' || !identify(typeof msg.token === 'string' ? msg.token : null)) {
            auth.authFailures.hit(Date.now());
            send({ type: 'auth_error', reason: 'invalid' });
            socket.close(4401, 'unauthorized');
            return;
          }
          clearTimeout(authTimer);
          if (role === 'local' && msg.client === 'macos') {
            isMac = true;
            hub.macConnected();
          }
          send(hub.snapshot());
          unsubscribe = hub.subscribe(send);
          return;
        }
        if (msg.type === 'ping') send({ type: 'pong' });
        else if (msg.type === 'presence' && isMac) hub.setMacIdle(Number(msg.idleSeconds));
      });

      socket.on('close', () => {
        clearTimeout(authTimer);
        unsubscribe?.();
        if (isMac) hub.macDisconnected();
      });
      socket.on('error', () => socket.close());
    });
  });

  // ────────────────────────────── PWA (arquivos estáticos) ────────────────────
  if (deps.webDir && existsSync(deps.webDir)) {
    const webDir = deps.webDir;
    // Pareamento por QR no iPhone: o app instalado na Tela de Início não herda
    // os dados do Safari. Para ele abrir já no pareamento, a página /pair/?code=…
    // aponta para um manifesto cujo start_url carrega o mesmo código de uso único.
    const pairCode = (value: unknown): string | null => {
      const raw = typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
      return /^[A-Z0-9]{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4)}` : null;
    };
    app.get<{ Querystring: { pair?: string } }>('/manifest.webmanifest', async (req, reply) => {
      const manifest = JSON.parse(readFileSync(join(webDir, 'manifest.webmanifest'), 'utf8')) as Record<string, unknown>;
      const code = pairCode(req.query.pair);
      if (code) manifest.start_url = `/pair/?code=${code}`;
      return reply.header('content-type', 'application/manifest+json; charset=utf-8').header('cache-control', 'no-store').send(manifest);
    });
    const pairPage = join(webDir, 'pair', 'index.html');
    if (existsSync(pairPage)) {
      app.get<{ Querystring: { code?: string } }>('/pair/', async (req, reply) => {
        let html = readFileSync(pairPage, 'utf8');
        const code = pairCode(req.query.code);
        if (code) html = html.replaceAll('href="/manifest.webmanifest"', `href="/manifest.webmanifest?pair=${code}"`);
        return reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
      });
    }
    app.register(fastifyStatic, { root: deps.webDir, index: 'index.html', redirect: true, cacheControl: false });
    app.addHook('onSend', async (req, reply) => {
      if (reply.hasHeader('cache-control')) return;
      const immutable = req.url.startsWith('/_next/static/');
      reply.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    });
  }

  return app;
}

export function createServers(deps: ServerDeps): { local: FastifyInstance; public: FastifyInstance } {
  return { local: createApp(deps, 'local'), public: createApp(deps, 'public') };
}
