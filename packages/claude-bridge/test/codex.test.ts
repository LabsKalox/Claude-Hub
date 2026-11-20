import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_EVENTS,
  buildCodexHooks,
  codexHookCommand,
  codexHooksPath,
  codexStatus,
  defaultConfig,
  installCodexHooks,
  isCodexHubHandler,
  uninstallCodexHooks,
} from '../src/index.js';

const NODE = '/Applications/ClaudeHub.app/Contents/Resources/runtime/bin/node';
const HOOK = '/Applications/ClaudeHub.app/Contents/Resources/runtime/claude-hub-hook.mjs';
const saved = { ...process.env };
let codexHome: string;

beforeEach(() => {
  codexHome = mkdtempSync(join(tmpdir(), 'hub-codex-'));
  process.env.CODEX_HOME = codexHome;
});
afterEach(() => {
  process.env = { ...saved };
});

/** Hooks do usuário no formato do Codex (`config/src/hooks_tests.rs`). */
const USER_HOOKS = {
  hooks: {
    PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: '~/bin/meu-guard.sh', timeout: 30 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'say pronto', async: true }] }],
  },
  meuCampo: 'fica',
};

describe('Codex: hooks.json', () => {
  it('os hooks do hub cobrem os eventos do Codex, com o hook de comando marcado --agent codex', () => {
    const map = buildCodexHooks({ ...defaultConfig(), approvalTimeoutSec: 300 }, NODE, HOOK);
    expect(Object.keys(map).sort()).toEqual([...CODEX_EVENTS].sort());
    const handler = map.PermissionRequest![0]!.hooks[0]!;
    expect(handler).toEqual({ type: 'command', command: `"${NODE}" "${HOOK}" --agent codex`, timeout: 330 });
    // O Codex limita SessionEnd a 3 s.
    expect(map.SessionEnd![0]!.hooks[0]!.timeout).toBe(3);
    expect(isCodexHubHandler(handler)).toBe(true);
    // O mesmo hook sem --agent codex (o do Claude Code) não é confundido com o do Codex.
    expect(isCodexHubHandler({ type: 'command', command: `"${NODE}" "${HOOK}"` })).toBe(false);
  });

  it('instala num arquivo só de hooks, preserva os do usuário, faz backup e é idempotente', () => {
    writeFileSync(codexHooksPath(), JSON.stringify(USER_HOOKS, null, 2));
    const first = installCodexHooks(defaultConfig(), NODE, HOOK);
    expect(first.ok).toBe(true);
    expect(first.detail).toContain('confiar nos hooks novos');
    const after = JSON.parse(readFileSync(codexHooksPath(), 'utf8')) as typeof USER_HOOKS & { hooks: Record<string, unknown[]> };
    expect(after.meuCampo).toBe('fica');
    expect(after.hooks.PreToolUse![0]).toEqual(USER_HOOKS.hooks.PreToolUse[0]);
    expect(after.hooks.Stop![0]).toEqual(USER_HOOKS.hooks.Stop[0]);
    expect(after.hooks.PermissionRequest).toHaveLength(1);
    expect(readdirSync(codexHome).filter((f) => f.endsWith('.bak'))).toHaveLength(1);

    const before = readFileSync(codexHooksPath(), 'utf8');
    expect(installCodexHooks(defaultConfig(), NODE, HOOK).detail).toContain('já estavam');
    expect(readFileSync(codexHooksPath(), 'utf8')).toBe(before);
    expect(readdirSync(codexHome).filter((f) => f.endsWith('.bak'))).toHaveLength(1);

    const st = codexStatus(NODE, HOOK);
    expect(st).toMatchObject({ valid: true, current: true, otherHooks: 2 });
    expect(st.events.sort()).toEqual([...CODEX_EVENTS].sort());
    // App movido: o comando gravado não aponta mais para ele.
    expect(codexStatus('/outro/node', HOOK).current).toBe(false);
  });

  it('desinstalar devolve exatamente os hooks do usuário', () => {
    writeFileSync(codexHooksPath(), JSON.stringify(USER_HOOKS, null, 2));
    installCodexHooks(defaultConfig(), NODE, HOOK);
    expect(uninstallCodexHooks().ok).toBe(true);
    expect(JSON.parse(readFileSync(codexHooksPath(), 'utf8'))).toEqual(USER_HOOKS);
    expect(uninstallCodexHooks().detail).toContain('Não havia');
  });

  it('arquivo inválido não é tocado', () => {
    writeFileSync(codexHooksPath(), '{ isto não é json');
    expect(installCodexHooks(defaultConfig(), NODE, HOOK).ok).toBe(false);
    expect(readFileSync(codexHooksPath(), 'utf8')).toBe('{ isto não é json');
    expect(codexStatus(NODE, HOOK).valid).toBe(false);
  });

  it('sem arquivo prévio, cria só com os hooks do hub', () => {
    expect(existsSync(codexHooksPath())).toBe(false);
    installCodexHooks(defaultConfig(), NODE, HOOK);
    const file = JSON.parse(readFileSync(codexHooksPath(), 'utf8')) as { hooks: Record<string, unknown> };
    expect(Object.keys(file)).toEqual(['hooks']);
    expect(codexHookCommand(NODE, HOOK)).toContain('--agent codex');
  });
});

// ── O hook de comando chamado como o Codex chama: JSON no stdin, `--agent codex` ──
const script = fileURLToPath(new URL('../dist/hook-command.js', import.meta.url));
let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

describe.skipIf(!existsSync(script))('hook de comando no Codex', () => {
  it('marca o evento como do Codex e devolve a decisão no formato que o Codex lê', async () => {
    const received: Array<Record<string, unknown>> = [];
    const decision = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    const port = await new Promise<number>((resolve) => {
      server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          received.push(JSON.parse(raw) as Record<string, unknown>);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(decision);
        });
      }).listen(0, '127.0.0.1', () => resolve((server?.address() as AddressInfo).port));
    });
    const home = mkdtempSync(join(tmpdir(), 'hub-hook-'));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ ...defaultConfig(), localPort: port, hookToken: 'tok' }));
    // Campos do `permission-request.command.input.schema.json` do Codex 0.171.0.
    const payload = {
      session_id: '019a3b2c-7d4e-7f00-9a1b-2c3d4e5f6a7b',
      transcript_path: null,
      cwd: '/Users/dev/projetos/site',
      hook_event_name: 'PermissionRequest',
      model: 'gpt-5-codex',
      permission_mode: 'default',
      turn_id: 'turn-1',
      tool_name: 'Bash',
      tool_input: { command: 'npm run build', description: 'Compilar' },
    };
    const out = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [script, '--agent', 'codex'], { env: { ...process.env, CLAUDE_HUB_HOME: home } });
      let stdout = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.on('exit', () => resolve(stdout));
      child.stdin.end(JSON.stringify(payload));
    });
    expect(received[0]).toMatchObject({ ...payload, hub_agent: 'codex' });
    expect(JSON.parse(out)).toEqual(JSON.parse(decision));
  });
});
