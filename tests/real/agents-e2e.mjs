#!/usr/bin/env node
/**
 * Codex e OpenCode DE VERDADE contra o Claude Hub.
 *
 *   node tests/real/agents-e2e.mjs codex|opencode <binário do agente>
 *
 * O agente real roda com um modelo falso local (tests/real/fake-model.mjs) que o
 * manda executar um comando no terminal. A integração é ligada pela CLI do
 * runtime empacotado (a mesma do app), exatamente como no Mac.
 *
 * Duas sessões ao mesmo tempo, em pastas diferentes:
 *   - "permitir": o "iPhone" permite → o comando roda e o arquivo aparece;
 *   - "negar":    o "iPhone" nega    → o comando não roda.
 *
 * Tudo numa pasta pessoal temporária: nada da máquina é tocado.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [variant, bin] = process.argv.slice(2);
// opencode2 = OpenCode V2 (@opencode/cli); para o hub, é o mesmo agente "opencode".
const agent = variant === 'opencode2' ? 'opencode' : variant;
const v2 = variant === 'opencode2';
if (!['codex', 'opencode', 'opencode2'].includes(variant) || !bin) {
  console.error('uso: node tests/real/agents-e2e.mjs codex|opencode|opencode2 <binário>');
  process.exit(2);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = process.env.CLAUDE_HUB_RUNTIME_DIR ?? join(root, 'dist-runtime');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (ok, label, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const home = mkdtempSync(join(tmpdir(), `hub-${agent}-`));
const env = {
  ...process.env,
  HOME: home,
  CLAUDE_HUB_HOME: join(home, '.claude-hub'),
  CODEX_HOME: join(home, '.codex'),
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local/share'),
  XDG_STATE_HOME: join(home, '.local/state'),
  XDG_CACHE_HOME: join(home, '.cache'),
  CLAUDE_HUB_LOCAL_PORT: '47811',
  CLAUDE_HUB_PUBLIC_PORT: '47812',
  FAKE_API_KEY: 'chave-falsa',
  NODE_NO_WARNINGS: '1',
  NO_COLOR: '1',
};
for (const d of [env.CODEX_HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME]) mkdirSync(d, { recursive: true });

const children = [];
function start(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const out = { text: '' };
  child.stdout.on('data', (c) => (out.text += c));
  child.stderr.on('data', (c) => (out.text += c));
  children.push(child);
  child.out = out;
  child.label = name;
  return child;
}
const tail = (text, n = 40) => text.split('\n').slice(-n).join('\n');

const fake = start('modelo', process.execPath, [join(root, 'tests/real/fake-model.mjs'), '47813', 'echo hub-ok > hub-test.txt']);
const hub = start('hub', process.execPath, [join(runtime, 'hub.mjs')]);
const base = 'http://127.0.0.1:47811';
for (let i = 0; i < 100; i++) {
  if (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) break;
  await sleep(100);
}
const cfg = JSON.parse(readFileSync(join(env.CLAUDE_HUB_HOME, 'config.json'), 'utf8'));
const local = (path, init = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${cfg.localToken}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } }).then((r) => r.json());

// "iPhone" pareado pela porta pública.
const { code } = await local('/local/pairing', { method: 'POST', body: '{}' });
const paired = await fetch('http://127.0.0.1:47812/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceName: 'iPhone de teste' }) }).then((r) => r.json());
const phone = (path, init = {}) =>
  fetch(`http://127.0.0.1:47812${path}`, { ...init, headers: { authorization: `Bearer ${paired.deviceToken}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });

// Liga a integração pela CLI do runtime (a mesma que o botão do app usa).
const on = spawnSync(process.execPath, [join(runtime, 'claude-hub.mjs'), 'agents', 'set', agent, 'on', '--json'], { env, encoding: 'utf8' });
const onJson = JSON.parse(on.stdout.trim().split('\n').pop() || '{}');
check(onJson.ok === true, `integração ${agent} ligada pela CLI do app`, onJson.detail);

// Configuração do agente para usar o modelo falso. Arquivos próprios do usuário seriam preservados; aqui não há nenhum.
const version = spawnSync(bin, ['--version'], { env, encoding: 'utf8' });
console.log(`${agent}: ${(version.stdout || version.stderr).trim()}`);
if (agent === 'codex') {
  writeFileSync(
    join(env.CODEX_HOME, 'config.toml'),
    [
      'model = "fake-model"',
      'model_provider = "fake"',
      'approval_policy = "on-request"',
      'sandbox_mode = "read-only"',
      '',
      '[model_providers.fake]',
      'name = "Modelo falso do teste"',
      'base_url = "http://127.0.0.1:47813/v1"',
      'wire_api = "responses"',
      'env_key = "FAKE_API_KEY"',
      '',
    ].join('\n'),
  );
} else if (v2) {
  // V2: `providers`, pacote próprio e regras de permissão (`shell`, não `bash`).
  const dir = join(env.XDG_CONFIG_HOME, 'opencode');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'opencode.jsonc'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        model: 'fake/fake-model',
        permissions: [
          { action: 'shell', resource: '*', effect: 'ask' },
          { action: 'edit', resource: '*', effect: 'ask' },
        ],
        providers: {
          fake: {
            name: 'Modelo falso do teste',
            env: ['FAKE_API_KEY'],
            package: '@opencode/ai/providers/openai-compatible',
            settings: { baseURL: 'http://127.0.0.1:47813/v1' },
            models: { 'fake-model': { name: 'fake-model' } },
          },
        },
      },
      null,
      2,
    ),
  );
} else {
  const dir = join(env.XDG_CONFIG_HOME, 'opencode');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        model: 'fake/fake-model',
        permission: { bash: 'ask', edit: 'ask' },
        provider: {
          fake: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Modelo falso do teste',
            options: { baseURL: 'http://127.0.0.1:47813/v1', apiKey: 'chave-falsa' },
            models: { 'fake-model': { name: 'fake-model', tool_call: true } },
          },
        },
      },
      null,
      2,
    ),
  );
}

// Duas sessões ao mesmo tempo.
const prompt = 'Crie o arquivo hub-test.txt rodando o comando no terminal.';
const project = (label) => {
  const cwd = join(home, `projeto-${label}`);
  mkdirSync(cwd, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd });
  return cwd;
};
let runs;
let opencodeServer = null;
if (agent === 'codex') {
  // `codex exec` força "nunca pedir aprovação", então não serve para testar aprovação.
  // O teste usa o `codex app-server` (JSON-RPC no stdio), o mesmo motor da interface
  // interativa, com aprovação "on-request" e sandbox somente leitura: sair da sandbox
  // exige aprovação — e o hook PermissionRequest do Claude Hub decide antes da tela.
  // --dangerously-bypass-hook-trust só aqui, no teste automatizado; no Mac o próprio
  // Codex pede para você confiar nos hooks.
  // Descoberta: métodos do app-server ligados a hooks (o esquema vem do próprio Codex).
  {
    const schemaDir = join(home, 'codex-schema');
    const g = spawnSync(bin, ['app-server', 'generate-json-schema', '--out', schemaDir], { env, encoding: 'utf8' });
    const found = [];
    const walk = (dir) => {
      for (const f of (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [])) {
        const p = join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (/hook/i.test(f.name) || /hook/i.test(readFileSync(p, 'utf8').slice(0, 200000).match(/"[a-zA-Z/]*[hH]ook[a-zA-Z/]*"/g)?.join(' ') ?? '')) found.push(p);
      }
    };
    walk(schemaDir);
    console.log(`── esquema do app-server (${g.status}): ${found.length} arquivo(s) com "hook"`);
    const names = new Set();
    for (const p of found) for (const m of readFileSync(p, 'utf8').match(/"(hooks?\/[A-Za-z/]+|[a-z]+\/[a-zA-Z]*[Hh]ook[a-zA-Z/]*)"/g) ?? []) names.add(m);
    console.log(`  métodos: ${[...names].join(', ')}`);
    const show = (re, max) => {
      const all = [];
      const w = (dir) => {
        for (const f of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
          const p = join(dir, f.name);
          if (f.isDirectory()) w(p);
          else if (re.test(f.name)) all.push(p);
        }
      };
      w(schemaDir);
      for (const p of all) console.log(`  ${p.slice(schemaDir.length)}: ${readFileSync(p, 'utf8').replace(/\s+/g, ' ').slice(-max)}`);
    };
    show(/^HooksListResponse\.json$/, 4000);
    show(/^ConfigBatchWriteParams\.json$/, 3000);
  }
  runs = [];
  for (const label of ['permitir', 'negar']) {
    const cwd = project(label);
    const child = spawn(bin, ['--dangerously-bypass-hook-trust', 'app-server'], { cwd, env: { ...env, PWD: cwd }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.out = { text: '' };
    child.label = `codex-app-server-${label}`;
    children.push(child);
    const pendingRpc = new Map();
    let nextId = 1;
    let buffer = '';
    let finished = false;
    child.stderr.on('data', (c) => (child.out.text += c));
    child.stdout.on('data', (c) => {
      buffer += c;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        child.out.text += `← ${line.slice(0, 400)}\n`;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && pendingRpc.has(msg.id) && (msg.result !== undefined || msg.error !== undefined)) {
          pendingRpc.get(msg.id)(msg);
          pendingRpc.delete(msg.id);
        } else if (msg.id !== undefined && msg.method) {
          // Pedido do servidor ao "cliente" (tela de aprovação): só chega se o hook não decidiu.
          child.out.text += `  (pedido de aprovação chegou à tela: o hook não decidiu) ${msg.method}\n`;
          child.stdin.write(`${JSON.stringify({ id: msg.id, result: { decision: 'decline' } })}\n`);
        } else if (msg.method === 'turn/completed' || msg.method === 'codex/event/task_complete') {
          finished = true;
        }
      }
    });
    const rpc = (method, params) =>
      new Promise((resolve) => {
        const id = nextId++;
        pendingRpc.set(id, resolve);
        const line = JSON.stringify({ id, method, params });
        child.out.text += `→ ${line.slice(0, 300)}\n`;
        child.stdin.write(`${line}\n`);
        setTimeout(() => pendingRpc.has(id) && (pendingRpc.delete(id), resolve({ error: { message: 'sem resposta em 20 s' } })), 20_000);
      });
    const init = await rpc('initialize', { clientInfo: { name: 'claude-hub-test', title: 'Claude Hub test', version: '0.5.0' } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    // Confiança nos hooks, como a tela "Review hooks" do Codex faz: lista e registra o que está pendente.
    const listed = await rpc('hooks/list', { cwds: [cwd] });
    console.log(`  hooks/list (${label}): ${JSON.stringify(listed.result ?? listed.error).slice(0, 2500)}`);
    const hooks = [];
    const collect = (o) => {
      if (Array.isArray(o)) o.forEach(collect);
      else if (o && typeof o === 'object') {
        if (typeof o.key === 'string' && (o.currentHash || o.hash)) hooks.push(o);
        Object.values(o).forEach(collect);
      }
    };
    collect(listed.result);
    const pendingTrust = hooks.filter((h) => !/^trusted$/i.test(String(h.trustStatus ?? h.trust ?? '')));
    if (pendingTrust.length) {
      const edits = pendingTrust.map((h) => ({ keyPath: `hooks.state.${JSON.stringify(h.key)}.trusted_hash`, value: h.currentHash ?? h.hash, mergeStrategy: 'replace' }));
      const wrote = await rpc('config/batchWrite', { edits });
      console.log(`  config/batchWrite (${pendingTrust.length} hook(s)): ${JSON.stringify(wrote.result ?? wrote.error).slice(0, 600)}`);
      const again = await rpc('hooks/list', { cwds: [cwd] });
      console.log(`  hooks/list depois: ${JSON.stringify(again.result ?? again.error).slice(0, 800)}`);
    }
    const thread = await rpc('thread/start', { cwd, approvalPolicy: 'on-request', sandbox: 'read-only', model: 'fake-model', modelProvider: 'fake' });
    const threadId = thread.result?.thread?.id ?? thread.result?.threadId;
    const turn = threadId ? await rpc('turn/start', { threadId, input: [{ type: 'text', text: prompt }] }) : null;
    console.log(`  Codex app-server (${label}): initialize ${init.error ? `erro ${init.error.message}` : 'ok'} · thread ${threadId ?? `erro ${JSON.stringify(thread.error ?? thread.result).slice(0, 200)}`} · turn ${turn ? (turn.error ? `erro ${turn.error.message}` : 'ok') : '—'}`);
    runs.push({ label, cwd, child: null, sessionId: threadId, done: () => finished });
  }
} else if (v2) {
  // OpenCode V2: servidor dedicado (`opencode serve`) com senha fixa; API em /api.
  const auth = `Basic ${Buffer.from('opencode:senha-do-teste').toString('base64')}`;
  opencodeServer = start('opencode-serve', bin, ['serve', '--hostname', '127.0.0.1', '--port', '47814'], { cwd: home, env: { ...env, OPENCODE_PASSWORD: 'senha-do-teste' } });
  const api = (path, body) =>
    fetch(`http://127.0.0.1:47814${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: auth, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  for (let i = 0; i < 150; i++) {
    if (await api('/api/session').then((r) => r.ok).catch(() => false)) break;
    await sleep(200);
  }
  runs = [];
  for (const label of ['permitir', 'negar']) {
    const cwd = project(label);
    const res = await api('/api/session', { title: `Teste ${label}`, location: { directory: cwd }, model: { providerID: 'fake', id: 'fake-model' } });
    const created = await res.json().catch(() => ({}));
    const id = created.id ?? created.data?.id ?? created.session?.id;
    const sent = id ? await api(`/api/session/${id}/prompt`, { text: prompt }) : null;
    console.log(`  sessão OpenCode V2 ${id ?? `(erro HTTP ${res.status}: ${JSON.stringify(created).slice(0, 300)})`} (${label}) → prompt ${sent ? `HTTP ${sent.status} ${sent.ok ? '' : (await sent.text()).slice(0, 300)}` : '—'}`);
    runs.push({ label, cwd, sessionId: id, child: null });
  }
} else {
  // OpenCode: o mesmo servidor que a interface do terminal usa, com duas sessões em
  // pastas diferentes. (`opencode run` recusa pedidos de permissão sozinho, por ser
  // não interativo, então não serve para testar aprovação.)
  opencodeServer = start('opencode-serve', bin, ['serve', '--port', '47814', '--hostname', '127.0.0.1'], { cwd: home });
  const oc = (path, cwd, body) =>
    fetch(`http://127.0.0.1:47814${path}${path.includes('?') ? '&' : '?'}directory=${encodeURIComponent(cwd)}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  for (let i = 0; i < 150; i++) {
    if (await oc('/session', home).then((r) => r.ok).catch(() => false)) break;
    await sleep(200);
  }
  runs = [];
  for (const label of ['permitir', 'negar']) {
    const cwd = project(label);
    const created = await oc('/session', cwd, { title: `Teste ${label}` }).then((r) => r.json());
    const sent = await oc(`/session/${created.id}/prompt_async`, cwd, { parts: [{ type: 'text', text: prompt }], model: { providerID: 'fake', modelID: 'fake-model' } });
    console.log(`  sessão OpenCode ${created.id} (${label}) → prompt HTTP ${sent.status}`);
    runs.push({ label, cwd, sessionId: created.id, child: null });
  }
}

// O "iPhone" responde cada pedido conforme o projeto.
const decided = new Map();
const deadline = Date.now() + 150_000;
// Codex: o processo termina. OpenCode: a sessão fica ociosa no hub (evento session.idle).
let hubSessions = [];
const exited = (r) =>
  r.child
    ? r.child.exitCode !== null || r.child.signalCode !== null
    : (r.done?.() ?? false) || (decided.size >= 2 && hubSessions.some((s) => s.id === r.sessionId && (s.status === 'COMPLETED' || s.status === 'ERROR')));
while (Date.now() < deadline && !runs.every(exited)) {
  hubSessions = (await local('/api/sessions').catch(() => ({}))).sessions ?? [];
  const { approvals = [] } = await local('/api/approvals?status=pending').catch(() => ({}));
  for (const a of approvals) {
    if (decided.has(a.id)) continue;
    const decision = a.projectName === 'projeto-negar' ? 'deny' : 'allow';
    const res = await phone(`/api/approvals/${a.id}/decision`, { method: 'POST', body: JSON.stringify({ decision }) });
    decided.set(a.id, { ...a, decision, status: res.status });
    console.log(`  iPhone: ${decision === 'allow' ? 'permitiu' : 'negou'} "${a.command}" (${a.agentKind}, ${a.projectName}) → HTTP ${res.status}`);
  }
  await sleep(300);
}
for (const r of runs) if (r.child && !exited(r)) r.child.kill('SIGTERM');
await sleep(1500);

// ── Verificações ──
const sessions = (await local('/api/sessions')).sessions ?? [];
const mine = sessions.filter((s) => s.agentKind === agent);
console.log(`\nsessões no hub: ${sessions.map((s) => `${s.projectName}:${s.agentKind}:${s.status}`).join(', ') || '(nenhuma)'}`);
check(mine.length >= 2, `as duas sessões simultâneas aparecem no hub como ${agent}`, `${mine.length} sessão(ões)`);
const approvals = [...decided.values()];
check(approvals.length >= 2 && approvals.every((a) => a.agentKind === agent), `os pedidos de permissão chegaram ao hub marcados como ${agent}`, approvals.map((a) => `${a.projectName}: ${a.command}`).join(' | '));
check(approvals.some((a) => /hub-test\.txt/.test(a.command)), 'o pedido mostra o comando completo');
check(existsSync(join(runs[0].cwd, 'hub-test.txt')), 'permitido no iPhone → o agente executou o comando');
check(approvals.some((a) => a.projectName === 'projeto-negar' && a.decision === 'deny' && a.status === 200) && !existsSync(join(runs[1].cwd, 'hub-test.txt')), 'negado no iPhone → o agente NÃO executou o comando');
check(approvals.some((a) => a.projectName === 'projeto-permitir' && a.decision === 'allow' && a.status === 200), 'o pedido da outra sessão foi permitido separadamente (sessões independentes)');
const done = mine.filter((s) => s.status === 'COMPLETED' || s.status === 'IDLE');
check(done.length >= 1, 'ao terminar, a sessão sai de "Trabalhando"', mine.map((s) => s.status).join(','));
const events = (await local('/api/events?limit=200')).events ?? [];
check(events.some((e) => e.toolName === 'Bash' || /hub-test/.test(e.summary ?? '')), 'as ferramentas usadas aparecem no histórico de eventos');

// Desligar devolve a configuração.
const off = spawnSync(process.execPath, [join(runtime, 'claude-hub.mjs'), 'agents', 'set', agent, 'off', '--json'], { env, encoding: 'utf8' });
check(JSON.parse(off.stdout.trim().split('\n').pop() || '{}').ok === true, 'integração desligada pela CLI do app');

const failed = results.filter((x) => !x).length;
// Saída de cada processo: é a evidência do que o agente real fez (e o diagnóstico, se algo falhar).
{
  for (const c of children) console.log(`\n── ${c.label} (saída final)\n${tail(c.out.text, failed ? 80 : 25)}`);
  const logPath = join(env.CLAUDE_HUB_HOME, 'hub.log');
  if (existsSync(logPath)) console.log(`\n── hub.log\n${tail(readFileSync(logPath, 'utf8'))}`);
}
for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
console.log(`\nRESULTADO ${variant.toUpperCase()}: ${failed ? `FALHOU (${failed})` : 'OK'}`);
process.exit(failed ? 1 : 0);
