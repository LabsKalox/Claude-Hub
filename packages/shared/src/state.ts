/**
 * Estado do cliente (PWA e ilha web) e o redutor que aplica as mensagens do
 * hub. O app macOS tem o equivalente em Swift (HubState.swift).
 */
import {
  DEFAULT_SETTINGS,
  type Approval,
  type HubAlert,
  type HubEvent,
  type HubSettings,
  type ServerMessage,
  type Session,
} from './core.js';

export interface ClientState {
  sessions: Session[];
  /** Pedidos pendentes, do mais antigo para o mais novo. */
  approvals: Approval[];
  settings: HubSettings;
  /** Eventos recebidos ao vivo, do mais novo para o mais antigo (limitado). */
  events: HubEvent[];
  /** Último alerta recebido (a interface decide por quanto tempo mostrar). */
  alert: HubAlert | null;
  /** Diferença entre o relógio do servidor e o local, em ms. */
  clockSkew: number;
  ready: boolean;
}

export const EMPTY_STATE: ClientState = {
  sessions: [],
  approvals: [],
  settings: DEFAULT_SETTINGS,
  events: [],
  alert: null,
  clockSkew: 0,
  ready: false,
};

const MAX_LIVE_EVENTS = 200;

export function applyServerMessage(state: ClientState, msg: ServerMessage, localNow: number = Date.now()): ClientState {
  switch (msg.type) {
    case 'snapshot':
      return {
        ...state,
        sessions: msg.sessions,
        approvals: [...msg.approvals].sort((a, b) => a.createdAt - b.createdAt),
        settings: msg.settings,
        clockSkew: msg.serverTime - localNow,
        ready: true,
      };
    case 'session': {
      const rest = state.sessions.filter((s) => s.id !== msg.session.id);
      return { ...state, sessions: [msg.session, ...rest] };
    }
    case 'session_removed':
      return {
        ...state,
        sessions: state.sessions.filter((s) => s.id !== msg.sessionId),
        approvals: state.approvals.filter((a) => a.sessionId !== msg.sessionId),
      };
    case 'event':
      return { ...state, events: [msg.event, ...state.events].slice(0, MAX_LIVE_EVENTS) };
    case 'approval': {
      const rest = state.approvals.filter((a) => a.id !== msg.approval.id);
      // Só pedidos pendentes ficam na fila; decididos/expirados saem.
      const approvals = msg.approval.status === 'pending' ? [...rest, msg.approval] : rest;
      return { ...state, approvals: approvals.sort((a, b) => a.createdAt - b.createdAt) };
    }
    case 'settings':
      return { ...state, settings: msg.settings };
    case 'alert':
      return { ...state, alert: msg.alert };
    default:
      return state;
  }
}
