/**
 * Instala o plugin do Claude Hub no OpenCode.
 *
 * O OpenCode (V1 e V2) carrega sozinho os arquivos `.js` de
 * `~/.config/opencode/plugins/` — documentado nas duas versões. O hub só copia
 * um arquivo para lá: nenhum `opencode.json` é editado, e os plugins do usuário
 * continuam como estão. Desinstalar apaga só esse arquivo.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const OPENCODE_PLUGIN_FILE = 'claude-hub.js';

export function opencodeConfigDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'opencode');
}

export function opencodePluginPath(): string {
  return join(opencodeConfigDir(), 'plugins', OPENCODE_PLUGIN_FILE);
}

export interface OpencodeStatus {
  /** A pasta de configuração do OpenCode existe (ele já rodou nesta conta). */
  present: boolean;
  pluginPath: string;
  installed: boolean;
  /** O arquivo instalado é igual ao que vem com esta versão do app. */
  current: boolean;
}

function same(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

export function opencodeStatus(bundledPlugin: string): OpencodeStatus {
  const path = opencodePluginPath();
  const installed = existsSync(path);
  return { present: existsSync(opencodeConfigDir()), pluginPath: path, installed, current: installed && same(path, bundledPlugin) };
}

export function installOpencodePlugin(bundledPlugin: string): { ok: boolean; detail: string } {
  if (!existsSync(bundledPlugin)) return { ok: false, detail: `Plugin do OpenCode não encontrado no app (${bundledPlugin}).` };
  const path = opencodePluginPath();
  if (existsSync(path) && same(path, bundledPlugin)) return { ok: true, detail: `Plugin já instalado em ${path}.` };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  copyFileSync(bundledPlugin, tmp);
  renameSync(tmp, path);
  return { ok: true, detail: `Plugin instalado em ${path}. Vale para sessões do OpenCode abertas a partir de agora.` };
}

export function uninstallOpencodePlugin(): { ok: boolean; detail: string } {
  const path = opencodePluginPath();
  if (!existsSync(path)) return { ok: true, detail: 'Não havia plugin do Claude Hub no OpenCode.' };
  rmSync(path, { force: true });
  return { ok: true, detail: `Plugin removido de ${path}.` };
}
