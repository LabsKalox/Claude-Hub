/**
 * Sobe um hub de verdade (processo separado, banco e portas temporários) e
 * oferece atalhos para mandar eventos de hook exatamente como o Claude Code.
 */
import { createServer, type AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const shots = join(root, 'docs/screenshots');

export interface RunningHub {
  localUrl: string;
  publicUrl: string;
  localToken: string;
  /** Liga as preferências de consumo e limites (como o botão da ilha faz) e envia o que o Claude Code enviaria. */
  reportUsage(metricsLines: string[], statusLine: unknown): Promise<void>;
  hook(sessionId: string, event: string, extra?: Record<string, unknown>, signal?: AbortSignal): Promise<Response>;
  local<T = unknown>(path: string, init?: RequestInit): Promise<T>;
  pairingCode(): Promise<string>;
  stop(): void;
}

/** Porta livre pedida ao sistema (os workers do Playwright rodam em paralelo: portas sorteadas colidiam). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export async function startHub(attempt = 0): Promise<RunningHub> {
  const home = mkdtempSync(join(tmpdir(), 'claude-hub-e2e-'));
  const localPort = await freePort();
  const publicPort = await freePort();
  // Com CLAUDE_HUB_RUNTIME_DIR, testa o runtime empacotado (o mesmo que vai dentro do app):
  // hub em arquivo único e PWA resolvida a partir da pasta ao lado dele.
  const runtime = process.env.CLAUDE_HUB_RUNTIME_DIR;
  const entry = runtime ? join(runtime, 'hub.mjs') : join(root, 'services/api/dist/main.js');
  const proc: ChildProcess = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      CLAUDE_HUB_HOME: home,
      CLAUDE_HUB_LOCAL_PORT: String(localPort),
      CLAUDE_HUB_PUBLIC_PORT: String(publicPort),
      ...(runtime ? {} : { CLAUDE_HUB_WEB_DIR: join(root, 'apps/web/out') }),
    },
    stdio: 'ignore',
  });
  const localUrl = `http://127.0.0.1:${localPort}`;
  const publicUrl = `http://127.0.0.1:${publicPort}`;
  let exited = false;
  proc.once('exit', () => (exited = true));
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${localUrl}/health`)).ok) break;
    } catch {
      // Porta tomada entre a escolha e o uso: tenta de novo com outras.
      if (exited && attempt < 3) return startHub(attempt + 1);
      if (i > 200) throw new Error('o hub não subiu em 20 s');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { localToken: string; hookToken: string };
  const cwdOf: Record<string, string> = {};

  const hub: RunningHub = {
    localUrl,
    publicUrl,
    localToken: cfg.localToken,
    hook: (sessionId, event, extra = {}, signal) => {
      if (typeof extra.cwd === 'string') cwdOf[sessionId] = extra.cwd;
      return fetch(`${localUrl}/hooks/claude-code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.hookToken}` },
        body: JSON.stringify({ session_id: sessionId, cwd: cwdOf[sessionId] ?? '/Users/dev/projetos/site', hook_event_name: event, ...extra }),
        signal,
      });
    },
    local: async (path, init = {}) => {
      const res = await fetch(`${localUrl}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${cfg.localToken}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      });
      return (await res.json()) as never;
    },
    reportUsage: async (metricsLines, statusLine) => {
      const path = join(home, 'config.json');
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), consumption: true, limits: true }, null, 2), { mode: 0o600 });
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${cfg.hookToken}` };
      for (const body of metricsLines) await fetch(`${localUrl}/otel/v1/metrics`, { method: 'POST', headers, body });
      await fetch(`${localUrl}/statusline/claude-code`, { method: 'POST', headers, body: JSON.stringify(statusLine) });
    },
    pairingCode: async () => (await hub.local<{ code: string }>('/local/pairing', { method: 'POST', body: '{}' })).code,
    stop: () => void proc.kill('SIGTERM'),
  };
  return hub;
}

/** As quatro sessões do frame 00:05, alimentadas por eventos de hook. */
export async function seedReferenceSessions(hub: RunningHub): Promise<void> {
  const sessions: Array<[string, string, string, string]> = [
    ['s-aprov', '/Users/dev/projetos/aprovacoes', 'Aprovações — vídeo do dia', "A máquina de reels mudou mais uma coisa: agora não existe 'STATUS.txt' em lugar nenhum. Sua decisão fica só no painel."],
    ['s-reels', '/Users/dev/projetos/maquina-de-reels', 'Máquina de reels: fase 1 (referência → prévia)', 'A sessão Aprovações — vídeo do dia confirmou a mudança. Agora ela lê a referência e monta a prévia.'],
    ['s-skill', '/Users/dev/projetos/skill-da-semana', "Modelo da série 'Skill da semana'", 'A sessão de aprovações confirmou a mudança: sua decisão fica só no painel.'],
    ['s-video', '/Users/dev/projetos/edicao', 'EDIÇÃO DE VÍDEOS M', 'Vou capturar telas reais do seu Claude Hub para usar no vídeo, assim ele mostra a sua ferramenta de verdade e não um desenho.'],
  ];
  for (const [id, cwd, title, text] of sessions) {
    await hub.hook(id, 'SessionStart', { cwd, source: 'startup', session_title: title, model: 'claude-sonnet-5' });
    await hub.hook(id, 'UserPromptSubmit', { prompt: text });
  }
}
