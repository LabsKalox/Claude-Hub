import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '@claude-hub/shared';
import { BASH, startHub, waitFor, type TestHub } from './helpers.js';

let t: TestHub;
beforeEach(async () => {
  t = await startHub();
});
afterEach(async () => {
  await t.close();
});

describe('separação das portas', () => {
  it('a porta do iPhone não expõe hooks nem rotas administrativas', async () => {
    const hook = await fetch(`${t.publicUrl}/hooks/claude-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t.config.hookToken}` },
      body: JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' }),
    });
    expect(hook.status).toBe(404);
    for (const path of ['/local/pairing', '/local/devices', '/local/info']) {
      const res = await fetch(`${t.publicUrl}${path}`, { headers: { authorization: `Bearer ${t.config.localToken}` } });
      expect(res.status).toBe(404);
    }
  });

  it('o token local não vale na porta do iPhone', async () => {
    const res = await fetch(`${t.publicUrl}/api/sessions`, { headers: { authorization: `Bearer ${t.config.localToken}` } });
    expect(res.status).toBe(401);
  });

  it('toda a API exige autenticação', async () => {
    for (const base of [t.localUrl, t.publicUrl]) {
      for (const path of ['/api/sessions', '/api/approvals', '/api/events', '/api/settings', '/api/audit', '/api/usage']) {
        expect((await fetch(`${base}${path}`)).status).toBe(401);
      }
    }
  });

  it('a porta local não aceita pareamento de fora', async () => {
    const res = await fetch(`${t.localUrl}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'AAAA-BBBB' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('pareamento', () => {
  const pair = (code: string) =>
    fetch(`${t.publicUrl}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceName: 'iPhone' }),
    });
  const newCode = async () =>
    ((await (await t.local('/local/pairing', { method: 'POST', body: '{}' })).json()) as { code: string }).code;

  it('o código é de uso único', async () => {
    const code = await newCode();
    expect((await pair(code)).status).toBe(200);
    expect((await pair(code)).status).toBe(401);
  });

  it('aceita o código digitado em minúsculas e sem hífen', async () => {
    const code = await newCode();
    expect((await pair(code.toLowerCase().replace('-', ''))).status).toBe(200);
  });

  it('cinco erros matam o código ativo', async () => {
    const code = await newCode();
    for (let i = 0; i < 5; i++) expect((await pair('ZZZZ-ZZZZ')).status).toBe(401);
    expect((await pair(code)).status).toBe(401);
  });

  it('bloqueia rajadas de tentativas', async () => {
    await newCode();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await pair('ZZZZ-ZZZZ')).status;
    expect(last).toBe(429);
  });

  it('gerar novo código invalida o anterior', async () => {
    const first = await newCode();
    const second = await newCode();
    expect((await pair(first)).status).toBe(401);
    expect((await pair(second)).status).toBe(200);
  });

  it('o token do dispositivo é guardado apenas como hash', async () => {
    const token = await t.pairDevice();
    const rows = t.db.prepare('SELECT token_hash FROM devices').all() as Array<{ token_hash: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(token);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('dispositivo revogado perde o acesso na hora', async () => {
    const token = await t.pairDevice();
    expect((await t.device(token, '/api/sessions')).status).toBe(200);
    const { devices } = (await (await t.local('/local/devices')).json()) as { devices: Array<{ id: string }> };
    await t.local(`/local/devices/${devices[0]?.id}`, { method: 'DELETE' });
    expect((await t.device(token, '/api/sessions')).status).toBe(401);
  });

  it('o link de pareamento usa a URL https informada', async () => {
    const res = await t.local('/local/pairing', { method: 'POST', body: JSON.stringify({ baseUrl: 'https://mac.tailnet.ts.net/' }) });
    const body = (await res.json()) as { code: string; url: string };
    expect(body.url).toBe(`https://mac.tailnet.ts.net/pair/?code=${body.code}`);
  });
});

describe('auditoria', () => {
  it('registra criação e decisão, vinculadas à sessão e ao pedido exatos', async () => {
    const token = await t.pairDevice();
    const hookRes = t.hook('PermissionRequest', BASH);
    const approval = await waitFor(() => t.hub.listApprovals('pending')[0]);
    await t.device(token, `/api/approvals/${approval.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'allow' }) });
    await hookRes;
    const entries = t.audit.list().filter((e) => e.approvalId === approval.id);
    expect(entries.map((e) => e.action).sort()).toEqual(['approval.allowed', 'approval.created']);
    const allowed = entries.find((e) => e.action === 'approval.allowed');
    expect(allowed?.sessionId).toBe('s1');
    expect(allowed?.actor).toMatch(/^dev_/);
    expect(allowed?.detail).toContain('npm install && npm run build -- --prod');
  });

  it('a cadeia de hashes detecta adulteração', async () => {
    await t.pairDevice();
    await t.local('/api/settings', { method: 'PUT', body: JSON.stringify({ away: true }) });
    expect(t.audit.verify().ok).toBe(true);
    t.db.prepare("UPDATE audit SET actor = 'outro' WHERE id = 1").run();
    const verdict = t.audit.verify();
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenAt).toBe(1);
  });

  it('remoção de registro também é detectada', async () => {
    await t.pairDevice();
    await t.local('/api/settings', { method: 'PUT', body: JSON.stringify({ away: true }) });
    t.db.prepare('DELETE FROM audit WHERE id = 2').run();
    expect(t.audit.verify().ok).toBe(false);
  });
});

describe('WebSocket', () => {
  const open = (url: string) => new WebSocket(`${url.replace('http', 'ws')}/ws`);
  const collect = (ws: WebSocket) => {
    const msgs: ServerMessage[] = [];
    ws.on('message', (raw) => msgs.push(JSON.parse(String(raw)) as ServerMessage));
    return msgs;
  };

  it('fecha a conexão sem token válido', async () => {
    const ws = open(t.publicUrl);
    const msgs = collect(ws);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'auth', token: 'errado' }));
    const code = await new Promise<number>((r) => ws.on('close', (c) => r(c)));
    expect(code).toBe(4401);
    expect(msgs[0]?.type).toBe('auth_error');
  });

  it('não envia nada antes da autenticação', async () => {
    const ws = open(t.publicUrl);
    const msgs = collect(ws);
    await new Promise((r) => ws.on('open', r));
    await t.hook('UserPromptSubmit', { prompt: 'segredo' });
    await new Promise((r) => setTimeout(r, 80));
    expect(msgs).toHaveLength(0);
    ws.close();
  });

  it('entrega snapshot e depois sessão, pedido e alerta em tempo real', async () => {
    const token = await t.pairDevice();
    await t.hook('UserPromptSubmit', { prompt: 'publicar o site' });
    const ws = open(t.publicUrl);
    const msgs = collect(ws);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'auth', token }));
    const snapshot = await waitFor(() => msgs.find((m) => m.type === 'snapshot'));
    expect(snapshot.type === 'snapshot' && snapshot.sessions[0]?.status).toBe('WORKING');

    const ctrl = new AbortController();
    void t.hook('PermissionRequest', BASH, { signal: ctrl.signal }).catch(() => null);
    const approvalMsg = await waitFor(() => msgs.find((m) => m.type === 'approval'));
    expect(approvalMsg.type === 'approval' && approvalMsg.approval.status).toBe('pending');
    await waitFor(() => msgs.find((m) => m.type === 'alert' && m.alert.kind === 'approval'));
    await waitFor(() => msgs.find((m) => m.type === 'session' && m.session.status === 'APPROVAL_REQUIRED'));
    ctrl.abort();
    ws.close();
  });

  it('o app macOS conectado e ativo conta como "no computador"', async () => {
    expect(t.hub.isAway()).toBe(true);
    const ws = open(t.localUrl);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'auth', token: t.config.localToken, client: 'macos' }));
    ws.send(JSON.stringify({ type: 'presence', idleSeconds: 2 }));
    await waitFor(() => !t.hub.isAway());
    ws.send(JSON.stringify({ type: 'presence', idleSeconds: 900 }));
    await waitFor(() => t.hub.isAway());
    ws.close();
    await waitFor(() => t.hub.isAway());
  });
});

describe('push', () => {
  it('só dispositivos pareados registram assinatura, e ela precisa ser https', async () => {
    const token = await t.pairDevice();
    const asMac = await t.local('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: {} }) });
    expect(asMac.status).toBe(403);
    const bad = await t.device(token, '/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ subscription: { endpoint: 'http://evil.local/x', keys: { p256dh: 'a', auth: 'b' } } }),
    });
    expect(bad.status).toBe(400);
    const ok = await t.device(token, '/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ subscription: { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'a', auth: 'b' } } }),
    });
    expect(ok.status).toBe(200);
    const { devices } = (await (await t.local('/local/devices')).json()) as { devices: Array<{ pushEnabled: boolean }> };
    expect(devices[0]?.pushEnabled).toBe(true);
  });
});
