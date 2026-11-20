import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Session } from '@claude-hub/shared';
import { parseHookPayload, reduceHook, type HookPayload } from '../src/index.js';

const base = { session_id: 's1', cwd: '/Users/dev/projetos/site' };
const hook = (hook_event_name: string, extra: Record<string, unknown> = {}): HookPayload =>
  ({ ...base, hook_event_name, ...extra }) as HookPayload;

function run(events: HookPayload[], start = 1_000_000): { session: Session; alerts: string[] } {
  let session: Session | undefined;
  const alerts: string[] = [];
  let t = start;
  for (const e of events) {
    const r = reduceHook(session, e, t);
    session = r.session;
    alerts.push(...r.alerts.map((a) => a.kind));
    t += 1000;
  }
  return { session: session as Session, alerts };
}

describe('máquina de estados de sessão', () => {
  it('SessionStart cria a sessão como IDLE com o nome do projeto', () => {
    const { session } = run([hook('SessionStart', { source: 'startup', model: 'claude-sonnet-5' })]);
    expect(session.status).toBe('IDLE');
    expect(session.projectName).toBe('site');
    expect(session.agent).toBe('claude-sonnet-5');
  });

  it('pedido do usuário → WORKING, com tarefa, título e turno aberto', () => {
    const { session } = run([
      hook('SessionStart'),
      hook('UserPromptSubmit', { prompt: 'Publicar o site\ncom o build novo' }),
    ]);
    expect(session.status).toBe('WORKING');
    expect(session.task).toBe('Publicar o site com o build novo');
    expect(session.title).toBe('Publicar o site com o build novo');
    expect(session.activeSince).not.toBeNull();
  });

  it('session_title do Claude Code tem prioridade sobre o primeiro pedido', () => {
    const { session } = run([
      hook('SessionStart', { session_title: 'Máquina de reels' }),
      hook('UserPromptSubmit', { prompt: 'continua' }),
    ]);
    expect(session.title).toBe('Máquina de reels');
  });

  it('PermissionRequest → APPROVAL_REQUIRED e volta a WORKING após a ferramenta', () => {
    const tool = { tool_name: 'Bash', tool_input: { command: 'npm run build' } };
    const a = run([hook('UserPromptSubmit', { prompt: 'build' }), hook('PermissionRequest', tool)]);
    expect(a.session.status).toBe('APPROVAL_REQUIRED');
    expect(a.session.lastEvent?.summary).toContain('npm run build');
    const b = run([
      hook('UserPromptSubmit', { prompt: 'build' }),
      hook('PermissionRequest', tool),
      hook('PostToolUse', tool),
    ]);
    expect(b.session.status).toBe('WORKING');
  });

  it('pergunta do Claude (AskUserQuestion) → WAITING, não aprovação', () => {
    const { session, alerts } = run([
      hook('UserPromptSubmit', { prompt: 'x' }),
      hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: {} }),
      hook('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: {} }),
    ]);
    expect(session.status).toBe('WAITING');
    expect(alerts).toContain('waiting');
  });

  it('Notification idle_prompt → WAITING com um único alerta', () => {
    const { session, alerts } = run([
      hook('UserPromptSubmit', { prompt: 'x' }),
      hook('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting' }),
      hook('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting' }),
    ]);
    expect(session.status).toBe('WAITING');
    expect(alerts.filter((a) => a === 'waiting')).toHaveLength(1);
  });

  it('idle_prompt depois de terminar não vira "Esperando você" nem gera alerta', () => {
    const { session, alerts } = run([
      hook('UserPromptSubmit', { prompt: 'x' }),
      hook('Stop', { last_assistant_message: 'Pronto.' }),
      hook('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }),
    ]);
    expect(session.status).toBe('COMPLETED');
    expect(alerts).toEqual(['completed']);
  });

  it('Stop → COMPLETED, fecha o turno, soma o tempo e gera alerta', () => {
    const { session, alerts } = run([
      hook('UserPromptSubmit', { prompt: 'x' }),
      hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }),
      hook('Stop', { last_assistant_message: '## Pronto\nVídeo renderizado.' }),
    ]);
    expect(session.status).toBe('COMPLETED');
    expect(session.activeSince).toBeNull();
    expect(session.activeMs).toBe(2000);
    expect(session.preview).toBe('Pronto Vídeo renderizado.');
    expect(alerts).toEqual(['completed']);
  });

  it('StopFailure → ERROR com alerta de erro', () => {
    const { session, alerts } = run([
      hook('UserPromptSubmit', { prompt: 'x' }),
      hook('StopFailure', { error: 'rate_limit', error_details: 'Limite de uso atingido' }),
    ]);
    expect(session.status).toBe('ERROR');
    expect(session.preview).toBe('Limite de uso atingido');
    expect(alerts).toEqual(['error']);
  });

  it('TodoWrite gera progresso mensurável; Stop completa a barra', () => {
    const todos = [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
      { content: 'c', status: 'in_progress' },
      { content: 'd', status: 'pending' },
    ];
    const mid = run([
      hook('UserPromptSubmit', { prompt: 'x' }),
      hook('PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos } }),
    ]);
    expect(mid.session.progress).toEqual({ done: 2, total: 4 });
    const end = run([
      hook('UserPromptSubmit', { prompt: 'x' }),
      hook('PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos } }),
      hook('Stop'),
    ]);
    expect(end.session.progress).toEqual({ done: 4, total: 4 });
  });

  it('TaskCreated/TaskCompleted também contam como progresso', () => {
    const { session } = run([
      hook('UserPromptSubmit', { prompt: 'x' }),
      hook('TaskCreated', { task_subject: 'a' }),
      hook('TaskCreated', { task_subject: 'b' }),
      hook('TaskCompleted', { task_subject: 'a' }),
    ]);
    expect(session.progress).toEqual({ done: 1, total: 2 });
  });

  it('SessionEnd encerra; novo evento reabre a sessão (retomada)', () => {
    const ended = run([hook('UserPromptSubmit', { prompt: 'x' }), hook('SessionEnd', { reason: 'other' })]);
    expect(ended.session.endedAt).not.toBeNull();
    expect(ended.session.status).toBe('IDLE');
    const resumed = reduceHook(ended.session, hook('SessionStart', { source: 'resume' }), 9_999_999);
    expect(resumed.session.endedAt).toBeNull();
  });

  it('subagentes não sobrescrevem a prévia da sessão principal', () => {
    const { session } = run([
      hook('UserPromptSubmit', { prompt: 'pedido principal' }),
      hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }),
      hook('PreToolUse', { agent_id: 'a1', tool_name: 'Grep', tool_input: { pattern: 'x' } }),
    ]);
    expect(session.subagents).toBe(1);
    expect(session.preview).toBe('pedido principal');
  });

  it('evento desconhecido não quebra nem muda o estado', () => {
    const { session } = run([hook('UserPromptSubmit', { prompt: 'x' }), hook('EventoDoFuturo')]);
    expect(session.status).toBe('WORKING');
  });

  it('rejeita payloads malformados', () => {
    expect(parseHookPayload(null)).toBeNull();
    expect(parseHookPayload({ hook_event_name: 'Stop' })).toBeNull();
    expect(parseHookPayload({ session_id: 's', hook_event_name: '../x' })).toBeNull();
    expect(parseHookPayload({ session_id: 's', hook_event_name: 'Stop' })).not.toBeNull();
  });
});

describe('payloads reais do Claude Code 2.1.329', () => {
  const file = fileURLToPath(
    new URL('../../../tests/fixtures/real-session-claude-code-2.1.329.jsonl', import.meta.url),
  );
  const payloads = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => parseHookPayload(JSON.parse(l)));

  it('todos os payloads capturados são aceitos', () => {
    expect(payloads.length).toBe(8);
    expect(payloads.every(Boolean)).toBe(true);
  });

  it('a sessão real percorre IDLE → WORKING → COMPLETED → encerrada', () => {
    const seen: string[] = [];
    let session: Session | undefined;
    let t = 0;
    for (const p of payloads) {
      session = reduceHook(session, p as HookPayload, (t += 1000)).session;
      seen.push(session.status);
    }
    expect(seen).toEqual(['IDLE', 'WORKING', 'WORKING', 'WORKING', 'WORKING', 'WORKING', 'COMPLETED', 'COMPLETED']);
    expect(session?.projectName).toBe('site');
    expect(session?.endedAt).not.toBeNull();
    expect(session?.preview).toContain('hub-probe');
  });
});
