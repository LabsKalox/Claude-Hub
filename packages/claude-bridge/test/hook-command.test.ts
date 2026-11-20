import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/index.js';

const script = fileURLToPath(new URL('../dist/hook-command.js', import.meta.url));
// O hook de comando roda como processo separado: o teste usa o build (dist).
const built = existsSync(script);

function runHook(home: string, stdin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, CLAUDE_HUB_HOME: home, __CFBundleIdentifier: 'com.googlecode.iterm2', TERM_PROGRAM: 'iTerm.app' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function homeFor(port: number): string {
  const home = mkdtempSync(join(tmpdir(), 'hub-hook-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ ...defaultConfig(), localPort: port, hookToken: 'tok' }));
  return home;
}

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

function listen(reply: string, status = 200): Promise<{ port: number; received: Array<{ auth?: string; body: Record<string, unknown> }> }> {
  const received: Array<{ auth?: string; body: Record<string, unknown> }> = [];
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        received.push({ auth: req.headers.authorization, body: JSON.parse(raw) as Record<string, unknown> });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(reply);
      });
    }).listen(0, '127.0.0.1', () => resolve({ port: (server?.address() as AddressInfo).port, received }));
  });
}

describe.skipIf(!built)('hook de comando', () => {
  const payload = JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', cwd: '/p/site', source: 'startup' });

  it('repassa o evento ao hub com o token e informa o terminal que hospeda a sessão', async () => {
    const { port, received } = await listen('');
    const r = await runHook(homeFor(port), payload);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(received[0]?.auth).toBe('Bearer tok');
    expect(received[0]?.body.hook_event_name).toBe('SessionStart');
    expect(received[0]?.body.hub_env).toEqual({ host_app: 'com.googlecode.iterm2', term_program: 'iTerm.app' });
  });

  it('devolve ao Claude Code a resposta JSON do hub', async () => {
    const decision = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"x"}}}';
    const { port } = await listen(decision);
    const r = await runHook(homeFor(port), JSON.stringify({ session_id: 's1', hook_event_name: 'PermissionRequest' }));
    expect(JSON.parse(r.stdout)).toEqual(JSON.parse(decision));
  });

  it('hub fora do ar: sai com 0 e sem saída (o Claude Code segue normalmente)', async () => {
    const r = await runHook(homeFor(1), payload);
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('erro do hub ou resposta que não é JSON não chegam ao Claude Code', async () => {
    const a = await listen('{"error":"x"}', 500);
    expect((await runHook(homeFor(a.port), payload)).stdout).toBe('');
    server?.close();
    const b = await listen('<html>oops</html>');
    expect((await runHook(homeFor(b.port), payload)).stdout).toBe('');
  });

  it('sem configuração do hub ou com stdin inválido: não faz nada', async () => {
    expect(await runHook(mkdtempSync(join(tmpdir(), 'hub-empty-')), payload)).toEqual({ code: 0, stdout: '', stderr: '' });
    const { port, received } = await listen('');
    expect((await runHook(homeFor(port), 'não é json')).code).toBe(0);
    expect(received).toHaveLength(0);
  });
});
