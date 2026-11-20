/**
 * Plugin do Claude Hub para o OpenCode.
 *
 * Um arquivo só, para as duas versões vivas do OpenCode (conferido no código e
 * nos tipos publicados em 20/11/2026):
 *
 *  - V1 (`opencode-ai` 1.19.x): carrega `~/.config/opencode/plugins/*.{js,ts}` e
 *    usa `default.server(input)`, que devolve os ganchos (`event`,
 *    `tool.execute.before`/`after`, `chat.message`). Pedidos de permissão chegam
 *    no evento `permission.asked` e são respondidos pelo cliente do próprio
 *    OpenCode (`postSessionIdPermissionsPermissionId`).
 *  - V2 (`@opencode/cli` 2.x): carrega o mesmo diretório e usa `default.id` +
 *    `default.setup(ctx)`; eventos por `ctx.event.subscribe`, ferramentas por
 *    `ctx.tool.hook('execute.before'|'execute.after')` e resposta por
 *    `ctx.permission.reply({ sessionID, requestID, decision })`.
 *
 * Como funciona a aprovação: o OpenCode mostra o pedido no terminal como
 * sempre; ao mesmo tempo o plugin entrega o pedido ao hub (ilha e iPhone). Quem
 * responder primeiro decide. Se a resposta vier do terminal, o plugin cancela o
 * pedido no hub (fecha a conexão, como o Claude Code faz). Hub fora do ar = o
 * OpenCode segue normal, só no terminal.
 *
 * O plugin não importa nada além de `node:fs`/`node:os`/`node:path` (o OpenCode
 * roda plugins no Bun, que os oferece) e lê o endereço e o token do hub em
 * `~/.claude-hub/config.json`.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Json = Record<string, unknown>;

interface HubTarget {
  url: string;
  token: string;
  approvalTimeoutSec: number;
}

function hubTarget(): HubTarget | null {
  try {
    const home = process.env.CLAUDE_HUB_HOME || join(homedir(), '.claude-hub');
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Json;
    const port = typeof cfg.localPort === 'number' ? cfg.localPort : 4317;
    const host = typeof cfg.localHost === 'string' ? cfg.localHost : '127.0.0.1';
    if (typeof cfg.hookToken !== 'string') return null;
    return {
      url: `http://${host}:${port}/hooks/claude-code`,
      token: cfg.hookToken,
      approvalTimeoutSec: typeof cfg.approvalTimeoutSec === 'number' ? cfg.approvalTimeoutSec : 300,
    };
  } catch {
    return null;
  }
}

/** Nomes das ferramentas do OpenCode → nomes que o hub já sabe descrever. */
const TOOL_NAMES: Record<string, string> = {
  bash: 'Bash',
  // V2 renomeou as ações de permissão: shell (era bash) e subagent (era task).
  shell: 'Bash',
  subagent: 'Task',
  edit: 'Edit',
  write: 'Write',
  read: 'Read',
  patch: 'Edit',
  multiedit: 'MultiEdit',
  glob: 'Glob',
  grep: 'Grep',
  list: 'Glob',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  task: 'Task',
  todowrite: 'TodoWrite',
  todoread: 'TodoRead',
};

export function toolName(name: unknown): string {
  const raw = typeof name === 'string' && name ? name : 'ferramenta';
  return TOOL_NAMES[raw] ?? raw;
}

/** Argumentos do OpenCode (camelCase) → os campos que o hub lê. */
export function toolInput(name: unknown, args: unknown): Json {
  const a = (args && typeof args === 'object' ? args : {}) as Json;
  const out: Json = { ...a };
  if (typeof a.filePath === 'string') out.file_path = a.filePath;
  if (toolName(name) === 'TodoWrite' && Array.isArray(a.todos)) out.todos = a.todos;
  return out;
}

/**
 * O que um pedido de permissão do OpenCode descreve, no formato do hub.
 * V1: `{ permission, patterns, metadata }`. V2: `{ action, resources, metadata }`.
 */
export function permissionRequest(p: Json): { tool_name: string; tool_input: Json } {
  // V1 novo: permission/patterns · V1 antigo (permission.updated): type/pattern · V2: action/resources.
  const action = [p.permission, p.action, p.type].find((x): x is string => typeof x === 'string' && x.length > 0) ?? 'ferramenta';
  const rawList = Array.isArray(p.patterns) ? p.patterns : Array.isArray(p.resources) ? p.resources : Array.isArray(p.pattern) ? p.pattern : [p.pattern];
  const list = rawList.filter((x): x is string => typeof x === 'string');
  const meta = (p.metadata && typeof p.metadata === 'object' ? p.metadata : {}) as Json;
  const name = toolName(action);
  const input: Json = {};
  if (name === 'Bash') input.command = typeof meta.command === 'string' ? meta.command : list.join('\n') || action;
  else if (name === 'Edit' || name === 'Write' || name === 'Read') {
    const file = meta.filepath ?? meta.filePath ?? list[0];
    if (typeof file === 'string') input.file_path = file;
    if (typeof meta.diff === 'string') input.diff = meta.diff;
  } else if (name === 'WebFetch') {
    const url = meta.url ?? list[0];
    if (typeof url === 'string') input.url = url;
  } else {
    input.description = list.join('\n') || (typeof p.message === 'string' ? p.message : action);
  }
  if (typeof p.message === 'string' && p.message && !input.description) input.reason = p.message;
  return { tool_name: name, tool_input: input };
}

function textOf(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return undefined;
  const text = parts
    .map((p) => (p && typeof p === 'object' && (p as Json).type === 'text' && typeof (p as Json).text === 'string' ? ((p as Json).text as string) : ''))
    .join('')
    .trim();
  return text || undefined;
}

export interface Bridge {
  send(event: Json): void;
  /** Entrega um pedido de permissão e espera a decisão. null = sem decisão (terminal decide). */
  ask(event: Json, cancel: AbortSignal): Promise<'allow' | 'deny' | null>;
}

export function createBridge(cwd: string, fetchImpl: typeof fetch = fetch): Bridge {
  let target = hubTarget();
  const post = async (body: Json, timeoutMs: number, signal?: AbortSignal): Promise<Response | null> => {
    target ??= hubTarget();
    if (!target) return null;
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await fetchImpl(target.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${target.token}` },
        body: JSON.stringify({ cwd, ...body, hub_agent: 'opencode' }),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch {
      // Hub reiniciado com outra porta ou token: relê na próxima.
      target = null;
      return null;
    }
  };
  // Os eventos saem na ordem em que aconteceram: cada envio espera o anterior.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    send(event) {
      queue = queue.then(() => post(event, 4000)).catch(() => undefined);
    },
    async ask(event, cancel) {
      // O pedido entra depois dos eventos que o antecederam, mas não segura a fila enquanto espera a decisão.
      await queue;
      const t = target ?? hubTarget();
      const res = await post({ ...event, hook_event_name: 'PermissionRequest' }, ((t?.approvalTimeoutSec ?? 300) + 20) * 1000, cancel);
      if (!res || !res.ok) return null;
      try {
        const out = (await res.json()) as { hookSpecificOutput?: { decision?: { behavior?: string } } };
        const behavior = out.hookSpecificOutput?.decision?.behavior;
        return behavior === 'allow' ? 'allow' : behavior === 'deny' ? 'deny' : null;
      } catch {
        return null; // corpo vazio: sem decisão
      }
    },
  };
}

/** Pedidos de permissão em andamento no hub, por id do pedido no OpenCode. */
class Pending {
  private readonly map = new Map<string, AbortController>();
  start(id: string): AbortSignal {
    this.map.get(id)?.abort();
    const c = new AbortController();
    this.map.set(id, c);
    return c.signal;
  }
  /** Respondido em outro lugar (terminal): cancela no hub. */
  cancel(id: string): void {
    this.map.get(id)?.abort();
    this.map.delete(id);
  }
  done(id: string): void {
    this.map.delete(id);
  }
}

const DENY_MESSAGE = 'Negado pelo usuário no Claude Hub.';

/**
 * Anuncia a sessão ao hub uma vez. Se o título chegar depois (o evento de
 * criação pode vir depois da primeira ferramenta), anuncia de novo com ele —
 * o hub só atualiza o título, sem mexer no estado.
 */
function sessionStarter(bridge: Bridge): (sessionID: string, title?: string) => void {
  const titles = new Map<string, string | null>();
  return (sessionID, title) => {
    const known = titles.get(sessionID);
    if (known !== undefined && (!title || known === title)) return;
    titles.set(sessionID, title ?? null);
    bridge.send({ session_id: sessionID, hook_event_name: 'SessionStart', source: 'startup', ...(title ? { session_title: title } : {}) });
  };
}

// ───────────────────────────────── V1 ─────────────────────────────────

interface V1Input {
  client: {
    postSessionIdPermissionsPermissionId?: (o: { path: { id: string; permissionID: string }; body: { response: string } }) => Promise<unknown>;
  };
  directory?: string;
  worktree?: string;
}

export function v1Hooks(input: V1Input, bridge = createBridge(input.directory ?? input.worktree ?? process.cwd())): Json {
  const pending = new Pending();
  const start = sessionStarter(bridge);
  return {
    event: async ({ event }: { event: { type?: string; properties?: Json } }) => {
      const p = (event?.properties ?? {}) as Json;
      const sessionID = (typeof p.sessionID === 'string' ? p.sessionID : (p.info as Json | undefined)?.id) as string | undefined;
      switch (event?.type) {
        case 'session.created': {
          const info = (p.info ?? {}) as Json;
          if (typeof info.id === 'string') start(info.id, typeof info.title === 'string' ? info.title : undefined);
          return;
        }
        case 'session.updated': {
          const info = (p.info ?? {}) as Json;
          if (typeof info.id === 'string' && typeof info.title === 'string') start(info.id, info.title);
          return;
        }
        case 'session.idle':
          if (sessionID) bridge.send({ session_id: sessionID, hook_event_name: 'Stop' });
          return;
        case 'session.error':
          if (sessionID) bridge.send({ session_id: sessionID, hook_event_name: 'StopFailure', error: JSON.stringify(p.error ?? 'erro').slice(0, 500) });
          return;
        case 'session.deleted':
          if (sessionID) bridge.send({ session_id: sessionID, hook_event_name: 'SessionEnd', reason: 'deleted' });
          return;
        case 'todo.updated':
          if (sessionID && Array.isArray(p.todos)) bridge.send({ session_id: sessionID, hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: { todos: p.todos } });
          return;
        case 'permission.asked':
        case 'permission.updated': {
          const id = typeof p.id === 'string' ? p.id : null;
          if (!id || !sessionID) return;
          start(sessionID);
          const signal = pending.start(id);
          // Não espera aqui: o OpenCode entrega os eventos um a um, e a resposta
          // dada no terminal (permission.replied) precisa chegar enquanto isto aguarda.
          void bridge
            .ask({ session_id: sessionID, ...permissionRequest(p), tool_use_id: id }, signal)
            .then(async (decision) => {
              pending.done(id);
              if (!decision || signal.aborted) return;
              await input.client.postSessionIdPermissionsPermissionId?.({
                path: { id: sessionID, permissionID: id },
                body: { response: decision === 'allow' ? 'once' : 'reject' },
              });
            })
            .catch(() => undefined);
          return;
        }
        case 'permission.replied': {
          const id = (p.requestID ?? p.permissionID) as string | undefined;
          if (typeof id === 'string') pending.cancel(id);
          return;
        }
        default:
      }
    },
    'chat.message': async (msg: Json, out: Json) => {
      const sessionID = typeof msg.sessionID === 'string' ? msg.sessionID : undefined;
      if (!sessionID) return;
      start(sessionID);
      const prompt = textOf(out?.parts);
      bridge.send({ session_id: sessionID, hook_event_name: 'UserPromptSubmit', ...(prompt ? { prompt } : {}) });
    },
    'tool.execute.before': async (i: Json, out: Json) => {
      if (typeof i.sessionID !== 'string') return;
      start(i.sessionID);
      bridge.send({ session_id: i.sessionID, hook_event_name: 'PreToolUse', tool_name: toolName(i.tool), tool_input: toolInput(i.tool, out?.args), tool_use_id: i.callID });
    },
    'tool.execute.after': async (i: Json) => {
      if (typeof i.sessionID !== 'string') return;
      bridge.send({ session_id: i.sessionID, hook_event_name: 'PostToolUse', tool_name: toolName(i.tool), tool_input: toolInput(i.tool, i.args), tool_use_id: i.callID });
    },
  };
}

// ───────────────────────────────── V2 ─────────────────────────────────

interface V2Context {
  location?: { directory?: string };
  event: { subscribe: (o?: { types?: string[]; signal?: AbortSignal }) => AsyncIterable<{ type: string; data?: Json; properties?: Json }> };
  tool: { hook: (name: 'execute.before' | 'execute.after', cb: (e: Json) => void | Promise<void>) => Promise<{ dispose: () => Promise<void> }> };
  permission: { reply: (i: { sessionID: string; requestID: string; decision: string; message?: string }) => Promise<unknown> };
}

export const V2_EVENTS = [
  'session.created',
  'session.renamed',
  'session.execution.started',
  'session.idle',
  'session.execution.succeeded',
  'session.execution.interrupted',
  'session.execution.failed',
  'session.deleted',
  'permission.asked',
  'permission.replied',
];

export async function v2Setup(ctx: V2Context, bridge = createBridge(ctx.location?.directory ?? process.cwd())): Promise<() => Promise<void>> {
  const pending = new Pending();
  const stop = new AbortController();
  const start = sessionStarter(bridge);

  const handle = async (type: string, d: Json) => {
    const sessionID = typeof d.sessionID === 'string' ? d.sessionID : undefined;
    if (!sessionID) return;
    switch (type) {
      case 'session.created':
        start(sessionID, typeof d.title === 'string' ? d.title : undefined);
        return;
      case 'session.renamed':
        start(sessionID, typeof d.title === 'string' ? d.title : undefined);
        return;
      case 'session.execution.started':
        start(sessionID);
        bridge.send({ session_id: sessionID, hook_event_name: 'UserPromptSubmit' });
        return;
      // V2 2.x anuncia o fim da execução com execution.succeeded/interrupted;
      // session.idle fica para versões que ainda o emitem.
      case 'session.idle':
      case 'session.execution.succeeded':
      case 'session.execution.interrupted':
        bridge.send({ session_id: sessionID, hook_event_name: 'Stop' });
        return;
      case 'session.execution.failed':
        bridge.send({ session_id: sessionID, hook_event_name: 'StopFailure', error: JSON.stringify(d.error ?? 'erro').slice(0, 500) });
        return;
      case 'session.deleted':
        bridge.send({ session_id: sessionID, hook_event_name: 'SessionEnd', reason: 'deleted' });
        return;
      case 'permission.asked': {
        const id = typeof d.id === 'string' ? d.id : null;
        if (!id) return;
        start(sessionID);
        const signal = pending.start(id);
        const decision = await bridge.ask({ session_id: sessionID, ...permissionRequest(d), tool_use_id: id }, signal);
        pending.done(id);
        if (!decision || signal.aborted) return;
        await ctx.permission.reply({
          sessionID,
          requestID: id,
          decision: decision === 'allow' ? 'once' : 'reject',
          ...(decision === 'deny' ? { message: DENY_MESSAGE } : {}),
        });
        return;
      }
      case 'permission.replied':
        if (typeof d.requestID === 'string') pending.cancel(d.requestID);
        return;
      default:
    }
  };

  const before = await ctx.tool.hook('execute.before', (e) => {
    if (typeof e.sessionID !== 'string') return;
    start(e.sessionID);
    bridge.send({ session_id: e.sessionID, hook_event_name: 'PreToolUse', tool_name: toolName(e.tool), tool_input: toolInput(e.tool, e.input), tool_use_id: e.id });
  });
  const after = await ctx.tool.hook('execute.after', (e) => {
    if (typeof e.sessionID !== 'string') return;
    bridge.send({ session_id: e.sessionID, hook_event_name: 'PostToolUse', tool_name: toolName(e.tool), tool_input: toolInput(e.tool, e.input), tool_use_id: e.id });
  });

  void (async () => {
    try {
      for await (const ev of ctx.event.subscribe({ types: V2_EVENTS, signal: stop.signal })) {
        // Pedidos de permissão esperam a decisão: não seguram os demais eventos.
        void handle(ev.type, (ev.data ?? ev.properties ?? {}) as Json).catch(() => undefined);
      }
    } catch {
      /* fim da assinatura: o OpenCode está saindo ou recarregando o plugin */
    }
  })();

  return async () => {
    stop.abort();
    await Promise.allSettled([before.dispose(), after.dispose()]);
  };
}

// ─────────────────────────────── Entrada ───────────────────────────────

/** V1 lê `server`; V2 lê `id` + `setup`. As duas ignoram o que não usam. */
const plugin = {
  id: 'claude-hub',
  server: async (input: V1Input) => v1Hooks(input),
  setup: async (ctx: V2Context) => v2Setup(ctx),
};

export default plugin;
