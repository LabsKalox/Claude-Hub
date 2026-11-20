import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildHubHooks,
  defaultConfig,
  describeToolCall,
  installedEvents,
  mergeHubHooks,
  readSettings,
  removeHubHooks,
  writeSettings,
  type ClaudeSettings,
} from '../src/index.js';

const cfg = { ...defaultConfig(), localPort: 4317, hookToken: 'tok-123' };
const opts = { hookCommandPath: '/opt/claude-hub/packages/claude-bridge/dist/hook-command.js', nodePath: '/usr/local/bin/node' };

describe('instalação de hooks', () => {
  it('gera hook HTTP local com token e sem falha fechada', () => {
    const hooks = buildHubHooks(cfg, opts);
    const h = hooks.PermissionRequest?.[0]?.hooks[0] as Record<string, unknown>;
    expect(h.type).toBe('http');
    expect(h.url).toBe('http://127.0.0.1:4317/hooks/claude-code');
    expect(h.headers).toEqual({ Authorization: 'Bearer tok-123' });
    expect(h.timeout).toBe(cfg.approvalTimeoutSec + 30);
    expect(h.onFailure).toBeUndefined();
  });

  it('SessionStart usa hook de comando (HTTP não dispara para esse evento)', () => {
    const h = buildHubHooks(cfg, opts).SessionStart?.[0]?.hooks[0] as Record<string, unknown>;
    expect(h.type).toBe('command');
    expect(h.command).toContain('hook-command.js');
  });

  it('--minimal deixa de fora os eventos mais novos', () => {
    expect(buildHubHooks(cfg, { ...opts, minimal: true }).StopFailure).toBeUndefined();
    expect(buildHubHooks(cfg, opts).StopFailure).toBeDefined();
  });

  it('preserva hooks e configurações que não são do hub', () => {
    const mine = { type: 'command', command: 'echo meu-hook' };
    const settings: ClaudeSettings = {
      model: 'opus',
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [mine] }] },
    };
    const merged = mergeHubHooks(settings, buildHubHooks(cfg, opts));
    expect(merged.model).toBe('opus');
    expect(merged.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    expect(merged.hooks?.PreToolUse).toHaveLength(2);
    expect(merged.hooks?.PreToolUse?.[0]).toEqual({ matcher: 'Bash', hooks: [mine] });
    expect(removeHubHooks(merged)).toEqual(settings);
  });

  it('é idempotente', () => {
    const hub = buildHubHooks(cfg, opts);
    const once = mergeHubHooks({}, hub);
    const twice = mergeHubHooks(once, hub);
    expect(twice).toEqual(once);
    expect(installedEvents(twice)).toContain('PermissionRequest');
  });

  it('reinstalar com outra porta/token substitui em vez de duplicar', () => {
    const a = mergeHubHooks({}, buildHubHooks(cfg, opts));
    const b = mergeHubHooks(a, buildHubHooks({ ...cfg, localPort: 5000, hookToken: 'novo' }, opts));
    expect(b.hooks?.Stop).toHaveLength(1);
    expect((b.hooks?.Stop?.[0]?.hooks[0] as Record<string, unknown>).url).toContain(':5000/');
  });

  it('desinstalar de um arquivo só com hooks do hub remove a chave hooks', () => {
    expect(removeHubHooks(mergeHubHooks({}, buildHubHooks(cfg, opts))).hooks).toBeUndefined();
  });

  it('grava com backup do arquivo anterior', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-settings-'));
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ model: 'opus' }));
    const backup = writeSettings(path, mergeHubHooks(readSettings(path), buildHubHooks(cfg, opts)));
    expect(JSON.parse(readFileSync(backup as string, 'utf8'))).toEqual({ model: 'opus' });
    expect(installedEvents(readSettings(path)).length).toBeGreaterThan(5);
  });
});

describe('descrição de chamadas de ferramenta', () => {
  it('mostra o comando Bash inteiro, sem truncar', () => {
    const command = `npm install && npm run build -- --prod ${'x'.repeat(500)}`;
    expect(describeToolCall('Bash', { command })).toBe(command);
  });
  it('usa o caminho do arquivo em edições e a URL em buscas', () => {
    expect(describeToolCall('Edit', { file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(describeToolCall('WebFetch', { url: 'https://x.dev' })).toBe('https://x.dev');
  });
  it('cai para o JSON da entrada em ferramentas desconhecidas', () => {
    expect(describeToolCall('mcp__db__query', { sql: 'select 1' })).toContain('select 1');
  });
});
