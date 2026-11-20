#!/usr/bin/env node
/**
 * Teste de fumaça da ilha NATIVA (roda no runner macOS do CI, ou no seu Mac).
 *
 *   node tests/real/macos-smoke.mjs [caminho/ClaudeHub.app]
 *
 * Sobe o hub, abre o app compilado, confirma que ele se conectou e autenticou
 * por WebSocket, leva a ilha por cada estado com eventos de hook e captura a
 * tela em cada um. Falha se o app cair ou não se conectar.
 *
 * Com SMOKE_PRINT_IMAGES=1, imprime as capturas reduzidas em base64 no log
 * (linhas "IMG:<nome>:<base64>"), para recuperar as imagens a partir do CI.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.error('Este teste só roda no macOS.');
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const app = resolve(process.argv[2] ?? join(root, 'apps/macos/build/ClaudeHub.app'));
const binary = join(app, 'Contents/MacOS/ClaudeHub');
const outDir = join(root, 'docs/screenshots/macos');
mkdirSync(outDir, { recursive: true });
if (!existsSync(binary)) {
  console.error(`App não encontrado em ${app}. Rode apps/macos/scripts/build-app.sh antes.`);
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), 'claude-hub-smoke-'));
// CLAUDE_HUB_NO_AUTO_SETUP: aqui o hub é temporário e nada está "instalado"; sem isso o
// assistente de configuração abriria sozinho por cima da ilha que queremos fotografar.
const env = {
  ...process.env,
  CLAUDE_HUB_HOME: home,
  CLAUDE_HUB_LOCAL_PORT: '45317',
  CLAUDE_HUB_PUBLIC_PORT: '45318',
  NODE_NO_WARNINGS: '1',
  CLAUDE_HUB_NO_AUTO_SETUP: '1',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    return `ERRO: ${String(err.stderr || err.message).trim().split('\n')[0]}`;
  }
};

const hubProc = spawn(process.execPath, [join(root, 'services/api/dist/main.js')], { env, stdio: 'ignore' });
let appProc = null;
let backdropProc = null;
let appExit = null;
const cleanup = () => {
  appProc?.kill('SIGTERM');
  backdropProc?.kill('SIGKILL');
  hubProc.kill('SIGTERM');
};
process.on('exit', cleanup);

const failures = [];
const tail = [];
const check = (ok, text) => {
  console.log(`${ok ? '✓' : '✗'} ${text}`);
  if (!ok) failures.push(text);
};

try {
  const base = 'http://127.0.0.1:45317';
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      await sleep(100);
    }
  }
  const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  const local = (path, init = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${cfg.localToken}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    }).then((r) => r.json());
  const hook = (id, event, extra = {}, signal) =>
    fetch(`${base}/hooks/claude-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.hookToken}` },
      body: JSON.stringify({ session_id: id, cwd: '/Users/dev/projetos/site', hook_event_name: event, ...extra }),
      signal,
    });

  console.log(sh('sw_vers', ['-productVersion']), '·', sh('sysctl', ['-n', 'machdep.cpu.brand_string']));
  const bounds = sh('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop']);
  const width = Number(bounds.split(',')[2]) || 0;
  console.log(`Área de trabalho: ${bounds}`);

  // Clima: cidade pré-configurada pelas mesmas chaves que o widget grava ao escolher uma cidade.
  for (const [key, type, value] of [
    ['widget.weather.cityName', '-string', 'São Paulo'],
    ['widget.weather.latitude', '-float', '-23.5475'],
    ['widget.weather.longitude', '-float', '-46.6361'],
  ]) sh('defaults', ['write', 'dev.claudehub.mac', key, type, value]);
  // Medição de consumo e leitura de limites ligadas neste hub temporário (settings.json à parte).
  const cliBin = join(app, 'Contents/Resources/runtime/bin/claude-hub');
  const prefsEnv = { ...env, CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'claude-hub-smoke-cfg-')) };
  if (existsSync(cliBin)) {
    for (const key of ['consumption', 'limits']) {
      try {
        execFileSync(cliBin, ['prefs', 'set', key, 'on', '--json'], { env: prefsEnv, encoding: 'utf8' });
      } catch (err) {
        console.log(`aviso: prefs set ${key}: ${String(err.stdout || err.message).slice(0, 160)}`);
      }
    }
  }

  // Fundo claro atrás da ilha, para a silhueta aparecer nas capturas.
  backdropProc = spawn('swift', [join(root, 'tests/real/backdrop.swift')], { stdio: 'ignore' });
  await sleep(Number(process.env.SMOKE_BACKDROP_WAIT_MS ?? 12000));

  // O app herda CLAUDE_HUB_HOME e lê a mesma configuração que o hub criou.
  appProc = spawn(binary, [], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  appProc.on('exit', (code, signal) => (appExit = { code, signal }));

  let connected = false;
  for (let i = 0; i < 100 && !connected && !appExit; i++) {
    connected = (await local('/local/info')).macConnected === true;
    if (!connected) await sleep(200);
  }
  check(connected, 'app nativo abriu, leu a configuração e autenticou no hub por WebSocket');
  if (!connected) throw new Error(appExit ? `o app saiu (${JSON.stringify(appExit)})` : 'o app não se conectou em 20 s');

  const notify = (name) =>
    sh('swift', ['-e', `import Foundation; DistributedNotificationCenter.default().postNotificationName(Notification.Name("${name}"), object: nil, userInfo: nil, deliverImmediately: true)`]);

  const shots = [];
  const shot = async (name, height = 300) => {
    await sleep(1800);
    const full = join(outDir, `${name}.png`);
    // Recorta a faixa superior, onde a ilha vive; sem a largura, captura a tela toda.
    const args = width > 0 ? ['-x', '-R', `0,0,${width},${height}`, full] : ['-x', full];
    const r = sh('screencapture', args);
    const ok = existsSync(full);
    check(ok, `captura ${name}${ok ? '' : ` (${r})`}`);
    if (ok) shots.push(name);
  };
  const endSession = (id) => hook(id, 'SessionEnd', { reason: 'other' });

  await shot('01-sem-sessoes');

  await hook('w', 'UserPromptSubmit', { prompt: 'Renderizar o vídeo' });
  const todos = Array.from({ length: 10 }, (_, i) => ({ content: `etapa ${i}`, status: i < 7 ? 'completed' : 'pending' }));
  await hook('w', 'PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos } });
  await shot('02-trabalhando');

  await hook('w', 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  await shot('03-esperando-voce');

  await hook('w', 'UserPromptSubmit', { prompt: 'Publicar o site' });
  const ctrl = new AbortController();
  const held = hook('w', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm install && npm run build -- --prod' } }, ctrl.signal).catch(() => null);
  await shot('04-pedido-de-permissao', 360);
  ctrl.abort();
  await held;

  await hook('w', 'UserPromptSubmit', { prompt: 'Renderizar o vídeo' });
  await hook('w', 'Stop', { last_assistant_message: 'Vídeo pronto para revisar.' });
  await shot('05-terminou');
  await endSession('w');

  const sessions = [
    ['s-aprov', '/Users/dev/projetos/aprovacoes', 'Aprovações — vídeo do dia', "A máquina de reels mudou mais uma coisa: agora não existe 'STATUS.txt' em lugar nenhum. Sua decisão fica só no painel."],
    ['s-reels', '/Users/dev/projetos/maquina-de-reels', 'Máquina de reels: fase 1 (referência → prévia)', 'A sessão Aprovações — vídeo do dia confirmou a mudança. Agora ela lê a referência e monta a prévia.'],
    ['s-skill', '/Users/dev/projetos/skill-da-semana', "Modelo da série 'Skill da semana'", 'A sessão de aprovações confirmou a mudança: sua decisão fica só no painel.'],
    ['s-video', '/Users/dev/projetos/edicao', 'EDIÇÃO DE VÍDEOS M', 'Vou capturar telas reais do seu Claude Hub para usar no vídeo, assim ele mostra a sua ferramenta de verdade e não um desenho.'],
  ];
  for (const [id, cwd, title, text] of sessions) {
    await hook(id, 'SessionStart', { cwd, source: 'startup', session_title: title });
    await hook(id, 'UserPromptSubmit', { cwd, prompt: text });
  }
  const opened = notify('dev.claudehub.mac.openPanel');
  if (opened.startsWith('ERRO')) console.log(`aviso: não consegui abrir o painel por notificação (${opened})`);
  await shot('06-painel-de-sessoes', 620);

  // Sistema: dá tempo de o monitor juntar alguns pontos para os gráficos.
  notify('dev.claudehub.mac.openTab.sistema');
  await sleep(9000);
  await shot('10-aba-sistema', 620);

  // Uso: alimenta o hub com métricas REAIS capturadas do Claude Code 2.1.329 e com o exemplo
  // oficial da linha de status (horários de renovação ajustados para o futuro). O que se
  // verifica aqui é a tela; a medição com uma sessão real está em tests/real/run-real-claude.mjs.
  const fixtures = join(root, 'tests/fixtures');
  const send = (path, body) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.hookToken}` }, body: JSON.stringify(body) });
  for (const line of readFileSync(join(fixtures, 'otel-metrics-claude-code-2.1.329.jsonl'), 'utf8').trim().split('\n')) await send('/otel/v1/metrics', JSON.parse(line));
  const status = JSON.parse(readFileSync(join(fixtures, 'statusline-input-docs.json'), 'utf8'));
  const soon = Math.floor(Date.now() / 1000);
  status.rate_limits = { five_hour: { used_percentage: 23.5, resets_at: soon + 3 * 3600 }, seven_day: { used_percentage: 41.2, resets_at: soon + 4 * 86400 } };
  await send('/statusline/claude-code', status);
  const usage = (await local('/api/usage')).usage;
  check(usage.consumption?.outputTokens === 4 && usage.limits?.windows?.length === 2, 'hub entrega consumo e limites para a aba Uso', `saída ${usage.consumption?.outputTokens} tokens · ${usage.limits?.windows?.length} janelas`);
  notify('dev.claudehub.mac.openTab.uso');
  await shot('11-aba-uso', 620);

  // Widgets: música chega como chega de verdade — a notificação que o app Música publica.
  sh('swift', ['-e', 'import Foundation; DistributedNotificationCenter.default().postNotificationName(Notification.Name("com.apple.Music.playerInfo"), object: nil, userInfo: ["Name": "Aquarela", "Artist": "Toquinho", "Album": "Aquarela", "Player State": "Playing"], deliverImmediately: true)']);
  notify('dev.claudehub.mac.openTab.widgets');
  await sleep(6000); // previsão do tempo: busca real na Open-Meteo
  await shot('12-aba-widgets', 620);
  notify('dev.claudehub.mac.collapse');

  // Três agentes ao mesmo tempo: os eventos chegam pelo mesmo caminho que os
  // integradores usam (hook do Codex e plugin do OpenCode marcam hub_agent).
  for (const [id] of sessions) await endSession(id);
  const agents = [
    ['ag-claude', '/Users/dev/projetos/site', 'Claude Code: revisar o checkout', undefined],
    ['ag-codex', '/Users/dev/projetos/api', 'Codex: migrar rotas para v2', 'codex'],
    ['ag-open', '/Users/dev/projetos/painel', 'OpenCode: refatorar o painel', 'opencode'],
  ];
  for (const [id, cwd, title, agent] of agents) {
    const tag = agent ? { hub_agent: agent } : {};
    await hook(id, 'SessionStart', { cwd, source: 'startup', session_title: title, ...tag });
    await hook(id, 'UserPromptSubmit', { cwd, prompt: title, ...tag });
  }
  const listed = (await local('/api/sessions')).sessions ?? [];
  check(['claude-code', 'codex', 'opencode'].every((k) => listed.some((x) => x.agentKind === k)), 'hub lista sessões dos três agentes ao mesmo tempo');
  notify('dev.claudehub.mac.openTab.claude');
  await shot('13-tres-agentes', 620);
  notify('dev.claudehub.mac.collapse');
  const ctrl2 = new AbortController();
  const held2 = hook('ag-codex', 'PermissionRequest', { cwd: '/Users/dev/projetos/api', hub_agent: 'codex', tool_name: 'Bash', tool_input: { command: 'pnpm prisma migrate deploy' } }, ctrl2.signal).catch(() => null);
  await shot('14-pedido-do-codex', 360);
  ctrl2.abort();
  await held2;
  for (const [id] of agents) await endSession(id);

  // Consumo em repouso: amostra depois de a ilha assentar.
  await sleep(4000);
  const ps = sh('ps', ['-o', '%cpu=,rss=', '-p', String(appProc.pid)]).split(/\s+/).filter(Boolean);
  const cpu = Number(ps[0]);
  const rssMb = Math.round(Number(ps[1]) / 1024);
  console.log(`Consumo do app com 4 sessões ativas: CPU ${cpu}% · memória ${rssMb} MB`);

  check(appExit === null, 'app continua em execução depois de todos os estados');
  check((await local('/local/info')).macConnected === true, 'app continua conectado ao hub');

  if (process.env.SMOKE_PRINT_IMAGES === '1') {
    for (const name of shots) {
      const jpg = join(tmpdir(), `${name}.jpg`);
      sh('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '60', '--resampleWidth', '1200', join(outDir, `${name}.png`), '--out', jpg]);
      if (!existsSync(jpg)) continue;
      // Em pedaços: linhas muito longas são cortadas no log do CI.
      const parts = readFileSync(jpg).toString('base64').match(/.{1,40000}/g) ?? [];
      parts.forEach((part, i) => tail.push(`IMGPART:${name}:${i + 1}:${parts.length}:${part}`));
    }
  }
} catch (err) {
  check(false, `erro: ${err.message}`);
} finally {
  cleanup();
}

// Uma única escrita e só então encerra: process.exit() logo após console.log()
// corta o que ainda não saiu pelo pipe.
tail.push(failures.length === 0 ? '\nRESULTADO: OK' : `\nRESULTADO: FALHOU (${failures.length})`);
process.stdout.write(`${tail.join('\n')}\n`, () => process.exit(failures.length === 0 ? 0 : 1));
