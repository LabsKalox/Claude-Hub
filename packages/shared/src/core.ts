/**
 * Contratos compartilhados do Claude Hub.
 *
 * Este pacote é a única fonte de verdade para: estados de sessão, formato de
 * eventos, pedidos de aprovação, mensagens WebSocket e tokens visuais.
 * O app macOS (Swift) espelha estes tipos em `apps/macos/Sources/ClaudeHubCore`.
 *
 * Não pode importar nada de Node: é usado também no navegador (PWA).
 */

export const PROTOCOL_VERSION = 1;

/**
 * Sessões cujo id começa assim são do autoteste do hub: passam pelo caminho
 * inteiro (hook → estado → WebSocket → decisão), mas não geram push no celular
 * nem contam como evento real do Claude Code.
 */
export const SELFTEST_PREFIX = 'selftest-';

// ───────────────────────────── Estados de sessão ─────────────────────────────

export const SESSION_STATUSES = [
  'WORKING',
  'WAITING',
  'APPROVAL_REQUIRED',
  'COMPLETED',
  'ERROR',
  'IDLE',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Rótulos exibidos na interface (pt-BR), iguais aos do vídeo de referência. */
export const STATUS_LABEL: Record<SessionStatus, string> = {
  WORKING: 'Trabalhando',
  WAITING: 'Esperando você',
  APPROVAL_REQUIRED: 'Precisa de autorização',
  COMPLETED: 'Terminou',
  ERROR: 'Erro',
  IDLE: 'Inativa',
};

/** Tokens visuais extraídos dos frames de referência. */
export const TOKENS = {
  color: {
    island: '#000000',
    card: '#111214',
    cardBorder: '#1E2024',
    field: '#16181C',
    text: '#FFFFFF',
    textDim: '#9BA1AC',
    textFaint: '#5E6470',
    blue: '#2F6BFF',
    green: '#2FBF71',
    orange: '#F5A524',
    red: '#FF453A',
    grey: '#6B7280',
    link: '#7C8CFF',
    buttonNeutral: '#2A2C31',
    coral: '#E8704F',
  },
  radius: { pill: 999, island: 28, card: 14, field: 10, button: 999 },
} as const;

export const STATUS_COLOR: Record<SessionStatus, string> = {
  WORKING: TOKENS.color.blue,
  WAITING: TOKENS.color.orange,
  APPROVAL_REQUIRED: TOKENS.color.orange,
  COMPLETED: TOKENS.color.green,
  ERROR: TOKENS.color.red,
  IDLE: TOKENS.color.grey,
};

/**
 * Prioridade para escolher qual sessão a ilha compacta mostra quando há
 * várias: quem precisa de você vem primeiro.
 */
export const STATUS_PRIORITY: Record<SessionStatus, number> = {
  APPROVAL_REQUIRED: 0,
  WAITING: 1,
  ERROR: 2,
  WORKING: 3,
  COMPLETED: 4,
  IDLE: 5,
};

// ───────────────────────────────── Sessões ──────────────────────────────────

export type AgentKind = 'claude-code' | 'codex' | 'opencode';

/** Nome de cada agente na interface. */
export const AGENT_LABEL: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

export interface SessionProgress {
  done: number;
  total: number;
}

export interface SessionLastEvent {
  type: string;
  summary: string;
  at: number;
}

export interface Session {
  id: string;
  agentKind: AgentKind;
  /** Nome do projeto (última parte do diretório de trabalho). */
  projectName: string;
  cwd: string;
  /** Título da sessão (session_title do Claude Code, ou o primeiro pedido). */
  title: string;
  /** Modelo ou tipo de agente, quando informado pelo Claude Code. */
  agent: string | null;
  status: SessionStatus;
  /** Tarefa em execução (último pedido enviado pelo usuário). */
  task: string | null;
  /** Texto de prévia do cartão (última resposta, pedido ou ferramenta). */
  preview: string | null;
  startedAt: number;
  updatedAt: number;
  /** Início do turno em andamento; null quando não está trabalhando. */
  activeSince: number | null;
  /** Tempo de trabalho acumulado em turnos já encerrados (ms). */
  activeMs: number;
  /** Progresso mensurável (lista de tarefas do agente); null se não houver. */
  progress: SessionProgress | null;
  lastEvent: SessionLastEvent | null;
  pendingApprovals: number;
  permissionMode: string | null;
  subagents: number;
  /** Bundle id do terminal que hospeda a sessão (macOS), quando conhecido. */
  hostApp: string | null;
  endedAt: number | null;
}

export interface HubEvent {
  id: number;
  sessionId: string;
  at: number;
  /** Nome do evento de hook (PreToolUse, Stop, …) ou evento interno do hub. */
  type: string;
  summary: string;
  toolName: string | null;
}

// ──────────────────────────────── Aprovações ────────────────────────────────

export const APPROVAL_STATUSES = [
  'pending',
  'allowed',
  'denied',
  'expired',
  'cancelled',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export type ApprovalDecision = 'allow' | 'deny';

export interface Approval {
  id: string;
  sessionId: string;
  /** Agente que pediu. Ausente em hubs anteriores à 0.5.0 (= Claude Code). */
  agentKind?: AgentKind;
  projectName: string;
  sessionTitle: string;
  toolName: string;
  /** Texto completo do que será executado (comando, arquivo, URL…). */
  command: string;
  /** Entrada completa da ferramenta, exatamente como o Claude Code enviou. */
  toolInput: unknown;
  cwd: string;
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedAt: number | null;
}

/**
 * Modos do seletor "APROVAÇÕES" do painel (frame 00:05).
 *  - auto:   roteia sozinho — ilha quando você está no computador, celular quando está longe.
 *  - always: "Sempre aqui" — todo pedido vem para a ilha e para o celular.
 *  - notify: "Só avisar" — só notifica; a resposta é dada no próprio Claude Code.
 * Nenhum modo aprova nada sozinho.
 */
export const APPROVAL_MODES = ['auto', 'always', 'notify'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const APPROVAL_MODE_LABEL: Record<ApprovalMode, string> = {
  auto: 'Automático',
  always: 'Sempre aqui',
  notify: 'Só avisar',
};

export const APPROVAL_MODE_HINT: Record<ApprovalMode, string> = {
  auto: 'O pedido vai para a ilha quando você está no computador e para o celular quando está longe.',
  always: 'Todo pedido de permissão vem para a ilha e para o celular.',
  notify: 'Só avisa. A resposta é dada no próprio Claude Code.',
};

export interface HubSettings {
  approvalMode: ApprovalMode;
  /** Chave "Estou longe do PC". */
  away: boolean;
}

export const DEFAULT_SETTINGS: HubSettings = { approvalMode: 'always', away: false };

// ───────────────────────────────── Alertas ──────────────────────────────────

export type AlertKind = 'completed' | 'waiting' | 'approval' | 'error';

export interface HubAlert {
  kind: AlertKind;
  sessionId: string;
  title: string;
  body: string;
  approvalId?: string;
  at: number;
}

// ──────────────────────────────── WebSocket ─────────────────────────────────

export type ServerMessage =
  | {
      type: 'snapshot';
      protocol: number;
      sessions: Session[];
      approvals: Approval[];
      settings: HubSettings;
      serverTime: number;
    }
  | { type: 'session'; session: Session }
  | { type: 'session_removed'; sessionId: string }
  | { type: 'event'; event: HubEvent }
  | { type: 'approval'; approval: Approval }
  | { type: 'settings'; settings: HubSettings }
  | { type: 'alert'; alert: HubAlert }
  | { type: 'auth_error'; reason: string }
  | { type: 'pong' };

export type ClientMessage =
  | { type: 'auth'; token: string; client?: string }
  | { type: 'presence'; idleSeconds: number }
  | { type: 'ping' };

// ─────────────────────────────────── REST ───────────────────────────────────

export interface DecisionRequest {
  decision: ApprovalDecision;
}

export interface PairRequest {
  code: string;
  deviceName: string;
}

export interface PairResponse {
  deviceId: string;
  deviceToken: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  pushEnabled: boolean;
}

export interface UsageStats {
  since: number;
  sessions: number;
  prompts: number;
  toolCalls: number;
  approvalsAllowed: number;
  approvalsDenied: number;
  activeMs: number;
  byTool: Array<{ tool: string; count: number }>;
  /** Tokens e custo informados pelo próprio Claude Code (OpenTelemetry). Ausente em hubs antigos. */
  consumption?: ConsumptionStats;
  /** Limites do plano informados pelo Claude Code (linha de status). Ausente em hubs antigos. */
  limits?: LimitsStats;
}

export interface ModelConsumptionStats {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Estimativa do próprio Claude Code; null quando ele não informou. */
  costUsd: number | null;
}

export interface ConsumptionStats extends Omit<ModelConsumptionStats, 'model'> {
  /** Medição ligada nas preferências. Desligada, todos os números são zero. */
  enabled: boolean;
  source: 'otel' | null;
  since: number;
  byModel: ModelConsumptionStats[];
  updatedAt: number | null;
}

export interface LimitWindowStats {
  id: string;
  label: string;
  /** 0–100, exatamente como o Claude Code informou. */
  usedPercent: number;
  /** Epoch em ms; null quando o Claude Code não informou. */
  resetsAt: number | null;
}

export interface LimitsStats {
  enabled: boolean;
  source: 'statusline' | null;
  updatedAt: number | null;
  /** Só as janelas informadas e ainda não reiniciadas. Vazio = sem dado. */
  windows: LimitWindowStats[];
  context: { usedPercent: number; windowSize: number | null; sessionId: string | null } | null;
}

/** Custo em dólar: centavos quando cabe, quatro casas quando é menor que um centavo (nunca "0,00" para algo que custou). */
export function formatUsd(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return 'US$ 0,00';
  return `US$ ${v.toFixed(v < 0.01 ? 4 : 2).replace('.', ',')}`;
}

/** "1,2 mil", "3,4 mi" — contagem de tokens legível. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0).replace('.', ',')} mil`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace('.', ',')} mi`;
}

// ──────────────────────────────── Utilidades ────────────────────────────────

/** "agora", "1 min", "2 h", "3 d" — formato do canto direito dos cartões. */
export function formatAgo(from: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - from) / 1000));
  if (s < 45) return 'agora';
  const m = Math.max(1, Math.round(s / 60));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/** Duração de atividade: "42s", "3min 05s", "1h 12min". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}min`;
}

export function progressPercent(p: SessionProgress | null): number | null {
  if (!p || p.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)));
}

/** Tempo total de atividade da sessão, incluindo o turno em andamento. */
export function sessionActiveMs(s: Session, now: number = Date.now()): number {
  return s.activeMs + (s.activeSince ? Math.max(0, now - s.activeSince) : 0);
}

/** Ordena para exibição: quem precisa de atenção primeiro, depois o mais recente. */
export function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort(
    (a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] || b.updatedAt - a.updatedAt,
  );
}

/** Sessão que a ilha compacta deve mostrar; null se não houver nenhuma viva. */
export function focusSession(sessions: Session[]): Session | null {
  const live = sessions.filter((s) => !s.endedAt);
  return sortSessions(live)[0] ?? null;
}

export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
