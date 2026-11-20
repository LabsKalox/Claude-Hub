/**
 * Preferências que mexem (com cuidado) nas configurações do Claude Code:
 *
 *  - consumption: acrescenta ao bloco `env` do settings.json as variáveis de
 *    telemetria OpenTelemetry do Claude Code, apontando SÓ para o hub local.
 *  - limits: põe na `statusLine` uma ponte que repassa ao hub os limites que o
 *    Claude Code informa, mantendo a linha de status que já existia.
 *  - autoOpenIsland: só no config do hub; não toca no Claude Code.
 *
 * Regras: backup antes de gravar; só acrescenta/remover o que é do Claude Hub;
 * se o usuário já usa telemetria própria, não altera nada.
 */
import { OTEL_PATH, loadConfig, saveConfig, type HubConfig } from './config.js';
import { readSettings, settingsPath, writeSettings, type ClaudeSettings } from './install.js';
import { runtimeInfo } from './setup.js';

export interface Prefs {
  autoOpenIsland: boolean;
  consumption: boolean;
  limits: boolean;
}

export type PrefKey = keyof Prefs;
export const PREF_KEYS: readonly PrefKey[] = ['autoOpenIsland', 'consumption', 'limits'];

const STATUSLINE_MARKER = /claude-hub-statusline\.mjs|claude-bridge[\\/](dist|src)[\\/]statusline\.js/;

function quote(p: string): string {
  return `"${p.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** Variáveis de ambiente que o Claude Hub acrescenta para receber as métricas. */
export function otelEnv(cfg: Pick<HubConfig, 'localPort' | 'hookToken'>): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${cfg.localPort}${OTEL_PATH}`,
    OTEL_EXPORTER_OTLP_METRICS_HEADERS: `Authorization=Bearer%20${cfg.hookToken}`,
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'delta',
    OTEL_METRIC_EXPORT_INTERVAL: '10000',
  };
}

function envOf(settings: ClaudeSettings): Record<string, unknown> {
  const env = settings.env;
  return env && typeof env === 'object' && !Array.isArray(env) ? (env as Record<string, unknown>) : {};
}

/** As variáveis do hub estão todas presentes, com os valores atuais? */
export function consumptionInstalled(settings: ClaudeSettings, cfg: Pick<HubConfig, 'localPort' | 'hookToken'>): boolean {
  const env = envOf(settings);
  return Object.entries(otelEnv(cfg)).every(([k, v]) => env[k] === v);
}

/** Há telemetria OpenTelemetry que NÃO é do hub? Nesse caso não mexemos. */
function foreignTelemetry(settings: ClaudeSettings): string | null {
  const env = envOf(settings);
  const endpoint = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  const ours = typeof endpoint === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/otel\/v1\/metrics$/.test(endpoint);
  if (ours) return null;
  const found = Object.keys(env).find((k) => k === 'CLAUDE_CODE_ENABLE_TELEMETRY' || k.startsWith('OTEL_'));
  return found ?? null;
}

export function applyConsumption(settings: ClaudeSettings, cfg: Pick<HubConfig, 'localPort' | 'hookToken'>, on: boolean): ClaudeSettings {
  const env = { ...envOf(settings) };
  const ours = otelEnv(cfg);
  if (on) Object.assign(env, ours);
  else {
    // Remove só as chaves do hub, e só se ainda apontam para um hub local.
    const endpoint = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    if (typeof endpoint === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/otel\/v1\/metrics$/.test(endpoint)) {
      for (const k of Object.keys(ours)) delete env[k];
    }
  }
  const next: ClaudeSettings = { ...settings };
  if (Object.keys(env).length > 0) next.env = env;
  else delete next.env;
  return next;
}

export function isHubStatusLine(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && typeof (value as { command?: unknown }).command === 'string' && STATUSLINE_MARKER.test((value as { command: string }).command));
}

export function hubStatusLine(original: Record<string, unknown> | null): Record<string, unknown> {
  const rt = runtimeInfo();
  // Mantém as opções de exibição que o usuário tinha (padding, intervalo…); troca só o comando.
  return { ...(original ?? {}), type: 'command', command: `${quote(rt.node)} ${quote(rt.statuslineCommand)}` };
}

function current(cfg: HubConfig, settings: ClaudeSettings | null): Prefs {
  return {
    autoOpenIsland: cfg.autoOpenIsland !== false,
    consumption: settings ? consumptionInstalled(settings, cfg) : cfg.consumption,
    limits: settings ? isHubStatusLine(settings.statusLine) : cfg.limits,
  };
}

function load(): { cfg: HubConfig; settings: ClaudeSettings | null; path: string; error: string | null } {
  const cfg = loadConfig() as HubConfig;
  const path = settingsPath('user');
  try {
    return { cfg, settings: readSettings(path), path, error: null };
  } catch (err) {
    return { cfg, settings: null, path, error: (err as Error).message };
  }
}

export function getPrefs(): { ok: boolean; prefs: Prefs } {
  const { cfg, settings } = load();
  return { ok: true, prefs: current(cfg, settings) };
}

export function setPref(key: string, on: boolean): { ok: boolean; detail: string; prefs: Prefs } {
  const { cfg, settings, path, error } = load();
  const stored = loadConfig() as HubConfig;
  const done = (ok: boolean, detail: string) => {
    const fresh = load();
    return { ok, detail, prefs: current(fresh.cfg, fresh.settings) };
  };
  if (!PREF_KEYS.includes(key as PrefKey)) return done(false, `Preferência desconhecida: ${key}. Use ${PREF_KEYS.join(', ')}.`);

  if (key === 'autoOpenIsland') {
    saveConfig({ ...stored, autoOpenIsland: on });
    return done(true, on ? 'A ilha abre sozinha quando uma sessão do Claude Code começa.' : 'A ilha não abre mais sozinha com o Claude Code.');
  }
  if (!settings) return done(false, `Não alterei ${path}: o arquivo não é um JSON válido (${error}).`);

  if (key === 'consumption') {
    if (on) {
      const foreign = foreignTelemetry(settings);
      if (foreign) {
        return done(false, `Você já tem telemetria OpenTelemetry configurada no Claude Code (${foreign}). Para não interferir, não alterei nada.`);
      }
    }
    const next = applyConsumption(settings, cfg, on);
    const changed = JSON.stringify(next) !== JSON.stringify(settings);
    const backup = changed ? writeSettings(path, next) : null;
    saveConfig({ ...stored, consumption: on });
    return done(
      true,
      on
        ? `Medição ligada${backup ? ` (backup em ${backup})` : ''}. Vale para sessões do Claude Code abertas a partir de agora; os dados ficam só neste Mac.`
        : `Medição desligada${backup ? ` (backup em ${backup})` : ''}.`,
    );
  }

  // limits
  if (on) {
    if (isHubStatusLine(settings.statusLine)) {
      // Já ligada: só garante que o comando aponta para este app.
      const next = { ...settings, statusLine: hubStatusLine(stored.statusLineOriginal) };
      if (JSON.stringify(next) !== JSON.stringify(settings)) writeSettings(path, next);
      saveConfig({ ...stored, limits: true });
      return done(true, 'Leitura de limites já estava ligada.');
    }
    const original = settings.statusLine && typeof settings.statusLine === 'object' ? (settings.statusLine as Record<string, unknown>) : null;
    const backup = writeSettings(path, { ...settings, statusLine: hubStatusLine(original) });
    saveConfig({ ...stored, limits: true, statusLineOriginal: original });
    return done(
      true,
      `Leitura de limites ligada${backup ? ` (backup em ${backup})` : ''}. ${original ? 'A sua linha de status continua aparecendo.' : 'Você não tinha linha de status; passa a aparecer uma linha curta do Claude Hub.'} Os limites só aparecem se o Claude Code os informar (planos Pro, Max e Ultra).`,
    );
  }
  if (isHubStatusLine(settings.statusLine)) {
    const next: ClaudeSettings = { ...settings };
    if (stored.statusLineOriginal) next.statusLine = stored.statusLineOriginal;
    else delete next.statusLine;
    writeSettings(path, next);
  }
  saveConfig({ ...stored, limits: false, statusLineOriginal: null });
  return done(true, 'Leitura de limites desligada; a linha de status voltou a ser a que você tinha.');
}

/** Desfaz, no settings.json, tudo o que as preferências acrescentaram (usado na desinstalação). */
export function removePrefsFromSettings(settings: ClaudeSettings, cfg: HubConfig): ClaudeSettings {
  let next = applyConsumption(settings, cfg, false);
  if (isHubStatusLine(next.statusLine)) {
    next = { ...next };
    if (cfg.statusLineOriginal) next.statusLine = cfg.statusLineOriginal;
    else delete next.statusLine;
  }
  return next;
}
