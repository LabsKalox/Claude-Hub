/**
 * Instala/remove os hooks do Claude Hub no settings.json do Claude Code.
 *
 * Usa somente o mecanismo oficial de hooks. Regras:
 *  - nunca apaga nem altera hooks que não sejam do Claude Hub;
 *  - é idempotente (instalar duas vezes não duplica nada);
 *  - faz backup do arquivo antes de gravar;
 *  - falha aberta: sem `onFailure: "block"`, se o hub estiver fora do ar o
 *    Claude Code segue normalmente e a permissão volta para o terminal.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { HOOK_PATH, hookUrl, type HubConfig } from './config.js';

/** Eventos entregues por hook HTTP (confirmado no Claude Code 2.1.329). */
export const HTTP_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'PreCompact',
  'SessionEnd',
] as const;

/** Eventos mais novos; ficam de fora com `--minimal` (Claude Code antigo). */
export const EXTENDED_HTTP_EVENTS = [
  'PermissionDenied',
  'StopFailure',
  'TaskCreated',
  'TaskCompleted',
  'CwdChanged',
  'Elicitation',
  'ElicitationResult',
] as const;

/** SessionStart só aceita hook de comando — o hook HTTP não dispara para ele. */
export const COMMAND_EVENTS = ['SessionStart'] as const;

export interface InstallOptions {
  /** Caminho absoluto de dist/hook-command.js. */
  hookCommandPath: string;
  /** Executável do Node (caminho absoluto: hooks não herdam o PATH do shell). */
  nodePath: string;
  mode?: 'http' | 'command';
  minimal?: boolean;
}

type HookHandler = Record<string, unknown> & { type: string };
interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}
type HooksMap = Record<string, HookGroup[]>;
export interface ClaudeSettings {
  hooks?: HooksMap;
  [key: string]: unknown;
}

/** Nomes do hook de comando: no repositório (dist) e embutido no app (runtime). */
const COMMAND_MARKER = /claude-bridge[\\/]dist[\\/]hook-command\.js|claude-hub-hook\.mjs/;

export function isHubHandler(h: unknown): boolean {
  if (!h || typeof h !== 'object') return false;
  const o = h as Record<string, unknown>;
  if (o.type === 'http' && typeof o.url === 'string') {
    return /^http:\/\/(127\.0\.0\.1|localhost):\d+/.test(o.url) && o.url.endsWith(HOOK_PATH);
  }
  if (o.type === 'command' && typeof o.command === 'string') {
    return COMMAND_MARKER.test(o.command);
  }
  return false;
}

function quote(p: string): string {
  return `"${p.replace(/(["\\$`])/g, '\\$1')}"`;
}

export function buildHubHooks(cfg: HubConfig, opts: InstallOptions): HooksMap {
  const mode = opts.mode ?? 'http';
  const permissionTimeout = cfg.approvalTimeoutSec + 30;
  const command = `${quote(opts.nodePath)} ${quote(opts.hookCommandPath)}`;
  const events: string[] = [...HTTP_EVENTS, ...(opts.minimal ? [] : EXTENDED_HTTP_EVENTS)];
  const map: HooksMap = {};

  const timeoutFor = (event: string): number => {
    if (event === 'PermissionRequest') return permissionTimeout;
    if (event === 'SessionEnd') return 5;
    return 10;
  };

  for (const event of events) {
    const handler: HookHandler =
      mode === 'http'
        ? {
            type: 'http',
            url: hookUrl(cfg),
            headers: { Authorization: `Bearer ${cfg.hookToken}` },
            timeout: timeoutFor(event),
          }
        : { type: 'command', command, timeout: timeoutFor(event) };
    map[event] = [{ hooks: [handler] }];
  }
  for (const event of COMMAND_EVENTS) {
    map[event] = [{ hooks: [{ type: 'command', command, timeout: 10 }] }];
  }
  return map;
}

/** Remove apenas os handlers do Claude Hub, preservando todo o resto. */
export function removeHubHooks(settings: ClaudeSettings): ClaudeSettings {
  if (!settings.hooks || typeof settings.hooks !== 'object') return settings;
  const next: HooksMap = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      next[event] = groups;
      continue;
    }
    const kept: HookGroup[] = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const hooks = group.hooks.filter((h) => !isHubHandler(h));
      if (hooks.length > 0) kept.push({ ...group, hooks });
    }
    if (kept.length > 0) next[event] = kept;
  }
  const out: ClaudeSettings = { ...settings };
  if (Object.keys(next).length > 0) out.hooks = next;
  else delete out.hooks;
  return out;
}

export function mergeHubHooks(settings: ClaudeSettings, hubHooks: HooksMap): ClaudeSettings {
  const cleaned = removeHubHooks(settings);
  const hooks: HooksMap = { ...(cleaned.hooks ?? {}) };
  for (const [event, groups] of Object.entries(hubHooks)) {
    hooks[event] = [...(hooks[event] ?? []), ...groups];
  }
  return { ...cleaned, hooks };
}

export function installedEvents(settings: ClaudeSettings): string[] {
  const out: string[] = [];
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    if (Array.isArray(groups) && groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some(isHubHandler))) {
      out.push(event);
    }
  }
  return out;
}

export type SettingsScope = 'user' | 'project' | 'local';

export function settingsPath(scope: SettingsScope, cwd: string = process.cwd()): string {
  if (scope === 'user') {
    return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
  }
  return join(cwd, '.claude', scope === 'project' ? 'settings.json' : 'settings.local.json');
}

export function readSettings(path: string): ClaudeSettings {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} não contém um objeto JSON`);
  }
  return parsed as ClaudeSettings;
}

/** Grava de forma atômica, com backup do arquivo anterior. Devolve o caminho do backup. */
export function writeSettings(path: string, settings: ClaudeSettings): string | null {
  mkdirSync(dirname(path), { recursive: true });
  let backup: string | null = null;
  if (existsSync(path)) {
    // Um backup por gravação, com data: instalar de novo nunca apaga a cópia do arquivo original.
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    backup = `${path}.claude-hub-${stamp}.bak`;
    for (let n = 2; existsSync(backup); n++) backup = `${path}.claude-hub-${stamp}-${n}.bak`;
    copyFileSync(path, backup);
  }
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, path);
  return backup;
}
