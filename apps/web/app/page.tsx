'use client';
/**
 * PWA do iPhone: sessões, pedidos de permissão, histórico e ajustes.
 * O cartão de pedido reproduz a notificação do frame 00:16
 * (ícone + "Claude Hub", título, caixa de código, Negar / Permitir).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AGENT_LABEL,
  STATUS_COLOR,
  STATUS_LABEL,
  formatAgo,
  formatDuration,
  formatTokens,
  formatUsd,
  progressPercent,
  sessionActiveMs,
  sortSessions,
  type Approval,
  type HubAlert,
  type HubEvent,
  type Session,
  type AgentUsageStats,
  type LimitWindowStats,
  type UsageStats,
} from '@claude-hub/shared';
import {
  ApprovalSettings,
  Countdown,
  ProgressBar,
  SessionCard,
  StatusDot,
  toolTitle,
  useDecision,
} from '@/components/common';
import { AppIcon, CloseIcon } from '@/components/icons';
import { hub, useHub, type StoreState } from '@/lib/hub';
import { PERMISSION_LABEL, STEP_LABEL as PUSH_STEP_LABEL, WORKER_LABEL, pushDiagnostics, type PushDiagnostics, type PushStep } from '@/lib/push';
import { useNow } from '@/lib/useNow';

type Tab = 'sessions' | 'usage' | 'history' | 'settings';

function ApprovalCard({ approval, now, highlighted }: { approval: Approval; now: number; highlighted: boolean }) {
  const { busy, error, decide } = useDecision(approval.id);
  const [details, setDetails] = useState(false);
  return (
    <article className={highlighted ? 'notif approval highlighted' : 'notif approval'} data-testid="approval-card">
      <header className="notif-head">
        <AppIcon size={22} />
        <span className="notif-app">Claude Hub</span>
        <span className="notif-when">
          {approval.projectName} · {formatAgo(approval.createdAt, now)}
        </span>
      </header>
      <h2 className="notif-title">{toolTitle(approval)}</h2>
      <pre className={details ? 'code-box open' : 'code-box'} onClick={() => setDetails((d) => !d)}>
        {approval.command}
      </pre>
      {details ? (
        <dl className="approval-details">
          <dt>Sessão</dt>
          <dd>{approval.sessionTitle}</dd>
          <dt>Pasta</dt>
          <dd className="mono">{approval.cwd}</dd>
          <dt>Ferramenta</dt>
          <dd>{approval.toolName}</dd>
        </dl>
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}
      <div className="notif-actions">
        <button type="button" className="btn neutral" disabled={busy !== null} onClick={() => void decide('deny')}>
          {busy === 'deny' ? 'Negando…' : 'Negar'}
        </button>
        <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void decide('allow')}>
          {busy === 'allow' ? 'Permitindo…' : 'Permitir'}
        </button>
      </div>
      <footer className="notif-foot">
        <button type="button" className="link" onClick={() => setDetails((d) => !d)}>
          {details ? 'Ocultar detalhes' : 'Ver detalhes'}
        </button>
        <Countdown expiresAt={approval.expiresAt} now={now} />
      </footer>
    </article>
  );
}

function AlertCard({ alert, now, onClose }: { alert: HubAlert; now: number; onClose: () => void }) {
  const color = alert.kind === 'completed' ? 'var(--green)' : alert.kind === 'error' ? 'var(--red)' : 'var(--orange)';
  return (
    <article className="notif" data-testid="alert-card" data-kind={alert.kind}>
      <header className="notif-head">
        <AppIcon size={22} />
        <span className="notif-app">Claude Hub · {formatAgo(alert.at, now)}</span>
        <span className="spacer" />
        <button type="button" className="icon-btn" aria-label="Dispensar" onClick={onClose}>
          <CloseIcon size={12} />
        </button>
      </header>
      <h2 className="notif-title">
        <span className="dot" style={{ width: 9, height: 9, background: color, marginRight: 8 }} />
        {alert.title}
      </h2>
      <p className="notif-body">{alert.body}</p>
    </article>
  );
}

function SessionSheet({ session, now, onClose }: { session: Session; now: number; onClose: () => void }) {
  const state = useHub();
  const [history, setHistory] = useState<HubEvent[]>([]);
  useEffect(() => {
    let alive = true;
    void hub
      .events(session.id, 80)
      .then((e) => alive && setHistory(e))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [session.id]);
  // Junta o histórico buscado com o que chega ao vivo, sem repetir.
  const events = useMemo(() => {
    const seen = new Set<number>();
    const merged: HubEvent[] = [];
    for (const e of [...state.events.filter((x) => x.sessionId === session.id), ...history]) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        merged.push(e);
      }
    }
    return merged.sort((a, b) => b.id - a.id);
  }, [state.events, history, session.id]);
  const pct = progressPercent(session.progress);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="sheet" onClick={(e) => e.stopPropagation()} data-testid="session-sheet">
        <div className="sheet-grab" />
        <header className="sheet-head">
          <StatusDot status={session.status} size={10} />
          <h2>{session.title}</h2>
          <button type="button" className="icon-btn" aria-label="Fechar" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <dl className="facts">
          <div>
            <dt>Status</dt>
            <dd style={{ color: STATUS_COLOR[session.status] }}>{STATUS_LABEL[session.status]}</dd>
          </div>
          <div>
            <dt>Projeto</dt>
            <dd>{session.projectName}</dd>
          </div>
          <div>
            <dt>Agente</dt>
            <dd>{session.agent ?? 'Claude Code'}</dd>
          </div>
          <div>
            <dt>Tempo ativo</dt>
            <dd>{formatDuration(sessionActiveMs(session, now))}</dd>
          </div>
          <div>
            <dt>Progresso</dt>
            <dd>{pct !== null ? `${pct}% (${session.progress?.done}/${session.progress?.total})` : 'não mensurável'}</dd>
          </div>
          <div>
            <dt>Pendências</dt>
            <dd>{session.pendingApprovals}</dd>
          </div>
        </dl>
        <ProgressBar session={session} />
        {session.task ? (
          <>
            <div className="label-caps">Tarefa</div>
            <p className="task">{session.task}</p>
          </>
        ) : null}
        <div className="label-caps">Retomar no Mac</div>
        <pre className="code-box resume">claude --resume {session.id}</pre>
        <div className="label-caps">Histórico</div>
        <ul className="events">
          {events.length === 0 ? <li className="hint">Sem eventos registrados.</li> : null}
          {events.map((e) => (
            <li key={e.id}>
              <time>{new Date(e.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</time>
              <span>{e.summary}</span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="btn neutral block"
          onClick={() => {
            void hub.dismissSession(session.id).catch(() => {});
            onClose();
          }}
        >
          Tirar da lista
        </button>
      </section>
    </div>
  );
}

const APPROVAL_STATUS_LABEL: Record<Approval['status'], string> = {
  pending: 'Pendente',
  allowed: 'Permitido',
  denied: 'Negado',
  expired: 'Expirou',
  cancelled: 'Respondido no Claude',
};

function HistoryTab({ state }: { state: StoreState }) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [events, setEvents] = useState<HubEvent[]>([]);
  // Recarrega quando chega evento novo ou muda a fila de pedidos.
  const refreshKey = `${state.events[0]?.id ?? 0}:${state.approvals.length}`;
  useEffect(() => {
    void hub.approvalHistory().then(setApprovals).catch(() => {});
    void hub.events(undefined, 60).then(setEvents).catch(() => {});
  }, [refreshKey]);
  const names = useMemo(() => new Map(state.sessions.map((s) => [s.id, s.projectName])), [state.sessions]);
  return (
    <>
      <div className="label-caps">Pedidos de permissão</div>
      <ul className="history">
        {approvals.length === 0 ? <li className="hint">Nenhum pedido até agora.</li> : null}
        {approvals.map((a) => (
          <li key={a.id}>
            <div className="history-top">
              <span className={`chip ${a.status}`}>{APPROVAL_STATUS_LABEL[a.status]}</span>
              <span className="history-when">
                {a.projectName} · {new Date(a.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <code>{a.command}</code>
          </li>
        ))}
      </ul>
      <div className="label-caps">Eventos recentes</div>
      <ul className="events">
        {events.length === 0 ? <li className="hint">Sem eventos.</li> : null}
        {events.map((e) => (
          <li key={e.id}>
            <time>{new Date(e.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</time>
            <span>
              {names.get(e.sessionId) ? <b>{names.get(e.sessionId)} · </b> : null}
              {e.summary}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Quanto falta para um instante futuro: "2 h 10 min", "3 d 4 h". */
function untilLabel(at: number, now: number): string {
  const min = Math.max(0, Math.round((at - now) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/**
 * Uso de hoje. Tokens, custo e limites só aparecem quando o Claude Code os
 * informou ao hub; sem dado, a tela diz isso — nada é estimado aqui.
 */
function UsageTab({ state }: { state: StoreState }) {
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [failed, setFailed] = useState(false);
  const refreshKey = `${state.events[0]?.id ?? 0}`;
  useEffect(() => {
    let alive = true;
    const load = () =>
      hub
        .usage()
        .then((u) => {
          if (alive) {
            setUsage(u);
            setFailed(false);
          }
        })
        .catch(() => alive && setFailed(true));
    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [refreshKey]);
  if (!usage) return <p className="hint">{failed ? 'Não foi possível ler o uso agora.' : 'Carregando uso de hoje…'}</p>;
  const now = Date.now();
  const c = usage.consumption;
  const l = usage.limits;
  const windows = (l?.windows ?? []).filter((w) => w.resetsAt === null || w.resetsAt > now);
  return (
    <div className="usage" data-testid="usage-tab">
      <div className="label-caps">Limites do plano</div>
      {!l || !l.enabled ? (
        <p className="hint">A leitura de limites está desligada. Ligue no Mac: ilha → aba Uso.</p>
      ) : windows.length === 0 ? (
        <p className="hint">O Claude Code ainda não informou limites. Eles só chegam em sessões interativas de planos com limite por janela.</p>
      ) : (
        <LimitList windows={windows} now={now} />
      )}
      {l?.updatedAt ? <p className="hint">Informado pelo Claude Code {formatAgo(l.updatedAt, now) === 'agora' ? 'agora' : `há ${formatAgo(l.updatedAt, now)}`}.</p> : null}

      <div className="label-caps">Consumo de hoje</div>
      {!c || !c.enabled ? (
        <p className="hint">A medição de consumo está desligada. Ligue no Mac: ilha → aba Uso.</p>
      ) : c.updatedAt === null ? (
        <p className="hint">Nenhum consumo informado hoje pelo Claude Code.</p>
      ) : (
        <>
          <div className="usage-grid" data-testid="consumption">
            {(
              [
                ['Entrada', formatTokens(c.inputTokens)],
                ['Saída', formatTokens(c.outputTokens)],
                ['Cache lido', formatTokens(c.cacheReadTokens)],
                ['Cache criado', formatTokens(c.cacheCreationTokens)],
                ['Custo estimado', c.costUsd === null ? '—' : formatUsd(c.costUsd)],
              ] as Array<[string, string]>
            ).map(([k, v]) => (
              <div key={k} className="usage-cell">
                <strong>{v}</strong>
                <span>{k}</span>
              </div>
            ))}
          </div>
          <p className="hint">Tokens e custo vêm do próprio Claude Code. O custo é uma estimativa dele, não a sua fatura.</p>
        </>
      )}

      {(usage.agents ?? []).map((a) => (
        <AgentUsage key={a.agent} a={a} now={now} />
      ))}

      <div className="label-caps">Atividade de hoje</div>
      <div className="usage-grid">
        {(
          [
            ['Sessões', String(usage.sessions)],
            ['Pedidos', String(usage.prompts)],
            ['Ferramentas', String(usage.toolCalls)],
            ['Tempo ativo', formatDuration(usage.activeMs)],
            ['Permitidos', String(usage.approvalsAllowed)],
            ['Negados', String(usage.approvalsDenied)],
          ] as Array<[string, string]>
        ).map(([k, v]) => (
          <div key={k} className="usage-cell">
            <strong>{v}</strong>
            <span>{k}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LimitList({ windows, now }: { windows: LimitWindowStats[]; now: number }) {
  return (
    <ul className="limits">
      {windows.map((w) => (
        <li key={w.id} data-testid={`limit-${w.id}`}>
          <div className="limit-top">
            <span>{w.label}</span>
            <strong>{String(Math.round(w.usedPercent * 10) / 10).replace('.', ',')}%</strong>
          </div>
          <div className="limit-bar">
            <i className={w.usedPercent >= 90 ? 'crit' : w.usedPercent >= 70 ? 'warn' : ''} style={{ width: `${Math.min(100, Math.max(0, w.usedPercent))}%` }} />
          </div>
          <small>{w.resetsAt ? `Reinicia em ${untilLabel(w.resetsAt, now)}` : 'Horário de reinício não informado'}</small>
        </li>
      ))}
    </ul>
  );
}

/** Codex e OpenCode: o que eles mesmos informam. */
function AgentUsage({ a, now }: { a: AgentUsageStats; now: number }) {
  const name = AGENT_LABEL[a.agent];
  const windows = (a.limits?.windows ?? []).filter((w) => w.resetsAt === null || w.resetsAt > now);
  return (
    <section data-testid={`agent-usage-${a.agent}`}>
      <div className="label-caps">{name}</div>
      {a.limits === null ? null : windows.length > 0 ? (
        <LimitList windows={windows} now={now} />
      ) : (
        <p className="hint">O {name} ainda não informou limites do plano (só aparecem com login ChatGPT).</p>
      )}
      {a.updatedAt === null ? (
        <p className="hint">Nenhum consumo do {name} hoje.</p>
      ) : (
        <div className="usage-grid">
          {(
            [
              ['Entrada', formatTokens(a.inputTokens)],
              ['Saída', formatTokens(a.outputTokens)],
              ['Cache lido', formatTokens(a.cacheReadTokens)],
              ['Raciocínio', formatTokens(a.reasoningTokens)],
              ['Custo', a.costUsd === null ? 'não informado' : formatUsd(a.costUsd)],
            ] as Array<[string, string]>
          ).map(([k, v]) => (
            <div key={k} className="usage-cell">
              <strong>{v}</strong>
              <span>{k}</span>
            </div>
          ))}
        </div>
      )}
      {a.limits === null ? <p className="hint">O {name} não tem limites de plano: depende do provedor de cada modelo.</p> : null}
    </section>
  );
}

const PUSH_STEPS: PushStep[] = ['permission', 'service-worker', 'key', 'subscribe', 'register'];

function PushSettings() {
  const [support, setSupport] = useState<ReturnType<typeof hub.pushSupport>>('unsupported');
  const [enabled, setEnabled] = useState(false);
  const [diag, setDiag] = useState<PushDiagnostics | null>(null);
  const [step, setStep] = useState<PushStep | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const refresh = useCallback(() => {
    setSupport(hub.pushSupport());
    void hub.pushEnabled().then(setEnabled).catch(() => setEnabled(false));
    void pushDiagnostics().then(setDiag).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  const activate = () => {
    if (busy) return;
    // O pedido de permissão sai aqui, dentro do toque: nada de `await` antes (exigência do iOS).
    const done = hub.enablePush((current, stalledMessage) => {
      setStep(current);
      if (stalledMessage) setNote({ text: stalledMessage, bad: true });
    });
    setBusy(true);
    setNote(null);
    done
      .then(
        () => setNote({ text: 'Notificações ativadas.', bad: false }),
        (err: unknown) => setNote({ text: err instanceof Error && err.message ? err.message : 'Não foi possível ativar as notificações.', bad: true }),
      )
      .finally(() => {
        setBusy(false);
        setStep(null);
        refresh();
      });
  };

  const run = async (fn: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      setNote({ text: await fn(), bad: false });
    } catch (err) {
      setNote({ text: err instanceof Error && err.message ? `Falhou: ${err.message}` : 'Falhou.', bad: true });
    }
    setBusy(false);
    refresh();
  };

  const sendTest = async (): Promise<string> => {
    const r = await hub.testPush();
    if (r.delivered > 0) {
      return 'Notificação de teste enviada. Se não aparecer em alguns segundos, confira em Ajustes do iPhone → Notificações → Claude Hub e o modo Foco.';
    }
    const failure = r.failures?.[0];
    if (failure) throw new Error(`o serviço de push (${failure.host}) recusou o envio: ${failure.status ?? 'sem resposta'} ${failure.reason}`);
    if (r.targets === 0) throw new Error('o hub não tem a inscrição deste aparelho. Toque em Desativar e ative de novo.');
    throw new Error('nenhuma notificação foi entregue.');
  };

  const stepIndex = step ? PUSH_STEPS.indexOf(step) : -1;

  return (
    <section className="panel" data-testid="push-settings">
      <div className="label-caps">Notificações</div>
      {support === 'needs-install' ? (
        <p className="hint">
          No iPhone, as notificações só funcionam com o app instalado: toque em <b>Compartilhar</b> → <b>Adicionar à Tela de Início</b> e abra o Claude Hub por lá.
        </p>
      ) : null}
      {support === 'unsupported' ? <p className="hint">Este navegador não oferece notificações push.</p> : null}
      {support === 'denied' ? <p className="hint">As notificações foram bloqueadas. Libere em Ajustes → Notificações → Claude Hub.</p> : null}
      {support === 'ok' && !enabled ? (
        <button type="button" className="btn primary block" disabled={busy} onClick={activate}>
          {busy ? 'Ativando…' : 'Ativar notificações'}
        </button>
      ) : null}
      {support === 'ok' && enabled ? (
        <div className="row-buttons">
          <button type="button" className="btn neutral" disabled={busy} onClick={() => void run(sendTest)}>
            Enviar teste
          </button>
          <button
            type="button"
            className="btn neutral"
            disabled={busy}
            onClick={() => void run(async () => (await hub.disablePush(), 'Notificações desativadas.'))}
          >
            Desativar
          </button>
        </div>
      ) : null}
      {busy && step ? (
        <p className="hint" data-testid="push-step">
          {stepIndex >= 0 ? `Etapa ${stepIndex + 1} de ${PUSH_STEPS.length} · ` : ''}
          {PUSH_STEP_LABEL[step]}
        </p>
      ) : null}
      {note ? (
        <p className={note.bad ? 'hint bad' : 'hint'} data-testid="push-note">
          {note.text}
        </p>
      ) : null}
      {diag && support !== 'unsupported' ? (
        <dl className="push-diag" data-testid="push-diag">
          <dt>Permissão do iPhone</dt>
          <dd>{PERMISSION_LABEL[diag.permission]}</dd>
          <dt>Serviço de notificações do app</dt>
          <dd>{diag.registrationError ? `erro: ${diag.registrationError}` : WORKER_LABEL[diag.serviceWorker]}</dd>
          <dt>Inscrição neste aparelho</dt>
          <dd>{diag.subscribed ? 'sim' : 'não'}</dd>
          <dt>Aberto pela Tela de Início</dt>
          <dd>{diag.standalone ? 'sim' : 'não'}</dd>
        </dl>
      ) : null}
    </section>
  );
}

export default function PhoneApp() {
  const state = useHub();
  const now = useNow(1000);
  const [tab, setTab] = useState<Tab>('sessions');
  const [openSession, setOpenSession] = useState<string | null>(null);
  const [focusApproval, setFocusApproval] = useState<string | null>(null);
  const [staleNotice, setStaleNotice] = useState<string | null>(null);

  const navigate = useCallback((url: string) => {
    const params = new URL(url, window.location.origin).searchParams;
    const approval = params.get('approval');
    const session = params.get('session');
    setTab('sessions');
    if (approval) setFocusApproval(approval);
    if (session) setOpenSession(session);
  }, []);

  useEffect(() => {
    hub.start();
    navigate(window.location.href);
    if (window.location.search) window.history.replaceState(null, '', '/');
    // Toque em notificação com a PWA já aberta: o service worker avisa para onde ir.
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; url?: string } | null;
      if (data?.type === 'navigate' && typeof data.url === 'string') navigate(data.url);
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    // Service worker registrado já na abertura: no toque em "Ativar notificações" ele está ativo.
    void hub.preparePush();
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage);
  }, [navigate]);

  useEffect(() => {
    if (state.connection === 'unpaired') window.location.replace('/pair/');
  }, [state.connection]);

  // Notificação aberta para um pedido que não está mais pendente: explica o porquê.
  useEffect(() => {
    if (!focusApproval || !state.ready) return;
    if (state.approvals.some((a) => a.id === focusApproval)) return;
    void hub
      .getApproval(focusApproval)
      .then((a) => {
        if (a.status !== 'pending') setStaleNotice(`Esse pedido não está mais pendente: ${APPROVAL_STATUS_LABEL[a.status].toLowerCase()}.`);
      })
      .catch(() => setStaleNotice('Esse pedido não existe mais.'));
    setFocusApproval(null);
  }, [focusApproval, state.ready, state.approvals]);

  const sessions = useMemo(() => sortSessions(state.sessions), [state.sessions]);
  const sheetSession = sessions.find((s) => s.id === openSession) ?? null;
  const alert = state.alert && state.alert.kind !== 'approval' && now - state.alert.at < 20_000 ? state.alert : null;

  if (state.connection === 'unpaired') return <main className="phone" />;

  return (
    <main className="phone" data-connection={state.connection}>
      <header className="phone-head">
        <AppIcon size={28} />
        <h1>Claude Hub</h1>
        <span className="spacer" />
        <span className={`conn ${state.connection}`}>
          {state.connection === 'online' ? 'Conectado' : state.connection === 'connecting' ? 'Conectando…' : 'Sem conexão com o Mac'}
        </span>
      </header>

      {tab === 'sessions' ? (
        <div className="stack">
          {staleNotice ? (
            <p className="notice" onClick={() => setStaleNotice(null)}>
              {staleNotice}
            </p>
          ) : null}
          {state.approvals.map((a) => (
            <ApprovalCard key={a.id} approval={a} now={now} highlighted={a.id === focusApproval} />
          ))}
          {alert ? <AlertCard alert={alert} now={now} onClose={() => hub.clearAlert()} /> : null}
          <div className="label-caps">Sessões{sessions.length > 0 ? ` · ${sessions.length}` : ''}</div>
          {state.ready && sessions.length === 0 ? (
            <p className="empty">Nenhuma sessão do Claude Code ativa. Abra o Claude Code no Mac e ela aparece aqui.</p>
          ) : null}
          {sessions.map((s) => (
            <SessionCard key={s.id} session={s} now={now} onOpen={() => setOpenSession(s.id)} />
          ))}
        </div>
      ) : null}

      {tab === 'usage' ? (
        <div className="stack">
          <UsageTab state={state} />
        </div>
      ) : null}

      {tab === 'history' ? (
        <div className="stack">
          <HistoryTab state={state} />
        </div>
      ) : null}

      {tab === 'settings' ? (
        <div className="stack">
          <section className="panel">
            <ApprovalSettings settings={state.settings} />
          </section>
          <PushSettings />
          <section className="panel">
            <div className="label-caps">Este dispositivo</div>
            <p className="hint">Desparear apaga o acesso deste aparelho. Para parear de novo, gere outro código no Mac.</p>
            <button
              type="button"
              className="btn neutral block"
              onClick={() => {
                if (window.confirm('Desparear este dispositivo?')) hub.unpair();
              }}
            >
              Desparear
            </button>
          </section>
        </div>
      ) : null}

      <nav className="tabbar">
        {(
          [
            ['sessions', 'Sessões'],
            ['usage', 'Uso'],
            ['history', 'Histórico'],
            ['settings', 'Ajustes'],
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button key={id} type="button" className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
            {id === 'sessions' && state.approvals.length > 0 ? <span className="badge">{state.approvals.length}</span> : null}
          </button>
        ))}
      </nav>

      {sheetSession ? <SessionSheet session={sheetSession} now={now} onClose={() => setOpenSession(null)} /> : null}
    </main>
  );
}
