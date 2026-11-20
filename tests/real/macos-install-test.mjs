#!/usr/bin/env node
/**
 * Teste de INSTALAÇÃO do Claude Hub num Mac Apple Silicon (runner do CI ou o seu Mac).
 *
 *   node tests/real/macos-install-test.mjs apps/macos/build/ClaudeHub-<versão>-arm64.dmg
 *
 * Faz o que uma pessoa faria, usando apenas o que vem dentro do .dmg:
 * monta a imagem, copia o app para /Applications, roda o assistente de
 * configuração (serviço launchd + hooks, preservando o settings.json que já
 * existia), executa a verificação de saúde, dispara os hooks exatamente como
 * foram gravados, pareia um "celular", abre o app e, no fim, desinstala.
 *
 * ATENÇÃO: mexe em /Applications/ClaudeHub.app, ~/Library/LaunchAgents,
 * ~/.claude/settings.json e ~/.claude-hub. No seu Mac, só rode se for essa a
 * intenção; o settings.json original é restaurado ao final.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error('Este teste só roda em macOS Apple Silicon.');
  process.exit(1);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const dmg = resolve(process.argv[2] ?? '');
if (!existsSync(dmg) || !dmg.endsWith('.dmg')) {
  console.error('Informe o caminho do .dmg.');
  process.exit(1);
}

const APP = '/Applications/ClaudeHub.app';
const RUNTIME = join(APP, 'Contents/Resources/runtime');
const CLI = join(RUNTIME, 'bin/claude-hub');
const home = homedir();
const settingsPath = join(home, '.claude/settings.json');
const plistPath = join(home, 'Library/LaunchAgents/dev.claudehub.hub.plist');
const outDir = join(root, 'docs/screenshots/macos');
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (ok, text, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${text}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures.push(text);
  return ok;
};
/** Roda um comando; `out` junta stdout e stderr (o codesign, por exemplo, escreve no stderr). */
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000, ...opts });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return { ok: r.status === 0, out: out || (r.error ? r.error.message : ''), stdout: (r.stdout ?? '').trim() };
};
/** Roda a CLI embutida no app e devolve o JSON. */
const cli = (args, env = {}) => {
  const r = sh(CLI, [...args, '--json'], { env: { ...process.env, ...env } });
  try {
    return JSON.parse(r.stdout.split('\n').filter(Boolean).pop());
  } catch {
    return { ok: false, detail: `saída inesperada da CLI: ${r.out.slice(0, 300)}` };
  }
};
const section = (title) => console.log(`\n── ${title}`);

// O settings.json de quem roda o teste: guarda para restaurar no fim.
const hadSettings = existsSync(settingsPath);
const originalSettings = hadSettings ? readFileSync(settingsPath, 'utf8') : null;
const userSettings = {
  model: 'opus',
  permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm -rf:*)'] },
  env: { MINHA_VARIAVEL: 'continua-aqui' },
  statusLine: { type: 'command', command: 'echo minha-linha-de-status', padding: 1 },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hook-do-usuario' }] }] },
};
const shots = [];
let mount = null;

try {
  // ───────────────────────── 1. O instalador ─────────────────────────
  section('1. Instalador (.dmg)');
  console.log(`${sh('sw_vers', ['-productVersion']).out} · ${sh('uname', ['-m']).out} · ${sh('sysctl', ['-n', 'machdep.cpu.brand_string']).out}`);
  const attach = sh('hdiutil', ['attach', '-nobrowse', '-readonly', dmg]);
  mount = attach.out.split('\n').map((l) => /(\/Volumes\/.+)$/.exec(l)?.[1]).filter(Boolean).pop() ?? null;
  check(attach.ok && Boolean(mount), 'a imagem monta', mount ?? attach.out);
  if (!mount) throw new Error('não consegui montar o .dmg');
  check(existsSync(join(mount, 'ClaudeHub.app/Contents/MacOS/ClaudeHub')), 'contém o ClaudeHub.app');
  check(sh('readlink', [join(mount, 'Applications')]).out === '/Applications', 'contém o atalho para a pasta Aplicativos');

  // Recusa de configurar a partir da própria imagem (fora de /Applications).
  const fromDmg = sh(join(mount, 'ClaudeHub.app/Contents/Resources/runtime/bin/claude-hub'), ['setup', 'run', '--json']);
  let refused = null;
  try {
    refused = JSON.parse(fromDmg.stdout.split('\n').filter(Boolean).pop());
  } catch {
    /* tratado abaixo */
  }
  check(refused?.ok === false && refused.steps?.[0]?.id === 'location' && refused.steps[0].ok === false, 'aberto de dentro do .dmg, o assistente se recusa a configurar', refused?.steps?.[0]?.detail ?? fromDmg.out.slice(0, 200));
  check(!existsSync(plistPath), 'e não instalou nenhum serviço');

  sh('pkill', ['-x', 'ClaudeHub']);
  rmSync(APP, { recursive: true, force: true });
  const copy = sh('ditto', [join(mount, 'ClaudeHub.app'), APP]);
  check(copy.ok && existsSync(CLI), 'copiado para /Applications', copy.ok ? '' : copy.out);
  sh('hdiutil', ['detach', mount]);
  mount = null;
  console.log(`  versão instalada: ${readFileSync(join(RUNTIME, 'VERSION'), 'utf8').trim()}`);

  // ───────────────────────── 2. O que foi instalado ─────────────────────────
  section('2. Conteúdo do app');
  const archApp = sh('lipo', ['-archs', join(APP, 'Contents/MacOS/ClaudeHub')]).out;
  const archNode = sh('lipo', ['-archs', join(RUNTIME, 'bin/node')]).out;
  check(archApp.includes('arm64') && archNode === 'arm64', 'binários para Apple Silicon', `app: ${archApp} · Node: ${archNode}`);
  const verify = sh('codesign', ['--verify', '--deep', '--strict', '--verbose=2', APP]);
  check(verify.ok, 'assinatura do app íntegra (codesign --verify --deep --strict)', verify.ok ? '' : verify.out);
  const nodeSig = sh('codesign', ['-dv', '--verbose=2', join(RUNTIME, 'bin/node')]).out;
  check(sh('codesign', ['--verify', '--strict', join(RUNTIME, 'bin/node')]).ok, 'Node embutido com a assinatura original intacta', (/Authority=(.+)/.exec(nodeSig)?.[1] ?? '').trim());
  for (const f of ['hub.mjs', 'claude-hub.mjs', 'claude-hub-hook.mjs', 'web/index.html', 'web/sw.js', 'licenses/node-LICENSE.txt']) {
    if (!existsSync(join(RUNTIME, f))) check(false, `falta ${f} no runtime`);
  }
  const appSig = sh('codesign', ['-dv', '--verbose=2', APP]).out;
  console.log(`  assinatura do app: ${(/Signature=(.+)/.exec(appSig)?.[1] ?? /Authority=(.+)/.exec(appSig)?.[1] ?? '?').trim()}`);
  const gate = sh('spctl', ['--assess', '--type', 'execute', '--verbose=2', APP]);
  console.log(`  Gatekeeper (spctl --assess, só leitura): ${gate.out.replace(/\n/g, ' | ')}`);
  console.log('  → informativo: um build sem notarização é rejeitado para download; este teste não altera isso.');

  // ───────────────────────── 3. Estado inicial ─────────────────────────
  section('3. Antes de configurar');
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(userSettings, null, 2)}\n`);
  const before = cli(['setup', 'status']);
  check(before.runtime?.bundled === true && before.runtime?.inApplications === true && before.runtime?.translocated === false, 'o app se reconhece instalado em /Applications com runtime embutido', `Node ${before.runtime?.nodeVersion}`);
  check(before.service?.installed === false && before.hooks?.installed === false && before.ready === false, 'nada configurado ainda');
  check(before.claude?.found === true, 'Claude Code detectado', before.claude?.found ? `${before.claude.version} em ${before.claude.path}` : 'não encontrado');
  check(before.claude?.otherHooks === 1, 'enxerga o hook que já era do usuário');

  // ───────────────────────── 4. Configuração ─────────────────────────
  section('4. Assistente de configuração (setup run)');
  const run = cli(['setup', 'run']);
  for (const s of run.steps ?? []) console.log(`  ${s.ok ? '✓' : '✗'} ${s.title} — ${s.detail}`);
  check(run.ok === true, 'configuração concluída', run.detail ?? '');
  const lc = sh('launchctl', ['print', `gui/${process.getuid()}/dev.claudehub.hub`]);
  check(lc.ok && /state = running/.test(lc.out), 'serviço launchd carregado e em execução', (/state = (\w+)/.exec(lc.out)?.[0] ?? lc.out.slice(0, 120)));
  const plist = existsSync(plistPath) ? readFileSync(plistPath, 'utf8') : '';
  check(plist.includes(`${RUNTIME}/bin/node`) && plist.includes(`${RUNTIME}/hub.mjs`) && !/\/bin\/(ba|z)?sh/.test(plist), 'o serviço executa só o Node embutido com o hub (sem shell)');
  check(/program = .*\/runtime\/bin\/node/.test(lc.out) || lc.out.includes(`${RUNTIME}/bin/node`), 'o processo do serviço é o Node de dentro do app');

  const cfg = JSON.parse(readFileSync(join(home, '.claude-hub/config.json'), 'utf8'));
  const base = `http://127.0.0.1:${cfg.localPort}`;
  const health = await fetch(`${base}/health`).then((r) => r.json()).catch(() => null);
  check(health?.ok === true, 'hub respondendo pelo serviço', health ? `v${health.version}` : 'sem resposta');
  const mode = sh('stat', ['-f', '%Lp', join(home, '.claude-hub/config.json')]).out;
  check(mode === '600', 'arquivo de segredos com permissão 600', mode);

  const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
  check(after.model === 'opus' && JSON.stringify(after.permissions) === JSON.stringify(userSettings.permissions), 'modelo e permissões do usuário intactos');
  check(JSON.stringify(after.hooks.PreToolUse[0]) === JSON.stringify(userSettings.hooks.PreToolUse[0]), 'hook do usuário preservado, no mesmo lugar');
  const text = JSON.stringify(after);
  check(!/bypassPermissions|dangerously|defaultMode|onFailure/.test(text), 'nenhuma permissão ampla ou modo de permissão foi acrescentado');
  const backups = readdirSync(dirname(settingsPath)).filter((f) => f.startsWith('settings.json.claude-hub-') && f.endsWith('.bak'));
  check(backups.length === 1 && JSON.stringify(JSON.parse(readFileSync(join(dirname(settingsPath), backups[0]), 'utf8'))) === JSON.stringify(userSettings), 'backup do settings.json original gravado', backups[0] ?? '');
  const status = cli(['setup', 'status']);
  check(status.ready === true && status.hooks?.current === true && status.service?.current === true, 'estado final: pronto');
  const pidBefore = /pid = (\d+)/.exec(sh('launchctl', ['print', `gui/${process.getuid()}/dev.claudehub.hub`]).out)?.[1];
  const again = cli(['setup', 'run']);
  const pidAfter = /pid = (\d+)/.exec(sh('launchctl', ['print', `gui/${process.getuid()}/dev.claudehub.hub`]).out)?.[1];
  check(again.ok === true && readFileSync(settingsPath, 'utf8') === `${JSON.stringify(after, null, 2)}\n`, 'rodar o assistente de novo não muda nada (idempotente)', again.ok ? '' : JSON.stringify(again.steps ?? again).slice(0, 300));
  check(Boolean(pidBefore) && pidBefore === pidAfter, 'e não reinicia um hub que está saudável', `pid ${pidBefore} → ${pidAfter}`);
  // "Reparar"/atualização: reinstalar o serviço três vezes seguidas tem de deixar o hub no ar todas as vezes.
  let repairs = 0;
  for (let i = 0; i < 3; i++) {
    const r = cli(['service', 'install']);
    let up = false;
    for (let t = 0; t < 60 && !up; t++) {
      up = Boolean(await fetch(`${base}/health`).then((x) => x.ok).catch(() => false));
      if (!up) await sleep(250);
    }
    if (r.ok && up) repairs++;
    else console.log(`  reinstalação ${i + 1}: ${JSON.stringify(r)} · hub no ar: ${up}`);
  }
  check(repairs === 3, 'reinstalar o serviço repetidamente mantém o hub no ar', `${repairs}/3`);

  // ───────────────────────── 5. Saúde ─────────────────────────
  section('5. Verificação de saúde (selftest)');
  const health1 = cli(['selftest']);
  for (const c of health1.checks ?? []) console.log(`  ${c.ok ? '✓' : c.optional ? '·' : '✗'} ${c.title} — ${c.detail} (${c.ms} ms)`);
  check(health1.ok === true, 'todos os itens obrigatórios passaram');
  check(health1.checks?.find((c) => c.id === 'real-event')?.ok === false, 'e ele avisa que ainda não chegou nenhum evento real');

  // ───────────────────────── 6. Hooks como o Claude Code os dispara ─────────────────────────
  section('6. Hooks gravados no settings.json, disparados como o Claude Code faz');
  const local = (path, init = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${cfg.localToken}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } }).then((r) => r.json());
  const sid = `instalacao-${Date.now()}`;
  const payload = (event, extra = {}) => JSON.stringify({ session_id: sid, cwd: join(home, 'projetos/site'), hook_event_name: event, ...extra });
  // SessionStart é um hook de COMANDO: executa a linha de comando gravada, com o JSON no stdin.
  const startCmd = after.hooks.SessionStart.flatMap((g) => g.hooks).find((h) => h.type === 'command' && h.command.includes('claude-hub-hook')).command;
  const started = sh('/bin/sh', ['-c', startCmd], { input: payload('SessionStart', { source: 'startup', session_title: 'Teste de instalação' }), env: { ...process.env, __CFBundleIdentifier: 'com.apple.Terminal' } });
  check(started.ok, 'hook de comando (SessionStart) executa com o Node embutido', started.ok ? '' : started.out);
  // Os demais são hooks HTTP: usa a URL e o cabeçalho exatamente como estão no arquivo.
  const httpHook = (event) => after.hooks[event].flatMap((g) => g.hooks).find((h) => h.type === 'http' && h.url.includes('/hooks/claude-code'));
  const post = (event, extra, signal) => {
    const h = httpHook(event);
    return fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json', ...h.headers }, body: payload(event, extra), signal });
  };
  await post('UserPromptSubmit', { prompt: 'Rodar o build do site' });
  let sessions = (await local('/api/sessions')).sessions;
  const mine = () => sessions.find((s) => s.id === sid);
  check(mine()?.status === 'WORKING' && mine()?.title === 'Teste de instalação', 'sessão aparece no hub como "Trabalhando"', mine() ? `${mine().projectName} · ${mine().title}` : 'ausente');
  check(mine()?.hostApp === 'com.apple.Terminal', 'o hub sabe qual terminal hospeda a sessão', mine()?.hostApp ?? '');

  const held = post('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm run build' } });
  let approval = null;
  for (let i = 0; i < 40 && !approval; i++) {
    approval = (await local('/api/approvals?status=pending')).approvals.find((a) => a.sessionId === sid) ?? null;
    if (!approval) await sleep(100);
  }
  check(Boolean(approval) && approval.command === 'npm run build', 'pedido de permissão fica retido à espera de decisão', approval?.command ?? 'não chegou');
  // Decisão tomada por um dispositivo pareado, pela porta do iPhone.
  const pairing = await local('/local/pairing', { method: 'POST', body: JSON.stringify({ baseUrl: 'https://mac-de-teste.exemplo.ts.net' }) });
  check(/^https:\/\/mac-de-teste\.exemplo\.ts\.net\/pair\/\?code=[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(pairing.url ?? ''), 'link do QR de pareamento gerado', pairing.url ?? '');
  const pub = `http://127.0.0.1:${cfg.publicPort}`;
  const pairHtml = await fetch(`${pub}/pair/?code=${pairing.code}`).then((r) => r.text());
  check(pairHtml.includes(`/manifest.webmanifest?pair=${pairing.code}`), 'a página do QR entrega o manifesto com o código (app instalado abre já pareando)');
  const unauth = await fetch(`${pub}/api/sessions`);
  check(unauth.status === 401, 'porta do iPhone exige autenticação', `HTTP ${unauth.status}`);
  const paired = await fetch(`${pub}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code, deviceName: 'iPhone (teste de instalação)' }) }).then((r) => r.json());
  check(typeof paired.deviceToken === 'string', 'celular pareado com o código do QR');
  const reuse = await fetch(`${pub}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code, deviceName: 'outro' }) });
  check(reuse.status === 401, 'o mesmo código não pareia um segundo aparelho', `HTTP ${reuse.status}`);
  if (approval && paired.deviceToken) {
    const decide = await fetch(`${pub}/api/approvals/${approval.id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${paired.deviceToken}` }, body: JSON.stringify({ decision: 'deny' }) });
    const out = await (await held).json();
    check(decide.status === 200 && out.hookSpecificOutput?.decision?.behavior === 'deny', 'decisão do celular chega ao hook no formato do Claude Code', JSON.stringify(out.hookSpecificOutput?.decision ?? {}));
  }
  // Permitir: a mesma coisa, com a outra resposta — e a sessão volta a trabalhar.
  const phone = (path, init = {}) =>
    fetch(`${pub}${path}`, { ...init, headers: { authorization: `Bearer ${paired.deviceToken}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  const heldAllow = post('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
  let second = null;
  for (let i = 0; i < 40 && !second; i++) {
    second = (await local('/api/approvals?status=pending')).approvals.find((a) => a.sessionId === sid) ?? null;
    if (!second) await sleep(100);
  }
  check(second?.command === 'npm test' && second.id !== approval?.id, 'segundo pedido chega como um pedido novo', second?.command ?? 'não chegou');
  if (second) {
    const wrong = await phone(`/api/approvals/${approval.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'allow' }) });
    check(wrong.status === 409, 'permitir o pedido ANTERIOR (já negado) é recusado', `HTTP ${wrong.status}`);
    const ok = await phone(`/api/approvals/${second.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'allow' }) });
    const outAllow = await (await heldAllow).json();
    check(ok.status === 200 && JSON.stringify(outAllow.hookSpecificOutput?.decision) === '{"behavior":"allow"}', 'permitir pelo celular devolve exatamente {"behavior":"allow"} ao hook', JSON.stringify(outAllow.hookSpecificOutput?.decision ?? {}));
    const dup = await phone(`/api/approvals/${second.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'deny' }) });
    check(dup.status === 409, 'mudar de ideia depois de decidir é recusado', `HTTP ${dup.status}`);
    sessions = (await local('/api/sessions')).sessions;
    check(mine()?.status === 'WORKING', 'depois de permitir, a sessão volta a "Trabalhando"', mine()?.status ?? '');
  }
  // Pedido sem resposta: quando o Claude Code desiste (respondido no terminal), some da fila.
  const ctrl = new AbortController();
  const abandoned = post('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm run lint' } }, ctrl.signal).catch(() => null);
  let third = null;
  for (let i = 0; i < 40 && !third; i++) {
    third = (await local('/api/approvals?status=pending')).approvals.find((a) => a.sessionId === sid) ?? null;
    if (!third) await sleep(100);
  }
  ctrl.abort();
  await abandoned;
  let cancelled = false;
  for (let i = 0; i < 40 && third && !cancelled; i++) {
    cancelled = (await local(`/api/approvals/${third.id}`)).approval?.status === 'cancelled';
    if (!cancelled) await sleep(100);
  }
  check(cancelled, 'pedido respondido no terminal é cancelado no hub e não pode mais ser aprovado');
  // Um aparelho revogado perde o poder de decidir na hora.
  const extra = await local('/local/pairing', { method: 'POST', body: '{}' });
  const intruder = await fetch(`${pub}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: extra.code, deviceName: 'aparelho a revogar' }) }).then((r) => r.json());
  const devicesNow = (await local('/local/devices')).devices;
  const toRevoke = devicesNow.find((d) => d.name === 'aparelho a revogar');
  await local(`/local/devices/${toRevoke?.id}`, { method: 'DELETE' });
  const afterRevoke = await fetch(`${pub}/api/approvals`, { headers: { authorization: `Bearer ${intruder.deviceToken}` } });
  check(afterRevoke.status === 401, 'aparelho revogado não acessa mais nada', `HTTP ${afterRevoke.status}`);

  await post('Stop', { last_assistant_message: 'Build concluído.' });
  sessions = (await local('/api/sessions')).sessions;
  check(mine()?.status === 'COMPLETED', 'sessão termina como "Terminou"');
  const health2 = cli(['selftest']);
  check(health2.checks?.find((c) => c.id === 'real-event')?.ok === true, 'a verificação de saúde agora reconhece o evento recebido', health2.checks?.find((c) => c.id === 'real-event')?.detail ?? '');
  const audit = await local('/local/audit/verify');
  check(audit.ok === true, 'auditoria íntegra', `${audit.entries} registros`);

  // ───────────────────────── 7. O serviço se recupera ─────────────────────────
  section('7. Resiliência do serviço');
  const pidOf = () => /pid = (\d+)/.exec(sh('launchctl', ['print', `gui/${process.getuid()}/dev.claudehub.hub`]).out)?.[1] ?? null;
  const pid = pidOf();
  if (pid) sh('kill', ['-9', pid]);
  let back = false;
  for (let i = 0; i < 100 && !back; i++) {
    await sleep(300);
    back = Boolean(await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) && pidOf() !== pid;
  }
  check(back, 'hub morto à força volta sozinho (KeepAlive)', `pid ${pid} → ${pidOf()}`);
  const kept = (await local('/api/sessions')).sessions.find((s) => s.id === sid);
  check(kept?.status === 'COMPLETED', 'e as sessões sobrevivem ao reinício (SQLite)');

  // ───────────────────────── 8. O app instalado ─────────────────────────
  section('8. App aberto a partir de /Applications');
  spawn('swift', [join(root, 'tests/real/backdrop.swift')], { stdio: 'ignore', detached: true }).unref();
  const opened = sh('open', [APP]);
  check(opened.ok, 'abre pelo LaunchServices (como um duplo clique)', opened.ok ? '' : opened.out);
  let connected = false;
  for (let i = 0; i < 100 && !connected; i++) {
    connected = (await local('/local/info')).macConnected === true;
    if (!connected) await sleep(300);
  }
  check(connected, 'app conectou ao hub do serviço');
  const notify = (name) => sh('swift', ['-e', `import Foundation; DistributedNotificationCenter.default().postNotificationName(Notification.Name("${name}"), object: nil, userInfo: nil, deliverImmediately: true)`]);
  const shot = async (name, wait) => {
    await sleep(wait);
    const file = join(outDir, `${name}.png`);
    sh('screencapture', ['-x', file]);
    if (check(existsSync(file), `captura ${name}`)) shots.push(name);
  };
  notify('dev.claudehub.mac.openSetup');
  await shot('07-assistente-de-configuracao', 5000);
  notify('dev.claudehub.mac.runSelfTest');
  await shot('08-verificacao-de-saude', 7000);
  notify('dev.claudehub.mac.closeSetup');
  check(sh('pgrep', ['-x', 'ClaudeHub']).ok, 'app continua em execução');

  // ───────────────────────── 8b. A ilha abre sozinha com o Claude Code ─────────────────────────
  section('8b. Abertura automática ao iniciar uma sessão do Claude Code');
  const owners = () => sh('swift', [join(root, 'tests/real/window-owners.swift')], { timeout: 90_000 }).stdout.split('\n').pop() ?? '';
  const instances = () => sh('pgrep', ['-x', 'ClaudeHub']).stdout.split('\n').filter(Boolean).length;
  sh('pkill', ['-x', 'ClaudeHub']);
  await sleep(1500);
  check(instances() === 0, 'ponto de partida: a ilha está fechada');
  const startHook = (id) => sh('/bin/sh', ['-c', startCmd], { input: JSON.stringify({ session_id: id, cwd: join(home, 'projetos/site'), hook_event_name: 'SessionStart', source: 'startup' }) });
  const hookRun = startHook(`auto-${Date.now()}`);
  check(hookRun.ok, 'o hook de SessionStart termina sem erro e sem esperar o app abrir');
  let appeared = false;
  for (let i = 0; i < 40 && !appeared; i++) {
    await sleep(500);
    appeared = instances() > 0;
  }
  await sleep(2500);
  check(appeared && owners().split(',').some((o) => /^Claude ?Hub$/.test(o.trim())), 'a ilha abriu sozinha quando a sessão começou', `janelas: ${owners()}`);
  startHook(`auto2-${Date.now()}`);
  startHook(`auto3-${Date.now()}`);
  sh('open', [APP]);
  await sleep(2500);
  check(instances() === 1, 'novas sessões e um novo duplo clique não criam uma segunda ilha', `${instances()} instância(s)`);
  // Preferência desligada: a ilha fica fechada.
  const off = cli(['prefs', 'set', 'autoOpenIsland', 'off']);
  sh('pkill', ['-x', 'ClaudeHub']);
  await sleep(1500);
  startHook(`auto4-${Date.now()}`);
  await sleep(5000);
  check(off.ok === true && instances() === 0, 'com a preferência desligada, a ilha não abre sozinha');
  check(cli(['prefs', 'set', 'autoOpenIsland', 'on']).prefs?.autoOpenIsland === true, 'preferência religada');

  // ───────────────────────── 8c. Consumo e limites ─────────────────────────
  section('8c. Consumo e limites (preferências que tocam no settings.json)');
  const beforePrefs = readFileSync(settingsPath, 'utf8');
  const onC = cli(['prefs', 'set', 'consumption', 'on']);
  console.log(`  ${onC.detail}`);
  const withC = JSON.parse(readFileSync(settingsPath, 'utf8'));
  check(onC.ok === true && withC.env?.MINHA_VARIAVEL === 'continua-aqui' && /^http:\/\/127\.0\.0\.1:\d+\/otel\/v1\/metrics$/.test(withC.env?.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? ''), 'medição ligada: variáveis acrescentadas, apontando só para o hub local; a variável do usuário continua');
  // Envia métricas reais (capturadas do Claude Code 2.1.329) para o endereço e com o cabeçalho gravados no arquivo.
  const [headerName, headerValue] = decodeURIComponent(withC.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS).split(/=(.*)/s);
  for (const line of readFileSync(join(root, 'tests/fixtures/otel-metrics-claude-code-2.1.329.jsonl'), 'utf8').trim().split('\n')) {
    await fetch(withC.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', [headerName]: headerValue }, body: line });
  }
  const onL = cli(['prefs', 'set', 'limits', 'on']);
  console.log(`  ${onL.detail}`);
  const withL = JSON.parse(readFileSync(settingsPath, 'utf8'));
  check(onL.ok === true && withL.statusLine?.padding === 1 && withL.statusLine?.command?.includes('claude-hub-statusline.mjs'), 'leitura de limites ligada: a linha de status passa pela ponte, mantendo as opções do usuário');
  // Roda a linha de status como o Claude Code faz: o comando gravado, com o JSON no stdin.
  const statusSample = JSON.parse(readFileSync(join(root, 'tests/fixtures/statusline-input-docs.json'), 'utf8'));
  const nowSec = Math.floor(Date.now() / 1000);
  statusSample.rate_limits = { five_hour: { used_percentage: 23.5, resets_at: nowSec + 3 * 3600 }, seven_day: { used_percentage: 41.2, resets_at: nowSec + 4 * 86400 } };
  const line = sh('/bin/sh', ['-c', withL.statusLine.command], { input: JSON.stringify(statusSample) });
  check(line.ok && line.stdout === 'minha-linha-de-status', 'a linha de status do usuário continua aparecendo, igual', JSON.stringify(line.stdout));
  const usageNow = (await local('/api/usage')).usage;
  check(usageNow.consumption?.enabled === true && usageNow.consumption.outputTokens === 4 && usageNow.consumption.byModel?.[0]?.model === 'claude-haiku-5-5', 'o hub mostra o consumo recebido', `entrada ${usageNow.consumption?.inputTokens} · saída ${usageNow.consumption?.outputTokens} · US$ ${usageNow.consumption?.costUsd?.toFixed(4)}`);
  check(usageNow.limits?.enabled === true && usageNow.limits.windows?.length === 2 && usageNow.limits.windows[0].usedPercent === 23.5 && usageNow.limits.windows[0].resetsAt === (nowSec + 3 * 3600) * 1000, 'o hub mostra os limites exatamente como informados', usageNow.limits?.windows?.map((w) => `${w.label} ${w.usedPercent}%`).join(' · '));
  const offL = cli(['prefs', 'set', 'limits', 'off']);
  const offC = cli(['prefs', 'set', 'consumption', 'off']);
  check(offL.ok && offC.ok && readFileSync(settingsPath, 'utf8') === beforePrefs, 'desligar as duas devolve o settings.json byte a byte');
  cli(['prefs', 'set', 'consumption', 'on']);
  cli(['prefs', 'set', 'limits', 'on']);
  console.log('  (religadas, para a desinstalação provar que desfaz tudo)');

  // ───────────────────────── 8d. Tailscale visto de dentro do app ─────────────────────────
  section('8d. Detecção do Tailscale do jeito que o app e o serviço chamam (sem shell)');
  // O app e o launchd executam o Node embutido direto, sem shell: não existe SHLVL.
  // O binário de dentro do Tailscale.app, chamado assim, só age como CLI com
  // TAILSCALE_BE_CLI=1; sem ela imprime um erro de interface e sai com código 0.
  // Este Tailscale de mentira se comporta igual. (O atalho bin/claude-hub passa por
  // /bin/sh e esconderia o problema — por isso aqui o Node é chamado direto.)
  const tsDir = mkdtempSync(join(tmpdir(), 'claude-hub-ts-'));
  const fakeTailscale = (certDomains) => {
    const path = join(tsDir, 'Tailscale');
    writeFileSync(
      path,
      `#!/bin/sh
if [ "$TAILSCALE_BE_CLI" != "1" ]; then echo "The Tailscale GUI failed to start: The operation couldn’t be completed. (Tailscale.CLIError error 3.)"; exit 0; fi
if [ "$1" = "status" ]; then echo '{"BackendState":"Running","Self":{"DNSName":"mac-de-teste.exemplo.ts.net."},"CertDomains":${certDomains}}'; exit 0; fi
if [ "$1" = "serve" ] && [ "$2" = "status" ]; then echo '{}'; exit 0; fi
echo "serve-chamado" >> "${tsDir}/chamadas.log"; exit 1
`,
    );
    chmodSync(path, 0o755);
    return path;
  };
  const asApp = (args, tailscalePath) => {
    const r = spawnSync(join(RUNTIME, 'bin/node'), [join(RUNTIME, 'claude-hub.mjs'), ...args, '--json'], {
      encoding: 'utf8',
      timeout: 120_000,
      env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', NODE_NO_WARNINGS: '1', CLAUDE_HUB_TAILSCALE_PATH: tailscalePath },
    });
    try {
      return JSON.parse((r.stdout ?? '').trim().split('\n').filter(Boolean).pop());
    } catch {
      return { ok: false, detail: `saída inesperada: ${`${r.stdout ?? ''}${r.stderr ?? ''}`.slice(0, 300)}` };
    }
  };
  const seen = asApp(['setup', 'status'], fakeTailscale('["mac-de-teste.exemplo.ts.net"]')).tunnel;
  check(seen?.tailscale === 'running' && seen.dnsName === 'mac-de-teste.exemplo.ts.net' && seen.httpsEnabled === true, 'sem shell em volta, o Tailscale conectado é reconhecido como conectado', JSON.stringify(seen));
  const noHttps = asApp(['setup', 'status'], fakeTailscale('null')).tunnel;
  check(noHttps?.tailscale === 'running' && noHttps.httpsEnabled === false, 'HTTPS desativado na rede Tailscale é percebido antes de publicar', JSON.stringify(noHttps));
  const tunnelRefused = asApp(['tunnel', 'enable'], fakeTailscale('null'));
  check(tunnelRefused.ok === false && /HTTPS Certificates/.test(tunnelRefused.detail ?? '') && !existsSync(join(tsDir, 'chamadas.log')), 'e "Ativar acesso pelo iPhone" explica o passo, sem tentar publicar', tunnelRefused.detail);
  const garbage = join(tsDir, 'Mudo');
  writeFileSync(garbage, '#!/bin/sh\necho "The Tailscale GUI failed to start: (Tailscale.CLIError error 3.)"\nexit 0\n');
  chmodSync(garbage, 0o755);
  const unreadable = asApp(['setup', 'status'], garbage).tunnel;
  check(unreadable?.tailscale === 'unknown' && /GUI failed to start/.test(unreadable.detail ?? ''), 'resposta que não é o estado em JSON vira "não consegui ler", com o texto real — não "desconectado"', JSON.stringify(unreadable));
  rmSync(tsDir, { recursive: true, force: true });

  // ───────────────────────── 8e. Notificações ─────────────────────────
  section('8e. Notificações: subject VAPID, estado e diagnóstico');
  const hubCfgPath = join(home, '.claude-hub/config.json');
  const vapidBefore = JSON.parse(readFileSync(hubCfgPath, 'utf8')).vapid;
  // Quem vem de uma versão antiga tem um subject local, que a Apple recusa (403 BadJwtToken).
  const legacyCfg = JSON.parse(readFileSync(hubCfgPath, 'utf8'));
  legacyCfg.vapid.subject = 'mailto:claude-hub@localhost.localdomain';
  writeFileSync(hubCfgPath, `${JSON.stringify(legacyCfg, null, 2)}\n`, { mode: 0o600 });
  cli(['service', 'restart']);
  let migrated = null;
  for (let t = 0; t < 80; t++) {
    await sleep(250);
    const up = await fetch(`${base}/health`).then((x) => x.ok).catch(() => false);
    migrated = JSON.parse(readFileSync(hubCfgPath, 'utf8')).vapid;
    if (up && migrated.subject !== legacyCfg.vapid.subject) break;
  }
  check(
    migrated.subject !== legacyCfg.vapid.subject && !/localhost|\.local/.test(migrated.subject) && migrated.publicKey === vapidBefore.publicKey && migrated.privateKey === vapidBefore.privateKey,
    'subject antigo é trocado ao subir; as chaves ficam (inscrições existentes continuam valendo)',
    `${legacyCfg.vapid.subject} → ${migrated.subject}`,
  );
  const pushNow = cli(['push']);
  check(pushNow.configured === true && pushNow.subject === migrated.subject && Array.isArray(pushNow.devices), 'o hub informa o estado do push', `subject ${pushNow.subject} · ${pushNow.devices?.length} aparelho(s) · ${pushNow.problem ?? 'sem problema apontado'}`);
  const withoutPush = (pushNow.devices ?? []).filter((d) => d.subscriptions === 0);
  const healthPush = cli(['selftest']).checks?.find((c) => c.id === 'push');
  console.log(`  ${healthPush?.ok ? '✓' : '·'} ${healthPush?.title} — ${healthPush?.detail}`);
  check(
    healthPush?.optional === true && (withoutPush.length === 0 ? healthPush.ok === true : healthPush.ok === false && /sem notificações ativas/.test(healthPush.detail)),
    'a verificação de saúde inclui as notificações e avisa de aparelho pareado sem inscrição',
  );
  const diagPush = cli(['diagnostics']).report ?? '';
  check(/\[Notificações\]/.test(diagPush) && /subject: /.test(diagPush) && !diagPush.includes(vapidBefore.privateKey) && !diagPush.includes(vapidBefore.publicKey), 'o diagnóstico traz a seção de notificações, sem as chaves');

  // ───────────────────────── 8f. Codex e OpenCode ─────────────────────────
  section('8f. Codex e OpenCode: ligar e desligar pela CLI do app');
  const agentHome = mkdtempSync(join(tmpdir(), 'claude-hub-agentes-'));
  const agentEnv = { CODEX_HOME: join(agentHome, 'codex'), XDG_CONFIG_HOME: join(agentHome, 'config') };
  mkdirSync(agentEnv.CODEX_HOME, { recursive: true });
  const userCodexHooks = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say pronto' }] }] } };
  writeFileSync(join(agentEnv.CODEX_HOME, 'hooks.json'), JSON.stringify(userCodexHooks, null, 2));
  mkdirSync(join(agentEnv.XDG_CONFIG_HOME, 'opencode', 'plugins'), { recursive: true });
  writeFileSync(join(agentEnv.XDG_CONFIG_HOME, 'opencode', 'plugins', 'meu.js'), 'export default {}');
  const codexOn = cli(['agents', 'set', 'codex', 'on'], agentEnv);
  const codexFile = JSON.parse(readFileSync(join(agentEnv.CODEX_HOME, 'hooks.json'), 'utf8'));
  check(
    codexOn.ok === true && codexOn.agents?.codex?.current === true && codexFile.hooks.Stop.length === 2 && codexFile.hooks.PermissionRequest[0].hooks[0].command.includes(join(RUNTIME, 'claude-hub-hook.mjs')),
    'Codex: hooks gravados em hooks.json apontando para o app, com o hook do usuário preservado',
    codexOn.detail,
  );
  const opencodeOn = cli(['agents', 'set', 'opencode', 'on'], agentEnv);
  const pluginFile = join(agentEnv.XDG_CONFIG_HOME, 'opencode', 'plugins', 'claude-hub.js');
  check(
    opencodeOn.ok === true && opencodeOn.agents?.opencode?.current === true && readFileSync(pluginFile, 'utf8') === readFileSync(join(RUNTIME, 'claude-hub-opencode.js'), 'utf8'),
    'OpenCode: plugin copiado do app para a pasta de plugins',
  );
  // O plugin, carregado como o OpenCode carrega (import do arquivo), expõe as duas entradas.
  const loaded = sh(join(RUNTIME, 'bin/node'), ['--input-type=module', '-e', `const m = await import(${JSON.stringify(pluginFile)}); console.log(JSON.stringify({ keys: Object.keys(m), id: m.default.id, server: typeof m.default.server, setup: typeof m.default.setup }))`]);
  check(
    loaded.ok && loaded.stdout === JSON.stringify({ keys: ['default'], id: 'claude-hub', server: 'function', setup: 'function' }),
    'o arquivo do plugin carrega e só exporta o plugin (entradas V1 e V2)',
    loaded.stdout || loaded.out,
  );
  // Evento no formato do Codex, pelo comando gravado no hooks.json, chega ao hub como Codex.
  const codexCmd = codexFile.hooks.SessionStart.flatMap((g) => g.hooks).find((h) => h.command.includes('--agent codex')).command;
  const codexSid = `codex-${Date.now()}`;
  const codexRun = sh('/bin/sh', ['-c', codexCmd], { input: JSON.stringify({ session_id: codexSid, cwd: join(home, 'projetos/api'), hook_event_name: 'SessionStart', source: 'startup', model: 'gpt-5-codex', turn_id: null, transcript_path: null, permission_mode: 'default' }) });
  let codexSession = null;
  for (let i = 0; i < 20 && !codexSession; i++) {
    await sleep(150);
    codexSession = (await local('/api/sessions')).sessions?.find((x) => x.id === codexSid) ?? null;
  }
  check(codexRun.ok && codexSession?.agentKind === 'codex', 'evento do Codex disparado pelo comando gravado chega ao hub marcado como Codex', codexSession ? `${codexSession.projectName} · ${codexSession.agentKind}` : 'sessão não apareceu');
  const codexOff = cli(['agents', 'set', 'codex', 'off'], agentEnv);
  const opencodeOff = cli(['agents', 'set', 'opencode', 'off'], agentEnv);
  check(
    codexOff.ok && opencodeOff.ok && JSON.stringify(JSON.parse(readFileSync(join(agentEnv.CODEX_HOME, 'hooks.json'), 'utf8'))) === JSON.stringify(userCodexHooks) && !existsSync(pluginFile) && existsSync(join(agentEnv.XDG_CONFIG_HOME, 'opencode', 'plugins', 'meu.js')),
    'desligar devolve o hooks.json do usuário e remove só o plugin do Claude Hub',
  );
  rmSync(agentHome, { recursive: true, force: true });

  // ───────────────────────── 9. Reinstalação por cima ─────────────────────────
  section('9. Reinstalação por cima (arrastar o app de novo para Aplicativos, com tudo configurado)');
  sh('pkill', ['-x', 'ClaudeHub']);
  const settingsBeforeReinstall = readFileSync(settingsPath, 'utf8');
  const attach2 = sh('hdiutil', ['attach', '-nobrowse', '-readonly', dmg]);
  mount = attach2.out.split('\n').map((l) => /(\/Volumes\/.+)$/.exec(l)?.[1]).filter(Boolean).pop() ?? null;
  // O Finder, ao "Substituir", troca o app inteiro: apaga e copia de novo, com o serviço ainda rodando.
  rmSync(APP, { recursive: true, force: true });
  const copy2 = sh('ditto', [join(mount ?? '', 'ClaudeHub.app'), APP]);
  if (mount) sh('hdiutil', ['detach', mount]);
  mount = null;
  check(copy2.ok && existsSync(CLI), 'app substituído em /Applications');
  const afterCopy = cli(['setup', 'status']);
  check(afterCopy.hooks?.current === true && afterCopy.service?.installed === true, 'serviço e hooks continuam apontando para o app', `pronto: ${afterCopy.ready}`);
  const repair = cli(['setup', 'run']);
  for (const st of repair.steps ?? []) console.log(`  ${st.ok ? '✓' : '✗'} ${st.title} — ${st.detail}`);
  check(repair.ok === true, 'configurar de novo (o botão "Reparar") conclui sem erro');
  let upAgain = false;
  for (let i = 0; i < 80 && !upAgain; i++) {
    upAgain = Boolean(await fetch(`${base}/health`).then((r) => r.ok).catch(() => false));
    if (!upAgain) await sleep(250);
  }
  check(upAgain, 'hub no ar depois da reinstalação');
  check(readFileSync(settingsPath, 'utf8') === settingsBeforeReinstall, 'settings.json idêntico: nenhum hook duplicado, nada reescrito');
  const reHooks = JSON.parse(readFileSync(settingsPath, 'utf8')).hooks;
  const perEvent = Object.entries(reHooks).map(([ev, groups]) => [ev, groups.flatMap((g) => g.hooks).filter((h) => (h.url ?? h.command ?? '').includes('claude-hub') || (h.url ?? '').includes('/hooks/claude-code')).length]);
  check(perEvent.every(([, n]) => n === 1), 'exatamente um hook do Claude Hub por evento', perEvent.filter(([, n]) => n !== 1).map(([e, n]) => `${e}:${n}`).join(' ') || `${perEvent.length} eventos`);
  const backupsBefore = readdirSync(dirname(settingsPath)).filter((f) => f.startsWith('settings.json.claude-hub-') && f.endsWith('.bak')).length;
  check(backupsBefore >= 1, 'a reinstalação não precisou gravar nada (nenhum backup novo)', `${backupsBefore} backup(s) no total, todos de alterações anteriores`);
  const stillPaired = await fetch(`${pub}/api/sessions`, { headers: { authorization: `Bearer ${paired.deviceToken}` } });
  check(stillPaired.status === 200, 'o celular pareado continua pareado depois da reinstalação', `HTTP ${stillPaired.status}`);
  const kept2 = (await local('/api/sessions')).sessions.find((x) => x.id === sid);
  check(Boolean(kept2), 'histórico de sessões preservado');
  const health3 = cli(['selftest']);
  check(health3.ok === true, 'verificação de saúde passa depois da reinstalação');
  const diag = cli(['diagnostics']);
  check(diag.ok === true && diag.report.includes('[Verificação de saúde] OK') && !diag.report.includes(cfg.localToken) && !diag.report.includes(cfg.hookToken), 'diagnóstico gerado, sem segredos', `${(diag.report ?? '').split('\n').length} linhas`);

  // ───────────────────────── 10. Desinstalação ─────────────────────────
  section('10. Desinstalação');
  sh('pkill', ['-x', 'ClaudeHub']);
  const un = cli(['uninstall-all']);
  for (const s of un.steps ?? []) console.log(`  ${s.ok ? '✓' : '✗'} ${s.title} — ${s.detail}`);
  check(un.ok === true, 'integração removida');
  check(JSON.stringify(JSON.parse(readFileSync(settingsPath, 'utf8'))) === JSON.stringify(userSettings), 'settings.json volta a ser exatamente o do usuário');
  check(!existsSync(plistPath) && !sh('launchctl', ['print', `gui/${process.getuid()}/dev.claudehub.hub`]).ok, 'serviço removido do launchd');
  await sleep(800);
  check(!(await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)), 'hub parado');
  check(existsSync(join(home, '.claude-hub/hub.sqlite')), 'dados mantidos (desinstalação sem apagar os dados)');

  // ───────────────────────── 11. Instalar de novo depois de desinstalar ─────────────────────────
  section('11. Configurar de novo depois de desinstalar, e desinstalar apagando os dados');
  const again2 = cli(['setup', 'run']);
  check(again2.ok === true && again2.status?.ready === true, 'configuração refeita do zero funciona');
  const health4 = cli(['selftest']);
  check(health4.ok === true, 'verificação de saúde passa');
  const stillPaired2 = await fetch(`${pub}/api/sessions`, { headers: { authorization: `Bearer ${paired.deviceToken}` } });
  check(stillPaired2.status === 200, 'como os dados foram mantidos, o celular continua pareado');
  const purge = cli(['uninstall-all', '--purge']);
  for (const st of purge.steps ?? []) console.log(`  ${st.ok ? '✓' : '✗'} ${st.title} — ${st.detail}`);
  check(purge.ok === true && !existsSync(join(home, '.claude-hub')), 'desinstalar apagando os dados remove ~/.claude-hub');
  check(JSON.stringify(JSON.parse(readFileSync(settingsPath, 'utf8'))) === JSON.stringify(userSettings), 'settings.json é, de novo, exatamente o do usuário');
  check(!existsSync(plistPath), 'nenhum serviço ficou para trás');
} catch (err) {
  check(false, `erro: ${err.message}`);
} finally {
  if (mount) sh('hdiutil', ['detach', mount]);
  sh('pkill', ['-x', 'ClaudeHub']);
  sh('pkill', ['-f', 'backdrop.swift']);
  // Devolve o settings.json de quem rodou o teste.
  if (originalSettings !== null) writeFileSync(settingsPath, originalSettings);
  else rmSync(settingsPath, { force: true });
  for (const f of existsSync(dirname(settingsPath)) ? readdirSync(dirname(settingsPath)) : []) {
    if (f.startsWith('settings.json.claude-hub-') && f.endsWith('.bak')) rmSync(join(dirname(settingsPath), f), { force: true });
  }
}

// Saída final numa única escrita, e só então encerra: process.exit() logo após
// console.log() corta o que ainda não saiu pelo pipe.
const tail = [];
if (process.env.SMOKE_PRINT_IMAGES === '1') {
  for (const name of shots) {
    const jpg = join(tmpdir(), `${name}.jpg`);
    sh('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '55', '--resampleWidth', '1100', join(outDir, `${name}.png`), '--out', jpg]);
    if (!existsSync(jpg)) continue;
    // Em pedaços: linhas muito longas são cortadas no log do CI.
    const data = readFileSync(jpg).toString('base64');
    const parts = data.match(/.{1,40000}/g) ?? [];
    parts.forEach((part, i) => tail.push(`IMGPART:${name}:${i + 1}:${parts.length}:${part}`));
  }
}
tail.push(failures.length === 0 ? '\nRESULTADO DA INSTALAÇÃO: OK' : `\nRESULTADO DA INSTALAÇÃO: FALHOU (${failures.length})\n- ${failures.join('\n- ')}`);
process.stdout.write(`${tail.join('\n')}\n`, () => process.exit(failures.length === 0 ? 0 : 1));
