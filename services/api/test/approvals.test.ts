import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Approval, Session } from '@claude-hub/shared';
import { BASH, startHub, waitFor, type TestHub } from './helpers.js';

let t: TestHub;
beforeEach(async () => {
  t = await startHub();
});
afterEach(async () => {
  await t.close();
});

const pending = () => t.hub.listApprovals('pending')[0];
const session = () => t.hub.getSession('s1') as Session;

describe('hooks → estado das sessões', () => {
  it('exige o token de hook', async () => {
    const res = await fetch(`${t.localUrl}/hooks/claude-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer errado' },
      body: JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' }),
    });
    expect(res.status).toBe(401);
    expect(t.hub.listSessions()).toHaveLength(0);
  });

  it('o token local (app/CLI) não serve para enviar hooks, e vice-versa', async () => {
    const asLocal = await fetch(`${t.localUrl}/hooks/claude-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t.config.localToken}` },
      body: JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' }),
    });
    expect(asLocal.status).toBe(401);
    const asHook = await fetch(`${t.localUrl}/api/sessions`, { headers: { authorization: `Bearer ${t.config.hookToken}` } });
    expect(asHook.status).toBe(401);
  });

  it('rejeita payload inválido', async () => {
    const res = await fetch(`${t.localUrl}/hooks/claude-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t.config.hookToken}` },
      body: JSON.stringify({ foo: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it('acompanha várias sessões ao mesmo tempo', async () => {
    await t.hook('UserPromptSubmit', { session_id: 'a', prompt: 'editar vídeo', cwd: '/p/videos' });
    await t.hook('UserPromptSubmit', { session_id: 'b', prompt: 'máquina de reels', cwd: '/p/reels' });
    await t.hook('Stop', { session_id: 'b', last_assistant_message: 'Pronto.', cwd: '/p/reels' });
    const res = await t.local('/api/sessions');
    const { sessions } = (await res.json()) as { sessions: Session[] };
    expect(sessions.map((s) => [s.projectName, s.status]).sort()).toEqual([
      ['reels', 'COMPLETED'],
      ['videos', 'WORKING'],
    ]);
  });

  it('responde 200 sem corpo a eventos comuns (não interfere no Claude Code)', async () => {
    const res = await t.hook('PreToolUse', BASH);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('SessionEnd tira a sessão da lista', async () => {
    await t.hook('UserPromptSubmit', { prompt: 'x' });
    await t.hook('SessionEnd', { reason: 'other' });
    expect(t.hub.listSessions()).toHaveLength(0);
  });
});

describe('aprovação remota', () => {
  it('segura o hook e devolve allow quando o iPhone permite', async () => {
    const token = await t.pairDevice();
    await t.hook('UserPromptSubmit', { prompt: 'publicar' });
    const hookRes = t.hook('PermissionRequest', BASH);
    const approval = await waitFor(pending);

    expect(session().status).toBe('APPROVAL_REQUIRED');
    expect(approval.command).toBe('npm install && npm run build -- --prod');
    expect(approval.projectName).toBe('site');

    const decision = await t.device(token, `/api/approvals/${approval.id}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'allow' }),
    });
    expect(decision.status).toBe(200);

    const out = (await (await hookRes).json()) as unknown;
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(session().status).toBe('WORKING');
    expect(t.hub.getApproval(approval.id)?.decidedBy).toMatch(/^dev_/);
  });

  it('devolve deny com mensagem quando a ilha nega', async () => {
    const hookRes = t.hook('PermissionRequest', BASH);
    const approval = await waitFor(pending);
    await t.local(`/api/approvals/${approval.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'deny' }) });
    const out = (await (await hookRes).json()) as { hookSpecificOutput: { decision: { behavior: string; message: string } } };
    expect(out.hookSpecificOutput.decision.behavior).toBe('deny');
    expect(out.hookSpecificOutput.decision.message).toContain('Negado');
    expect(t.hub.getApproval(approval.id)?.decidedBy).toBe('mac');
  });

  it('a resposta nunca altera o comando nem cria regras permanentes', async () => {
    const hookRes = t.hook('PermissionRequest', BASH);
    const approval = await waitFor(pending);
    await t.local(`/api/approvals/${approval.id}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'allow', updatedInput: { command: 'rm -rf /' }, updatedPermissions: [{ type: 'setMode' }] }),
    });
    const text = await (await hookRes).text();
    expect(text).not.toContain('updatedInput');
    expect(text).not.toContain('updatedPermissions');
    expect(text).not.toContain('rm -rf');
  });

  it('impede decisão duplicada: só a primeira vale', async () => {
    const token = await t.pairDevice();
    const hookRes = t.hook('PermissionRequest', BASH);
    const approval = await waitFor(pending);
    const decide = (decision: string) =>
      t.device(token, `/api/approvals/${approval.id}/decision`, { method: 'POST', body: JSON.stringify({ decision }) });
    const [a, b] = await Promise.all([decide('deny'), decide('allow')]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const third = await decide('allow');
    expect(third.status).toBe(409);
    expect(((await third.json()) as { error: string }).error).toBe('already_decided');
    await hookRes;
    expect(t.audit.list().some((e) => e.action === 'approval.decision_rejected')).toBe(true);
  });

  it('decisão para outro id não afeta o pedido pendente', async () => {
    const hookRes = t.hook('PermissionRequest', BASH);
    const approval = await waitFor(pending);
    const res = await t.local('/api/approvals/apr_inexistente/decision', { method: 'POST', body: JSON.stringify({ decision: 'allow' }) });
    expect(res.status).toBe(404);
    expect(t.hub.getApproval(approval.id)?.status).toBe('pending');
    await t.local(`/api/approvals/${approval.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'deny' }) });
    await hookRes;
  });

  it('recusa decisão inválida', async () => {
    const hookRes = t.hook('PermissionRequest', BASH);
    const approval = await waitFor(pending);
    const res = await t.local(`/api/approvals/${approval.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'sempre' }) });
    expect(res.status).toBe(400);
    await t.local(`/api/approvals/${approval.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'deny' }) });
    await hookRes;
  });

  it('se o Claude Code fecha a conexão (respondido no terminal), o pedido é cancelado', async () => {
    const ctrl = new AbortController();
    const hookRes = t.hook('PermissionRequest', BASH, { signal: ctrl.signal }).catch(() => null);
    const approval = await waitFor(pending);
    ctrl.abort();
    await hookRes;
    await waitFor(() => t.hub.getApproval(approval.id)?.status === 'cancelled');
    const late = await t.local(`/api/approvals/${approval.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'allow' }) });
    expect(late.status).toBe(409);
  });

  it('PostToolUse da mesma chamada cancela o pedido (resolvido em outro lugar)', async () => {
    const ctrl = new AbortController();
    void t.hook('PermissionRequest', BASH, { signal: ctrl.signal }).catch(() => null);
    const approval = await waitFor(pending);
    await t.hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/x' } });
    expect(t.hub.getApproval(approval.id)?.status).toBe('pending');
    await t.hook('PostToolUse', BASH);
    expect(t.hub.getApproval(approval.id)?.status).toBe('cancelled');
    expect(session().status).toBe('WORKING');
    ctrl.abort();
  });

  it('pergunta do Claude (AskUserQuestion) não vira aprovação remota', async () => {
    const res = await t.hook('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } });
    expect(await res.text()).toBe('');
    expect(t.hub.listApprovals()).toHaveLength(0);
    expect(session().status).toBe('WAITING');
  });

  it('modo "Só avisar": avisa, mas não segura nem decide', async () => {
    await t.local('/api/settings', { method: 'PUT', body: JSON.stringify({ approvalMode: 'notify' }) });
    const res = await t.hook('PermissionRequest', BASH);
    expect(await res.text()).toBe('');
    expect(t.hub.listApprovals()).toHaveLength(0);
    expect(session().status).toBe('APPROVAL_REQUIRED');
    expect(t.push.sent.at(-1)?.kind).toBe('approval');
  });

  it('não existe modo que aprove sozinho', async () => {
    for (const approvalMode of ['auto', 'always', 'notify', 'yolo']) {
      await t.local('/api/settings', { method: 'PUT', body: JSON.stringify({ approvalMode }) });
      const ctrl = new AbortController();
      const res = t.hook('PermissionRequest', BASH, { signal: ctrl.signal }).catch(() => null);
      await new Promise((r) => setTimeout(r, 60));
      expect(t.hub.listApprovals('allowed')).toHaveLength(0);
      ctrl.abort();
      await res;
    }
  });
});

describe('expiração', () => {
  it('pedido sem resposta expira e devolve o controle ao terminal', async () => {
    const short = await startHub({ approvalTimeoutSec: 0.15 });
    try {
      const res = await short.hook('PermissionRequest', BASH);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
      const approval = short.hub.listApprovals()[0] as Approval;
      expect(approval.status).toBe('expired');
      const late = await short.local(`/api/approvals/${approval.id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'allow' }),
      });
      expect(late.status).toBe(409);
      expect(((await late.json()) as { error: string }).error).toBe('expired');
    } finally {
      await short.close();
    }
  });
});

describe('roteamento para o celular', () => {
  it('"Sempre aqui" manda o pedido para o celular, com link para o pedido exato', async () => {
    const ctrl = new AbortController();
    void t.hook('PermissionRequest', BASH, { signal: ctrl.signal }).catch(() => null);
    const approval = await waitFor(pending);
    const push = t.push.sent.find((p) => p.kind === 'approval');
    expect(push?.title).toBe('Claude quer usar Bash');
    expect(push?.url).toBe(`/?approval=${approval.id}`);
    ctrl.abort();
  });

  it('"Automático" só manda para o celular quando você está longe', async () => {
    await t.local('/api/settings', { method: 'PUT', body: JSON.stringify({ approvalMode: 'auto' }) });
    t.hub.macConnected();
    t.hub.setMacIdle(3);
    await t.hook('Stop', { last_assistant_message: 'Vídeo pronto' });
    expect(t.push.sent).toHaveLength(0);

    await t.local('/api/settings', { method: 'PUT', body: JSON.stringify({ away: true }) });
    await t.hook('Stop', { last_assistant_message: 'Vídeo pronto' });
    expect(t.push.sent).toHaveLength(1);
    expect(t.push.sent[0]?.kind).toBe('completed');

    await t.local('/api/settings', { method: 'PUT', body: JSON.stringify({ away: false }) });
    t.hub.setMacIdle(600);
    await t.hook('Stop', { last_assistant_message: 'Vídeo pronto' });
    expect(t.push.sent).toHaveLength(2);
  });
});
