/**
 * Máquina de estados de sessão.
 *
 * Função pura: (sessão atual, payload de hook, agora) → (nova sessão, evento, alertas).
 * Não faz I/O — por isso é testável isoladamente e reutilizável por outros
 * agentes (Codex, OpenCode) que mapeiem seus eventos para HookPayload.
 *
 * Transições:
 *   SessionStart            → IDLE
 *   UserPromptSubmit        → WORKING   (abre o turno)
 *   PreToolUse/PostToolUse  → WORKING
 *   PermissionRequest       → APPROVAL_REQUIRED (ou WAITING para perguntas)
 *   Notification            → APPROVAL_REQUIRED / WAITING conforme o tipo
 *   Stop                    → COMPLETED (fecha o turno)
 *   StopFailure             → ERROR     (fecha o turno)
 *   SessionEnd              → sessão encerrada
 */
import type { AlertKind, HubAlert, Session, SessionStatus } from '@claude-hub/shared';
import { truncate } from '@claude-hub/shared';
import {
  QUESTION_TOOLS,
  firstLine,
  projectNameFromCwd,
  summarizeToolCall,
  todoProgress,
  toolLabel,
  type HookPayload,
} from './normalize.js';

export interface ReducedEvent {
  type: string;
  summary: string;
  toolName: string | null;
}

export interface ReduceResult {
  session: Session;
  /** Evento para o histórico; null quando o hook não merece registro. */
  event: ReducedEvent | null;
  alerts: HubAlert[];
}

export function newSession(p: HookPayload, now: number): Session {
  const projectName = projectNameFromCwd(p.cwd);
  return {
    id: p.session_id,
    agentKind: p.hub_agent ?? 'claude-code',
    projectName,
    cwd: p.cwd ?? '',
    title: p.session_title || projectName,
    agent: p.model ?? p.agent_type ?? null,
    status: 'IDLE',
    task: null,
    preview: null,
    startedAt: now,
    updatedAt: now,
    activeSince: null,
    activeMs: 0,
    progress: null,
    lastEvent: null,
    pendingApprovals: 0,
    permissionMode: p.permission_mode ?? null,
    subagents: 0,
    hostApp: null,
    endedAt: null,
  };
}

function closeTurn(s: Session, now: number): void {
  if (s.activeSince) {
    s.activeMs += Math.max(0, now - s.activeSince);
    s.activeSince = null;
  }
}

function openTurn(s: Session, now: number): void {
  if (!s.activeSince) s.activeSince = now;
}

function alert(kind: AlertKind, s: Session, title: string, body: string, now: number): HubAlert {
  return { kind, sessionId: s.id, title, body, at: now };
}

/** O título ainda é o nome genérico do projeto? Então dá para melhorar. */
function hasGenericTitle(s: Session): boolean {
  return s.title === s.projectName;
}

export function reduceHook(prev: Session | undefined, p: HookPayload, now: number): ReduceResult {
  const s: Session = prev ? { ...prev } : newSession(p, now);
  const alerts: HubAlert[] = [];
  let event: ReducedEvent | null = null;
  const isSubagent = Boolean(p.agent_id);

  // Uma sessão encerrada que volta a emitir eventos foi retomada (--resume).
  if (s.endedAt && p.hook_event_name !== 'SessionEnd') s.endedAt = null;

  if (p.cwd && p.cwd !== s.cwd && !isSubagent) {
    const generic = hasGenericTitle(s);
    s.cwd = p.cwd;
    s.projectName = projectNameFromCwd(p.cwd);
    if (generic) s.title = s.projectName;
  }
  if (p.permission_mode) s.permissionMode = p.permission_mode;
  if (p.session_title) s.title = p.session_title;
  if (p.hub_env?.host_app) s.hostApp = p.hub_env.host_app;

  const setStatus = (status: SessionStatus) => {
    s.status = status;
  };

  switch (p.hook_event_name) {
    case 'SessionStart': {
      if (p.model) s.agent = p.model;
      else if (p.agent_type) s.agent = p.agent_type;
      const resumed = p.source === 'resume';
      if (!prev || s.status === 'COMPLETED' || s.status === 'ERROR') setStatus('IDLE');
      event = {
        type: 'SessionStart',
        summary: resumed ? 'Sessão retomada' : 'Sessão iniciada',
        toolName: null,
      };
      break;
    }

    case 'UserPromptSubmit': {
      const prompt = typeof p.prompt === 'string' ? p.prompt : '';
      setStatus('WORKING');
      openTurn(s, now);
      s.task = firstLine(prompt, 300);
      s.preview = s.task;
      s.progress = null;
      s.pendingApprovals = 0;
      if (hasGenericTitle(s) && s.task) s.title = truncate(s.task, 60);
      event = {
        type: 'UserPromptSubmit',
        summary: s.task ? `Pedido: ${truncate(s.task, 120)}` : 'Novo pedido',
        toolName: null,
      };
      break;
    }

    case 'PreToolUse': {
      const tool = p.tool_name ?? 'ferramenta';
      const summary = summarizeToolCall(tool, p.tool_input);
      if (QUESTION_TOOLS.has(tool)) {
        // O Claude está perguntando algo: a espera é por você, não por execução.
        setStatus('WAITING');
        alerts.push(alert('waiting', s, 'Esperando você', `${s.title} precisa de uma resposta`, now));
      } else {
        setStatus('WORKING');
        openTurn(s, now);
        if (!isSubagent) s.preview = summary;
      }
      const progress = tool === 'TodoWrite' ? todoProgress(p.tool_input) : null;
      if (progress) s.progress = progress;
      event = { type: 'PreToolUse', summary, toolName: tool };
      break;
    }

    case 'PostToolUse': {
      const tool = p.tool_name ?? 'ferramenta';
      if (s.status !== 'WAITING' || QUESTION_TOOLS.has(tool)) setStatus('WORKING');
      openTurn(s, now);
      s.pendingApprovals = 0;
      // Sem registro no histórico: o PreToolUse já descreveu a chamada.
      break;
    }

    case 'PostToolUseFailure': {
      const tool = p.tool_name ?? 'ferramenta';
      setStatus('WORKING');
      s.pendingApprovals = 0;
      const why = p.is_interrupt ? 'interrompido' : firstLine(p.error, 120) ?? 'falhou';
      event = { type: 'PostToolUseFailure', summary: `${toolLabel(tool)}: ${why}`, toolName: tool };
      break;
    }

    case 'PermissionRequest': {
      const tool = p.tool_name ?? 'ferramenta';
      if (QUESTION_TOOLS.has(tool)) {
        setStatus('WAITING');
        event = { type: 'PermissionRequest', summary: 'Claude tem uma pergunta', toolName: tool };
      } else {
        setStatus('APPROVAL_REQUIRED');
        event = {
          type: 'PermissionRequest',
          summary: `Pediu permissão: ${summarizeToolCall(tool, p.tool_input)}`,
          toolName: tool,
        };
      }
      break;
    }

    case 'PermissionDenied': {
      const tool = p.tool_name ?? 'ferramenta';
      if (s.status === 'APPROVAL_REQUIRED') setStatus('WORKING');
      event = {
        type: 'PermissionDenied',
        summary: `Negado: ${summarizeToolCall(tool, p.tool_input)}`,
        toolName: tool,
      };
      break;
    }

    case 'Notification': {
      const kind = p.notification_type ?? '';
      const message = firstLine(p.message, 160) ?? '';
      if (kind === 'permission_prompt') {
        if (s.status !== 'APPROVAL_REQUIRED' && s.status !== 'WAITING') {
          setStatus('APPROVAL_REQUIRED');
        }
      } else if (
        kind === 'idle_prompt' ||
        kind === 'agent_needs_input' ||
        kind === 'elicitation_dialog' ||
        kind === 'elicitation_url_dialog'
      ) {
        // O Claude Code também manda idle_prompt um minuto depois de terminar
        // um turno. Isso não é "precisa de você": quem já terminou continua
        // como "Terminou", sem novo alerta.
        const restingAfterTurn =
          kind === 'idle_prompt' && (s.status === 'COMPLETED' || s.status === 'ERROR' || s.status === 'IDLE');
        if (!restingAfterTurn) {
          if (s.status !== 'WAITING') {
            alerts.push(alert('waiting', s, 'Esperando você', message || s.title, now));
          }
          closeTurn(s, now);
          setStatus('WAITING');
        }
      } else if (kind === 'auth_success' || kind === 'elicitation_complete') {
        // Informativo; não muda o estado.
      }
      if (message) event = { type: 'Notification', summary: message, toolName: null };
      break;
    }

    case 'Elicitation': {
      setStatus('WAITING');
      const message = firstLine(p.message, 160) ?? 'Um servidor MCP pediu dados';
      alerts.push(alert('waiting', s, 'Esperando você', message, now));
      event = { type: 'Elicitation', summary: message, toolName: null };
      break;
    }

    case 'ElicitationResult': {
      if (s.status === 'WAITING') setStatus('WORKING');
      break;
    }

    case 'SubagentStart': {
      s.subagents += 1;
      event = {
        type: 'SubagentStart',
        summary: `Subagente iniciado${p.agent_type ? `: ${p.agent_type}` : ''}`,
        toolName: null,
      };
      break;
    }

    case 'SubagentStop': {
      s.subagents = Math.max(0, s.subagents - 1);
      event = {
        type: 'SubagentStop',
        summary: `Subagente terminou${p.agent_type ? `: ${p.agent_type}` : ''}`,
        toolName: null,
      };
      break;
    }

    case 'TaskCreated': {
      const cur = s.progress ?? { done: 0, total: 0 };
      s.progress = { done: cur.done, total: cur.total + 1 };
      if (p.task_subject) {
        event = { type: 'TaskCreated', summary: `Tarefa: ${truncate(p.task_subject, 120)}`, toolName: null };
      }
      break;
    }

    case 'TaskCompleted': {
      const cur = s.progress ?? { done: 0, total: 1 };
      s.progress = { done: Math.min(cur.total, cur.done + 1), total: cur.total };
      if (p.task_subject) {
        event = {
          type: 'TaskCompleted',
          summary: `Concluída: ${truncate(p.task_subject, 120)}`,
          toolName: null,
        };
      }
      break;
    }

    case 'Stop': {
      closeTurn(s, now);
      setStatus('COMPLETED');
      s.pendingApprovals = 0;
      s.subagents = 0;
      const last = firstLine(p.last_assistant_message, 240);
      if (last) s.preview = last;
      if (s.progress && s.progress.total > 0) {
        s.progress = { done: s.progress.total, total: s.progress.total };
      }
      alerts.push(alert('completed', s, `Terminou · ${s.projectName}`, last ?? s.title, now));
      event = { type: 'Stop', summary: last ? `Terminou: ${truncate(last, 120)}` : 'Terminou', toolName: null };
      break;
    }

    case 'StopFailure': {
      closeTurn(s, now);
      setStatus('ERROR');
      s.pendingApprovals = 0;
      const why = firstLine(p.error_details, 200) ?? firstLine(p.error, 200) ?? 'O turno falhou';
      s.preview = why;
      alerts.push(alert('error', s, `Erro · ${s.projectName}`, why, now));
      event = { type: 'StopFailure', summary: `Erro: ${why}`, toolName: null };
      break;
    }

    case 'PreCompact': {
      event = { type: 'PreCompact', summary: 'Compactando o contexto', toolName: null };
      break;
    }

    case 'CwdChanged': {
      if (p.new_cwd) {
        const generic = hasGenericTitle(s);
        s.cwd = p.new_cwd;
        s.projectName = projectNameFromCwd(p.new_cwd);
        if (generic) s.title = s.projectName;
      }
      break;
    }

    case 'SessionEnd': {
      closeTurn(s, now);
      s.endedAt = now;
      s.pendingApprovals = 0;
      s.subagents = 0;
      if (s.status === 'WORKING' || s.status === 'APPROVAL_REQUIRED' || s.status === 'WAITING') {
        setStatus('IDLE');
      }
      event = { type: 'SessionEnd', summary: 'Sessão encerrada', toolName: null };
      break;
    }

    default:
      // Evento desconhecido: mantém o estado, apenas marca atividade.
      break;
  }

  s.updatedAt = now;
  if (event) s.lastEvent = { type: event.type, summary: event.summary, at: now };
  return { session: s, event, alerts };
}
