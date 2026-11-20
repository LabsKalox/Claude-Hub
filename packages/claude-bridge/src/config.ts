/**
 * Configuração local do hub: ~/.claude-hub/config.json (permissão 0600).
 * Guarda portas e segredos locais. Nunca é versionada nem enviada a lugar algum.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface HubConfig {
  /** Porta só-loopback: hooks do Claude Code, app macOS e administração. */
  localPort: number;
  /** Endereço de bind da porta local. Só mude dentro de contêiner (ver docker-compose.yml). */
  localHost: string;
  /** Porta voltada ao iPhone (PWA + API de dispositivos). */
  publicPort: number;
  /** Endereço de bind da porta pública. 127.0.0.1 = só via túnel (tailscale serve). */
  publicHost: string;
  /** URL https pela qual o iPhone alcança a porta pública (usada no pareamento). */
  publicUrl: string | null;
  /** Autoriza o app macOS e a CLI na porta local. */
  localToken: string;
  /** Autoriza apenas o envio de eventos de hook. */
  hookToken: string;
  /** Tempo máximo que um pedido de permissão espera por resposta remota. */
  approvalTimeoutSec: number;
  vapid: { publicKey: string; privateKey: string; subject: string } | null;
  /** Abrir a ilha (app) sozinha quando uma sessão do Claude Code começa. */
  autoOpenIsland: boolean;
  /** Medição de consumo ligada (telemetria local do Claude Code apontando para o hub). */
  consumption: boolean;
  /** Leitura de limites ligada (ponte na linha de status do Claude Code). */
  limits: boolean;
  /**
   * A linha de status que o usuário tinha antes de ligar a leitura de limites,
   * para continuar aparecendo e ser devolvida ao desligar. null = não tinha.
   */
  statusLineOriginal: Record<string, unknown> | null;
}

/** Subject VAPID das versões até a 0.4.2: um domínio que não existe. A Apple responde 403 BadJwtToken. */
export const LEGACY_VAPID_SUBJECT = 'mailto:claude-hub@localhost.localdomain';
/** Padrão quando o hub ainda não tem endereço https próprio. */
export const DEFAULT_VAPID_SUBJECT = 'mailto:claude-hub@example.com';

const LOCAL_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.localdomain|\[?::1\]?|127\.\d+\.\d+\.\d+|0\.0\.0\.0)$/i;

/**
 * Um "subject" VAPID que os serviços de push aceitam: `mailto:` com um domínio
 * de verdade, ou `https://` que não aponte para a própria máquina. O serviço da
 * Apple recusa o JWT (403 BadJwtToken) quando o subject é local — medido em
 * 20/11/2026 com a sonda `.github/scripts/apple-vapid-probe.mjs`.
 */
export function isValidVapidSubject(subject: unknown): subject is string {
  if (typeof subject !== 'string' || subject.length > 200 || /\s/.test(subject)) return false;
  if (subject.startsWith('mailto:')) {
    const match = /^mailto:[^@\s<>]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})$/.exec(subject);
    return Boolean(match) && !LOCAL_HOST.test(match![1]!);
  }
  if (subject.startsWith('https://')) {
    try {
      const url = new URL(subject);
      return url.hostname.includes('.') && !LOCAL_HOST.test(url.hostname);
    } catch {
      return false;
    }
  }
  return false;
}

export function hubHome(): string {
  return process.env.CLAUDE_HUB_HOME || join(homedir(), '.claude-hub');
}

export function configPath(): string {
  return join(hubHome(), 'config.json');
}

export function dbPath(): string {
  return join(hubHome(), 'hub.sqlite');
}

function token(): string {
  return randomBytes(32).toString('base64url');
}

export function defaultConfig(): HubConfig {
  return {
    localPort: 4317,
    localHost: '127.0.0.1',
    publicPort: 4318,
    publicHost: '127.0.0.1',
    publicUrl: null,
    localToken: token(),
    hookToken: token(),
    approvalTimeoutSec: 300,
    vapid: null,
    autoOpenIsland: true,
    consumption: false,
    limits: false,
    statusLineOriginal: null,
  };
}

export function saveConfig(cfg: HubConfig): void {
  const dir = hubHome();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${configPath()}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, configPath());
  try {
    chmodSync(configPath(), 0o600);
  } catch {
    /* sistemas sem chmod (Windows) */
  }
}

/** Lê a configuração; cria com segredos novos se ainda não existir. */
export function loadConfig(options: { create?: boolean } = {}): HubConfig | null {
  const create = options.create ?? true;
  if (!existsSync(configPath())) {
    if (!create) return null;
    const cfg = applyEnv(defaultConfig());
    saveConfig(cfg);
    return cfg;
  }
  const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<HubConfig>;
  const cfg: HubConfig = { ...defaultConfig(), ...raw };
  // Arquivo antigo sem algum segredo: completa e regrava.
  if (!raw.localToken || !raw.hookToken) saveConfig(cfg);
  return applyEnv(cfg);
}

function applyEnv(cfg: HubConfig): HubConfig {
  const env = process.env;
  const port = (v: string | undefined) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
  };
  return {
    ...cfg,
    localPort: port(env.CLAUDE_HUB_LOCAL_PORT) ?? cfg.localPort,
    publicPort: port(env.CLAUDE_HUB_PUBLIC_PORT) ?? cfg.publicPort,
    localHost: env.CLAUDE_HUB_LOCAL_HOST || cfg.localHost,
    publicHost: env.CLAUDE_HUB_PUBLIC_HOST || cfg.publicHost,
    publicUrl: env.CLAUDE_HUB_PUBLIC_URL || cfg.publicUrl,
  };
}

export const HOOK_PATH = '/hooks/claude-code';

export function hookUrl(cfg: Pick<HubConfig, 'localPort'>): string {
  return `http://127.0.0.1:${cfg.localPort}${HOOK_PATH}`;
}

export const OTEL_PATH = '/otel/v1/metrics';
export const STATUSLINE_PATH = '/statusline/claude-code';
/** Consumo do Codex e do OpenCode (tokens e custo que os próprios agentes informam). */
export const AGENT_USAGE_PATH = '/hooks/agent-usage';
