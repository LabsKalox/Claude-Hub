/**
 * Serviço de inicialização do hub no macOS (LaunchAgent do usuário).
 *
 * O serviço roda SEMPRE como o usuário atual, nunca como root, e só executa o
 * Node embutido com o hub — nada de shell. Label: dev.claudehub.hub.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hubHome } from './config.js';

export const SERVICE_LABEL = 'dev.claudehub.hub';

export interface ServiceSpec {
  node: string;
  hubEntry: string;
  webDir: string | null;
  workingDir: string;
}

export interface ServiceState {
  supported: boolean;
  installed: boolean;
  loaded: boolean;
  /** O plist aponta para este mesmo runtime (Node + hub)? */
  current: boolean;
  plistPath: string;
  label: string;
}

export function servicePlistPath(): string {
  return join(process.env.CLAUDE_HUB_LAUNCH_AGENTS_DIR || join(homedir(), 'Library', 'LaunchAgents'), `${SERVICE_LABEL}.plist`);
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildServicePlist(spec: ServiceSpec, env: Record<string, string> = {}): string {
  const vars: Record<string, string> = { NODE_NO_WARNINGS: '1', ...env };
  if (spec.webDir) vars.CLAUDE_HUB_WEB_DIR = spec.webDir;
  // Um diretório de dados fora do padrão precisa acompanhar o serviço.
  if (process.env.CLAUDE_HUB_HOME) vars.CLAUDE_HUB_HOME = process.env.CLAUDE_HUB_HOME;
  const log = join(hubHome(), 'hub.log');
  const envXml = Object.entries(vars)
    .map(([k, v]) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${SERVICE_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${xml(spec.node)}</string>
\t\t<string>${xml(spec.hubEntry)}</string>
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${xml(spec.workingDir)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
${envXml}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>StandardOutPath</key>
\t<string>${xml(log)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** Lê de volta os dois argumentos do programa gravados no plist. */
export function programArgumentsOf(plist: string): string[] {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] ?? '';
  return [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) =>
    (m[1] as string).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
  );
}

function launchctl(args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message };
  }
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

export function serviceSupported(): boolean {
  return process.platform === 'darwin';
}

export function serviceState(spec: ServiceSpec): ServiceState {
  const plistPath = servicePlistPath();
  const installed = existsSync(plistPath);
  let current = false;
  if (installed) {
    const args = programArgumentsOf(readFileSync(plistPath, 'utf8'));
    current = args[0] === spec.node && args[1] === spec.hubEntry;
  }
  const loaded = serviceSupported() && launchctl(['print', `${domain()}/${SERVICE_LABEL}`]).ok;
  return { supported: serviceSupported(), installed, loaded, current, plistPath, label: SERVICE_LABEL };
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isLoaded(): boolean {
  return launchctl(['print', `${domain()}/${SERVICE_LABEL}`]).ok;
}

/**
 * Instala (ou atualiza) e inicia o serviço.
 *
 *  - Mesmo plist já carregado: só reinicia o processo (carrega código novo após
 *    uma atualização do app) — sem remover o registro.
 *  - Plist novo ou diferente: remove o registro anterior, ESPERA o launchd
 *    terminar de encerrá-lo e só então registra o novo. Registrar logo após o
 *    bootout falha de forma intermitente ("Bootstrap failed: 5").
 */
export async function installService(spec: ServiceSpec): Promise<{ ok: boolean; detail: string }> {
  if (!serviceSupported()) return { ok: false, detail: 'O serviço de inicialização só existe no macOS.' };
  if (!existsSync(spec.node) || !existsSync(spec.hubEntry)) {
    return { ok: false, detail: `Runtime incompleto: não encontrei ${existsSync(spec.node) ? spec.hubEntry : spec.node}.` };
  }
  const plistPath = servicePlistPath();
  const wanted = buildServicePlist(spec);
  const same = existsSync(plistPath) && readFileSync(plistPath, 'utf8') === wanted;
  const target = `${domain()}/${SERVICE_LABEL}`;

  if (same && isLoaded()) {
    const r = launchctl(['kickstart', '-k', target]);
    if (r.ok) return { ok: true, detail: `Serviço ${SERVICE_LABEL} já estava instalado; hub reiniciado.` };
    // Se o reinício falhar, cai no caminho completo abaixo.
  }

  mkdirSync(join(plistPath, '..'), { recursive: true });
  mkdirSync(hubHome(), { recursive: true, mode: 0o700 });
  if (isLoaded()) {
    launchctl(['bootout', target]);
    for (let i = 0; i < 50 && isLoaded(); i++) await pause(200);
  }
  writeFileSync(plistPath, wanted, { mode: 0o644 });

  let boot = launchctl(['bootstrap', domain(), plistPath]);
  for (let attempt = 1; !boot.ok && attempt <= 5; attempt++) {
    if (isLoaded()) break; // outro processo registrou no intervalo
    await pause(600 * attempt);
    boot = launchctl(['bootstrap', domain(), plistPath]);
  }
  if (!boot.ok && !isLoaded()) return { ok: false, detail: `launchctl bootstrap falhou: ${boot.output}` };
  launchctl(['kickstart', target]);
  return { ok: true, detail: `Serviço ${SERVICE_LABEL} instalado (${plistPath}).` };
}

export function restartService(): { ok: boolean; detail: string } {
  if (!serviceSupported()) return { ok: false, detail: 'O serviço de inicialização só existe no macOS.' };
  const r = launchctl(['kickstart', '-k', `${domain()}/${SERVICE_LABEL}`]);
  return r.ok ? { ok: true, detail: 'Hub reiniciado.' } : { ok: false, detail: `Não consegui reiniciar o hub: ${r.output}` };
}

export async function uninstallService(): Promise<{ ok: boolean; detail: string }> {
  const plistPath = servicePlistPath();
  if (serviceSupported() && isLoaded()) {
    launchctl(['bootout', `${domain()}/${SERVICE_LABEL}`]);
    // O bootout é assíncrono: só devolve depois que o launchd realmente descarregou o serviço.
    for (let i = 0; i < 50 && isLoaded(); i++) await pause(200);
    if (isLoaded()) return { ok: false, detail: 'O launchd não descarregou o serviço; tente de novo.' };
  }
  if (existsSync(plistPath)) rmSync(plistPath);
  return { ok: true, detail: 'Serviço removido.' };
}
