/**
 * Leitor do arquivo de sessão do Codex ("rollout", JSONL que o próprio Codex
 * grava em $CODEX_HOME/sessions/…). Os hooks do Codex não informam consumo,
 * limites, plano nem erro do turno; esse arquivo informa, e é a mesma fonte que
 * o Codex usa para retomar uma sessão. O caminho chega pelo `transcript_path`
 * dos próprios hooks.
 *
 * Linhas aproveitadas (formato `{"timestamp", "type", "payload"}`):
 *  - turn_context            → modelo em uso
 *  - event_msg/token_count   → tokens acumulados (total_token_usage) e limites do plano
 *  - response_item/function_call `update_plan` → progresso (lista do plano)
 *  - event_msg/turn_complete com `error`       → turno com erro (o Codex não chama o hook Stop nesse caso)
 *  - event_msg/turn_aborted  → turno interrompido
 *
 * Só lê; nunca escreve no diretório do Codex. Caminhos fora de
 * $CODEX_HOME/sessions são ignorados.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { LimitWindowStats } from '@claude-hub/shared';
import { codexHome, type HookPayload } from '@claude-hub/claude-bridge';
import { windowLabel, type AgentUsageStore } from './agent-usage.js';

interface Tracked {
  path: string;
  offset: number;
  rest: string;
  model: string | null;
  /** Último total acumulado visto; null = ainda sem base (não conta o que veio antes). */
  total: Totals | null;
  lastSeen: number;
}

interface Totals {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

type Json = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const MAX_READ = 4 * 1024 * 1024;

export interface CodexRolloutOptions {
  usage: AgentUsageStore;
  /** Encaminha eventos sintetizados ao hub (mesmo formato dos hooks). */
  emit: (payload: HookPayload) => void;
  home?: () => string;
  intervalMs?: number;
  now?: () => number;
}

export class CodexRolloutReader {
  private readonly tracked = new Map<string, Tracked>();
  private timer: NodeJS.Timeout | null = null;
  private readonly home: () => string;
  private readonly now: () => number;

  constructor(private readonly opts: CodexRolloutOptions) {
    this.home = opts.home ?? codexHome;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.opts.intervalMs ?? 1500);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** O caminho só vale se estiver dentro de $CODEX_HOME/sessions. */
  private allowed(path: string): string | null {
    try {
      if (!/\.jsonl$/.test(path) || !existsSync(path)) return null;
      const real = realpathSync(path);
      const root = realpathSync(join(this.home(), 'sessions'));
      return real.startsWith(root + sep) ? real : null;
    } catch {
      return null;
    }
  }

  /** Chamado para cada evento de hook recebido. */
  observe(p: HookPayload): void {
    if (p.hub_agent !== 'codex') return;
    const id = p.session_id;
    let t = this.tracked.get(id);
    if (!t && typeof p.transcript_path === 'string') {
      const path = this.allowed(p.transcript_path);
      if (path) {
        // Sessão nova: lê desde o começo. Sessão retomada (ou hub reiniciado no
        // meio): começa do fim, para não contar de novo o que já foi contado.
        const fresh = p.hook_event_name === 'SessionStart' && p.source !== 'resume';
        t = { path, offset: fresh ? 0 : this.size(path), rest: '', model: null, total: fresh ? zero() : null, lastSeen: this.now() };
        this.tracked.set(id, t);
      }
    }
    if (!t) return;
    t.lastSeen = this.now();
    if (p.hook_event_name === 'Stop' || p.hook_event_name === 'SessionEnd') this.read(id, t);
    if (p.hook_event_name === 'SessionEnd') this.tracked.delete(id);
  }

  poll(): void {
    const now = this.now();
    for (const [id, t] of this.tracked) {
      this.read(id, t);
      // Sessão parada há mais de 2 h: deixa de acompanhar.
      if (now - t.lastSeen > 2 * 3600_000) this.tracked.delete(id);
    }
  }

  private size(path: string): number {
    try {
      const fd = openSync(path, 'r');
      try {
        return fstatSync(fd).size;
      } finally {
        closeSync(fd);
      }
    } catch {
      return 0;
    }
  }

  /** Lê o que foi acrescentado desde a última leitura. */
  read(id: string, t: Tracked): void {
    let fd: number;
    try {
      fd = openSync(t.path, 'r');
    } catch {
      return;
    }
    try {
      const size = fstatSync(fd).size;
      if (size < t.offset) {
        // Arquivo reescrito: recomeça sem base, para não contar duas vezes.
        t.offset = 0;
        t.rest = '';
        t.total = null;
      }
      while (t.offset < size) {
        const len = Math.min(size - t.offset, MAX_READ);
        const buf = Buffer.alloc(len);
        const got = readSync(fd, buf, 0, len, t.offset);
        if (got <= 0) break;
        t.offset += got;
        const text = t.rest + buf.subarray(0, got).toString('utf8');
        const lines = text.split('\n');
        t.rest = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) this.line(id, t, line);
      }
    } finally {
      closeSync(fd);
    }
  }

  private line(id: string, t: Tracked, raw: string): void {
    let row: Json;
    try {
      row = JSON.parse(raw) as Json;
    } catch {
      return;
    }
    const payload = (row.payload ?? {}) as Json;
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    t.lastSeen = this.now();
    if (row.type === 'turn_context') {
      if (typeof payload.model === 'string') t.model = payload.model.slice(0, 80);
      return;
    }
    if (row.type === 'response_item' && payload.type === 'function_call' && payload.name === 'update_plan') {
      this.plan(id, payload.arguments);
      return;
    }
    if (row.type !== 'event_msg') return;
    switch (payload.type) {
      case 'token_count':
        this.tokens(t, payload.info as Json | null);
        this.limits(payload.rate_limits as Json | null, Number.isFinite(at) ? at : this.now());
        return;
      // 0.171 grava `task_complete`; versões novas, `turn_complete`. Os dois trazem `error` quando o turno falha.
      case 'task_complete':
      case 'turn_complete': {
        const err = payload.error as Json | null | undefined;
        if (err && typeof err === 'object') {
          this.opts.emit({ session_id: id, hook_event_name: 'StopFailure', hub_agent: 'codex', error: readableError(err.message) });
        }
        return;
      }
      case 'turn_aborted':
        this.opts.emit({ session_id: id, hook_event_name: 'Stop', hub_agent: 'codex', last_assistant_message: 'Interrompido' });
        return;
      default:
    }
  }

  private tokens(t: Tracked, info: Json | null): void {
    const total = info?.total_token_usage as Json | undefined;
    if (!total) return;
    const now: Totals = {
      input: num(total.input_tokens),
      cached: num(total.cached_input_tokens),
      cacheWrite: num(total.cache_write_input_tokens),
      output: num(total.output_tokens),
      reasoning: num(total.reasoning_output_tokens),
    };
    const prev = t.total;
    t.total = now;
    // Sem base, ou total menor (compactação reinicia a contagem): só registra a base.
    if (!prev || now.input < prev.input || now.output < prev.output) return;
    const dInput = now.input - prev.input;
    const dCached = now.cached - prev.cached;
    this.opts.usage.record({
      agent: 'codex',
      model: t.model,
      // O Codex conta a entrada já incluindo o que veio do cache.
      input: Math.max(0, dInput - Math.max(0, dCached)),
      cacheRead: Math.max(0, dCached),
      cacheWrite: Math.max(0, now.cacheWrite - prev.cacheWrite),
      output: now.output - prev.output,
      reasoning: Math.max(0, now.reasoning - prev.reasoning),
    });
  }

  private limits(rl: Json | null, at: number): void {
    if (!rl || typeof rl !== 'object') return;
    const windows: LimitWindowStats[] = [];
    for (const id of ['primary', 'secondary'] as const) {
      const w = rl[id] as Json | null | undefined;
      if (!w || typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) continue;
      const minutes = typeof w.window_minutes === 'number' ? w.window_minutes : null;
      let resetsAt: number | null = null;
      if (typeof w.resets_at === 'number' && w.resets_at > 0) resetsAt = Math.round(w.resets_at * 1000);
      else if (typeof w.resets_in_seconds === 'number' && w.resets_in_seconds >= 0) resetsAt = Math.round(at + w.resets_in_seconds * 1000);
      windows.push({ id, label: windowLabel(minutes), usedPercent: w.used_percent, resetsAt });
    }
    this.opts.usage.setLimits('codex', windows);
  }

  private plan(id: string, args: unknown): void {
    let parsed: Json;
    try {
      parsed = (typeof args === 'string' ? JSON.parse(args) : args) as Json;
    } catch {
      return;
    }
    const plan = Array.isArray(parsed?.plan) ? (parsed.plan as Json[]) : null;
    if (!plan) return;
    const todos = plan
      .filter((p) => typeof p.step === 'string')
      .map((p) => ({ content: String(p.step).slice(0, 200), status: p.status === 'completed' || p.status === 'in_progress' ? p.status : 'pending' }));
    this.opts.emit({ session_id: id, hook_event_name: 'PreToolUse', hub_agent: 'codex', tool_name: 'TodoWrite', tool_input: { todos } });
  }

  close(): void {
    this.stop();
    this.tracked.clear();
  }
}

/** O Codex repassa o corpo de erro do servidor como texto JSON; mostra só a mensagem. */
export function readableError(message: unknown): string {
  if (typeof message !== 'string' || !message) return 'O turno falhou';
  try {
    const parsed = JSON.parse(message) as { error?: { message?: unknown }; message?: unknown };
    const inner = parsed?.error?.message ?? parsed?.message;
    if (typeof inner === 'string' && inner) return inner.slice(0, 500);
  } catch {
    /* não é JSON: usa como veio */
  }
  return message.slice(0, 500);
}

function zero(): Totals {
  return { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
}
