import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, getPrefs, loadConfig, otelEnv, saveConfig, setPref, uninstallAll, type HubConfig } from '../src/index.js';

const saved = { ...process.env };
let claudeDir: string;
let home: string;
const settingsFile = () => join(claudeDir, 'settings.json');
const read = () => JSON.parse(readFileSync(settingsFile(), 'utf8')) as Record<string, any>;
const write = (v: unknown) => writeFileSync(settingsFile(), JSON.stringify(v, null, 2));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hub-prefs-'));
  claudeDir = mkdtempSync(join(tmpdir(), 'hub-prefs-claude-'));
  process.env.CLAUDE_HUB_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.CLAUDE_HUB_LAUNCH_AGENTS_DIR = join(home, 'LaunchAgents');
  delete process.env.CLAUDE_HUB_LOCAL_PORT;
  saveConfig({ ...defaultConfig(), localPort: 4317, hookToken: 'tok-abc' });
});
afterEach(() => {
  process.env = { ...saved };
});

describe('preferências: padrão', () => {
  it('abrir a ilha com o Claude Code vem ligado; medições vêm desligadas', () => {
    expect(getPrefs().prefs).toEqual({ autoOpenIsland: true, consumption: false, limits: false });
  });
  it('autoOpenIsland só mexe na configuração do hub', () => {
    write({ model: 'opus' });
    expect(setPref('autoOpenIsland', false).prefs.autoOpenIsland).toBe(false);
    expect(read()).toEqual({ model: 'opus' });
    expect((loadConfig() as HubConfig).autoOpenIsland).toBe(false);
  });
  it('chave desconhecida é recusada', () => {
    expect(setPref('aprovarTudo', true).ok).toBe(false);
  });
});

describe('medição de consumo (variáveis de telemetria)', () => {
  it('acrescenta as variáveis apontando só para o hub local, preservando o resto', () => {
    write({ model: 'opus', env: { MEU_TOKEN: 'x' }, permissions: { deny: ['Bash(rm:*)'] } });
    const r = setPref('consumption', true);
    expect(r.ok).toBe(true);
    expect(r.prefs.consumption).toBe(true);
    const s = read();
    expect(s.model).toBe('opus');
    expect(s.permissions).toEqual({ deny: ['Bash(rm:*)'] });
    expect(s.env.MEU_TOKEN).toBe('x');
    expect(s.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe('http://127.0.0.1:4317/otel/v1/metrics');
    expect(s.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS).toBe('Authorization=Bearer%20tok-abc');
    expect(s.env).not.toHaveProperty('OTEL_LOGS_EXPORTER');
    expect(readdirSync(claudeDir).filter((f) => f.endsWith('.bak'))).toHaveLength(1);
  });

  it('desligar remove só o que é do hub', () => {
    write({ env: { MEU_TOKEN: 'x' } });
    setPref('consumption', true);
    setPref('consumption', false);
    expect(read()).toEqual({ env: { MEU_TOKEN: 'x' } });
  });

  it('sem env antes, não deixa um env vazio depois', () => {
    write({ model: 'opus' });
    setPref('consumption', true);
    setPref('consumption', false);
    expect(read()).toEqual({ model: 'opus' });
  });

  it('quem já usa telemetria própria não é alterado', () => {
    const mine = { env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_METRICS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.minha-empresa.com' } };
    write(mine);
    const r = setPref('consumption', true);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('já tem telemetria');
    expect(read()).toEqual(mine);
    expect(r.prefs.consumption).toBe(false);
  });

  it('settings.json inválido não é tocado', () => {
    writeFileSync(settingsFile(), '{ quebrado');
    expect(setPref('consumption', true).ok).toBe(false);
    expect(readFileSync(settingsFile(), 'utf8')).toBe('{ quebrado');
  });

  it('as variáveis são exatamente as testadas com o Claude Code real', () => {
    expect(Object.keys(otelEnv({ localPort: 1, hookToken: 't' })).sort()).toEqual([
      'CLAUDE_CODE_ENABLE_TELEMETRY',
      'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
      'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
      'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
      'OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE',
      'OTEL_METRICS_EXPORTER',
      'OTEL_METRIC_EXPORT_INTERVAL',
    ]);
  });
});

describe('leitura de limites (ponte na linha de status)', () => {
  const mine = { type: 'command', command: '~/.claude/statusline.sh', padding: 2 };

  it('com linha de status própria: guarda a original e mantém as opções de exibição', () => {
    write({ statusLine: mine, model: 'opus' });
    const r = setPref('limits', true);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('continua aparecendo');
    const s = read();
    expect(s.statusLine.type).toBe('command');
    expect(s.statusLine.padding).toBe(2);
    expect(s.statusLine.command).toMatch(/statusline\.js"$/);
    expect((loadConfig() as HubConfig).statusLineOriginal).toEqual(mine);
  });

  it('desligar devolve exatamente a linha de status original', () => {
    write({ statusLine: mine, model: 'opus' });
    setPref('limits', true);
    setPref('limits', false);
    expect(read()).toEqual({ statusLine: mine, model: 'opus' });
    expect((loadConfig() as HubConfig).statusLineOriginal).toBeNull();
  });

  it('sem linha de status antes: cria a do hub e a remove ao desligar', () => {
    write({ model: 'opus' });
    expect(setPref('limits', true).detail).toContain('não tinha linha de status');
    expect(read().statusLine.command).toMatch(/statusline\.js"$/);
    setPref('limits', false);
    expect(read()).toEqual({ model: 'opus' });
  });

  it('ligar duas vezes não perde a original', () => {
    write({ statusLine: mine });
    setPref('limits', true);
    setPref('limits', true);
    setPref('limits', false);
    expect(read()).toEqual({ statusLine: mine });
  });
});

describe('desinstalação com as preferências ligadas', () => {
  it('devolve o settings.json exatamente como era', async () => {
    const original = { model: 'opus', env: { MEU_TOKEN: 'x' }, statusLine: { type: 'command', command: 'echo minha-linha' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo fim' }] }] } };
    write(original);
    setPref('consumption', true);
    setPref('limits', true);
    expect(read()).not.toEqual(original);
    const r = await uninstallAll(false);
    expect(r.ok).toBe(true);
    expect(read()).toEqual(original);
    expect(getPrefs().prefs).toMatchObject({ consumption: false, limits: false });
  });
});

describe('ponte da linha de status (processo real)', () => {
  const script = fileURLToPath(new URL('../dist/statusline.js', import.meta.url));
  const input = readFileSync(new URL('../../../tests/fixtures/statusline-input-docs.json', import.meta.url), 'utf8');
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });
  const listen = (): Promise<{ port: number; received: Array<{ auth?: string; body: Record<string, any> }> }> => {
    const received: Array<{ auth?: string; body: Record<string, any> }> = [];
    return new Promise((resolve) => {
      server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          received.push({ auth: req.headers.authorization, body: JSON.parse(raw) as Record<string, any> });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
        });
      }).listen(0, '127.0.0.1', () => resolve({ port: (server?.address() as AddressInfo).port, received }));
    });
  };
  const run = (stdin: string): Promise<{ code: number | null; stdout: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [script], { env: { ...process.env } });
      let stdout = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.on('exit', (code) => resolve({ code, stdout }));
      child.stdin.end(stdin);
    });

  it.skipIf(!existsSync(script))('repassa só limites e contexto ao hub, com o token de hook', async () => {
    const { port, received } = await listen();
    saveConfig({ ...(loadConfig() as HubConfig), localPort: port });
    const r = await run(input);
    expect(r.code).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0]?.auth).toBe('Bearer tok-abc');
    expect(Object.keys(received[0]?.body ?? {}).sort()).toEqual(['context_window', 'rate_limits', 'session_id']);
    expect(received[0]?.body.rate_limits.five_hour).toEqual({ used_percentage: 23.5, resets_at: 1738425600 });
    expect(JSON.stringify(received[0]?.body)).not.toContain('transcript');
  });

  it.skipIf(!existsSync(script))('sem linha original, mostra uma linha curta só com o que foi informado', async () => {
    const { port } = await listen();
    saveConfig({ ...(loadConfig() as HubConfig), localPort: port });
    expect((await run(input)).stdout.trim()).toBe('Claude Hub · contexto 8% · 5 h 24% · 7 d 41%');
    const { rate_limits: _omit, ...noLimits } = JSON.parse(input) as Record<string, unknown>;
    expect((await run(JSON.stringify(noLimits))).stdout.trim()).toBe('Claude Hub · contexto 8%');
  });

  it.skipIf(!existsSync(script))('com linha original, mostra a saída dela, recebendo o mesmo JSON', async () => {
    const { port } = await listen();
    const original = join(home, 'minha-linha.sh');
    writeFileSync(original, '#!/bin/sh\nprintf "minha linha: "; cat | tr -d "\\n" | cut -c1-12\n');
    chmodSync(original, 0o755);
    saveConfig({ ...(loadConfig() as HubConfig), localPort: port, statusLineOriginal: { type: 'command', command: original } });
    const r = await run(input);
    expect(r.stdout).toContain('minha linha: {');
    expect(r.stdout).not.toContain('Claude Hub');
  });

  it.skipIf(!existsSync(script))('hub fora do ar ou entrada inválida: ainda mostra a linha e sai com 0', async () => {
    saveConfig({ ...(loadConfig() as HubConfig), localPort: 1 });
    const a = await run(input);
    expect(a.code).toBe(0);
    expect(a.stdout).toContain('Claude Hub');
    const b = await run('não é json');
    expect(b.code).toBe(0);
    expect(b.stdout.trim()).toBe('Claude Hub');
  });
});
