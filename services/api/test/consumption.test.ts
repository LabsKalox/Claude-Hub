import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConsumptionStore, localDay } from '../src/consumption.js';
import { openDb, type Db } from '../src/db.js';
import { startHub, type TestHub } from './helpers.js';

const fixture = (name: string) => readFileSync(new URL(`../../../tests/fixtures/${name}`, import.meta.url), 'utf8');
/** Métricas reais exportadas pelo Claude Code 2.1.329 (uma resposta curta com o Haiku). */
const realMetrics = fixture('otel-metrics-claude-code-2.1.329.jsonl').trim().split('\n').map((l) => JSON.parse(l) as unknown);
/** Exemplo de entrada da linha de status, como está na documentação oficial. */
const statusInput = JSON.parse(fixture('statusline-input-docs.json')) as Record<string, any>;

const metric = (name: string, value: number, attrs: Record<string, string>, temporality = 1) => ({
  resourceMetrics: [
    {
      scopeMetrics: [
        {
          metrics: [
            {
              name,
              sum: {
                aggregationTemporality: temporality,
                dataPoints: [{ asDouble: value, attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: { stringValue: v } })) }],
              },
            },
          ],
        },
      ],
    },
  ],
});

describe('consumo (métricas OpenTelemetry do Claude Code)', () => {
  let db: Db;
  let now = Date.parse('2026-11-20T15:00:00');
  let store: ConsumptionStore;
  beforeEach(() => {
    db = openDb(':memory:');
    now = Date.parse('2026-11-20T15:00:00');
    store = new ConsumptionStore(db, () => now);
  });
  const today = () => new Date(now).setHours(0, 0, 0, 0);

  it('sem nenhuma métrica recebida, não há número nenhum', () => {
    const c = store.consumption(today(), false);
    expect(c).toMatchObject({ enabled: false, source: null, inputTokens: 0, outputTokens: 0, costUsd: null, byModel: [], updatedAt: null });
  });

  it('soma os tokens e o custo dos dados reais, por modelo', () => {
    for (const body of realMetrics) store.ingestOtlpMetrics(body);
    const c = store.consumption(today(), true);
    expect(c.source).toBe('otel');
    expect(c.inputTokens).toBe(2);
    expect(c.outputTokens).toBe(4);
    expect(c.cacheReadTokens).toBe(26774);
    expect(c.cacheCreationTokens).toBe(20499);
    expect(c.costUsd).toBeCloseTo(0.00436974, 6);
    expect(c.byModel).toHaveLength(1);
    expect(c.byModel[0]?.model).toBe('claude-haiku-5-5');
    expect(c.updatedAt).toBe(now);
  });

  it('não guarda e-mail, conta nem organização', () => {
    for (const body of realMetrics) store.ingestOtlpMetrics(body);
    const dump = JSON.stringify(db.prepare('SELECT * FROM consumption').all());
    expect(dump).not.toContain('removido');
    expect(dump).not.toMatch(/user|account|organization|email/i);
  });

  it('métrica cumulativa vira incremento, sem contar duas vezes', () => {
    const attrs = { model: 'claude-sonnet-5', type: 'output', 'session.id': 's1' };
    store.ingestOtlpMetrics(metric('claude_code.token.usage', 100, attrs, 2));
    store.ingestOtlpMetrics(metric('claude_code.token.usage', 250, attrs, 2));
    store.ingestOtlpMetrics(metric('claude_code.token.usage', 250, attrs, 2));
    expect(store.consumption(today(), true).outputTokens).toBe(250);
    // Contador reiniciado (nova sessão do processo): recomeça do valor informado.
    store.ingestOtlpMetrics(metric('claude_code.token.usage', 40, attrs, 2));
    expect(store.consumption(today(), true).outputTokens).toBe(290);
  });

  it('ignora métricas de outro tipo, valores inválidos e corpos malformados', () => {
    expect(store.ingestOtlpMetrics(metric('claude_code.lines_of_code.count', 10, { type: 'added' }))).toBe(0);
    expect(store.ingestOtlpMetrics(metric('claude_code.token.usage', -5, { model: 'm', type: 'input' }))).toBe(0);
    expect(store.ingestOtlpMetrics(metric('claude_code.token.usage', 5, { model: 'm', type: 'inventado' }))).toBe(0);
    expect(store.ingestOtlpMetrics(null)).toBe(0);
    expect(store.ingestOtlpMetrics({ resourceMetrics: 'x' })).toBe(0);
    expect(store.consumption(today(), true).source).toBeNull();
  });

  it('o consumo é por dia: o de ontem não entra no de hoje', () => {
    store.ingestOtlpMetrics(metric('claude_code.token.usage', 500, { model: 'm', type: 'input' }));
    now += 24 * 3600 * 1000;
    store.ingestOtlpMetrics(metric('claude_code.token.usage', 7, { model: 'm', type: 'input' }));
    expect(store.consumption(today(), true).inputTokens).toBe(7);
    expect(localDay(now)).toBe('2026-11-21');
  });
});

describe('limites do plano (linha de status do Claude Code)', () => {
  let db: Db;
  let now: number;
  let store: ConsumptionStore;
  beforeEach(() => {
    db = openDb(':memory:');
    now = 1738420000 * 1000; // antes dos dois horários de renovação do exemplo
    store = new ConsumptionStore(db, () => now);
  });

  it('sem informação do Claude Code, não mostra nada', () => {
    expect(store.getLimits(false)).toEqual({ enabled: false, source: null, updatedAt: null, windows: [], context: null });
  });

  it('repassa exatamente o percentual e o horário informados', () => {
    store.ingestStatusLine(statusInput);
    const l = store.getLimits(true);
    expect(l.source).toBe('statusline');
    expect(l.windows).toEqual([
      { id: 'five_hour', label: 'Janela de 5 horas', usedPercent: 23.5, resetsAt: 1738425600 * 1000 },
      { id: 'seven_day', label: 'Janela de 7 dias', usedPercent: 41.2, resetsAt: 1738857600 * 1000 },
    ]);
    expect(l.context).toEqual({ usedPercent: 8, windowSize: 200000, sessionId: 'abc123' });
    expect(l.updatedAt).toBe(now);
  });

  it('janela cujo horário de renovação já passou deixa de ser mostrada', () => {
    store.ingestStatusLine(statusInput);
    now = 1738425600 * 1000 + 1;
    expect(store.getLimits(true).windows.map((w) => w.id)).toEqual(['seven_day']);
    now = 1738857600 * 1000 + 1;
    expect(store.getLimits(true).windows).toEqual([]);
  });

  it('plano sem limites informados (sem rate_limits): nenhum percentual é criado', () => {
    const { rate_limits: _omit, ...withoutLimits } = statusInput;
    store.ingestStatusLine(withoutLimits);
    const l = store.getLimits(true);
    expect(l.windows).toEqual([]);
    expect(l.context?.usedPercent).toBe(8);
  });

  it('percentual ausente ou não numérico não vira janela; horário ausente fica vazio', () => {
    store.ingestStatusLine({ rate_limits: { five_hour: { used_percentage: null, resets_at: 1738425600 }, seven_day: { used_percentage: 12 }, x: null } });
    expect(store.getLimits(true).windows).toEqual([{ id: 'seven_day', label: 'Janela de 7 dias', usedPercent: 12, resetsAt: null }]);
  });

  it('sobrevive a reinício do hub', () => {
    store.ingestStatusLine(statusInput);
    const again = new ConsumptionStore(db, () => now);
    expect(again.getLimits(true).windows).toHaveLength(2);
  });
});

describe('rotas de consumo e limites', () => {
  let t: TestHub;
  beforeEach(async () => {
    t = await startHub();
  });
  afterEach(async () => {
    await t.close();
  });
  const post = (path: string, body: unknown, token: string) =>
    fetch(`${t.localUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

  it('exigem o token de hook e só existem na porta local', async () => {
    expect((await post('/otel/v1/metrics', realMetrics[0], 'errado')).status).toBe(401);
    expect((await post('/statusline/claude-code', statusInput, t.config.localToken)).status).toBe(401);
    const onPublic = await fetch(`${t.publicUrl}/otel/v1/metrics`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t.config.hookToken}` }, body: '{}' });
    expect(onPublic.status).toBe(404);
  });

  it('o que entra pelas rotas aparece em /api/usage', async () => {
    for (const body of realMetrics) expect((await post('/otel/v1/metrics', body, t.config.hookToken)).status).toBe(200);
    expect((await post('/statusline/claude-code', { ...statusInput, rate_limits: { five_hour: { used_percentage: 23.5, resets_at: Math.floor(Date.now() / 1000) + 3600 } } }, t.config.hookToken)).status).toBe(200);
    const { usage } = (await (await t.local('/api/usage')).json()) as { usage: Record<string, any> };
    expect(usage.sessions).toBe(0);
    expect(usage.consumption.outputTokens).toBe(4);
    expect(usage.consumption.byModel[0].model).toBe('claude-haiku-5-5');
    expect(usage.limits.windows).toHaveLength(1);
    expect(usage.limits.windows[0].usedPercent).toBe(23.5);
  });

  it('o celular pareado lê os mesmos números, mas não pode enviar', async () => {
    const token = await t.pairDevice();
    for (const body of realMetrics) await post('/otel/v1/metrics', body, t.config.hookToken);
    const { usage } = (await (await t.device(token, '/api/usage')).json()) as { usage: Record<string, any> };
    expect(usage.consumption.inputTokens).toBe(2);
    const send = await fetch(`${t.publicUrl}/statusline/claude-code`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' });
    expect(send.status).toBe(404);
  });
});
