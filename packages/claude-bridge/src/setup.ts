/**
 * Configuração inicial: estado completo da instalação e os passos para
 * deixá-la funcionando. É a lógica por trás do assistente do app macOS.
 */
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookUrl, hubHome, loadConfig, saveConfig, type HubConfig } from './config.js';
import { detectAgentBinary, detectClaude, detectTailscale, enableTailscaleServe } from './detect.js';
import { codexStatus, installCodexHooks, uninstallCodexHooks } from './codex.js';
import { installOpencodePlugin, opencodeStatus, uninstallOpencodePlugin } from './opencode.js';
import {
  buildHubHooks,
  installedEvents,
  isHubHandler,
  mergeHubHooks,
  readSettings,
  removeHubHooks,
  settingsPath,
  writeSettings,
  type ClaudeSettings,
} from './install.js';
import { hubStatusLine, isHubStatusLine, removePrefsFromSettings } from './prefs.js';
import { installService, restartService, serviceState, uninstallService, type ServiceSpec } from './service.js';

export const RUNTIME_VERSION = '0.5.1';

const here = dirname(fileURLToPath(import.meta.url));

export interface RuntimeInfo {
  dir: string;
  node: string;
  nodeVersion: string;
  bundled: boolean;
  appPath: string | null;
  inApplications: boolean;
  translocated: boolean;
  hubEntry: string;
  hookCommand: string;
  statuslineCommand: string;
  /** Plugin do OpenCode em arquivo único (gerado pelo empacotamento do runtime). */
  opencodePlugin: string;
  webDir: string | null;
}

/** Onde estão o Node, o hub e o hook: dentro do app (bundle) ou no repositório (dev). */
export function runtimeInfo(): RuntimeInfo {
  const bundled = existsSync(join(here, 'hub.mjs'));
  const hubEntry = bundled ? join(here, 'hub.mjs') : join(here, '../../../services/api/dist/main.js');
  const hookCommand = bundled ? join(here, 'claude-hub-hook.mjs') : join(here, 'hook-command.js');
  const statuslineCommand = bundled ? join(here, 'claude-hub-statusline.mjs') : join(here, 'statusline.js');
  const opencodePlugin = bundled ? join(here, 'claude-hub-opencode.js') : join(here, '../../../dist-runtime/claude-hub-opencode.js');
  const webCandidates = bundled ? [join(here, 'web')] : [join(here, '../../../apps/web/out')];
  const webDir = webCandidates.find((d) => existsSync(join(d, 'index.html'))) ?? null;
  const fromPath = /^(.*\.app)\/Contents\/Resources\/runtime$/.exec(here)?.[1] ?? null;
  const appPath = process.env.CLAUDE_HUB_APP_PATH || fromPath;
  const home = process.env.HOME ?? '';
  return {
    dir: here,
    node: process.execPath,
    nodeVersion: process.version,
    bundled,
    appPath,
    inApplications: Boolean(appPath && (appPath.startsWith('/Applications/') || (home && appPath.startsWith(`${home}/Applications/`)))),
    translocated: Boolean(appPath?.includes('/AppTranslocation/')),
    hubEntry,
    hookCommand,
    statuslineCommand,
    opencodePlugin,
    webDir,
  };
}

export function serviceSpec(rt: RuntimeInfo = runtimeInfo()): ServiceSpec {
  return { node: rt.node, hubEntry: rt.hubEntry, webDir: rt.webDir, workingDir: rt.dir };
}

export interface SetupStatus {
  version: string;
  runtime: Omit<RuntimeInfo, 'hubEntry' | 'hookCommand' | 'statuslineCommand' | 'opencodePlugin' | 'webDir'>;
  claude: {
    found: boolean;
    path: string | null;
    version: string | null;
    settingsPath: string;
    settingsExists: boolean;
    settingsValid: boolean;
    otherHooks: number;
  };
  service: ReturnType<typeof serviceState>;
  hub: { running: boolean; version: string | null; localPort: number; publicPort: number; lastHookAt: number | null };
  hooks: { installed: boolean; events: number; current: boolean };
  tunnel: {
    tailscale: 'missing' | 'stopped' | 'unknown' | 'running';
    dnsName: string | null;
    serving: boolean;
    publicUrl: string | null;
    /** HTTPS Certificates do tailnet: null quando o Tailscale não informou. */
    httpsEnabled: boolean | null;
    /** Texto do próprio Tailscale quando o estado não pôde ser lido. */
    detail: string | null;
  };
  devices: number;
  /** Codex CLI e OpenCode: opcionais, ligados pelo usuário. */
  agents: { codex: AgentIntegration; opencode: AgentIntegration };
  ready: boolean;
}

export interface AgentIntegration {
  found: boolean;
  path: string | null;
  version: string | null;
  /** Integração ligada (hooks no Codex, plugin no OpenCode). */
  installed: boolean;
  /** Ligada e apontando para este app. */
  current: boolean;
  /** Arquivo que o hub mantém. */
  configPath: string;
  /** false: o arquivo do usuário não pôde ser lido, e o hub não mexe nele. */
  configValid: boolean;
}

export function agentIntegrations(rt: RuntimeInfo = runtimeInfo()): SetupStatus['agents'] {
  const codexBin = detectAgentBinary('codex');
  const codex = codexStatus(rt.node, rt.hookCommand);
  const opencodeBin = detectAgentBinary('opencode');
  const opencode = opencodeStatus(rt.opencodePlugin);
  return {
    codex: { ...codexBin, installed: codex.events.length > 0, current: codex.current, configPath: codex.hooksPath, configValid: codex.valid },
    opencode: { ...opencodeBin, installed: opencode.installed, current: opencode.current, configPath: opencode.pluginPath, configValid: true },
  };
}

/** Liga ou desliga a integração com o Codex ou o OpenCode. */
export function setAgentIntegration(agent: 'codex' | 'opencode', on: boolean): { ok: boolean; detail: string } {
  const rt = runtimeInfo();
  if (agent === 'codex') {
    if (!on) return uninstallCodexHooks();
    const cfg = loadConfig() as HubConfig;
    const r = installCodexHooks(cfg, rt.node, rt.hookCommand);
    return { ok: r.ok, detail: r.detail };
  }
  return on ? installOpencodePlugin(rt.opencodePlugin) : uninstallOpencodePlugin();
}

export interface StepResult {
  id: string;
  title: string;
  ok: boolean;
  detail: string;
}

async function localJson<T>(cfg: HubConfig, path: string, timeoutMs = 2500): Promise<T | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.localPort}${path}`, {
      headers: { authorization: `Bearer ${cfg.localToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

async function hubVersion(cfg: HubConfig): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.localPort}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? ((await res.json()) as { version: string }).version : null;
  } catch {
    return null;
  }
}

function countOtherHooks(settings: ClaudeSettings): number {
  let n = 0;
  for (const groups of Object.values(settings.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) for (const h of g?.hooks ?? []) if (!isHubHandler(h)) n++;
  }
  return n;
}

/** Os hooks instalados apontam para ESTE hub (porta, token e caminho do hook)? */
export function hooksAreCurrent(settings: ClaudeSettings, cfg: HubConfig, rt: RuntimeInfo): boolean {
  let http = 0;
  let command = 0;
  for (const groups of Object.values(settings.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const h of g?.hooks ?? []) {
        if (!isHubHandler(h)) continue;
        const o = h as Record<string, unknown>;
        if (o.type === 'http') {
          const auth = (o.headers as Record<string, string> | undefined)?.Authorization;
          if (o.url !== hookUrl(cfg) || auth !== `Bearer ${cfg.hookToken}`) return false;
          http++;
        } else if (o.type === 'command') {
          if (typeof o.command !== 'string' || !o.command.includes(rt.hookCommand) || !o.command.includes(rt.node)) return false;
          command++;
        }
      }
    }
  }
  return http > 0 && command > 0;
}

export async function setupStatus(): Promise<SetupStatus> {
  const cfg = loadConfig() as HubConfig;
  const rt = runtimeInfo();
  const path = settingsPath('user');
  let settings: ClaudeSettings = {};
  let settingsValid = true;
  try {
    settings = readSettings(path);
  } catch {
    settingsValid = false;
  }
  const claude = detectClaude();
  const service = serviceState(serviceSpec(rt));
  const version = await hubVersion(cfg);
  // App atualizado por cima com o hub antigo ainda rodando: o serviço precisa ser recarregado.
  if (version && version !== RUNTIME_VERSION) service.current = false;
  const info = version ? await localJson<{ lastHookAt?: number | null }>(cfg, '/local/info') : null;
  const devices = version ? await localJson<{ devices: unknown[] }>(cfg, '/local/devices') : null;
  const events = installedEvents(settings);
  const hooksCurrent = events.length > 0 && hooksAreCurrent(settings, cfg, rt);
  const ts = detectTailscale(cfg.publicPort);
  const serviceOk = service.supported ? service.installed && service.current : true;
  return {
    version: RUNTIME_VERSION,
    runtime: {
      dir: rt.dir,
      node: rt.node,
      nodeVersion: rt.nodeVersion,
      bundled: rt.bundled,
      appPath: rt.appPath,
      inApplications: rt.inApplications,
      translocated: rt.translocated,
    },
    claude: {
      ...claude,
      settingsPath: path,
      settingsExists: existsSync(path),
      settingsValid,
      otherHooks: settingsValid ? countOtherHooks(settings) : 0,
    },
    service,
    hub: {
      running: Boolean(version),
      version,
      localPort: cfg.localPort,
      publicPort: cfg.publicPort,
      lastHookAt: info?.lastHookAt ?? null,
    },
    hooks: { installed: events.length > 0, events: events.length, current: hooksCurrent },
    tunnel: { tailscale: ts.tailscale, dnsName: ts.dnsName, serving: ts.serving, publicUrl: cfg.publicUrl, httpsEnabled: ts.httpsEnabled, detail: ts.detail },
    devices: devices?.devices.length ?? 0,
    agents: agentIntegrations(rt),
    ready: version === RUNTIME_VERSION && hooksCurrent && serviceOk,
  };
}

async function waitForHub(cfg: HubConfig, ms: number): Promise<string | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await hubVersion(cfg);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Instala o serviço, espera o hub subir e liga os hooks do Claude Code. */
export async function setupRun(): Promise<{ ok: boolean; steps: StepResult[]; status: SetupStatus }> {
  const cfg = loadConfig() as HubConfig;
  const rt = runtimeInfo();
  const steps: StepResult[] = [];
  const push = (id: string, title: string, ok: boolean, detail: string) => {
    steps.push({ id, title, ok, detail });
    return ok;
  };
  const finish = async () => ({ ok: steps.every((s) => s.ok), steps, status: await setupStatus() });

  // 1. O app precisa estar num lugar fixo: serviço e hooks guardam caminhos absolutos.
  if (rt.bundled && rt.appPath && (rt.translocated || !rt.inApplications)) {
    push('location', 'Local do aplicativo', false, `O Claude Hub está em ${rt.appPath}. Arraste-o para a pasta Aplicativos e abra de lá antes de configurar.`);
    return finish();
  }
  push('location', 'Local do aplicativo', true, rt.bundled ? (rt.appPath ?? rt.dir) : `modo desenvolvimento (${rt.dir})`);

  // 2. Serviço de inicialização.
  const before = serviceState(serviceSpec(rt));
  if (!before.supported) {
    push('service', 'Serviço de inicialização', true, 'Fora do macOS o hub não é instalado como serviço; inicie-o manualmente.');
  } else if (before.installed && before.loaded && before.current && (await hubVersion(cfg)) === RUNTIME_VERSION) {
    // Tudo certo e rodando a versão atual: não reinicia o hub à toa (pedidos em espera seriam perdidos).
    push('service', 'Serviço de inicialização', true, `Serviço ${before.label} já instalado e em execução.`);
  } else {
    const r = await installService(serviceSpec(rt));
    if (!push('service', 'Serviço de inicialização', r.ok, r.detail)) return finish();
  }

  // 3. Hub respondendo.
  const version = await waitForHub(cfg, before.supported ? 20_000 : 3000);
  if (!push('hub', 'Hub local', Boolean(version), version ? `No ar em 127.0.0.1:${cfg.localPort} (v${version}).` : `O hub não respondeu em 127.0.0.1:${cfg.localPort}. Veja ${join(hubHome(), 'hub.log')}.`)) {
    return finish();
  }

  // 4. Hooks do Claude Code, preservando o que já existe.
  const path = settingsPath('user');
  let settings: ClaudeSettings;
  try {
    settings = readSettings(path);
  } catch (err) {
    push('hooks', 'Hooks do Claude Code', false, `Não alterei ${path}: o arquivo não é um JSON válido (${(err as Error).message}). Corrija-o e tente de novo.`);
    return finish();
  }
  const others = countOtherHooks(settings);
  let merged = mergeHubHooks(settings, buildHubHooks(cfg, { hookCommandPath: rt.hookCommand, nodePath: rt.node }));
  // Com a leitura de limites ligada, a ponte da linha de status também guarda o caminho do app.
  if (isHubStatusLine(merged.statusLine)) merged = { ...merged, statusLine: hubStatusLine(cfg.statusLineOriginal) };
  const unchanged = JSON.stringify(merged) === JSON.stringify(settings);
  const backup = unchanged ? null : writeSettings(path, merged);
  push(
    'hooks',
    'Hooks do Claude Code',
    true,
    `${unchanged ? 'Já estavam atualizados' : 'Instalados'} em ${path}` +
      (others > 0 ? `; ${others} hook(s) seus foram preservados` : '') +
      (backup ? `; backup em ${backup}` : '') +
      '.',
  );

  const claude = detectClaude();
  push(
    'claude',
    'Claude Code',
    true,
    claude.found
      ? `Encontrado${claude.version ? ` (${claude.version})` : ''} em ${claude.path}. Sessões abertas a partir de agora aparecem no hub.`
      : 'Não encontrei o Claude Code nesta máquina. Os hooks já estão prontos; as sessões aparecem assim que ele for instalado.',
  );

  // Codex e OpenCode: só se o usuário já ligou. "Reparar" atualiza o que ficou
  // apontando para uma versão anterior do app; nunca liga sozinho.
  const agents = agentIntegrations(rt);
  if (agents.codex.installed && !agents.codex.current) {
    const r = installCodexHooks(cfg, rt.node, rt.hookCommand);
    push('codex', 'Codex', r.ok, r.detail);
  }
  if (agents.opencode.installed && !agents.opencode.current) {
    const r = installOpencodePlugin(rt.opencodePlugin);
    push('opencode', 'OpenCode', r.ok, r.detail);
  }
  return finish();
}

export const TAILSCALE_DNS_ADMIN = 'https://login.tailscale.com/admin/dns';
export const HTTPS_DISABLED_HELP = `O Tailscale está conectado, mas o HTTPS está desativado na sua rede. Ative "HTTPS Certificates" em ${TAILSCALE_DNS_ADMIN} e toque em Atualizar.`;

/** Publica a porta do iPhone no Tailscale e grava a URL https no hub. */
export async function tunnelEnable(): Promise<{ ok: boolean; detail: string; publicUrl: string | null }> {
  const cfg = loadConfig() as HubConfig;
  const ts = detectTailscale(cfg.publicPort);
  if (ts.tailscale === 'missing' || !ts.binary) {
    return { ok: false, detail: 'O Tailscale não está instalado neste Mac.', publicUrl: cfg.publicUrl };
  }
  if (ts.tailscale === 'unknown') {
    return { ok: false, detail: `Não foi possível ler o estado do Tailscale. Resposta dele: "${ts.detail ?? ''}"`, publicUrl: cfg.publicUrl };
  }
  if (ts.tailscale === 'stopped' || !ts.dnsName) {
    return { ok: false, detail: 'O Tailscale está instalado, mas não conectado. Abra o Tailscale e entre na sua conta.', publicUrl: cfg.publicUrl };
  }
  if (!ts.serving) {
    // Sem HTTPS no tailnet o `serve` não publica nada: avisa antes de tentar.
    if (ts.httpsEnabled === false) {
      return { ok: false, detail: HTTPS_DISABLED_HELP, publicUrl: cfg.publicUrl };
    }
    const r = enableTailscaleServe(ts.binary, cfg.publicPort);
    if (!r.ok) {
      return {
        ok: false,
        detail: `O Tailscale recusou publicar a porta. Resposta dele: "${r.detail}". Confira se "HTTPS Certificates" está ativado em ${TAILSCALE_DNS_ADMIN}.`,
        publicUrl: cfg.publicUrl,
      };
    }
    // Código de saída 0 não basta: confere se a porta ficou mesmo publicada.
    if (!detectTailscale(cfg.publicPort).serving) {
      return {
        ok: false,
        detail: `O Tailscale respondeu, mas a porta não ficou publicada. Resposta dele: "${r.detail}".`,
        publicUrl: cfg.publicUrl,
      };
    }
  }
  const publicUrl = `https://${ts.dnsName}`;
  if (cfg.publicUrl !== publicUrl) {
    const stored = loadConfig() as HubConfig;
    saveConfig({ ...stored, publicUrl });
    // O hub lê a URL ao iniciar: reinicia para valer no pareamento e no push.
    restartService();
    await waitForHub({ ...cfg, publicUrl }, 15_000);
  }
  return { ok: true, detail: `iPhone alcança o hub em ${publicUrl} (só dentro da sua rede Tailscale).`, publicUrl };
}

/** Remove a integração. Com purge, apaga também configuração, segredos e histórico. */
export async function uninstallAll(purge: boolean): Promise<{ ok: boolean; steps: StepResult[] }> {
  const steps: StepResult[] = [];
  const path = settingsPath('user');
  try {
    const before = readSettings(path);
    const stored = loadConfig() as HubConfig;
    // Hooks, variáveis de telemetria e a ponte da linha de status: tudo o que é do hub sai junto.
    const after = removePrefsFromSettings(removeHubHooks(before), stored);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      writeSettings(path, after);
      saveConfig({ ...stored, consumption: false, limits: false, statusLineOriginal: null });
      steps.push({ id: 'hooks', title: 'Hooks do Claude Code', ok: true, detail: `Removidos de ${path}; os demais hooks e configurações foram preservados.` });
    } else {
      steps.push({ id: 'hooks', title: 'Hooks do Claude Code', ok: true, detail: 'Não havia hooks do Claude Hub.' });
    }
  } catch (err) {
    steps.push({ id: 'hooks', title: 'Hooks do Claude Code', ok: false, detail: `Não alterei ${path}: ${(err as Error).message}` });
  }
  const codex = uninstallCodexHooks();
  steps.push({ id: 'codex', title: 'Codex', ok: codex.ok, detail: codex.detail });
  const opencode = uninstallOpencodePlugin();
  steps.push({ id: 'opencode', title: 'OpenCode', ok: opencode.ok, detail: opencode.detail });
  const s = await uninstallService();
  steps.push({ id: 'service', title: 'Serviço de inicialização', ok: s.ok, detail: s.detail });
  if (purge) {
    rmSync(hubHome(), { recursive: true, force: true });
    steps.push({ id: 'data', title: 'Dados locais', ok: true, detail: `${hubHome()} apagado.` });
  } else {
    steps.push({ id: 'data', title: 'Dados locais', ok: true, detail: `Mantidos em ${hubHome()} (use --purge para apagar).` });
  }
  return { ok: steps.every((x) => x.ok), steps };
}
