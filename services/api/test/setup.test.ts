import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUNTIME_VERSION, defaultConfig, saveConfig, selftest, setupRun, setupStatus, uninstallAll, type HubConfig } from '@claude-hub/claude-bridge';
import { Audit } from '../src/audit.js';
import { Auth } from '../src/auth.js';
import { openDb, type Db } from '../src/db.js';
import { Hub } from '../src/hub.js';
import { VERSION, createServers } from '../src/server.js';
import { FakePush } from './helpers.js';

/**
 * Assistente de configuração e verificação de saúde, exercitados contra um hub
 * de verdade ouvindo numa porta, com diretórios de dados e do Claude Code temporários.
 */
const saved = { ...process.env };
let cfg: HubConfig;
let db: Db;
let hub: Hub;
let push: FakePush;
let claudeDir: string;
let close: () => Promise<void>;

beforeEach(async () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-setup-'));
  claudeDir = mkdtempSync(join(tmpdir(), 'hub-claude-'));
  process.env.CLAUDE_HUB_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.CLAUDE_HUB_LAUNCH_AGENTS_DIR = join(home, 'LaunchAgents');
  process.env.CLAUDE_HUB_TAILSCALE_PATH = '/nao/existe';
  delete process.env.CLAUDE_HUB_LOCAL_PORT;
  delete process.env.CLAUDE_HUB_PUBLIC_PORT;

  db = openDb(':memory:');
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  push = new FakePush();
  cfg = { ...defaultConfig(), localPort: 0 };
  hub = new Hub({ db, audit, push, approvalTimeoutSec: 30 });
  const servers = createServers({ hub, auth, audit, db, push, config: cfg });
  await servers.local.listen({ host: '127.0.0.1', port: 0 });
  cfg.localPort = (servers.local.server.address() as AddressInfo).port;
  saveConfig(cfg);
  close = async () => {
    hub.close();
    await servers.local.close();
    await servers.public.close();
    db.close();
  };
});

afterEach(async () => {
  await close();
  process.env = { ...saved };
});

const settingsFile = () => join(claudeDir, 'settings.json');
const readSettingsFile = () => JSON.parse(readFileSync(settingsFile(), 'utf8')) as Record<string, any>;

describe('versão', () => {
  it('hub, CLI e pacote usam o mesmo número de versão', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VERSION).toBe(RUNTIME_VERSION);
    expect(pkg.version).toBe(RUNTIME_VERSION);
  });
});

describe('configuração inicial', () => {
  it('antes de configurar: hub no ar, hooks ausentes, não está pronto', async () => {
    const st = await setupStatus();
    expect(st.hub.running).toBe(true);
    expect(st.hooks).toEqual({ installed: false, events: 0, current: false });
    expect(st.ready).toBe(false);
  });

  it('instala os hooks preservando as configurações e os hooks do usuário, com backup', async () => {
    const original = {
      model: 'opus',
      permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo meu-hook' }] }] },
    };
    writeFileSync(settingsFile(), JSON.stringify(original, null, 2));
    const r = await setupRun();
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => [s.id, s.ok])).toEqual([
      ['location', true],
      ['service', true],
      ['hub', true],
      ['hooks', true],
      ['claude', true],
    ]);
    const after = readSettingsFile();
    expect(after.model).toBe('opus');
    expect(after.permissions).toEqual(original.permissions);
    expect(after.hooks.PreToolUse[0]).toEqual(original.hooks.PreToolUse[0]);
    expect(after.hooks.PermissionRequest[0].hooks[0].url).toBe(`http://127.0.0.1:${cfg.localPort}/hooks/claude-code`);
    const backups = readdirSync(claudeDir).filter((f) => f.endsWith('.bak'));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(claudeDir, backups[0] as string), 'utf8'))).toEqual(original);
    expect(r.status.hooks.current).toBe(true);
    expect(r.status.claude.otherHooks).toBe(1);
  });

  it('nunca acrescenta permissões nem muda o modo de permissão do Claude Code', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }));
    await setupRun();
    const after = readSettingsFile();
    expect(after.permissions).toEqual({ deny: ['Bash(rm:*)'] });
    const text = JSON.stringify(after);
    for (const forbidden of ['bypassPermissions', 'dangerously', 'defaultMode', 'skipDangerousModePermissionPrompt', 'onFailure']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('rodar de novo é idempotente e não cria outro backup', async () => {
    await setupRun();
    const once = readFileSync(settingsFile(), 'utf8');
    const again = await setupRun();
    expect(again.ok).toBe(true);
    expect(readFileSync(settingsFile(), 'utf8')).toBe(once);
    expect(readdirSync(claudeDir).filter((f) => f.endsWith('.bak'))).toHaveLength(0);
    expect(again.steps.find((s) => s.id === 'hooks')?.detail).toContain('Já estavam atualizados');
  });

  it('settings.json inválido não é sobrescrito', async () => {
    writeFileSync(settingsFile(), '{ isto não é json');
    const r = await setupRun();
    expect(r.ok).toBe(false);
    expect(r.steps.find((s) => s.id === 'hooks')?.ok).toBe(false);
    expect(readFileSync(settingsFile(), 'utf8')).toBe('{ isto não é json');
    expect((await setupStatus()).claude.settingsValid).toBe(false);
  });

  it('no repositório (desenvolvimento), o local do app não bloqueia a configuração', async () => {
    // A recusa fora da pasta Aplicativos só vale para o runtime embutido no app;
    // esse caso é exercitado no teste de instalação do CI macOS.
    process.env.CLAUDE_HUB_APP_PATH = '/Volumes/Claude Hub/ClaudeHub.app';
    const r = await setupRun();
    expect(r.steps[0]?.id).toBe('location');
    expect(r.steps[0]?.ok).toBe(true);
  });

  it('desinstalar remove só o que é do hub', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo fim' }] }] } }));
    await setupRun();
    const r = await uninstallAll(false);
    expect(r.ok).toBe(true);
    expect(readSettingsFile()).toEqual({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo fim' }] }] } });
  });
});

describe('verificação de saúde', () => {
  it('com tudo configurado, todos os itens obrigatórios passam', async () => {
    await setupRun();
    const r = await selftest();
    const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    expect(byId.hub?.ok).toBe(true);
    expect(byId.realtime?.ok).toBe(true);
    expect(byId.event?.ok).toBe(true);
    expect(byId.approval?.ok).toBe(true);
    expect(byId.approval?.detail).toContain('negar');
    expect(byId.hooks?.ok).toBe(true);
    expect(byId['real-event']?.ok).toBe(false);
    expect(byId['real-event']?.optional).toBe(true);
    expect(r.checks.filter((c) => !c.optional && c.id !== 'claude').every((c) => c.ok)).toBe(true);
  });

  it('o pedido do autoteste é sempre negado, fica na auditoria e nunca vira "permitido"', async () => {
    await setupRun();
    await selftest();
    const approvals = hub.listApprovals();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.status).toBe('denied');
    expect(approvals[0]?.command).toBe('echo claude-hub-autoteste');
    expect(hub.listApprovals('allowed')).toHaveLength(0);
    expect(hub.listApprovals('pending')).toHaveLength(0);
  });

  it('não manda push para o celular nem conta como evento real', async () => {
    await setupRun();
    await selftest();
    expect(push.sent).toHaveLength(0);
    expect(hub.getLastHookAt()).toBeNull();
    expect(hub.listSessions()).toHaveLength(0);
  });

  it('depois de um evento de sessão real, o item "evento real" passa', async () => {
    await setupRun();
    hub.ingestHook({ session_id: 'real-1', hook_event_name: 'UserPromptSubmit', prompt: 'oi', cwd: '/p/site' });
    const r = await selftest();
    expect(r.checks.find((c) => c.id === 'real-event')?.ok).toBe(true);
  });

  it('sem hooks instalados, aponta o problema certo', async () => {
    const r = await selftest();
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'hooks')?.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'approval')?.ok).toBe(true);
  });

  it('no modo "Só avisar", confirma que o pedido volta para o terminal', async () => {
    await setupRun();
    hub.updateSettings({ approvalMode: 'notify' }, 'teste');
    const r = await selftest();
    expect(r.checks.find((c) => c.id === 'approval')?.detail).toContain('Só avisar');
    expect(hub.listApprovals()).toHaveLength(0);
  });

  it('hub fora do ar: falha logo no primeiro item, com mensagem clara', async () => {
    await close();
    close = async () => {};
    const r = await selftest();
    expect(r.ok).toBe(false);
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]?.detail).toContain('não respondeu');
  });

  it('token de hook divergente é detectado', async () => {
    await setupRun();
    // Simula um hub reinstalado com outro token: o settings.json ficou para trás.
    const stored = JSON.parse(readFileSync(join(process.env.CLAUDE_HUB_HOME as string, 'config.json'), 'utf8')) as HubConfig;
    mkdirSync(process.env.CLAUDE_HUB_HOME as string, { recursive: true });
    writeFileSync(join(process.env.CLAUDE_HUB_HOME as string, 'config.json'), JSON.stringify({ ...stored, hookToken: 'outro-token' }));
    const r = await selftest();
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'event')?.detail).toContain('token de hook');
  });
});

describe('diagnóstico', () => {
  it('resume a instalação e a saúde num texto, sem nenhum segredo', async () => {
    const { diagnostics } = await import('@claude-hub/claude-bridge');
    await setupRun();
    const r = await diagnostics();
    expect(r.ok).toBe(true);
    expect(r.report).toContain('Diagnóstico do Claude Hub');
    expect(r.report).toContain('[Verificação de saúde]');
    expect(r.report).toContain('Pedido de aprovação de ponta a ponta');
    const stored = JSON.parse(readFileSync(join(process.env.CLAUDE_HUB_HOME as string, 'config.json'), 'utf8')) as HubConfig;
    expect(r.report).not.toContain(stored.localToken);
    expect(r.report).not.toContain(stored.hookToken);
    expect(r.report).not.toMatch(/Bearer [A-Za-z0-9_-]{20,}/);
  });

  it('oculta tokens que apareçam no log e troca a pasta pessoal por "~"', async () => {
    const { redact } = await import('@claude-hub/claude-bridge');
    const { homedir } = await import('node:os');
    const text = `erro em ${homedir()}/x com Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345 e ${cfg.localToken}`;
    const out = redact(text, cfg);
    expect(out).not.toContain(cfg.localToken);
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
    expect(out).toContain('~/x');
  });
});
