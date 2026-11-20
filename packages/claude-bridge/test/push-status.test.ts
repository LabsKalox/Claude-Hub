import { describe, expect, it } from 'vitest';
import { clientReportText, pushProblem, pushSummary, type PushStatus } from '../src/index.js';

const base: PushStatus = { configured: true, subject: 'mailto:claude-hub@example.com', publicUrl: 'https://macbook.exemplo.ts.net', devices: [], last: null };
const device = (over: Partial<PushStatus['devices'][number]> = {}): PushStatus['devices'][number] => ({
  id: 'dev_1',
  name: 'iPhone 14 Pro Max',
  lastSeenAt: Date.now(),
  subscriptions: 1,
  lastClientReport: null,
  ...over,
});

describe('estado do push no diagnóstico e na verificação de saúde', () => {
  it('sem aparelho pareado não há problema a apontar', () => {
    expect(pushProblem(base)).toBeNull();
    expect(pushSummary(base)).toBe('nenhum iPhone pareado ainda');
  });

  it('aparelho pareado sem inscrição é avisado, com a etapa em que o iPhone parou', () => {
    const stalled = device({
      subscriptions: 0,
      lastClientReport: { at: Date.now() - 5000, step: 'permission', outcome: 'stalled', permission: 'default', serviceWorker: 'active', standalone: 'sim', subscribed: 'não', detail: '' },
    });
    const problem = pushProblem({ ...base, devices: [stalled] });
    expect(problem).toContain('aparelho pareado sem notificações ativas: iPhone 14 Pro Max');
    expect(problem).toContain('pedido de permissão do iOS: sem resposta');
    expect(problem).toContain('permissão default');
  });

  it('sem nenhum relato do aparelho, diz isso', () => {
    expect(pushProblem({ ...base, devices: [device({ subscriptions: 0 })] })).toContain('nenhuma tentativa registrada pelo aparelho');
  });

  it('último envio recusado pelo serviço de push aparece com status e motivo', () => {
    const status: PushStatus = {
      ...base,
      devices: [device()],
      last: { at: Date.now() - 60_000, kind: 'approval', targets: 1, delivered: 0, removed: 0, failures: [{ status: 403, reason: 'BadJwtToken', host: 'web.push.apple.com', deviceId: 'dev_1' }] },
    };
    expect(pushProblem(status)).toContain('o último envio foi recusado por web.push.apple.com: 403 BadJwtToken');
  });

  it('inscrição vencida (410) removida não conta como recusa', () => {
    const status: PushStatus = {
      ...base,
      devices: [device()],
      last: { at: Date.now(), kind: 'test', targets: 1, delivered: 0, removed: 1, failures: [{ status: 410, reason: 'Unregistered', host: 'web.push.apple.com', deviceId: 'dev_1' }] },
    };
    expect(pushProblem(status)).toBeNull();
  });

  it('tudo certo: resume inscrições e o último envio', () => {
    const status: PushStatus = { ...base, devices: [device()], last: { at: Date.now() - 2000, kind: 'test', targets: 1, delivered: 1, removed: 0, failures: [] } };
    expect(pushProblem(status)).toBeNull();
    expect(pushSummary(status)).toMatch(/^1 inscrição\(ões\) em 1 aparelho\(s\); último envio: 1\/1 entregue\(s\) há /);
  });

  it('hub sem chaves é problema', () => {
    expect(pushProblem({ ...base, configured: false })).toBe('o hub está sem chaves de push');
  });

  it('o relato traduz a etapa e o resultado', () => {
    const text = clientReportText({ at: Date.now(), step: 'subscribe', outcome: 'failed', permission: 'granted', serviceWorker: 'active', standalone: 'sim', subscribed: 'não', detail: 'AbortError: (url)' });
    expect(text).toContain('inscrição no serviço de push: falhou');
    expect(text).toContain('AbortError');
  });
});
