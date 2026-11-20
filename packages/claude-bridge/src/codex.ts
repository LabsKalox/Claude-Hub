/**
 * Integração com o Codex CLI (OpenAI), pelos hooks oficiais dele.
 *
 * O Codex tem um sistema de hooks no mesmo modelo do Claude Code: hooks de
 * comando que recebem o evento em JSON no stdin, e um `PermissionRequest` que
 * pode devolver `{"hookSpecificOutput":{"hookEventName":"PermissionRequest",
 * "decision":{"behavior":"allow"|"deny"}}}` — o mesmo formato que o hub já
 * produz. Por isso o Codex usa o mesmo hook de comando do Claude Code, com
 * `--agent codex` para o hub saber de onde veio. (Conferido no código do Codex
 * 0.171.0: `hooks/src/engine/discovery.rs`, `protocol/src/hooks.rs`,
 * `hooks/schema/generated/*.command.input.schema.json`.)
 *
 * Onde fica: `$CODEX_HOME/hooks.json` (padrão `~/.codex/hooks.json`), um arquivo
 * só de hooks — o `config.toml` do usuário não é tocado. Os hooks de todas as
 * camadas se somam, então os hooks do próprio usuário continuam rodando.
 *
 * Confiança: o Codex só executa um hook novo depois que o usuário o aprova na
 * tela "Review hooks" que ele mostra ao abrir. O hub NÃO grava essa aprovação
 * por conta própria e não usa `--dangerously-bypass-hook-trust`: quem decide é
 * você, na primeira sessão do Codex depois de ligar a integração.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HubConfig } from './config.js';

/** Eventos do Codex encaminhados ao hub. */
export const CODEX_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'SessionEnd',
] as const;

/** Marca do hook do Claude Hub no hooks.json do Codex. */
const MARKER = /(claude-bridge[\\/]dist[\\/]hook-command\.js|claude-hub-hook\.mjs).*--agent codex/;

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

export function codexHooksPath(): string {
  return join(codexHome(), 'hooks.json');
}

type Handler = Record<string, unknown> & { type: string };
interface Group {
  matcher?: string;
  hooks: Handler[];
}
export interface CodexHooksFile {
  hooks?: Record<string, Group[]>;
  [key: string]: unknown;
}

function quote(p: string): string {
  return `"${p.replace(/(["\\$`])/g, '\\$1')}"`;
}

export function codexHookCommand(nodePath: string, hookCommandPath: string): string {
  return `${quote(nodePath)} ${quote(hookCommandPath)} --agent codex`;
}

export function isCodexHubHandler(h: unknown): boolean {
  if (!h || typeof h !== 'object') return false;
  const o = h as Record<string, unknown>;
  return o.type === 'command' && typeof o.command === 'string' && MARKER.test(o.command);
}

export function buildCodexHooks(cfg: HubConfig, nodePath: string, hookCommandPath: string): Record<string, Group[]> {
  const command = codexHookCommand(nodePath, hookCommandPath);
  const timeoutFor = (event: string): number => {
    // O pedido espera a decisão no iPhone; o hub encerra antes (prazo + folga).
    if (event === 'PermissionRequest') return cfg.approvalTimeoutSec + 30;
    // O Codex limita SessionEnd a 3 s.
    if (event === 'SessionEnd') return 3;
    return 10;
  };
  const map: Record<string, Group[]> = {};
  for (const event of CODEX_EVENTS) {
    map[event] = [{ hooks: [{ type: 'command', command, timeout: timeoutFor(event) }] }];
  }
  return map;
}

export function removeCodexHubHooks(file: CodexHooksFile): CodexHooksFile {
  if (!file.hooks || typeof file.hooks !== 'object') return file;
  const next: Record<string, Group[]> = {};
  for (const [event, groups] of Object.entries(file.hooks)) {
    if (!Array.isArray(groups)) {
      next[event] = groups;
      continue;
    }
    const kept: Group[] = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const hooks = group.hooks.filter((h) => !isCodexHubHandler(h));
      if (hooks.length > 0) kept.push({ ...group, hooks });
    }
    if (kept.length > 0) next[event] = kept;
  }
  const out: CodexHooksFile = { ...file };
  if (Object.keys(next).length > 0) out.hooks = next;
  else delete out.hooks;
  return out;
}

export function mergeCodexHubHooks(file: CodexHooksFile, hub: Record<string, Group[]>): CodexHooksFile {
  const cleaned = removeCodexHubHooks(file);
  const hooks: Record<string, Group[]> = { ...(cleaned.hooks ?? {}) };
  for (const [event, groups] of Object.entries(hub)) hooks[event] = [...(hooks[event] ?? []), ...groups];
  return { ...cleaned, hooks };
}

export function readCodexHooks(path = codexHooksPath()): CodexHooksFile {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} não é um objeto JSON`);
  return parsed as CodexHooksFile;
}

/** Grava com backup datado. Arquivo que ficaria vazio é removido (e o backup guarda o original). */
function writeCodexHooks(path: string, file: CodexHooksFile): string | null {
  mkdirSync(dirname(path), { recursive: true });
  let backup: string | null = null;
  if (existsSync(path)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    backup = `${path}.claude-hub-${stamp}.bak`;
    for (let n = 2; existsSync(backup); n++) backup = `${path}.claude-hub-${stamp}-${n}.bak`;
    copyFileSync(path, backup);
  }
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(tmp, path);
  return backup;
}

export interface CodexStatus {
  /** Pasta do Codex existe (o Codex já rodou nesta conta). */
  present: boolean;
  hooksPath: string;
  /** Arquivo legível (ou inexistente). false = JSON inválido: não é tocado. */
  valid: boolean;
  /** Eventos com o hook do Claude Hub. */
  events: string[];
  /** Hooks do Claude Hub apontam para este app/Node. */
  current: boolean;
  /** Hooks que são do usuário (preservados). */
  otherHooks: number;
}

export function codexStatus(nodePath: string, hookCommandPath: string): CodexStatus {
  const path = codexHooksPath();
  const base: CodexStatus = { present: existsSync(codexHome()), hooksPath: path, valid: true, events: [], current: false, otherHooks: 0 };
  let file: CodexHooksFile;
  try {
    file = readCodexHooks(path);
  } catch {
    return { ...base, valid: false };
  }
  const command = codexHookCommand(nodePath, hookCommandPath);
  let current = true;
  for (const [event, groups] of Object.entries(file.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const h of group?.hooks ?? []) {
        if (isCodexHubHandler(h)) {
          if (!base.events.includes(event)) base.events.push(event);
          if ((h as { command?: unknown }).command !== command) current = false;
        } else {
          base.otherHooks++;
        }
      }
    }
  }
  base.current = current && CODEX_EVENTS.every((e) => base.events.includes(e));
  return base;
}

export function installCodexHooks(cfg: HubConfig, nodePath: string, hookCommandPath: string): { ok: boolean; detail: string; backup: string | null } {
  const path = codexHooksPath();
  let file: CodexHooksFile;
  try {
    file = readCodexHooks(path);
  } catch (err) {
    return { ok: false, detail: `Não alterei ${path}: ${(err as Error).message}`, backup: null };
  }
  const next = mergeCodexHubHooks(file, buildCodexHooks(cfg, nodePath, hookCommandPath));
  if (JSON.stringify(next) === JSON.stringify(file)) {
    return { ok: true, detail: `Hooks do Claude Hub já estavam em ${path}.`, backup: null };
  }
  const backup = writeCodexHooks(path, next);
  return {
    ok: true,
    detail: `Hooks gravados em ${path}${backup ? ` (backup em ${backup})` : ''}. Na próxima sessão, o Codex vai pedir para você revisar e confiar nos hooks novos: aprove para o Claude Hub receber os eventos.`,
    backup,
  };
}

export function uninstallCodexHooks(): { ok: boolean; detail: string } {
  const path = codexHooksPath();
  let file: CodexHooksFile;
  try {
    file = readCodexHooks(path);
  } catch (err) {
    return { ok: false, detail: `Não alterei ${path}: ${(err as Error).message}` };
  }
  const next = removeCodexHubHooks(file);
  if (JSON.stringify(next) === JSON.stringify(file)) return { ok: true, detail: 'Não havia hooks do Claude Hub no Codex.' };
  writeCodexHooks(path, next);
  return { ok: true, detail: `Hooks do Claude Hub removidos de ${path}; os demais foram preservados.` };
}
