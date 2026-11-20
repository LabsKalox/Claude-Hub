import { describe, expect, it } from 'vitest';
import {
  EMPTY_STATE,
  applyServerMessage,
  focusSession,
  formatAgo,
  formatDuration,
  progressPercent,
  sessionActiveMs,
  type Approval,
  type Session,
} from '../src/index.js';

const session = (id: string, status: Session['status'], updatedAt = 0): Session => ({
  id,
  agentKind: 'claude-code',
  projectName: id,
  cwd: `/p/${id}`,
  title: id,
  agent: null,
  status,
  task: null,
  preview: null,
  startedAt: 0,
  updatedAt,
  activeSince: null,
  activeMs: 0,
  progress: null,
  lastEvent: null,
  pendingApprovals: 0,
  permissionMode: null,
  subagents: 0,
  hostApp: null,
  endedAt: null,
});

const approval = (id: string, status: Approval['status'], createdAt = 0): Approval => ({
  id,
  sessionId: 's1',
  projectName: 'site',
  sessionTitle: 'site',
  toolName: 'Bash',
  command: 'npm run build',
  toolInput: { command: 'npm run build' },
  cwd: '/p/site',
  createdAt,
  expiresAt: createdAt + 1000,
  status,
  decidedBy: null,
  decidedAt: null,
});

describe('formatadores', () => {
  it('formatAgo usa o formato dos cartões do vídeo', () => {
    expect(formatAgo(0, 10_000)).toBe('agora');
    expect(formatAgo(0, 60_000)).toBe('1 min');
    expect(formatAgo(0, 7 * 60_000)).toBe('7 min');
    expect(formatAgo(0, 3 * 3_600_000)).toBe('3 h');
    expect(formatAgo(0, 50 * 3_600_000)).toBe('2 d');
  });
  it('formatDuration', () => {
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(185_000)).toBe('3min 05s');
    expect(formatDuration(4_320_000)).toBe('1h 12min');
  });
  it('progressPercent só existe quando o progresso é mensurável', () => {
    expect(progressPercent(null)).toBeNull();
    expect(progressPercent({ done: 0, total: 0 })).toBeNull();
    expect(progressPercent({ done: 7, total: 10 })).toBe(70);
  });
  it('sessionActiveMs soma o turno em andamento', () => {
    expect(sessionActiveMs({ ...session('a', 'WORKING'), activeMs: 1000, activeSince: 5000 }, 8000)).toBe(4000);
  });
});

describe('sessão em foco na ilha', () => {
  it('quem precisa de você vem antes de quem está trabalhando', () => {
    const list = [session('a', 'WORKING', 50), session('b', 'COMPLETED', 99), session('c', 'APPROVAL_REQUIRED', 1)];
    expect(focusSession(list)?.id).toBe('c');
  });
  it('entre iguais, a mais recente', () => {
    expect(focusSession([session('a', 'WORKING', 1), session('b', 'WORKING', 2)])?.id).toBe('b');
  });
  it('ignora sessões encerradas', () => {
    expect(focusSession([{ ...session('a', 'WORKING'), endedAt: 5 }])).toBeNull();
  });
});

describe('redutor do cliente', () => {
  const snap = applyServerMessage(
    EMPTY_STATE,
    { type: 'snapshot', protocol: 1, sessions: [session('a', 'WORKING')], approvals: [], settings: { approvalMode: 'auto', away: true }, serverTime: 1500 },
    1000,
  );
  it('snapshot substitui tudo e calcula a diferença de relógio', () => {
    expect(snap.ready).toBe(true);
    expect(snap.sessions).toHaveLength(1);
    expect(snap.settings.away).toBe(true);
    expect(snap.clockSkew).toBe(500);
  });
  it('session atualiza sem duplicar', () => {
    const next = applyServerMessage(snap, { type: 'session', session: session('a', 'COMPLETED') });
    expect(next.sessions).toHaveLength(1);
    expect(next.sessions[0]?.status).toBe('COMPLETED');
  });
  it('pedido pendente entra na fila; decidido sai', () => {
    const withTwo = [approval('x', 'pending', 2), approval('y', 'pending', 1)].reduce(
      (s, a) => applyServerMessage(s, { type: 'approval', approval: a }),
      snap,
    );
    expect(withTwo.approvals.map((a) => a.id)).toEqual(['y', 'x']);
    const decided = applyServerMessage(withTwo, { type: 'approval', approval: approval('y', 'allowed', 1) });
    expect(decided.approvals.map((a) => a.id)).toEqual(['x']);
  });
  it('sessão removida leva junto seus pedidos', () => {
    const withApproval = applyServerMessage(
      applyServerMessage(snap, { type: 'session', session: session('s1', 'APPROVAL_REQUIRED') }),
      { type: 'approval', approval: approval('x', 'pending') },
    );
    const removed = applyServerMessage(withApproval, { type: 'session_removed', sessionId: 's1' });
    expect(removed.approvals).toHaveLength(0);
    expect(removed.sessions.map((s) => s.id)).toEqual(['a']);
  });
});

describe('formatação de consumo', () => {
  it('tokens: unidade, milhar com uma casa, milhão', async () => {
    const { formatTokens } = await import('../src/index.js');
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(4)).toBe('4');
    expect(formatTokens(26_812)).toBe('26,8 mil');
    expect(formatTokens(250_400)).toBe('250 mil');
    expect(formatTokens(3_400_000)).toBe('3,4 mi');
  });

  it('custo: nunca mostra 0,00 para algo que custou', async () => {
    const { formatUsd } = await import('../src/index.js');
    expect(formatUsd(0)).toBe('US$ 0,00');
    expect(formatUsd(0.0044)).toBe('US$ 0,0044');
    expect(formatUsd(1.239)).toBe('US$ 1,24');
  });
});
