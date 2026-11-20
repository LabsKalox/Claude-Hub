#!/usr/bin/env node
/**
 * Monta o runtime que vai DENTRO do ClaudeHub.app (Contents/Resources/runtime):
 *
 *   hub.mjs              hub local (API, WebSocket, SQLite, push)
 *   claude-hub.mjs       CLI: configuração, hooks, serviço, saúde
 *   claude-hub-hook.mjs  hook de comando chamado pelo Claude Code
 *   claude-hub-statusline.mjs  ponte da linha de status (limites do plano)
 *   web/                 PWA do iPhone (export estático)
 *   bin/claude-hub       atalho de terminal para a CLI
 *   VERSION
 *
 * Cada .mjs é um arquivo único, sem node_modules: menos arquivos para assinar
 * e nada para instalar no Mac. O binário do Node entra à parte (package-dmg.sh).
 *
 *   pnpm build && node scripts/bundle-runtime.mjs [pasta-de-saída]
 */
import { build } from 'esbuild';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(root, 'dist-runtime'));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

const entries = {
  'hub.mjs': 'services/api/dist/main.js',
  'claude-hub.mjs': 'packages/claude-bridge/dist/cli.js',
  'claude-hub-hook.mjs': 'packages/claude-bridge/dist/hook-command.js',
  'claude-hub-statusline.mjs': 'packages/claude-bridge/dist/statusline.js',
};
// Plugin do OpenCode: arquivo único copiado para ~/.config/opencode/plugins/.
// Sem o banner de CommonJS e com um só export (o padrão).
const opencodePlugin = { 'claude-hub-opencode.js': 'packages/claude-bridge/dist/opencode-plugin-entry.js' };
for (const src of Object.values(entries)) {
  if (!existsSync(join(root, src))) {
    console.error(`Falta ${src}. Rode "pnpm build" antes.`);
    process.exit(1);
  }
}
const web = join(root, 'apps/web/out');
if (!existsSync(join(web, 'index.html'))) {
  console.error('Falta apps/web/out. Rode "pnpm build" antes.');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'bin'), { recursive: true });

// Dependências em CommonJS esperam require/__dirname, que não existem em módulos ES.
const banner = [
  "import { createRequire as __hubCreateRequire } from 'node:module';",
  "import { fileURLToPath as __hubFileURLToPath } from 'node:url';",
  "import { dirname as __hubDirname } from 'node:path';",
  'const require = __hubCreateRequire(import.meta.url);',
  'const __filename = __hubFileURLToPath(import.meta.url);',
  'const __dirname = __hubDirname(__filename);',
].join('\n');

// Pacotes de terceiros que entram nos arquivos gerados: os avisos de licença vão junto.
const bundledPackages = new Map();
const notePackages = (metafile) => {
  for (const input of Object.keys(metafile.inputs)) {
    const m = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (!m) continue;
    const dir = join(root, input.slice(0, input.indexOf(m[0]) + m[0].length));
    if (!bundledPackages.has(m[1])) bundledPackages.set(m[1], dir);
  }
};

for (const [name, src] of Object.entries(entries)) {
  const result = await build({
    entryPoints: [join(root, src)],
    outfile: join(out, name),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: { js: banner },
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
  });
  notePackages(result.metafile);
  console.log(`✓ ${name}  ${(statSync(join(out, name)).size / 1024).toFixed(0)} KB`);
}

for (const [name, src] of Object.entries(opencodePlugin)) {
  await build({
    entryPoints: [join(root, src)],
    outfile: join(out, name),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    legalComments: 'none',
    logLevel: 'warning',
    banner: { js: `// Claude Hub ${version} — plugin para o OpenCode. Instalado pelo app Claude Hub; remova pelo próprio app.` },
  });
  console.log(`✓ ${name}  ${(statSync(join(out, name)).size / 1024).toFixed(0)} KB`);
}

cpSync(web, join(out, 'web'), { recursive: true });
writeFileSync(join(out, 'VERSION'), `${version}\n`);

// Avisos de licença: Claude Hub (MIT), cada pacote embutido e as fontes da PWA.
for (const dir of ['@fontsource/montserrat', '@fontsource/jetbrains-mono']) {
  const pkg = join(root, 'apps/web/node_modules', dir);
  if (existsSync(pkg)) bundledPackages.set(dir, realpathSync(pkg) + '/');
}
const licenseText = (dir) => {
  for (const f of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'license', 'LICENSE-MIT']) {
    if (existsSync(join(dir, f))) return readFileSync(join(dir, f), 'utf8').trim();
  }
  return null;
};
const notices = [
  `Claude Hub ${version} — avisos de licença de terceiros / third-party notices`,
  '',
  'Claude Hub is released under the MIT License (see LICENSE in the source repository).',
  'The files in this folder ship the following third-party software. Node.js has its own notice (node-LICENSE.txt).',
  '',
];
const missing = [];
for (const [name, dir] of [...bundledPackages.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    /* sem package.json */
  }
  const text = licenseText(dir);
  if (!text) missing.push(name);
  notices.push('='.repeat(78), `${name}${meta.version ? ` ${meta.version}` : ''} — ${meta.license ?? meta.licenses?.[0]?.type ?? 'licença não declarada'}`, meta.homepage ?? '', '', text ?? `(arquivo de licença ausente no pacote; licença declarada: ${meta.license ?? '?'})`, '');
}
mkdirSync(join(out, 'licenses'), { recursive: true });
writeFileSync(join(out, 'licenses', 'THIRD_PARTY_NOTICES.txt'), `${notices.join('\n')}\n`);
console.log(`✓ licenses/THIRD_PARTY_NOTICES.txt  ${bundledPackages.size} pacotes${missing.length ? ` (sem arquivo de licença: ${missing.join(', ')})` : ''}`);

// Atalho para usar a CLI no Terminal com o Node embutido.
const wrapper = `#!/bin/sh
# Claude Hub ${version} — CLI com o Node embutido no app.
DIR="$(cd "$(dirname "$0")" && pwd)"
export NODE_NO_WARNINGS=1
exec "$DIR/node" "$DIR/../claude-hub.mjs" "$@"
`;
writeFileSync(join(out, 'bin/claude-hub'), wrapper);
chmodSync(join(out, 'bin/claude-hub'), 0o755);

console.log(`✓ web/ e VERSION (${version})`);
console.log(`Runtime pronto em ${out} (falta só bin/node, que o empacotador acrescenta).`);
