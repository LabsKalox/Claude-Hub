/**
 * Codex e OpenCode chegando a um hub de verdade.
 *
 * Codex: os payloads seguem os schemas gerados do Codex 0.171.0
 * (`hooks/schema/generated/*.command.input.schema.json`), enviados pela mesma
 * rota que o hook de comando usa.
 *
 * OpenCode: o próprio plugin (o mesmo código que vai para a pasta de plugins)
 * roda contra um OpenCode de mentira que entrega os eventos nos formatos dos
 * tipos publicados — V1 (`@opencode-ai/plugin` 1.19.6) e V2 (`@opencode/plugin` 2.3.2).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Approval, Session } from '@claude-hub/shared';
import { v1Hooks, v2Setup } from '../../../packages/claude-bridge/src/opencode-plugin.js';
import { startHub, type TestHub } from './helpers.js';

let t: TestHub;
const saved = { ...process.env };
afterEach(async () => {
  process.env = { ...saved };
  await t?.close();
  t = undefined as unknown as TestHub;
});

/** O plugin acha o hub pelo config.json, como no Mac. */
function pointPluginAtHub(): void {
  const home = mkdtempSync(join(tmpdir(), 'hub-plugin-'));
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ localHost: '127.0.0.1', localPort: Number(new URL(t.localUrl).port), hookToken: t.config.hookToken, approvalTimeoutSec: 30 }),
  );
  process.env.CLAUDE_HUB_HOME = home;
}

const sessions = async () => ((await (await t.local('/api/sessions')).json()) as { sessions: Session[] }).sessions;
const approvals = async (status?: string) =>
  ((await (await t.local(`/api/approvals${status ? `?status=${status}` : ''}`)).json()) as { approvals: Approval[] }).approvals;
async function waitAsync<T>(fn: () => Promise<T | null | undefined | false>, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('tempo esgotado');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const decide = async (token: string, id: string, decision: 'allow' | 'deny') =>
  t.device(token, `/api/approvals/${id}/decision`, { method: 'POST', body: JSON.stringify({ decision }) });

describe('Codex', () => {
  it('sessão, ferramenta e pedido de permissão: o hub identifica o Codex e devolve a decisão no formato que ele lê', async () => {
    t = await startHub();
    const token = await t.pairDevice();
    const common = { session_id: '019a3b2c-7d4e-7f00-9a1b-2c3d4e5f6a7b', transcript_path: null, cwd: '/Users/dev/projetos/api', model: 'gpt-5-codex', permission_mode: 'default', turn_id: 'turn-1', hub_agent: 'codex' };
    await t.hook('SessionStart', { ...common, source: 'startup' });
    await t.hook('UserPromptSubmit', { ...common, prompt: 'Atualize as dependências' });
    const held = t.hook('PermissionRequest', { ...common, tool_name: 'Bash', tool_input: { command: 'npm install', description: 'Instalar' } });
    const [approval] = await waitAsync(async () => (await approvals('pending')).length > 0 && approvals('pending'));
    expect(approval).toMatchObject({ agentKind: 'codex', toolName: 'Bash', command: 'npm install', projectName: 'api' });
    expect(t.push.sent.at(-1)?.title).toBe('Codex quer usar Bash');
    const session = (await sessions()).find((s) => s.id === common.session_id);
    expect(session).toMatchObject({ agentKind: 'codex', status: 'APPROVAL_REQUIRED', agent: 'gpt-5-codex' });

    expect((await decide(token, approval!.id, 'allow')).status).toBe(200);
    const res = await held;
    expect(await res.json()).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    expect(t.audit.list(20).find((e) => e.action === 'approval.created')?.actor).toBe('codex');
  });

  it('patch (apply_patch) mostra o patch inteiro para quem decide', async () => {
    t = await startHub();
    const token = await t.pairDevice();
    const patch = '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-const a = 1\n+const a = 2\n*** End Patch';
    const held = t.hook('PermissionRequest', { session_id: 'cx-2', cwd: '/p/api', hub_agent: 'codex', tool_name: 'apply_patch', tool_input: { command: patch } });
    const [approval] = await waitAsync(async () => (await approvals('pending')).length > 0 && approvals('pending'));
    expect(approval!.command).toBe(patch);
    await decide(token, approval!.id, 'deny');
    expect(await (await held).json()).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
  });

  it('agente desconhecido é recusado', async () => {
    t = await startHub();
    expect((await t.hook('SessionStart', { session_id: 'x', hub_agent: 'outro' })).status).toBe(400);
  });
});

describe('OpenCode V1 (plugin.server)', () => {
  function fakeClient() {
    const replies: Array<{ path: { id: string; permissionID: string }; body: { response: string } }> = [];
    return { replies, client: { postSessionIdPermissionsPermissionId: async (o: (typeof replies)[number]) => void replies.push(o) } };
  }

  it('eventos viram sessão do OpenCode; permitir no iPhone responde "once" ao OpenCode', async () => {
    t = await startHub();
    pointPluginAtHub();
    const token = await t.pairDevice();
    const { client, replies } = fakeClient();
    const hooks = v1Hooks({ client, directory: '/Users/dev/projetos/loja' }) as Record<string, (...a: unknown[]) => Promise<void>>;

    await hooks.event!({ event: { type: 'session.created', properties: { info: { id: 'ses_A', title: 'Checkout novo' } } } });
    await hooks['chat.message']!({ sessionID: 'ses_A' }, { parts: [{ type: 'text', text: 'Rode os testes' }] });
    await hooks['tool.execute.before']!({ tool: 'bash', sessionID: 'ses_A', callID: 'call_1' }, { args: { command: 'npm test', description: 'Testes' } });
    await hooks.event!({
      event: { type: 'todo.updated', properties: { sessionID: 'ses_A', todos: [{ content: 'a', status: 'completed', priority: 'high' }, { content: 'b', status: 'pending', priority: 'low' }] } },
    });
    const s1 = await waitAsync(async () => (await sessions()).find((s) => s.id === 'ses_A' && s.progress));
    expect(s1).toMatchObject({ agentKind: 'opencode', title: 'Checkout novo', projectName: 'loja', status: 'WORKING', task: 'Rode os testes' });
    expect(s1.progress).toMatchObject({ done: 1, total: 2 });

    // Pedido de permissão no formato do evento permission.asked do V1.
    await hooks.event!({
      event: { type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_A', permission: 'bash', patterns: ['rm -rf dist && npm run build'], metadata: {}, always: ['rm *'] } },
    });
    const [approval] = await waitAsync(async () => (await approvals('pending')).length > 0 && approvals('pending'));
    expect(approval).toMatchObject({ agentKind: 'opencode', toolName: 'Bash', command: 'rm -rf dist && npm run build' });
    expect(t.push.sent.at(-1)?.title).toBe('OpenCode quer usar Bash');

    await decide(token, approval!.id, 'allow');
    await waitAsync(async () => replies.length > 0);
    expect(replies).toEqual([{ path: { id: 'ses_A', permissionID: 'per_1' }, body: { response: 'once' } }]);

    await hooks.event!({ event: { type: 'session.idle', properties: { sessionID: 'ses_A' } } });
    await waitAsync(async () => (await sessions()).find((s) => s.id === 'ses_A' && s.status === 'COMPLETED'));
  });

  it('negar no iPhone responde "reject"; arquivo editado mostra o caminho', async () => {
    t = await startHub();
    pointPluginAtHub();
    const token = await t.pairDevice();
    const { client, replies } = fakeClient();
    const hooks = v1Hooks({ client, directory: '/p/loja' }) as Record<string, (...a: unknown[]) => Promise<void>>;
    await hooks.event!({
      event: { type: 'permission.asked', properties: { id: 'per_2', sessionID: 'ses_B', permission: 'edit', patterns: ['src/pagamento.ts'], metadata: { filepath: '/p/loja/src/pagamento.ts', diff: '-a\n+b' } } },
    });
    const [approval] = await waitAsync(async () => (await approvals('pending')).length > 0 && approvals('pending'));
    expect(approval).toMatchObject({ toolName: 'Edit', command: '/p/loja/src/pagamento.ts' });
    await decide(token, approval!.id, 'deny');
    await waitAsync(async () => replies.length > 0);
    expect(replies[0]).toEqual({ path: { id: 'ses_B', permissionID: 'per_2' }, body: { response: 'reject' } });
  });

  it('respondido no terminal: o pedido é cancelado no hub e o plugin não responde de novo', async () => {
    t = await startHub();
    pointPluginAtHub();
    const token = await t.pairDevice();
    const { client, replies } = fakeClient();
    const hooks = v1Hooks({ client, directory: '/p/loja' }) as Record<string, (...a: unknown[]) => Promise<void>>;
    await hooks.event!({ event: { type: 'permission.asked', properties: { id: 'per_3', sessionID: 'ses_C', permission: 'bash', patterns: ['git push'] } } });
    const [approval] = await waitAsync(async () => (await approvals('pending')).length > 0 && approvals('pending'));
    await hooks.event!({ event: { type: 'permission.replied', properties: { sessionID: 'ses_C', requestID: 'per_3', reply: 'once' } } });
    await waitAsync(async () => (await approvals()).find((a) => a.id === approval!.id && a.status === 'cancelled'));
    expect((await decide(token, approval!.id, 'allow')).status).toBe(409);
    await new Promise((r) => setTimeout(r, 100));
    expect(replies).toHaveLength(0);
  });

  it('hub fora do ar: o plugin não atrapalha (nenhuma resposta, nenhum erro)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hub-plugin-'));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ localPort: 9, hookToken: 'x' }));
    process.env.CLAUDE_HUB_HOME = home;
    const replies: unknown[] = [];
    const hooks = v1Hooks({ client: { postSessionIdPermissionsPermissionId: async (o) => void replies.push(o) }, directory: '/p' }) as Record<string, (...a: unknown[]) => Promise<void>>;
    await expect(hooks.event!({ event: { type: 'permission.asked', properties: { id: 'p', sessionID: 's', permission: 'bash', patterns: ['ls'] } } })).resolves.toBeUndefined();
    await hooks['tool.execute.before']!({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: { command: 'ls' } });
    await new Promise((r) => setTimeout(r, 200));
    expect(replies).toHaveLength(0);
  });
});

describe('OpenCode V2 (Plugin.define / setup)', () => {
  /** OpenCode V2 de mentira: fila de eventos, ganchos de ferramenta e permission.reply. */
  function fakeContext(directory = '/Users/dev/projetos/painel') {
    const queue: Array<{ type: string; data: Record<string, unknown>; location?: { directory: string } }> = [];
    let wake: (() => void) | null = null;
    const replies: Array<Record<string, unknown>> = [];
    const toolHooks: Record<string, (e: Record<string, unknown>) => void | Promise<void>> = {};
    let subscribed: string[] = [];
    const ctx = {
      location: { directory },
      event: {
        subscribe: (o?: { types?: string[]; signal?: AbortSignal }) => {
          subscribed = o?.types ?? [];
          return {
            async *[Symbol.asyncIterator]() {
              while (!o?.signal?.aborted) {
                if (queue.length === 0) await new Promise<void>((r) => (wake = r));
                const ev = queue.shift();
                if (ev) yield ev;
              }
            },
          };
        },
      },
      tool: {
        hook: async (name: 'execute.before' | 'execute.after', cb: (e: Record<string, unknown>) => void) => {
          toolHooks[name] = cb;
          return { dispose: async () => void delete toolHooks[name] };
        },
      },
      permission: { reply: async (i: Record<string, unknown>) => void replies.push(i) },
    };
    const emit = (type: string, data: Record<string, unknown>, location?: { directory: string }) => {
      queue.push({ type, data, ...(location ? { location } : {}) });
      wake?.();
      wake = null;
    };
    return { ctx, emit, replies, toolHooks, subscribed: () => subscribed };
  }

  it('barramento global do 2.x: com duas pastas abertas, só a instância da pasta da sessão encaminha (sem pedidos duplicados)', async () => {
    t = await startHub();
    pointPluginAtHub();
    const token = await t.pairDevice();
    const a = fakeContext('/Users/dev/projetos/api');
    const b = fakeContext('/Users/dev/projetos/site');
    const stopA = await v2Setup(a.ctx);
    const stopB = await v2Setup(b.ctx);
    // O OpenCode entrega o mesmo evento às duas instâncias, com a pasta da sessão no envelope.
    const both = (type: string, data: Record<string, unknown>, dir: string) => {
      a.emit(type, data, { directory: dir });
      b.emit(type, data, { directory: dir });
    };
    both('session.created', { sessionID: 'ses_api', title: 'API', location: { directory: '/Users/dev/projetos/api' } }, '/Users/dev/projetos/api');
    both('session.created', { sessionID: 'ses_site', title: 'Site', location: { directory: '/Users/dev/projetos/site' } }, '/Users/dev/projetos/site');
    both('permission.asked', { id: 'per_api', sessionID: 'ses_api', action: 'shell', resources: ['npm test'] }, '/Users/dev/projetos/api');
    const pending = await waitAsync(async () => (await approvals('pending')).length > 0 && approvals('pending'));
    await new Promise((r) => setTimeout(r, 150));
    expect((await approvals('pending')).length).toBe(1);
    expect(pending[0]).toMatchObject({ projectName: 'api', command: 'npm test' });
    const all = await sessions();
    expect(all.find((s) => s.id === 'ses_api')?.projectName).toBe('api');
    expect(all.find((s) => s.id === 'ses_site')?.projectName).toBe('site');
    // Gancho de ferramenta (também global): só a instância dona encaminha.
    await a.toolHooks['execute.before']!({ tool: 'shell', sessionID: 'ses_site', id: 'c1', input: { command: 'ls' } });
    await b.toolHooks['execute.before']!({ tool: 'shell', sessionID: 'ses_site', id: 'c1', input: { command: 'ls' } });
    await decide(token, pending[0]!.id, 'allow');
    await waitAsync(async () => a.replies.length > 0);
    expect(b.replies).toHaveLength(0);
    const events = ((await (await t.local('/api/events?sessionId=ses_site')).json()) as { events: Array<{ toolName: string | null }> }).events;
    expect(events.filter((e) => e.toolName === 'Bash')).toHaveLength(1);
    await stopA();
    await stopB();
  });

  it('eventos e ferramentas do V2 chegam ao hub; permitir no iPhone chama permission.reply com "once"', async () => {
    t = await startHub();
    pointPluginAtHub();
    const token = await t.pairDevice();
    const { ctx, emit, replies, toolHooks, subscribed } = fakeContext();
    const cleanup = await v2Setup(ctx);
    expect(subscribed()).toContain('permission.asked');
    expect(subscribed()).toContain('permission.replied');

    emit('session.created', { sessionID: 'ses_V2', title: 'Dashboard', projectID: 'p' });
    emit('session.execution.started', { sessionID: 'ses_V2' });
    await toolHooks['execute.before']!({ tool: 'edit', sessionID: 'ses_V2', agent: 'build', messageID: 'm', id: 'call_9', input: { filePath: '/Users/dev/projetos/painel/app.tsx' } });
    const s = await waitAsync(async () => (await sessions()).find((x) => x.id === 'ses_V2' && x.status === 'WORKING' && x.title === 'Dashboard'));
    expect(s).toMatchObject({ agentKind: 'opencode', title: 'Dashboard', projectName: 'painel', status: 'WORKING' });
    const events = await waitAsync(async () => {
      const list = ((await (await t.local('/api/events?sessionId=ses_V2')).json()) as { events: Array<{ summary: string; toolName: string | null }> }).events;
      return list.some((e) => e.toolName === 'Edit') && list;
    });
    expect(events.find((e) => e.toolName === 'Edit')?.summary).toBe('Editando app.tsx');

    emit('permission.asked', { id: 'per_V2', sessionID: 'ses_V2', action: 'bash', resources: ['docker compose up -d'], save: ['docker *'] });
    const [approval] = await waitAsync(async () => (await approvals('pending')).length > 0 && approvals('pending'));
    expect(approval).toMatchObject({ agentKind: 'opencode', toolName: 'Bash', command: 'docker compose up -d' });
    await decide(token, approval!.id, 'allow');
    await waitAsync(async () => replies.length > 0);
    expect(replies[0]).toEqual({ sessionID: 'ses_V2', requestID: 'per_V2', decision: 'once' });

    // 2.x avisa o fim com execution.succeeded (não emite session.idle).
    emit('session.execution.succeeded', { sessionID: 'ses_V2' });
    await waitAsync(async () => (await sessions()).find((x) => x.id === 'ses_V2' && x.status === 'COMPLETED'));

    emit('session.execution.started', { sessionID: 'ses_V2' });
    emit('session.execution.failed', { sessionID: 'ses_V2', error: { type: 'provider', message: 'rate limited' } });
    // O OpenCode avisa "ocioso" logo depois do erro: não pode apagar o Erro.
    emit('session.idle', { sessionID: 'ses_V2' });
    const failed = await waitAsync(async () => (await sessions()).find((x) => x.id === 'ses_V2' && x.status === 'ERROR'));
    expect(failed.preview).toBe('provider: rate limited');
    await new Promise((r) => setTimeout(r, 150));
    expect((await sessions()).find((x) => x.id === 'ses_V2')?.status).toBe('ERROR');
    await cleanup();
    expect(Object.keys(toolHooks)).toHaveLength(0);
  });

  it('negar responde "reject" com a mensagem; resposta no terminal cancela o pedido no hub', async () => {
    t = await startHub();
    pointPluginAtHub();
    const token = await t.pairDevice();
    const { ctx, emit, replies } = fakeContext();
    const cleanup = await v2Setup(ctx);

    emit('permission.asked', { id: 'per_D', sessionID: 'ses_D', action: 'webfetch', resources: ['https://exemplo.com/api'] });
    const [first] = await waitAsync(async () => (await approvals('pending')).length > 0 && approvals('pending'));
    expect(first).toMatchObject({ toolName: 'WebFetch', command: 'https://exemplo.com/api' });
    await decide(token, first!.id, 'deny');
    await waitAsync(async () => replies.length > 0);
    expect(replies[0]).toEqual({ sessionID: 'ses_D', requestID: 'per_D', decision: 'reject', message: 'Negado pelo usuário no Claude Hub.' });

    emit('permission.asked', { id: 'per_E', sessionID: 'ses_D', action: 'bash', resources: ['make deploy'] });
    const [second] = await waitAsync(async () => (await approvals('pending')).length > 0 && approvals('pending'));
    emit('permission.replied', { sessionID: 'ses_D', requestID: 'per_E', reply: 'reject' });
    await waitAsync(async () => (await approvals()).find((a) => a.id === second!.id && a.status === 'cancelled'));
    expect(replies).toHaveLength(1);
    await cleanup();
  });
});
