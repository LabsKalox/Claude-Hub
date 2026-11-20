import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installOpencodePlugin, opencodePluginPath, opencodeStatus, uninstallOpencodePlugin } from '../src/index.js';

const saved = { ...process.env };
let dir: string;
let bundled: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-opencode-'));
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.OPENCODE_CONFIG_DIR;
  bundled = join(dir, 'claude-hub-opencode.js');
  writeFileSync(bundled, 'export default { id: "claude-hub" };\n');
});
afterEach(() => {
  process.env = { ...saved };
});

describe('OpenCode: plugin na pasta de plugins', () => {
  it('copia um arquivo para ~/.config/opencode/plugins e não toca no opencode.json nem nos outros plugins', () => {
    const plugins = join(dir, 'opencode', 'plugins');
    mkdirSync(plugins, { recursive: true });
    writeFileSync(join(dir, 'opencode', 'opencode.json'), '{"plugin":["meu-plugin"]}');
    writeFileSync(join(plugins, 'meu.js'), 'export default {}');
    expect(opencodePluginPath()).toBe(join(plugins, 'claude-hub.js'));
    expect(installOpencodePlugin(bundled).ok).toBe(true);
    expect(readFileSync(opencodePluginPath(), 'utf8')).toBe(readFileSync(bundled, 'utf8'));
    expect(readFileSync(join(dir, 'opencode', 'opencode.json'), 'utf8')).toBe('{"plugin":["meu-plugin"]}');
    expect(existsSync(join(plugins, 'meu.js'))).toBe(true);
    expect(opencodeStatus(bundled)).toMatchObject({ present: true, installed: true, current: true });
    expect(installOpencodePlugin(bundled).detail).toContain('já instalado');
  });

  it('versão nova do app: o arquivo instalado fica desatualizado até reinstalar', () => {
    installOpencodePlugin(bundled);
    writeFileSync(bundled, 'export default { id: "claude-hub", v: 2 };\n');
    expect(opencodeStatus(bundled)).toMatchObject({ installed: true, current: false });
    installOpencodePlugin(bundled);
    expect(opencodeStatus(bundled).current).toBe(true);
  });

  it('desinstalar remove só o arquivo do Claude Hub', () => {
    installOpencodePlugin(bundled);
    writeFileSync(join(dir, 'opencode', 'plugins', 'meu.js'), 'export default {}');
    expect(uninstallOpencodePlugin().ok).toBe(true);
    expect(existsSync(opencodePluginPath())).toBe(false);
    expect(existsSync(join(dir, 'opencode', 'plugins', 'meu.js'))).toBe(true);
    expect(uninstallOpencodePlugin().detail).toContain('Não havia');
  });

  it('respeita OPENCODE_CONFIG_DIR', () => {
    process.env.OPENCODE_CONFIG_DIR = join(dir, 'custom');
    expect(opencodePluginPath()).toBe(join(dir, 'custom', 'plugins', 'claude-hub.js'));
  });

  it('sem o arquivo no app, recusa com explicação', () => {
    expect(installOpencodePlugin(join(dir, 'nao-existe.js'))).toMatchObject({ ok: false });
  });
});
