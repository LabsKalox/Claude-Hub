#!/usr/bin/env node
/**
 * O que o macOS diz de um instalador BAIXADO DA INTERNET.
 *
 *   node tests/real/macos-gatekeeper-check.mjs apps/macos/build/ClaudeHub-<versão>-arm64.dmg
 *
 * No CI o .dmg é criado na própria máquina, então não carrega a marca de
 * quarentena que o navegador põe em todo download — e sem ela o Gatekeeper não
 * avalia nada. Este teste ACRESCENTA essa marca a uma cópia do .dmg (como o
 * Safari faria) e registra o veredito do sistema para a imagem, para o app e
 * para o Node embutido, e se o app abre.
 *
 * Só observa. Não remove quarentena, não altera políticas do Gatekeeper e não
 * aprova nada: se o sistema bloquear, o bloqueio fica registrado como resultado.
 * O teste só falha se não conseguir medir, ou se o resultado contradisser o que
 * o instalador declara sobre si mesmo (notarizado ou não).
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.error('Este teste só roda no macOS.');
  process.exit(1);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const source = resolve(process.argv[2] ?? '');
if (!existsSync(source) || !source.endsWith('.dmg')) {
  console.error('Informe o caminho do .dmg.');
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, ...opts });
  return { ok: r.status === 0, status: r.status, signal: r.signal, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() || (r.error ? r.error.message : '') };
};
const one = (text) => text.replace(/\s*\n\s*/g, ' | ');
const outDir = join(root, 'docs/screenshots/macos');
mkdirSync(outDir, { recursive: true });

const work = mkdtempSync(join(tmpdir(), 'claude-hub-download-'));
const dmg = join(work, 'ClaudeHub-baixado.dmg');
const findings = [];
const note = (label, value) => {
  console.log(`${label}: ${value}`);
  findings.push([label, value]);
};
const problems = [];
let mount = null;
let shot = null;

try {
  console.log(`${sh('sw_vers', ['-productVersion']).out} · ${sh('uname', ['-m']).out}`);
  note('Gatekeeper neste Mac', one(sh('spctl', ['--status']).out));

  // 1. A cópia "baixada": marca de quarentena no formato que o Safari grava.
  copyFileSync(source, dmg);
  const stamp = Math.floor(Date.now() / 1000).toString(16);
  const quarantine = `0083;${stamp};Safari;${crypto.randomUUID().toUpperCase()}`;
  const mark = sh('xattr', ['-w', 'com.apple.quarantine', quarantine, dmg]);
  if (!mark.ok) throw new Error(`não consegui marcar o .dmg como download: ${mark.out}`);
  note('Marca de quarentena no .dmg', sh('xattr', ['-p', 'com.apple.quarantine', dmg]).out);

  // 2. A imagem.
  const dmgSig = sh('codesign', ['-dv', '--verbose=2', dmg]).out;
  const dmgSigned = !/not signed at all/.test(dmgSig);
  note('Assinatura do .dmg', dmgSigned ? one((/Authority=.+/.exec(dmgSig)?.[0] ?? 'assinado')) : 'sem assinatura');
  const stapled = sh('xcrun', ['stapler', 'validate', dmg]);
  note('Tíquete de notarização grampeado no .dmg', stapled.ok ? 'sim' : `não (${one(stapled.out).slice(-120)})`);
  note('Veredito para o .dmg (spctl --assess --type open)', one(sh('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg]).out));

  // 3. O conteúdo, depois de arrastado para outra pasta (herda a quarentena).
  const attach = sh('hdiutil', ['attach', '-nobrowse', '-readonly', dmg]);
  mount = attach.out.split('\n').map((l) => /(\/Volumes\/.+)$/.exec(l)?.[1]).filter(Boolean).pop() ?? null;
  if (!mount) throw new Error(`a imagem em quarentena não montou: ${attach.out}`);
  const dest = join(work, 'Aplicativos');
  mkdirSync(dest);
  const app = join(dest, 'ClaudeHub.app');
  const copy = sh('ditto', [join(mount, 'ClaudeHub.app'), app]);
  if (!copy.ok) throw new Error(`não consegui copiar o app: ${copy.out}`);
  sh('hdiutil', ['detach', mount]);
  mount = null;
  const node = join(app, 'Contents/Resources/runtime/bin/node');
  const inherited = sh('xattr', ['-p', 'com.apple.quarantine', app]);
  note('O app copiado herda a quarentena', inherited.ok ? `sim (${inherited.out})` : 'não');
  note('O Node embutido herda a quarentena', sh('xattr', ['-p', 'com.apple.quarantine', node]).ok ? 'sim' : 'não');

  const appSig = sh('codesign', ['-dv', '--verbose=2', app]).out;
  const adhoc = /Signature=adhoc/.test(appSig);
  note('Assinatura do app', adhoc ? 'local (ad-hoc), sem Developer ID' : one((/Authority=.+/.exec(appSig)?.[0] ?? '?')));
  const appVerdict = sh('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  note('Veredito para o app (spctl --assess --type execute)', one(appVerdict.out));
  const nodeVerdict = sh('spctl', ['--assess', '--type', 'execute', '--verbose=2', node]);
  note('Veredito para o Node embutido', one(nodeVerdict.out));

  // 4. O Node embutido, em quarentena, executa? (É ele que roda o hub e o assistente.)
  const run = sh(node, ['-e', 'console.log("node-ok")'], { timeout: 30_000 });
  note('Node embutido em quarentena executa', run.out.includes('node-ok') ? 'sim' : `NÃO (${run.signal ?? `código ${run.status}`}: ${one(run.out).slice(0, 160)})`);

  // 5. Abrir o app como um duplo clique. Com bloqueio, o macOS mostra um aviso e o app não inicia.
  sh('pkill', ['-x', 'ClaudeHub']);
  const opener = spawn('open', [app], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_HUB_NO_AUTO_SETUP: '1' } });
  let openOut = '';
  opener.stdout.on('data', (c) => (openOut += c));
  opener.stderr.on('data', (c) => (openOut += c));
  await sleep(9000);
  shot = join(outDir, '09-download-nao-notarizado.png');
  sh('screencapture', ['-x', shot]);
  // "Abriu" = existe janela do ClaudeHub na tela (a ilha fica sempre visível).
  // Um processo listado não prova nada: no bloqueio só aparece o aviso do sistema.
  const owners = sh('swift', [join(root, 'tests/real/window-owners.swift')], { timeout: 90_000 }).out.split('\n').pop() ?? '';
  const running = owners.split(',').some((o) => /^Claude ?Hub$/.test(o.trim()));
  note('Processo ClaudeHub listado', sh('pgrep', ['-x', 'ClaudeHub']).ok ? 'sim' : 'não');
  note('Janelas na tela (donos)', owners || '(não consegui listar)');
  if (!owners) throw new Error('não consegui listar as janelas na tela');
  note('O app abriu com duplo clique', running ? 'SIM' : `não — bloqueado pelo macOS${openOut.trim() ? ` (${one(openOut.trim()).slice(0, 200)})` : ''}`);
  opener.kill('SIGKILL');
  sh('pkill', ['-x', 'ClaudeHub']);
  // O aviso do sistema, se houver, fica na tela: este teste não clica em nada dele.

  // 6. Coerência: o que o instalador é × o que o sistema respondeu.
  const notarized = stapled.ok;
  const accepted = appVerdict.ok;
  console.log('\n── Conclusão');
  if (notarized) {
    console.log('Instalador NOTARIZADO: o esperado é o macOS aceitar e o app abrir.');
    if (!accepted) problems.push('instalador notarizado, mas o Gatekeeper rejeitou o app');
    if (!running) problems.push('instalador notarizado, mas o app não abriu');
  } else {
    console.log('Instalador NÃO notarizado (build de teste).');
    console.log(accepted ? 'ATENÇÃO: o Gatekeeper aceitou um app sem notarização — resultado inesperado.' : 'O Gatekeeper rejeita este app quando ele vem de um download, como esperado.');
    console.log(running ? 'ATENÇÃO: o app abriu mesmo assim neste Mac de teste.' : 'Com duplo clique, o app NÃO abre: o macOS mostra um aviso e interrompe.');
    if (accepted) problems.push('um app não notarizado foi aceito pelo Gatekeeper — o relatório não pode afirmar que ele é bloqueado');
    if (running) problems.push('um app não notarizado abriu com duplo clique — o guia não pode afirmar que ele é bloqueado');
  }
} catch (err) {
  problems.push(`erro: ${err.message}`);
} finally {
  if (mount) sh('hdiutil', ['detach', mount]);
  sh('pkill', ['-x', 'ClaudeHub']);
  rmSync(work, { recursive: true, force: true });
}

const tail = ['', 'GATEKEEPER-RESUMO-INICIO', ...findings.map(([k, v]) => `${k} => ${v}`), 'GATEKEEPER-RESUMO-FIM'];
if (process.env.SMOKE_PRINT_IMAGES === '1' && shot && existsSync(shot)) {
  const jpg = join(tmpdir(), '09-download-nao-notarizado.jpg');
  sh('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '55', '--resampleWidth', '1100', shot, '--out', jpg]);
  if (existsSync(jpg)) {
    const parts = readFileSync(jpg).toString('base64').match(/.{1,40000}/g) ?? [];
    parts.forEach((part, i) => tail.push(`IMGPART:09-download-nao-notarizado:${i + 1}:${parts.length}:${part}`));
  }
}
tail.push(problems.length === 0 ? '\nRESULTADO DO GATEKEEPER: medido' : `\nRESULTADO DO GATEKEEPER: INCONSISTENTE\n- ${problems.join('\n- ')}`);
process.stdout.write(`${tail.join('\n')}\n`, () => process.exit(problems.length === 0 ? 0 : 1));
