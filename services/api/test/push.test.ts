import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '@claude-hub/claude-bridge';
import {
  DEFAULT_VAPID_SUBJECT,
  LEGACY_VAPID_SUBJECT,
  ensureVapid,
  failureReason,
  isValidVapidSubject,
  resolveVapidSubject,
} from '../src/push.js';
import { clientPushReport } from '../src/server.js';
import { BASH, startHub, waitFor, type TestHub } from './helpers.js';

let t: TestHub;
afterEach(async () => {
  await t?.close();
});

const ENDPOINT = 'https://web.push.apple.com/QSEGREDO-DO-APARELHO-abc123';
const SUB = { endpoint: ENDPOINT, keys: { p256dh: 'CHAVE-P256DH-SECRETA', auth: 'CHAVE-AUTH-SECRETA' } };
const subscribe = (token: string, sub: unknown = SUB) =>
  t.device(token, '/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub }) });
const actions = () => t.audit.list(200).map((e) => e.action);
const everything = () => `${t.pushLog.join('\n')}\n${t.audit.list(200).map((e) => e.detail).join('\n')}`;

describe('subject VAPID', () => {
  it('o subject das versões antigas e os locais são inválidos (a Apple responde 403 BadJwtToken)', () => {
    expect(isValidVapidSubject(LEGACY_VAPID_SUBJECT)).toBe(false);
    for (const bad of ['mailto:a@localhost', 'https://localhost', 'https://127.0.0.1', 'https://mac.local', 'http://exemplo.com', 'mailto: a@b.com', 'exemplo.com', '', null]) {
      expect(isValidVapidSubject(bad), String(bad)).toBe(false);
    }
    for (const good of [DEFAULT_VAPID_SUBJECT, 'mailto:eu@empresa.com.br', 'https://macbook.tail1a2b3c.ts.net', 'https://exemplo.com']) {
      expect(isValidVapidSubject(good), good).toBe(true);
    }
  });

  it('migração: mantém as chaves (as inscrições continuam valendo) e troca só o subject', () => {
    const old = { publicKey: 'PUB', privateKey: 'PRIV', subject: LEGACY_VAPID_SUBJECT };
    const migrated = ensureVapid({ ...defaultConfig(), vapid: old });
    expect(migrated).toEqual({ publicKey: 'PUB', privateKey: 'PRIV', subject: DEFAULT_VAPID_SUBJECT });
    // Quem já tem um subject válido não é tocado.
    const custom = { publicKey: 'PUB', privateKey: 'PRIV', subject: 'mailto:eu@empresa.com.br' };
    expect(ensureVapid({ ...defaultConfig(), vapid: custom })).toBe(custom);
    // Instalação nova já nasce com subject válido.
    expect(isValidVapidSubject(ensureVapid({ ...defaultConfig(), vapid: null }).subject)).toBe(true);
  });

  it('ordem de escolha: o do usuário, depois o endereço https do hub, depois o padrão', () => {
    expect(resolveVapidSubject('mailto:eu@empresa.com.br', 'https://macbook.tail1a2b3c.ts.net')).toBe('mailto:eu@empresa.com.br');
    expect(resolveVapidSubject(DEFAULT_VAPID_SUBJECT, 'https://macbook.tail1a2b3c.ts.net/')).toBe('https://macbook.tail1a2b3c.ts.net');
    expect(resolveVapidSubject(LEGACY_VAPID_SUBJECT, null)).toBe(DEFAULT_VAPID_SUBJECT);
    expect(resolveVapidSubject(LEGACY_VAPID_SUBJECT, 'http://127.0.0.1:4318')).toBe(DEFAULT_VAPID_SUBJECT);
    expect(resolveVapidSubject('mailto:a@localhost', 'isto não é url')).toBe(DEFAULT_VAPID_SUBJECT);
  });
});

describe('motivo de uma recusa', () => {
  it('usa o "reason" do serviço de push, o texto quando não é JSON, e o erro de rede', () => {
    expect(failureReason({ statusCode: 403, body: '{"reason":"BadJwtToken"}' })).toEqual({ status: 403, reason: 'BadJwtToken' });
    expect(failureReason({ statusCode: 413, body: 'Payload Too Large\n' })).toEqual({ status: 413, reason: 'Payload Too Large' });
    expect(failureReason({ statusCode: 500, body: '' })).toEqual({ status: 500, reason: 'sem motivo informado' });
    expect(failureReason({ code: 'ETIMEDOUT', message: 'socket hang up' })).toEqual({ status: null, reason: 'ETIMEDOUT' });
  });
});

describe('inscrição: log e auditoria', () => {
  it('push.subscribed uma vez só (a PWA reenvia a cada abertura) e push.unsubscribed', async () => {
    t = await startHub();
    const token = await t.pairDevice();
    expect((await subscribe(token)).status).toBe(200);
    expect((await subscribe(token)).status).toBe(200);
    expect(actions().filter((a) => a === 'push.subscribed')).toHaveLength(1);
    expect(t.pushLog.filter((l) => l.startsWith('push.subscribed'))).toHaveLength(1);
    expect(t.pushLog[0]).toContain('serviço=web.push.apple.com');

    expect((await t.device(token, '/api/push/subscribe', { method: 'DELETE' })).status).toBe(200);
    expect(actions()).toContain('push.unsubscribed');
    // Desativar sem inscrição não gera registro.
    await t.device(token, '/api/push/subscribe', { method: 'DELETE' });
    expect(actions().filter((a) => a === 'push.unsubscribed')).toHaveLength(1);
    expect((await t.audit.verify()).ok).toBe(true);
  });

  it('nunca registra o endereço completo da inscrição nem as chaves do aparelho', async () => {
    t = await startHub({ pushTransport: async () => Promise.reject({ statusCode: 403, body: '{"reason":"BadJwtToken"}' }) });
    const token = await t.pairDevice();
    await subscribe(token);
    await t.device(token, '/api/push/test', { method: 'POST' });
    const text = everything();
    expect(text).toContain('web.push.apple.com');
    for (const secret of ['QSEGREDO-DO-APARELHO', 'CHAVE-P256DH-SECRETA', 'CHAVE-AUTH-SECRETA', 'UUxI4O8']) expect(text).not.toContain(secret);
  });
});

describe('envio: log, auditoria e último resultado', () => {
  it('entrega: push.sent, e o estado mostra a inscrição e o último envio', async () => {
    const sent: string[] = [];
    t = await startHub({
      pushTransport: async (sub, payload) => {
        sent.push(`${sub.endpoint} ${payload}`);
      },
    });
    const token = await t.pairDevice('iPhone de teste');
    await subscribe(token);
    const res = (await (await t.device(token, '/api/push/test', { method: 'POST' })).json()) as { delivered: number; targets: number; failures: unknown[] };
    expect(res).toEqual({ delivered: 1, targets: 1, failures: [] });
    expect(sent).toHaveLength(1);
    expect(actions()).toContain('push.sent');
    expect(t.pushLog.some((l) => l.startsWith('push.sent tipo=test entregues=1/1'))).toBe(true);

    const status = (await (await t.local('/local/push')).json()) as {
      configured: boolean;
      subject: string;
      devices: Array<{ name: string; subscriptions: number }>;
      last: { delivered: number; targets: number; kind: string; failures: unknown[] };
    };
    expect(status.configured).toBe(true);
    expect(status.subject).toBe('mailto:claude-hub@example.com');
    expect(status.devices).toMatchObject([{ name: 'iPhone de teste', subscriptions: 1 }]);
    expect(status.last).toMatchObject({ kind: 'test', delivered: 1, targets: 1, failures: [] });
  });

  it('recusa da Apple: push.failed com o status HTTP e o motivo, e a tela do iPhone recebe o motivo', async () => {
    t = await startHub({ pushTransport: async () => Promise.reject({ statusCode: 403, body: '{"reason":"BadJwtToken"}' }) });
    const token = await t.pairDevice();
    await subscribe(token);
    const res = (await (await t.device(token, '/api/push/test', { method: 'POST' })).json()) as { delivered: number; failures: Array<Record<string, unknown>> };
    expect(res.delivered).toBe(0);
    expect(res.failures).toEqual([{ status: 403, reason: 'BadJwtToken', host: 'web.push.apple.com' }]);
    const failed = t.audit.list(50).find((e) => e.action === 'push.failed');
    expect(failed?.detail).toContain('status=403');
    expect(failed?.detail).toContain('motivo=BadJwtToken');
    expect(t.pushLog.some((l) => l.startsWith('push.failed') && l.includes('status=403 motivo=BadJwtToken'))).toBe(true);
    // A inscrição continua: o problema é do hub (JWT), não do aparelho.
    const status = (await (await t.local('/local/push')).json()) as { devices: Array<{ subscriptions: number }>; last: { failures: Array<{ status: number }> } };
    expect(status.devices[0]?.subscriptions).toBe(1);
    expect(status.last.failures[0]?.status).toBe(403);
  });

  it('inscrição vencida (410) é removida e fica registrado', async () => {
    t = await startHub({ pushTransport: async () => Promise.reject({ statusCode: 410, body: '{"reason":"Unregistered"}' }) });
    const token = await t.pairDevice();
    await subscribe(token);
    await t.device(token, '/api/push/test', { method: 'POST' });
    expect(t.pushLog.some((l) => l.includes('status=410') && l.includes('inscrição vencida, removida'))).toBe(true);
    const status = (await (await t.local('/local/push')).json()) as { devices: Array<{ subscriptions: number }> };
    expect(status.devices[0]?.subscriptions).toBe(0);
  });

  it('sem resposta do serviço de push: registra o erro de rede, sem status', async () => {
    t = await startHub({ pushTransport: async () => Promise.reject(Object.assign(new Error('socket hang up'), { code: 'ETIMEDOUT' })) });
    const token = await t.pairDevice();
    await subscribe(token);
    const res = (await (await t.device(token, '/api/push/test', { method: 'POST' })).json()) as { failures: Array<Record<string, unknown>> };
    expect(res.failures[0]).toMatchObject({ status: null, reason: 'ETIMEDOUT' });
    expect(t.pushLog.some((l) => l.includes('status=sem resposta motivo=ETIMEDOUT'))).toBe(true);
  });

  it('um pedido de aprovação de verdade gera um envio registrado', async () => {
    const payloads: string[] = [];
    t = await startHub({
      pushTransport: async (_sub, payload) => {
        payloads.push(String(payload));
      },
    });
    const token = await t.pairDevice();
    await subscribe(token);
    const held = t.hook('PermissionRequest', BASH);
    await waitFor(() => payloads.length > 0);
    expect(JSON.parse(payloads[0]!)).toMatchObject({ kind: 'approval' });
    await waitFor(() => actions().includes('push.sent'));
    const pending = (await (await t.device(token, '/api/approvals')).json()) as { approvals: Array<{ id: string }> };
    await t.device(token, `/api/approvals/${pending.approvals[0]!.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'deny' }) });
    await held;
  });

  it('sem nenhuma inscrição não há envio nem registro', async () => {
    let calls = 0;
    t = await startHub({
      pushTransport: async () => {
        calls++;
      },
    });
    const token = await t.pairDevice();
    const res = (await (await t.device(token, '/api/push/test', { method: 'POST' })).json()) as { delivered: number; targets: number };
    expect(res).toMatchObject({ delivered: 0, targets: 0 });
    expect(calls).toBe(0);
    expect(actions().some((a) => a.startsWith('push.'))).toBe(false);
  });
});

describe('relato do iPhone sobre "Ativar notificações"', () => {
  const report = (token: string, body: unknown) => t.device(token, '/api/push/client-report', { method: 'POST', body: JSON.stringify(body) });

  it('travamento vira linha no log, entrada na auditoria e aparece no estado do push', async () => {
    t = await startHub();
    const token = await t.pairDevice('iPhone 14 Pro Max');
    const res = await report(token, {
      step: 'permission',
      outcome: 'stalled',
      detail: 'O iPhone não respondeu ao pedido de permissão.',
      permission: 'default',
      serviceWorker: 'active',
      standalone: 'sim',
      subscribed: 'não',
    });
    expect(res.status).toBe(200);
    expect(t.pushLog.at(-1)).toMatch(/^push\.client dispositivo=dev_\S+ etapa=permission resultado=stalled permissão=default sw=active instalado=sim inscrição=não/);
    expect(actions()).toContain('push.client');
    const status = (await (await t.local('/local/push')).json()) as {
      devices: Array<{ subscriptions: number; lastClientReport: { step: string; outcome: string; permission: string } }>;
    };
    expect(status.devices[0]).toMatchObject({ subscriptions: 0, lastClientReport: { step: 'permission', outcome: 'stalled', permission: 'default' } });
  });

  it('sucesso fica no log, mas não enche a auditoria', async () => {
    t = await startHub();
    const token = await t.pairDevice();
    await report(token, { step: 'done', outcome: 'ok', permission: 'granted', serviceWorker: 'active', standalone: 'sim', subscribed: 'sim' });
    expect(t.pushLog.at(-1)).toContain('etapa=done resultado=ok');
    expect(actions()).not.toContain('push.client');
  });

  it('só aparelho pareado relata; corpo inválido é recusado; texto é cortado e URLs somem', async () => {
    t = await startHub();
    const token = await t.pairDevice();
    expect((await t.local('/api/push/client-report', { method: 'POST', body: JSON.stringify({ step: 'permission', outcome: 'failed' }) })).status).toBe(403);
    expect((await fetch(`${t.publicUrl}/api/push/client-report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await report(token, { step: 'permission', outcome: 'explodiu' })).status).toBe(400);
    expect((await report(token, { step: 'DROP TABLE', outcome: 'failed' })).status).toBe(400);
    const cleaned = clientPushReport({
      step: 'subscribe',
      outcome: 'failed',
      detail: `erro em ${ENDPOINT} "aspas"\nlinha2 ${'x'.repeat(500)}`,
      permission: 'granted'.repeat(10),
    });
    expect(cleaned?.detail).not.toContain('web.push.apple.com');
    expect(cleaned?.detail).not.toContain('"');
    expect(cleaned?.detail.length).toBeLessThanOrEqual(300);
    expect(cleaned?.permission.length).toBeLessThanOrEqual(16);
  });

  it('o estado do push não existe na porta do iPhone', async () => {
    t = await startHub();
    const token = await t.pairDevice();
    expect((await t.device(token, '/local/push')).status).toBe(404);
  });
});
