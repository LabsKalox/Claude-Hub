/**
 * Detecção do Claude Code e do Tailscale instalados na máquina.
 * Só lê: nenhuma função daqui altera nada.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && isExecutable(join(dir, name))) return join(dir, name);
  }
  return null;
}

/** Apps abertos pelo Finder não herdam o PATH do terminal; pergunta ao shell de login. */
function fromLoginShell(name: string): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('/bin/zsh', ['-lic', `command -v ${name}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 6000,
    });
    const line = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/')).pop();
    return line && isExecutable(line) ? line : null;
  } catch {
    return null;
  }
}

export interface ClaudeInfo {
  found: boolean;
  path: string | null;
  version: string | null;
}

/** Codex CLI (OpenAI) e OpenCode: mesmo esquema de busca do Claude Code. */
export function detectAgentBinary(name: 'codex' | 'opencode'): ClaudeInfo {
  const home = homedir();
  const override = name === 'codex' ? process.env.CLAUDE_HUB_CODEX_PATH : process.env.CLAUDE_HUB_OPENCODE_PATH;
  const candidates = [
    override,
    onPath(name),
    join(home, '.local/bin', name),
    name === 'opencode' ? join(home, '.opencode/bin/opencode') : undefined,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    join(home, '.npm-global/bin', name),
    join(home, '.bun/bin', name),
    join(home, '.volta/bin', name),
  ].filter((p): p is string => Boolean(p));
  const path = candidates.find(isExecutable) ?? (override ? null : fromLoginShell(name));
  if (!path) return { found: false, path: null, version: null };
  return { found: true, path, version: binaryVersion(path) };
}

function binaryVersion(path: string): string | null {
  try {
    const env = { ...process.env, PATH: [dirname(process.execPath), dirname(path), process.env.PATH ?? ''].join(delimiter) };
    const out = execFileSync(path, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env });
    return /\d+\.\d+\.\d+[\w.-]*/.exec(out)?.[0] ?? (out.trim().split('\n')[0] || null);
  } catch {
    return null;
  }
}

export function detectClaude(): ClaudeInfo {
  const home = homedir();
  const candidates = [
    process.env.CLAUDE_HUB_CLAUDE_PATH,
    onPath('claude'),
    join(home, '.local/bin/claude'),
    join(home, '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(home, '.npm-global/bin/claude'),
    join(home, '.bun/bin/claude'),
    join(home, '.volta/bin/claude'),
  ].filter((p): p is string => Boolean(p));
  const path = candidates.find(isExecutable) ?? fromLoginShell('claude');
  if (!path) return { found: false, path: null, version: null };
  let version: string | null = null;
  try {
    // Instalações via npm usam "#!/usr/bin/env node": garante um node no PATH.
    const env = { ...process.env, PATH: [dirname(process.execPath), dirname(path), process.env.PATH ?? ''].join(delimiter) };
    const out = execFileSync(path, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env });
    version = /\d+\.\d+\.\d+[\w.-]*/.exec(out)?.[0] ?? (out.trim().split('\n')[0] || null);
  } catch {
    version = null;
  }
  return { found: true, path, version };
}

export interface TailscaleInfo {
  /**
   * missing: não instalado · stopped: instalado e desconectado (o próprio Tailscale disse) ·
   * unknown: respondeu algo que não é o estado em JSON (ver `detail`) · running: conectado.
   */
  tailscale: 'missing' | 'stopped' | 'unknown' | 'running';
  binary: string | null;
  dnsName: string | null;
  serving: boolean;
  /**
   * HTTPS Certificates da rede Tailscale: true/false quando o Tailscale informou
   * (`CertDomains`), null quando não informou ou não está conectado.
   */
  httpsEnabled: boolean | null;
  /** O que o Tailscale respondeu, quando não deu para entender; ou o estado dele, quando desconectado. */
  detail: string | null;
}

function tailscaleBinary(): string | null {
  const candidates = [
    process.env.CLAUDE_HUB_TAILSCALE_PATH,
    onPath('tailscale'),
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p) && isExecutable(p)) ?? null;
}

/**
 * O binário de dentro do Tailscale.app só se comporta como CLI quando percebe
 * um shell (SHLVL) ou quando recebe TAILSCALE_BE_CLI=1. O app e o serviço do
 * launchd não têm shell: sem a variável ele tenta abrir a interface gráfica,
 * imprime um erro no stdout e sai com código 0. A CLI do Homebrew ignora a variável.
 */
function tailscaleEnv(): NodeJS.ProcessEnv {
  return { ...process.env, TAILSCALE_BE_CLI: '1' };
}

interface TailscaleRun {
  /** Terminou com código 0. */
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Falha ao executar (não encontrado, tempo esgotado…). */
  failure: string | null;
}

function runTailscale(binary: string, args: string[], timeoutMs = 10_000): TailscaleRun {
  const r = spawnSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, env: tailscaleEnv() });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  return {
    ok: r.status === 0 && !r.error,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    failure: r.error ? (timedOut ? `não respondeu em ${Math.round(timeoutMs / 1000)} s` : r.error.message) : null,
  };
}

/** Texto do Tailscale em uma linha, para mostrar ao usuário como ele veio. */
function tailscaleText(run: TailscaleRun, max = 400): string {
  const text = [run.stdout, run.stderr, run.failure ?? '']
    .map((t) => t.trim())
    .filter(Boolean)
    .join(' — ')
    .replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function detectTailscale(publicPort: number): TailscaleInfo {
  const binary = tailscaleBinary();
  const none = { dnsName: null, serving: false, httpsEnabled: null };
  if (!binary) return { tailscale: 'missing', binary: null, ...none, detail: null };
  const run = runTailscale(binary, ['status', '--json']);
  type Status = { BackendState?: unknown; Self?: { DNSName?: unknown } | null; CertDomains?: unknown };
  let status: Status | null = null;
  try {
    const parsed: unknown = JSON.parse(run.stdout);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) status = parsed as Status;
  } catch {
    status = null;
  }
  // Sem o estado em JSON não dá para afirmar "desconectado": devolve o que o Tailscale disse.
  if (!status || typeof status.BackendState !== 'string') {
    return { tailscale: 'unknown', binary, ...none, detail: tailscaleText(run) || 'O Tailscale não respondeu nada.' };
  }
  if (status.BackendState !== 'Running') {
    return { tailscale: 'stopped', binary, ...none, detail: status.BackendState };
  }
  const rawName = status.Self?.DNSName;
  const dnsName = typeof rawName === 'string' && rawName ? rawName.replace(/\.$/, '') : null;
  // CertDomains: nomes para os quais a rede emite certificado. Vazio/nulo = HTTPS desativado no tailnet.
  const httpsEnabled = 'CertDomains' in status ? Array.isArray(status.CertDomains) && status.CertDomains.length > 0 : null;
  const serve = runTailscale(binary, ['serve', 'status', '--json']).stdout;
  const serving = serve.includes(`127.0.0.1:${publicPort}`) || serve.includes(`localhost:${publicPort}`);
  return { tailscale: 'running', binary, dnsName, serving, httpsEnabled, detail: null };
}

/** Publica a porta do iPhone dentro da rede Tailscale do usuário, com https. */
export function enableTailscaleServe(binary: string, publicPort: number): { ok: boolean; detail: string } {
  const run = runTailscale(binary, ['serve', '--bg', String(publicPort)], 20_000);
  const text = tailscaleText(run, 600);
  if (!run.ok) return { ok: false, detail: text || 'o Tailscale não explicou o motivo' };
  return { ok: true, detail: text || 'tailscale serve ativado.' };
}
