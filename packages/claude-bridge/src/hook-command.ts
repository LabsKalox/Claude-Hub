#!/usr/bin/env node
/**
 * Hook de comando do Claude Hub.
 *
 * Recebe o JSON do evento no stdin, repassa ao hub local e devolve no stdout a
 * resposta do hub (quando houver). Usado para SessionStart — que não aceita
 * hook HTTP — e como alternativa completa em `--mode command`.
 *
 * Sempre termina com código 0 e nunca escreve nada que não venha do hub:
 * se o hub estiver fora do ar, o Claude Code segue como se o hook não existisse.
 *
 * `--agent codex`: o mesmo hook serve ao Codex CLI, cujos hooks seguem o mesmo
 * formato (evento no stdin, decisão de permissão no stdout).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookUrl, loadConfig } from './config.js';

/**
 * Abre a ilha (o app) quando uma sessão do Claude Code começa, se ela ainda
 * não estiver aberta. `open` nunca cria uma segunda instância de um app que já
 * está rodando; a checagem com pgrep só evita o custo de chamá-lo à toa.
 * Não espera o app abrir: o hook precisa devolver o controle na hora.
 */
function openIslandIfNeeded(): void {
  if (process.platform !== 'darwin') return;
  const here = dirname(fileURLToPath(import.meta.url));
  const app = /^(.*\.app)\/Contents\/Resources\/runtime$/.exec(here)?.[1];
  if (!app || !existsSync(app)) return;
  const running = spawnSync('/usr/bin/pgrep', ['-x', 'ClaudeHub'], { stdio: 'ignore', timeout: 2000 }).status === 0;
  if (running) return;
  // -g: não rouba o foco do terminal.
  spawn('/usr/bin/open', ['-g', app], { stdio: 'ignore', detached: true }).unref();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const cfg = loadConfig({ create: false });
  if (!cfg) return;

  const agentFlag = process.argv.indexOf('--agent');
  const agent = agentFlag >= 0 ? process.argv[agentFlag + 1] : undefined;
  if (agent === 'codex') payload.hub_agent = 'codex';

  if (payload.hook_event_name === 'SessionStart' && cfg.autoOpenIsland !== false) {
    try {
      openIslandIfNeeded();
    } catch {
      /* abrir a ilha é conveniência: nunca atrapalha a sessão */
    }
  }

  // Só o hook de comando enxerga o ambiente do terminal: aproveita para dizer
  // ao hub qual aplicativo hospeda a sessão (usado por "Responder no Claude").
  payload.hub_env = {
    host_app: process.env.__CFBundleIdentifier || undefined,
    term_program: process.env.TERM_PROGRAM || undefined,
  };

  const waitsForHuman = payload.hook_event_name === 'PermissionRequest';
  const timeoutMs = waitsForHuman ? (cfg.approvalTimeoutSec + 20) * 1000 : 4000;
  const res = await fetch(hookUrl(cfg), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.hookToken}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return;
  const body = (await res.text()).trim();
  if (!body) return;
  try {
    JSON.parse(body);
  } catch {
    return;
  }
  process.stdout.write(body);
}

main()
  .catch(() => {
    /* falha aberta */
  })
  .finally(() => {
    process.exitCode = 0;
  });
