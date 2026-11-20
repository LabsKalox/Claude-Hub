#!/usr/bin/env node
/**
 * Prova ponta a ponta com o Claude Code DE VERDADE (não roda no CI: precisa de
 * um Claude Code autenticado na máquina).
 *
 *   node tests/real/run-real-claude.mjs [allow|deny]
 *
 * 1. sobe o hub com diretório e portas temporários;
 * 2. instala os hooks num projeto temporário com a CLI do Claude Hub;
 * 3. roda `claude -p` pedindo um comando que exige permissão;
 * 4. pareia um "celular" e responde ao pedido pela porta do iPhone;
 * 5. confere se o Claude Code obedeceu e imprime o que o hub registrou.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const decision = process.argv[2] === 'deny' ? 'deny' : 'allow';
const work = mkdtempSync(join(tmpdir(), 'claude-hub-real-'));
const project = join(work, 'site');
mkdirSync(project, { recursive: true });
const localPort = 46000 + Math.floor(Math.random() * 500);
const publicPort = localPort + 1000;
const env = {
  ...process.env,
  CLAUDE_HUB_HOME: join(work, 'hub'),
  CLAUDE_HUB_LOCAL_PORT: String(localPort),
  CLAUDE_HUB_PUBLIC_PORT: String(publicPort),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const marker = `hub-${Date.now()}.txt`;

// Com CLAUDE_HUB_RUNTIME_DIR, usa o runtime empacotado (hub e CLI em arquivo único).
const runtime = process.env.CLAUDE_HUB_RUNTIME_DIR;
const hubEntry = runtime ? join(runtime, 'hub.mjs') : join(root, 'services/api/dist/main.js');
const cliEntry = runtime ? join(runtime, 'claude-hub.mjs') : join(root, 'packages/claude-bridge/dist/cli.js');
const hubProc = spawn(process.execPath, [hubEntry], { env, stdio: ['ignore', 'pipe', 'inherit'] });
let claudeProc = null;
const cleanup = () => {
  hubProc.kill('SIGTERM');
  claudeProc?.kill('SIGTERM');
};
process.on('exit', cleanup);

try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${localPort}/health`)).ok) break;
    } catch {
      await sleep(100);
    }
  }
  const cfg = JSON.parse(execFileSync('cat', [join(env.CLAUDE_HUB_HOME, 'config.json')], { encoding: 'utf8' }));
  const local = (path, init = {}) =>
    fetch(`http://127.0.0.1:${localPort}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${cfg.localToken}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    }).then((r) => r.json());

  console.log(execFileSync(process.execPath, [cliEntry, 'install', '--scope', 'project'], { env, cwd: project, encoding: 'utf8' }));

  // "Celular": pareia pela porta pública, como a PWA faz.
  const pairing = await local('/local/pairing', { method: 'POST', body: '{}' });
  const paired = await fetch(`http://127.0.0.1:${publicPort}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairing.code, deviceName: 'iPhone (teste real)' }),
  }).then((r) => r.json());
  const phone = (path, init = {}) =>
    fetch(`http://127.0.0.1:${publicPort}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${paired.deviceToken}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    });

  // Medição de consumo: liga pela CLI num settings.json à parte (para não mexer no do usuário) e
  // entrega ao Claude Code exatamente as variáveis que a preferência grava.
  const prefsDir = join(work, 'claude-config');
  mkdirSync(prefsDir, { recursive: true });
  const prefsOut = execFileSync(process.execPath, [cliEntry, 'prefs', 'set', 'consumption', 'on', '--json'], { env: { ...env, CLAUDE_CONFIG_DIR: prefsDir }, encoding: 'utf8' });
  const telemetryEnv = JSON.parse(execFileSync('cat', [join(prefsDir, 'settings.json')], { encoding: 'utf8' })).env;
  console.log(`Medição de consumo: ${JSON.parse(prefsOut.trim().split('\n').pop()).detail}`);
  Object.assign(env, telemetryEnv, { OTEL_METRIC_EXPORT_INTERVAL: '2000' });

  const prompt = `Run exactly this bash command and nothing else: touch ${marker}\nThen reply with one short sentence saying whether it worked.`;
  claudeProc = spawn('claude', ['-p', prompt, '--model', 'haiku', '--output-format', 'json'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  claudeProc.stdout.on('data', (c) => (out += c));
  const exited = new Promise((r) => claudeProc.on('exit', r));

  // Espera o pedido de permissão chegar ao celular e responde.
  let approval = null;
  const statuses = new Set();
  const deadline = Date.now() + 120_000;
  while (!approval && Date.now() < deadline) {
    const { approvals } = await phone('/api/approvals?status=pending').then((r) => r.json());
    const { sessions } = await phone('/api/sessions').then((r) => r.json());
    for (const s of sessions) statuses.add(s.status);
    approval = approvals[0] ?? null;
    if (!approval) await sleep(150);
  }
  if (!approval) throw new Error('nenhum pedido de permissão chegou ao hub');
  console.log(`Pedido recebido no celular: "${approval.command}" (${approval.toolName}, projeto ${approval.projectName})`);
  const { sessions: during } = await phone('/api/sessions').then((r) => r.json());
  console.log(`Estado da sessão enquanto espera: ${during[0]?.status}`);
  const res = await phone(`/api/approvals/${approval.id}/decision`, { method: 'POST', body: JSON.stringify({ decision }) });
  console.log(`Decisão enviada pelo celular: ${decision} → HTTP ${res.status}`);

  await Promise.race([exited, sleep(120_000)]);
  await sleep(300);
  let reply = '';
  try {
    reply = JSON.parse(out).result ?? '';
  } catch {
    reply = out.slice(0, 300);
  }
  const created = existsSync(join(project, marker));
  const events = (await local('/api/events?limit=50')).events.reverse();
  const audit = (await local('/api/audit?limit=20')).entries.reverse();
  const verify = await local('/local/audit/verify');

  console.log(`\nResposta do Claude: ${reply}`);
  console.log(`Arquivo criado pelo comando: ${created ? 'sim' : 'não'}`);
  console.log('\nEventos registrados pelo hub:');
  for (const e of events) console.log(`  ${e.type.padEnd(18)} ${e.summary}`);
  console.log('\nAuditoria:');
  for (const a of audit) console.log(`  ${a.actor.padEnd(16)} ${a.action.padEnd(22)} ${a.detail}`);
  console.log(`  cadeia íntegra: ${verify.ok ? 'sim' : 'NÃO'} (${verify.entries} registros)`);

  // Consumo informado pelo próprio Claude Code (OpenTelemetry) → hub.
  let consumption = null;
  for (let i = 0; i < 40; i++) {
    consumption = (await local('/api/usage')).usage.consumption;
    if (consumption?.updatedAt) break;
    await sleep(250);
  }
  const tokensOk = Boolean(consumption?.updatedAt) && consumption.outputTokens > 0 && consumption.byModel.length > 0;
  console.log('\nConsumo medido pelo hub:');
  console.log(`  entrada ${consumption?.inputTokens} · saída ${consumption?.outputTokens} · cache lido ${consumption?.cacheReadTokens} · cache criado ${consumption?.cacheCreationTokens}`);
  console.log(`  custo estimado pelo Claude Code: US$ ${consumption?.costUsd?.toFixed(4)} · modelos: ${consumption?.byModel.map((m) => m.model).join(', ')}`);
  let reported = null;
  try {
    reported = JSON.parse(out);
  } catch {
    /* sem JSON de saída */
  }
  if (reported?.total_cost_usd !== undefined) {
    const same = Math.abs(reported.total_cost_usd - (consumption?.costUsd ?? -1)) < 1e-6;
    console.log(`  custo que o Claude Code imprimiu na saída: US$ ${reported.total_cost_usd.toFixed(4)} → ${same ? 'igual ao medido' : 'DIFERENTE do medido'}`);
  }
  console.log(`  ${tokensOk ? '✓' : '✗'} tokens e custo de uma sessão real chegaram ao hub`);

  const ok = (decision === 'allow' ? created : !created) && tokensOk;
  console.log(`\nRESULTADO: ${ok ? 'OK' : 'FALHOU'} — decisão "${decision}" ${ok ? 'foi obedecida' : 'NÃO foi obedecida'} pelo Claude Code.`);
  writeFileSync(join(work, 'result.json'), JSON.stringify({ decision, created, reply, events, audit }, null, 2));
  process.exitCode = ok ? 0 : 1;
} catch (err) {
  console.error(`ERRO: ${err.message}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
