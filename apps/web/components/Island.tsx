'use client';
/**
 * Réplica web da ilha do macOS — mesmos estados, textos e medidas do app
 * nativo (apps/macos). Serve para ver a ilha em qualquer navegador e é o que
 * os testes visuais comparam com os frames de referência.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AGENT_LABEL,
  STATUS_LABEL,
  focusSession,
  formatDuration,
  progressPercent,
  sortSessions,
  type Approval,
  type HubAlert,
  type Session,
  type UsageStats,
} from '@claude-hub/shared';
import { hub, type StoreState } from '@/lib/hub';
import { useNow } from '@/lib/useNow';
import { ApprovalSettings, Countdown, SessionCard, StatusDot, toolTitle, useDecision } from './common';
import { PhoneIcon, Ring, Spark, SwapIcon } from './icons';

type Tab = 'sistema' | 'claude' | 'uso' | 'widgets';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'sistema', label: 'Sistema' },
  { id: 'claude', label: 'Claude' },
  { id: 'uso', label: 'Uso' },
  { id: 'widgets', label: 'Widgets' },
];

function ApprovalIsland({ approval, more, now }: { approval: Approval; more: number; now: number }) {
  const { busy, error, decide } = useDecision(approval.id);
  return (
    <div className="island-approval" data-testid="island-approval">
      <div className="ia-title">
        <span className="dot pulse" style={{ width: 8, height: 8, background: 'var(--orange)' }} />
        <span>
          {toolTitle(approval)} · {approval.projectName}
        </span>
        {more > 0 ? <span className="badge">+{more}</span> : null}
      </div>
      <pre className="code-box">{approval.command}</pre>
      {error ? <p className="error-text">{error}</p> : null}
      <div className="ia-actions">
        <span className="ia-link" title={`A resposta também pode ser dada no terminal do ${AGENT_LABEL[approval.agentKind ?? 'claude-code']}`}>
          Responder no {AGENT_LABEL[approval.agentKind ?? 'claude-code'].replace(' Code', '')}
        </span>
        <Countdown expiresAt={approval.expiresAt} now={now} />
        <span className="spacer" />
        <button type="button" className="btn neutral" disabled={busy !== null} onClick={() => void decide('deny')}>
          Negar
        </button>
        <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void decide('allow')}>
          Permitir
        </button>
      </div>
    </div>
  );
}

function UsageTab() {
  const [usage, setUsage] = useState<UsageStats | null>(null);
  useEffect(() => {
    void hub.usage().then(setUsage).catch(() => setUsage(null));
  }, []);
  if (!usage) return <p className="hint">Carregando uso de hoje…</p>;
  const cells: Array<[string, string]> = [
    ['Sessões', String(usage.sessions)],
    ['Pedidos', String(usage.prompts)],
    ['Ferramentas', String(usage.toolCalls)],
    ['Tempo ativo', formatDuration(usage.activeMs)],
    ['Permitidos', String(usage.approvalsAllowed)],
    ['Negados', String(usage.approvalsDenied)],
  ];
  return (
    <div className="usage">
      <div className="usage-grid">
        {cells.map(([k, v]) => (
          <div key={k} className="usage-cell">
            <strong>{v}</strong>
            <span>{k}</span>
          </div>
        ))}
      </div>
      {usage.byTool.length > 0 ? (
        <p className="hint">Mais usadas hoje: {usage.byTool.map((t) => `${t.tool} (${t.count})`).join(' · ')}</p>
      ) : null}
    </div>
  );
}

function Panel({ state, now, onClose }: { state: StoreState; now: number; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('claude');
  const sessions = useMemo(() => sortSessions(state.sessions), [state.sessions]);
  return (
    <div className="island-panel" data-testid="island-panel">
      <div className="ip-top">
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'tab on' : 'tab'} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="icon-btn" title="Parear iPhone: rode “pnpm hub pair” no Mac">
          <PhoneIcon />
        </span>
        <button type="button" className="icon-btn" title="Recolher" onClick={onClose}>
          <SwapIcon />
        </button>
      </div>
      {tab === 'claude' ? (
        <div className="ip-body">
          <div className="ip-sessions">
            {sessions.length === 0 ? <p className="hint">Nenhuma sessão do Claude Code ativa.</p> : null}
            {sessions.map((s) => (
              <SessionCard key={s.id} session={s} now={now} />
            ))}
          </div>
          <ApprovalSettings settings={state.settings} compact />
        </div>
      ) : null}
      {tab === 'uso' ? <UsageTab /> : null}
      {tab === 'sistema' ? (
        <div className="usage">
          <div className="usage-grid">
            <div className="usage-cell">
              <strong>{state.connection === 'online' ? 'No ar' : 'Offline'}</strong>
              <span>Hub local</span>
            </div>
            <div className="usage-cell">
              <strong>{state.sessions.length}</strong>
              <span>Sessões acompanhadas</span>
            </div>
            <div className="usage-cell">
              <strong>{state.approvals.length}</strong>
              <span>Pedidos pendentes</span>
            </div>
          </div>
          <p className="hint">CPU, memória e bateria aparecem no app nativo do macOS.</p>
        </div>
      ) : null}
      {tab === 'widgets' ? <p className="hint">As preferências da ilha (tela, sons, início com o sistema) ficam no app nativo do macOS.</p> : null}
    </div>
  );
}

function Compact({ session, alert, connection, now }: { session: Session | null; alert: HubAlert | null; connection: StoreState['connection']; now: number }) {
  if (connection === 'offline') {
    return (
      <div className="island-pill small" data-testid="island-offline">
        <span className="dot" style={{ width: 8, height: 8, background: 'var(--red)' }} />
        <span className="pill-label">Hub offline</span>
      </div>
    );
  }
  // Alerta recente de conclusão tem prioridade por alguns segundos.
  if (alert && alert.kind === 'completed' && now - alert.at < 6000 && (!session || session.status === 'COMPLETED' || session.status === 'IDLE')) {
    return (
      <div className="island-pill medium" data-testid="island-completed">
        <span className="dot" style={{ width: 10, height: 10, background: 'var(--green)' }} />
        <span className="pill-strong">Terminou</span>
        <span className="pill-dim">{alert.title.replace(/^Terminou · /, '')}</span>
      </div>
    );
  }
  if (!session) {
    return (
      <div className="island-pill small idle" data-testid="island-idle">
        <Spark size={15} />
        <span className="pill-dim">Sem sessões</span>
      </div>
    );
  }
  if (session.status === 'WAITING') {
    return (
      <div className="island-pill large" data-testid="island-waiting">
        <span className="dot pulse" style={{ width: 11, height: 11, background: 'var(--orange)' }} />
        <span className="pill-big">Esperando você</span>
        <span className="btn primary big" title="No app nativo, traz o terminal da sessão para a frente">
          Responder
        </span>
      </div>
    );
  }
  if (session.status === 'WORKING') {
    const pct = progressPercent(session.progress);
    return (
      <div className="island-pill small" data-testid="island-working">
        <Spark size={15} />
        <span className="pill-label">Trabalhando</span>
        <span className="dots" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        <Ring size={15} percent={pct} />
        {pct !== null ? <span className="pill-pct">{pct}%</span> : null}
      </div>
    );
  }
  return (
    <div className="island-pill medium" data-testid={`island-${session.status.toLowerCase()}`}>
      <StatusDot status={session.status} size={10} />
      <span className="pill-strong">{STATUS_LABEL[session.status]}</span>
      <span className="pill-dim">{session.projectName}</span>
    </div>
  );
}

export function Island({ state }: { state: StoreState }) {
  const now = useNow(1000);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const session = focusSession(state.sessions);
  const approval = state.approvals[0] ?? null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  let content: React.ReactNode;
  let mode: string;
  if (open) {
    mode = 'panel';
    content = <Panel state={state} now={now} onClose={() => setOpen(false)} />;
  } else if (approval) {
    mode = 'approval';
    content = <ApprovalIsland key={approval.id} approval={approval} more={state.approvals.length - 1} now={now} />;
  } else {
    mode = 'compact';
    content = (
      <div role="button" tabIndex={0} onClick={() => setOpen(true)} onKeyDown={(e) => e.key === 'Enter' && setOpen(true)} className="compact-hit">
        <Compact session={session} alert={state.alert} connection={state.connection} now={now} />
      </div>
    );
  }
  return (
    <div ref={ref} className={`island mode-${mode}`} data-mode={mode} data-testid="island">
      {content}
    </div>
  );
}
