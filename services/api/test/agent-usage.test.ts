/**
 * Consumo, limites, progresso e erro do Codex e do OpenCode.
 *
 * Codex: o leitor do arquivo de sessão contra um rollout escrito no formato que
 * o Codex grava (`{"timestamp","type","payload"}`, `token_count` com
 * `total_token_usage` e `rate_limits`, `function_call` `update_plan`,
 * `turn_complete` com `error`). O teste com o Codex real está em tests/real.
 *
 * OpenCode: o próprio plugin, com eventos nos formatos dos tipos publicados.
 */
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentUsageStats, Session } from '@claude-hub/shared';
import { v1Hooks } from '../../../packages/claude-bridge/src/opencode-plugin.js';
import { startHub, type TestHub } from './helpers.js';

let t: TestHub;
const saved = { ...process.env };
afterEach(async () => {
  process.env = { ...saved };
  await t?.close();
  t = undefined as unknown as TestHub;
});

const usage = async () => ((await (await t.local('/api/usage')).json()) as { usage: { agents: AgentUsageStats[] } }).usage.agents;
const session = async (id: string) => ((await (await t.local('/api/sessions')).json()) as { sessions: Session[] }).sessions.find((s) => s.id === id);
async function waitAsync<T>(fn: () => Promise<T | null | undefined | false>, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('tempo esgotado');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const line = (type: string, payload: Record<string, unknown>) => `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`;
const tokenCount = (input: number, cached: number, output: number, reasoning: number, rateLimits: unknown = null) =>
  line('event_msg', {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output },
      last_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 },
      model_context_window: 272000,
    },
    rate_limits: rateLimits,
  });

describe('Codex — arquivo de sessão', () => {
  function codexHome(): { home: string; rollout: string } {
    const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
    const dir = join(home, 'sessions', '2026', '11', '20');
    mkdirSync(dir, { recursive: true });
    const rollout = join(dir, 'rollout-2026-11-20T10-00-00-019a.jsonl');
    writeFileSync(rollout, line('session_meta', { id: '019a', cwd: '/Users/dev/projetos/api' }));
    return { home, rollout };
  }

  it('consumo, limites do plano e progresso saem do arquivo que o Codex grava', async () => {
    const { home, rollout } = codexHome();
    t = await startHub({ codexHome: home });
    const common = { session_id: '019a', cwd: '/Users/dev/projetos/api', transcript_path: rollout, hub_agent: 'codex' };
    await t.hook('SessionStart', { ...common, source: 'startup' });
    await t.hook('UserPromptSubmit', { ...common, prompt: 'Migrar rotas' });

    const resets = Math.floor(Date.now() / 1000) + 3600;
    appendFileSync(rollout, line('turn_context', { cwd: '/Users/dev/projetos/api', model: 'gpt-5-codex' }));
    appendFileSync(
      rollout,
      line('response_item', {
        type: 'function_call',
        name: 'update_plan',
        call_id: 'c1',
        arguments: JSON.stringify({ plan: [{ step: 'Ler rotas', status: 'completed' }, { step: 'Migrar', status: 'in_progress' }, { step: 'Testar', status: 'pending' }, { step: 'Revisar', status: 'pending' }] }),
      }),
    );
    appendFileSync(rollout, tokenCount(1000, 400, 120, 40));
    // Mesmo total de novo (só limites mudaram): não pode contar duas vezes.
    appendFileSync(
      rollout,
      tokenCount(1000, 400, 120, 40, {
        primary: { used_percent: 12.5, window_minutes: 300, resets_at: resets },
        secondary: { used_percent: 40, window_minutes: 10080, resets_at: resets + 86400 },
      }),
    );
    appendFileSync(rollout, tokenCount(1500, 600, 200, 60));
    t.pollCodex();

    const codex = await waitAsync(async () => (await usage()).find((a) => a.agent === 'codex' && a.outputTokens > 0));
    expect(codex).toMatchObject({ inputTokens: 900, cacheReadTokens: 600, outputTokens: 200, reasoningTokens: 60, costUsd: null });
    expect(codex.byModel[0]).toMatchObject({ model: 'gpt-5-codex', inputTokens: 900, outputTokens: 200 });
    expect(codex.limits?.windows).toEqual([
      { id: 'primary', label: 'Janela de 5 horas', usedPercent: 12.5, resetsAt: resets * 1000 },
      { id: 'secondary', label: 'Janela semanal', usedPercent: 40, resetsAt: (resets + 86400) * 1000 },
    ]);
    const s = await session('019a');
    expect(s?.progress).toMatchObject({ done: 1, total: 4 });
  });

  it('turno com erro: o Codex não chama o hook Stop, o hub marca Erro pelo arquivo', async () => {
    const { home, rollout } = codexHome();
    t = await startHub({ codexHome: home });
    const common = { session_id: '019a', cwd: '/Users/dev/projetos/api', transcript_path: rollout, hub_agent: 'codex' };
    await t.hook('SessionStart', { ...common, source: 'startup' });
    await t.hook('UserPromptSubmit', { ...common, prompt: 'Migrar rotas' });
    // Codex 0.171 grava `task_complete` (com o corpo do servidor como texto JSON).
    appendFileSync(
      rollout,
      line('event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: null, error: { message: JSON.stringify({ error: { message: 'unexpected status 400 Bad Request' } }), codex_error_info: 'other' } }),
    );
    t.pollCodex();
    const s = await waitAsync(async () => {
      const x = await session('019a');
      return x?.status === 'ERROR' && x;
    });
    expect(s.preview).toContain('400');
  });

  it('caminho fora de $CODEX_HOME/sessions é ignorado', async () => {
    const { home } = codexHome();
    const outside = join(mkdtempSync(join(tmpdir(), 'fora-')), 'x.jsonl');
    writeFileSync(outside, tokenCount(9999, 0, 9999, 0));
    t = await startHub({ codexHome: home });
    await t.hook('SessionStart', { session_id: 's2', cwd: '/tmp', transcript_path: outside, hub_agent: 'codex', source: 'startup' });
    appendFileSync(outside, tokenCount(20000, 0, 20000, 0));
    t.pollCodex();
    await new Promise((r) => setTimeout(r, 100));
    expect((await usage()).find((a) => a.agent === 'codex')?.outputTokens).toBe(0);
  });

  it('sessão retomada começa do fim do arquivo (não conta de novo)', async () => {
    const { home, rollout } = codexHome();
    appendFileSync(rollout, tokenCount(5000, 0, 800, 0));
    t = await startHub({ codexHome: home });
    await t.hook('SessionStart', { session_id: '019a', cwd: '/tmp', transcript_path: rollout, hub_agent: 'codex', source: 'resume' });
    appendFileSync(rollout, tokenCount(5200, 0, 850, 0));
    appendFileSync(rollout, tokenCount(5300, 0, 900, 0));
    t.pollCodex();
    // A primeira linha nova vira a base; só a diferença seguinte conta.
    const codex = await waitAsync(async () => (await usage()).find((a) => a.agent === 'codex' && a.outputTokens > 0));
    expect(codex).toMatchObject({ inputTokens: 100, outputTokens: 50 });
  });
});

describe('OpenCode — consumo', () => {
  function pointPluginAtHub(): void {
    const home = mkdtempSync(join(tmpdir(), 'hub-plugin-'));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ localHost: '127.0.0.1', localPort: Number(new URL(t.localUrl).port), hookToken: t.config.hookToken }));
    process.env.CLAUDE_HUB_HOME = home;
  }

  it('V1: tokens e custo da resposta concluída, uma vez só; sem limites (o OpenCode não tem)', async () => {
    t = await startHub();
    pointPluginAtHub();
    const hooks = v1Hooks({ client: {}, directory: '/Users/dev/projetos/painel' }) as { event: (e: unknown) => Promise<void> };
    const info = {
      id: 'msg_1',
      sessionID: 'ses_1',
      role: 'assistant',
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
      cost: 0.0123,
      tokens: { input: 300, output: 50, reasoning: 10, cache: { read: 1000, write: 20 } },
      time: { created: 1 },
    };
    await hooks.event({ event: { type: 'message.updated', properties: { info } } });
    const done = { ...info, time: { created: 1, completed: 2 } };
    await hooks.event({ event: { type: 'message.updated', properties: { info: done } } });
    await hooks.event({ event: { type: 'message.updated', properties: { info: done } } });
    const oc = await waitAsync(async () => (await usage()).find((a) => a.agent === 'opencode' && a.inputTokens > 0));
    await new Promise((r) => setTimeout(r, 100));
    const final = (await usage()).find((a) => a.agent === 'opencode')!;
    expect(final).toMatchObject({ inputTokens: 300, outputTokens: 50, reasoningTokens: 10, cacheReadTokens: 1000, cacheCreationTokens: 20, limits: null });
    expect(final.costUsd).toBeCloseTo(0.0123, 6);
    expect(oc.byModel[0]?.model).toBe('anthropic/claude-sonnet-4');
  });

  it('relatório de consumo exige o token dos hooks', async () => {
    t = await startHub();
    const res = await fetch(`${t.localUrl}/hooks/agent-usage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'opencode', input: 5 }) });
    expect(res.status).toBe(401);
  });
});
