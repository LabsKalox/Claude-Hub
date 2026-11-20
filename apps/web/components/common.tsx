'use client';
import { useState } from 'react';
import {
  APPROVAL_MODES,
  APPROVAL_MODE_HINT,
  APPROVAL_MODE_LABEL,
  STATUS_COLOR,
  STATUS_LABEL,
  formatAgo,
  formatDuration,
  progressPercent,
  sessionActiveMs,
  type Approval,
  type ApprovalDecision,
  type HubSettings,
  type Session,
  type SessionStatus,
  AGENT_LABEL,
} from '@claude-hub/shared';
import { HubError, hub } from '@/lib/hub';

export function StatusDot({ status, size = 8 }: { status: SessionStatus; size?: number }) {
  const pulsing = status === 'WORKING' || status === 'APPROVAL_REQUIRED' || status === 'WAITING';
  return (
    <span
      className={pulsing ? 'dot pulse' : 'dot'}
      style={{ width: size, height: size, background: STATUS_COLOR[status] }}
      title={STATUS_LABEL[status]}
    />
  );
}

export function toolTitle(a: Pick<Approval, 'toolName' | 'agentKind'>): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(a.toolName);
  const who = a.agentKind === 'codex' ? 'Codex' : a.agentKind === 'opencode' ? 'OpenCode' : 'Claude';
  return `${who} quer usar ${mcp ? `${mcp[1]} · ${mcp[2]}` : a.toolName}`;
}

/** Mensagem legível para os erros de decisão. */
export function decisionError(err: unknown): string {
  if (err instanceof HubError) {
    if (err.code === 'expired') return 'Este pedido expirou. Responda no Claude Code.';
    if (err.code === 'already_decided') return 'Este pedido já foi respondido.';
    if (err.code === 'not_found') return 'Pedido não encontrado.';
    if (err.status === 401) return 'Dispositivo não autorizado. Pareie de novo.';
  }
  return 'Não foi possível enviar a resposta. Verifique a conexão com o Mac.';
}

/**
 * Dispara a decisão de um pedido e controla o estado dos botões.
 * Enquanto a resposta não volta, os dois botões ficam travados.
 */
export function useDecision(approvalId: string) {
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision: ApprovalDecision) => {
    if (busy) return;
    setBusy(decision);
    setError(null);
    try {
      await hub.decide(approvalId, decision);
    } catch (err) {
      setError(decisionError(err));
      setBusy(null);
    }
  };
  return { busy, error, decide };
}

export function Countdown({ expiresAt, now }: { expiresAt: number; now: number }) {
  const left = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const m = Math.floor(left / 60);
  const s = String(left % 60).padStart(2, '0');
  return <span className={left <= 30 ? 'countdown urgent' : 'countdown'}>{left > 0 ? `expira em ${m}:${s}` : 'expirado'}</span>;
}

export function ProgressBar({ session }: { session: Session }) {
  const pct = progressPercent(session.progress);
  if (pct === null) return null;
  return (
    <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function SessionCard({ session, now, onOpen }: { session: Session; now: number; onOpen?: () => void }) {
  const pct = progressPercent(session.progress);
  return (
    <button type="button" className="session-card" onClick={onOpen} data-status={session.status}>
      <div className="session-head">
        <StatusDot status={session.status} size={7} />
        <span className="session-title">{session.title}</span>
        <span className="session-time">{formatAgo(session.updatedAt, now)}</span>
      </div>
      <p className="session-preview">{session.preview ?? session.lastEvent?.summary ?? STATUS_LABEL[session.status]}</p>
      <ProgressBar session={session} />
      <div className="session-meta">
        <span style={{ color: STATUS_COLOR[session.status] }}>{STATUS_LABEL[session.status]}</span>
        <span>{session.projectName}</span>
        {session.agentKind !== 'claude-code' ? <span className="agent-kind">{AGENT_LABEL[session.agentKind]}</span> : null}
        {session.agent ? <span>{session.agent}</span> : null}
        <span>{formatDuration(sessionActiveMs(session, now))}</span>
        {pct !== null ? <span>{pct}%</span> : null}
        {session.pendingApprovals > 0 ? <span className="badge">{session.pendingApprovals} pendente</span> : null}
      </div>
    </button>
  );
}

/** Seletor "APROVAÇÕES" + chave "Estou longe do PC" (frame 00:05). */
export function ApprovalSettings({ settings, compact = false }: { settings: HubSettings; compact?: boolean }) {
  return (
    <div className={compact ? 'approval-settings compact' : 'approval-settings'}>
      <div className="label-caps">Aprovações</div>
      <div className="segmented" role="radiogroup" aria-label="Modo de aprovação">
        {APPROVAL_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={settings.approvalMode === mode}
            className={settings.approvalMode === mode ? 'seg on' : 'seg'}
            onClick={() => void hub.updateSettings({ approvalMode: mode })}
          >
            {APPROVAL_MODE_LABEL[mode]}
          </button>
        ))}
      </div>
      <p className="hint">{APPROVAL_MODE_HINT[settings.approvalMode]}</p>
      <label className="toggle-row">
        <input type="checkbox" checked={settings.away} onChange={(e) => void hub.updateSettings({ away: e.target.checked })} />
        <span className="toggle" aria-hidden="true" />
        <span>Estou longe do PC</span>
      </label>
    </div>
  );
}
