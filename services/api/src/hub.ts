/**
 * Núcleo do Claude Hub: recebe eventos de hook, mantém o estado das sessões,
 * guarda pedidos de aprovação à espera de resposta e avisa os clientes.
 *
 * O hub só observa e responde a pedidos de permissão que o próprio Claude Code
 * fez. Ele nunca inicia agentes nem executa comandos.
 */
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  APPROVAL_MODES,
  SELFTEST_PREFIX,
  truncate,
  type Approval,
  type ApprovalDecision,
  type ApprovalStatus,
  type HubAlert,
  type HubEvent,
  type HubSettings,
  type ServerMessage,
  type Session,
  type UsageStats,
  type AgentKind,
} from '@claude-hub/shared';
import {
  QUESTION_TOOLS,
  describeToolCall,
  reduceHook,
  toolLabel,
  type HookPayload,
} from '@claude-hub/claude-bridge';
import type { Audit } from './audit.js';
import type { Db } from './db.js';
import type { PushPayload, PushSender } from './push.js';

/** Resposta entregue ao Claude Code para um hook PermissionRequest. */
export interface PermissionHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision: { behavior: 'allow' } | { behavior: 'deny'; message: string };
  };
}

export interface HeldApproval {
  approval: Approval;
  /** Resolve com a decisão, ou null se expirar/cancelar (o terminal volta a perguntar). */
  result: Promise<PermissionHookOutput | null>;
  /** O Claude Code fechou a conexão: respondido no terminal ou turno interrompido. */
  abandon(): void;
}

export type DecideResult =
  | { ok: true; approval: Approval }
  | { ok: false; reason: 'not_found' | 'already_decided' | 'expired' };

interface ApprovalRow {
  id: string;
  session_id: string;
  project_name: string;
  session_title: string;
  tool_name: string;
  command: string;
  tool_input: string;
  cwd: string;
  created_at: number;
  expires_at: number;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: number | null;
  agent_kind: AgentKind;
}

function rowToApproval(r: ApprovalRow): Approval {
  return {
    id: r.id,
    sessionId: r.session_id,
    agentKind: r.agent_kind,
    projectName: r.project_name,
    sessionTitle: r.session_title,
    toolName: r.tool_name,
    command: r.command,
    toolInput: JSON.parse(r.tool_input) as unknown,
    cwd: r.cwd,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    status: r.status,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
  };
}

/** Como o agente aparece nos avisos: "Claude quer usar…", "Codex quer usar…". */
export function agentShortName(kind: AgentKind | undefined): string {
  return kind === 'codex' ? 'Codex' : kind === 'opencode' ? 'OpenCode' : 'Claude';
}

const STALE_SESSION_MS = 6 * 60 * 60 * 1000;
const EVENT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** Sem atividade no Mac por este tempo, o modo automático considera você longe. */
export const AWAY_IDLE_SECONDS = 120;

export interface HubOptions {
  db: Db;
  audit: Audit;
  push: PushSender | null;
  approvalTimeoutSec: number;
  now?: () => number;
}

export class Hub {
  private readonly db: Db;
  private readonly audit: Audit;
  private readonly push: PushSender | null;
  private readonly approvalTimeoutMs: number;
  private readonly now: () => number;

  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<(msg: ServerMessage) => void>();
  private readonly waiters = new Map<
    string,
    { resolve: (out: PermissionHookOutput | null) => void; timer: NodeJS.Timeout }
  >();
  private settings: HubSettings;
  private macClients = 0;
  private macIdleSeconds = 0;
  /** Último evento de hook vindo de uma sessão real (não do autoteste). */
  private lastHookAt: number | null = null;
  private lastHookSavedAt = 0;

  constructor(opts: HubOptions) {
    this.db = opts.db;
    this.audit = opts.audit;
    this.push = opts.push;
    this.approvalTimeoutMs = opts.approvalTimeoutSec * 1000;
    this.now = opts.now ?? Date.now;
    this.settings = this.loadSettings();
    const last = this.db.prepare("SELECT value FROM settings WHERE key = 'lastHookAt'").get() as { value: string } | undefined;
    this.lastHookAt = last ? Number(last.value) || null : null;
    this.recover();
  }

  /** Quando chegou o último evento de uma sessão real do Claude Code. */
  getLastHookAt(): number | null {
    return this.lastHookAt;
  }

  private noteRealHook(now: number): void {
    this.lastHookAt = now;
    // Persistir a cada evento seria desperdício: basta de tempos em tempos.
    if (now - this.lastHookSavedAt > 30_000) {
      this.lastHookSavedAt = now;
      this.db
        .prepare("INSERT INTO settings (key, value) VALUES ('lastHookAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(now));
    }
  }

  // ───────────────────────────── Inicialização ─────────────────────────────

  private loadSettings(): HubSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'hub'").get() as
      | { value: string }
      | undefined;
    if (!row) return { ...DEFAULT_SETTINGS };
    try {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.value) as Partial<HubSettings>) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  private recover(): void {
    const now = this.now();
    // Pedidos que estavam pendentes quando o hub caiu perderam a conexão com o
    // Claude Code: não podem mais ser respondidos por aqui.
    const orphans = this.db.prepare("SELECT id, session_id FROM approvals WHERE status = 'pending'").all() as unknown as Array<{
      id: string;
      session_id: string;
    }>;
    for (const o of orphans) {
      this.db.prepare("UPDATE approvals SET status = 'cancelled' WHERE id = ?").run(o.id);
      this.audit.record({
        at: now,
        actor: 'hub',
        action: 'approval.cancelled',
        approvalId: o.id,
        sessionId: o.session_id,
        detail: 'hub reiniciado',
      });
    }
    this.db.prepare('DELETE FROM events WHERE at < ?').run(now - EVENT_RETENTION_MS);
    const rows = this.db
      .prepare('SELECT json FROM sessions WHERE ended_at IS NULL AND updated_at > ?')
      .all(now - STALE_SESSION_MS) as unknown as Array<{ json: string }>;
    for (const r of rows) {
      const s = JSON.parse(r.json) as Session;
      s.pendingApprovals = 0;
      this.sessions.set(s.id, s);
    }
  }

  // ─────────────────────────────── Assinantes ───────────────────────────────

  subscribe(fn: (msg: ServerMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private broadcast(msg: ServerMessage): void {
    for (const fn of this.listeners) {
      try {
        fn(msg);
      } catch {
        /* um cliente com problema não derruba os outros */
      }
    }
  }

  snapshot(): ServerMessage {
    return {
      type: 'snapshot',
      protocol: 1,
      sessions: this.listSessions(),
      approvals: this.listApprovals('pending'),
      settings: this.getSettings(),
      serverTime: this.now(),
    };
  }

  // ──────────────────────────────── Presença ────────────────────────────────

  macConnected(): void {
    this.macClients++;
  }
  macDisconnected(): void {
    this.macClients = Math.max(0, this.macClients - 1);
  }
  setMacIdle(seconds: number): void {
    if (Number.isFinite(seconds) && seconds >= 0) this.macIdleSeconds = seconds;
  }

  /** Há um app macOS conectado agora? */
  hasMacClient(): boolean {
    return this.macClients > 0;
  }

  /** Você está longe do computador? */
  isAway(): boolean {
    return this.settings.away || this.macClients === 0 || this.macIdleSeconds >= AWAY_IDLE_SECONDS;
  }

  /** Este alerta deve ir para o celular? */
  private phoneWanted(): boolean {
    return this.settings.approvalMode !== 'auto' || this.isAway();
  }

  // ─────────────────────────────── Configuração ─────────────────────────────

  getSettings(): HubSettings {
    return { ...this.settings };
  }

  updateSettings(patch: unknown, actor: string): HubSettings {
    const p = (patch ?? {}) as Partial<Record<keyof HubSettings, unknown>>;
    const next = { ...this.settings };
    if (typeof p.approvalMode === 'string' && (APPROVAL_MODES as readonly string[]).includes(p.approvalMode)) {
      next.approvalMode = p.approvalMode as HubSettings['approvalMode'];
    }
    if (typeof p.away === 'boolean') next.away = p.away;
    if (next.approvalMode !== this.settings.approvalMode || next.away !== this.settings.away) {
      this.settings = next;
      this.db
        .prepare("INSERT INTO settings (key, value) VALUES ('hub', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(JSON.stringify(next));
      this.audit.record({ at: this.now(), actor, action: 'settings.changed', detail: JSON.stringify(next) });
      this.broadcast({ type: 'settings', settings: this.getSettings() });
    }
    return this.getSettings();
  }

  // ───────────────────────────────── Sessões ────────────────────────────────

  listSessions(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  private saveSession(s: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, json, updated_at, ended_at) VALUES (?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at, ended_at = excluded.ended_at`,
      )
      .run(s.id, JSON.stringify(s), s.updatedAt, s.endedAt);
  }

  private publishSession(s: Session): void {
    this.saveSession(s);
    if (s.endedAt) {
      this.sessions.delete(s.id);
      this.broadcast({ type: 'session_removed', sessionId: s.id });
    } else {
      this.sessions.set(s.id, s);
      this.broadcast({ type: 'session', session: s });
    }
  }

  /** Remove da lista uma sessão que você não quer mais ver. */
  dismissSession(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.cancelApprovals(id, () => true, 'sessão dispensada');
    this.publishSession({ ...s, endedAt: this.now(), pendingApprovals: 0 });
    return true;
  }

  /** Encerra sessões que pararam de emitir eventos (terminal fechado à força). */
  sweep(): void {
    const now = this.now();
    for (const s of this.sessions.values()) {
      if (now - s.updatedAt > STALE_SESSION_MS) this.dismissSession(s.id);
    }
  }

  private addEvent(sessionId: string, at: number, type: string, summary: string, toolName: string | null): HubEvent {
    const r = this.db
      .prepare('INSERT INTO events (session_id, at, type, summary, tool_name) VALUES (?,?,?,?,?)')
      .run(sessionId, at, type, summary, toolName);
    const event: HubEvent = { id: Number(r.lastInsertRowid), sessionId, at, type, summary, toolName };
    this.broadcast({ type: 'event', event });
    return event;
  }

  listEvents(opts: { sessionId?: string; limit?: number; before?: number } = {}): HubEvent[] {
    const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
    const before = opts.before ?? Number.MAX_SAFE_INTEGER;
    const rows = (
      opts.sessionId
        ? this.db
            .prepare('SELECT * FROM events WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
            .all(opts.sessionId, before, limit)
        : this.db.prepare('SELECT * FROM events WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit)
    ) as unknown as Array<{ id: number; session_id: string; at: number; type: string; summary: string; tool_name: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      at: r.at,
      type: r.type,
      summary: r.summary,
      toolName: r.tool_name,
    }));
  }

  // ───────────────────────────── Entrada de hooks ───────────────────────────

  /**
   * Processa um evento de hook. Para PermissionRequest que deve esperar uma
   * resposta remota, devolve `held`; o chamador mantém a requisição aberta.
   */
  ingestHook(payload: HookPayload): { held: HeldApproval | null } {
    const now = this.now();
    if (!payload.session_id.startsWith(SELFTEST_PREFIX)) this.noteRealHook(now);
    const prev = this.sessions.get(payload.session_id);
    const { session, event, alerts } = reduceHook(prev, payload, now);
    const name = payload.hook_event_name;

    // Pedidos pendentes que deixaram de fazer sentido.
    if (name === 'Stop' || name === 'StopFailure' || name === 'UserPromptSubmit' || name === 'SessionEnd') {
      this.cancelApprovals(session.id, () => true, 'turno encerrado');
    } else if (name === 'PostToolUse' || name === 'PostToolUseFailure' || name === 'PermissionDenied') {
      const key = JSON.stringify(payload.tool_input ?? null);
      this.cancelApprovals(
        session.id,
        (a) => a.toolName === payload.tool_name && JSON.stringify(a.toolInput ?? null) === key,
        'respondido no Claude Code',
      );
    }

    let held: HeldApproval | null = null;
    const tool = payload.tool_name ?? 'ferramenta';
    if (name === 'PermissionRequest' && !QUESTION_TOOLS.has(tool)) {
      const title = `${agentShortName(session.agentKind)} quer usar ${toolLabel(tool)}`;
      const command = describeToolCall(tool, payload.tool_input);
      if (this.settings.approvalMode === 'notify') {
        // "Só avisar": o pedido continua no terminal do Claude Code.
        alerts.push({ kind: 'approval', sessionId: session.id, title, body: command, at: now });
      } else {
        held = this.createApproval(session, tool, payload.tool_input, command, now);
        alerts.push({
          kind: 'approval',
          sessionId: session.id,
          title,
          body: command,
          approvalId: held.approval.id,
          at: now,
        });
      }
    }

    session.pendingApprovals = this.countPending(session.id);
    this.publishSession(session);
    if (event) this.addEvent(session.id, now, event.type, event.summary, event.toolName);
    for (const a of alerts) this.deliverAlert(a);
    return { held };
  }

  private deliverAlert(alert: HubAlert): void {
    this.broadcast({ type: 'alert', alert });
    // O autoteste percorre o caminho inteiro, mas não incomoda o celular.
    if (alert.sessionId.startsWith(SELFTEST_PREFIX)) return;
    if (!this.push || !this.phoneWanted()) return;
    const payload: PushPayload = {
      kind: alert.kind,
      title: alert.title,
      body: truncate(alert.body, 180),
      url: alert.approvalId ? `/?approval=${alert.approvalId}` : `/?session=${alert.sessionId}`,
      tag: alert.approvalId ?? `${alert.kind}:${alert.sessionId}`,
    };
    void this.push.send(payload).catch(() => {});
  }

  // ──────────────────────────────── Aprovações ──────────────────────────────

  private countPending(sessionId: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM approvals WHERE session_id = ? AND status = 'pending'")
      .get(sessionId) as { n: number };
    return r.n;
  }

  private createApproval(session: Session, toolName: string, toolInput: unknown, command: string, now: number): HeldApproval {
    const approval: Approval = {
      id: `apr_${randomBytes(16).toString('hex')}`,
      sessionId: session.id,
      agentKind: session.agentKind,
      projectName: session.projectName,
      sessionTitle: session.title,
      toolName,
      command,
      toolInput: toolInput ?? null,
      cwd: session.cwd,
      createdAt: now,
      expiresAt: now + this.approvalTimeoutMs,
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO approvals (id, session_id, project_name, session_title, tool_name, command, tool_input, cwd, created_at, expires_at, status, agent_kind)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?)`,
      )
      .run(
        approval.id,
        approval.sessionId,
        approval.projectName,
        approval.sessionTitle,
        approval.toolName,
        approval.command,
        JSON.stringify(approval.toolInput),
        approval.cwd,
        approval.createdAt,
        approval.expiresAt,
        approval.agentKind ?? 'claude-code',
      );
    this.audit.record({
      at: now,
      actor: session.agentKind,
      action: 'approval.created',
      approvalId: approval.id,
      sessionId: session.id,
      detail: `${toolName}: ${truncate(command, 400)}`,
    });

    let resolve!: (out: PermissionHookOutput | null) => void;
    const result = new Promise<PermissionHookOutput | null>((r) => (resolve = r));
    const timer = setTimeout(() => this.closeApproval(approval.id, 'expired', 'tempo esgotado'), this.approvalTimeoutMs);
    timer.unref?.();
    this.waiters.set(approval.id, { resolve, timer });
    this.broadcast({ type: 'approval', approval });
    return {
      approval,
      result,
      abandon: () => this.closeApproval(approval.id, 'cancelled', 'respondido no Claude Code'),
    };
  }

  getApproval(id: string): Approval | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as unknown as ApprovalRow | undefined;
    return row ? rowToApproval(row) : null;
  }

  listApprovals(status?: ApprovalStatus, limit = 100): Approval[] {
    const lim = Math.min(500, Math.max(1, limit));
    const rows = (
      status
        ? this.db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, lim)
        : this.db.prepare('SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?').all(lim)
    ) as unknown as ApprovalRow[];
    return rows.map(rowToApproval);
  }

  /**
   * Registra a decisão de um pedido. A troca de estado é um UPDATE condicional
   * único: só a primeira decisão válida, dentro do prazo, tem efeito.
   */
  decide(id: string, decision: ApprovalDecision, actor: string): DecideResult {
    const now = this.now();
    const status: ApprovalStatus = decision === 'allow' ? 'allowed' : 'denied';
    const r = this.db
      .prepare(
        "UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?",
      )
      .run(status, actor, now, id, now);
    const approval = this.getApproval(id);
    if (r.changes !== 1 || !approval) {
      const reason = !approval ? 'not_found' : approval.status === 'pending' || approval.status === 'expired' ? 'expired' : 'already_decided';
      this.audit.record({
        at: now,
        actor,
        action: 'approval.decision_rejected',
        approvalId: id,
        sessionId: approval?.sessionId ?? null,
        detail: `${decision}: ${reason}`,
      });
      return { ok: false, reason };
    }
    this.audit.record({
      at: now,
      actor,
      action: `approval.${status}`,
      approvalId: id,
      sessionId: approval.sessionId,
      detail: `${approval.toolName}: ${truncate(approval.command, 400)}`,
    });
    const waiter = this.waiters.get(id);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(id);
      waiter.resolve({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision:
            decision === 'allow'
              ? { behavior: 'allow' }
              : { behavior: 'deny', message: 'Negado pelo usuário no Claude Hub.' },
        },
      });
    }
    this.broadcast({ type: 'approval', approval });
    this.afterApprovalClosed(approval, decision === 'allow' ? 'Permitido' : 'Negado', now);
    return { ok: true, approval };
  }

  /** Fecha um pedido sem decisão (expirou ou foi resolvido em outro lugar). */
  private closeApproval(id: string, status: 'expired' | 'cancelled', why: string): void {
    const now = this.now();
    const r = this.db.prepare("UPDATE approvals SET status = ? WHERE id = ? AND status = 'pending'").run(status, id);
    const waiter = this.waiters.get(id);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(id);
      waiter.resolve(null);
    }
    if (r.changes !== 1) return;
    const approval = this.getApproval(id);
    if (!approval) return;
    this.audit.record({
      at: now,
      actor: 'hub',
      action: `approval.${status}`,
      approvalId: id,
      sessionId: approval.sessionId,
      detail: why,
    });
    this.broadcast({ type: 'approval', approval });
    this.afterApprovalClosed(approval, status === 'expired' ? 'Pedido expirou' : null, now);
  }

  private cancelApprovals(sessionId: string, match: (a: Approval) => boolean, why: string): void {
    const rows = this.db
      .prepare("SELECT * FROM approvals WHERE session_id = ? AND status = 'pending'")
      .all(sessionId) as unknown as ApprovalRow[];
    for (const row of rows) {
      const a = rowToApproval(row);
      if (match(a)) this.closeApproval(a.id, 'cancelled', why);
    }
  }

  private afterApprovalClosed(approval: Approval, note: string | null, now: number): void {
    const s = this.sessions.get(approval.sessionId);
    if (!s) return;
    const pending = this.countPending(s.id);
    const next: Session = { ...s, pendingApprovals: pending, updatedAt: now };
    if (pending === 0 && next.status === 'APPROVAL_REQUIRED' && approval.status !== 'expired') {
      next.status = 'WORKING';
    }
    if (note) {
      const summary = `${note}: ${truncate(approval.command, 120)}`;
      next.lastEvent = { type: 'Approval', summary, at: now };
      this.publishSession(next);
      this.addEvent(s.id, now, 'Approval', summary, approval.toolName);
    } else {
      this.publishSession(next);
    }
  }

  // ─────────────────────────────────── Uso ──────────────────────────────────

  usage(since: number): UsageStats {
    const count = (type: string) =>
      (this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ? AND at >= ?').get(type, since) as { n: number }).n;
    const approvals = (status: string) =>
      (
        this.db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE status = ? AND created_at >= ?').get(status, since) as {
          n: number;
        }
      ).n;
    const byTool = this.db
      .prepare(
        "SELECT tool_name AS tool, COUNT(*) AS count FROM events WHERE type = 'PreToolUse' AND at >= ? AND tool_name IS NOT NULL GROUP BY tool_name ORDER BY count DESC LIMIT 8",
      )
      .all(since) as unknown as Array<{ tool: string; count: number }>;
    const rows = this.db.prepare('SELECT json FROM sessions WHERE updated_at >= ?').all(since) as unknown as Array<{ json: string }>;
    const now = this.now();
    let activeMs = 0;
    for (const r of rows) {
      const s = JSON.parse(r.json) as Session;
      activeMs += s.activeMs + (s.activeSince && !s.endedAt ? Math.max(0, now - s.activeSince) : 0);
    }
    return {
      since,
      sessions: rows.length,
      prompts: count('UserPromptSubmit'),
      toolCalls: count('PreToolUse'),
      approvalsAllowed: approvals('allowed'),
      approvalsDenied: approvals('denied'),
      activeMs,
      byTool,
    };
  }

  /** Encerra temporizadores e libera hooks em espera (desligamento do hub). */
  close(): void {
    for (const [id, w] of this.waiters) {
      clearTimeout(w.timer);
      w.resolve(null);
      this.waiters.delete(id);
    }
    this.listeners.clear();
  }
}
