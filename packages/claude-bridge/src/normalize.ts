/**
 * Leitura defensiva dos payloads de hook do Claude Code.
 *
 * Os campos seguem a referência oficial de hooks (code.claude.com/docs/en/hooks)
 * e foram conferidos contra payloads reais do Claude Code 2.1.329
 * (ver tests/fixtures/real-session-claude-code-2.1.329.jsonl).
 * Tudo é opcional: versões diferentes do Claude Code mandam campos diferentes.
 */
import { truncate, type AgentKind } from '@claude-hub/shared';

export interface HookPayload {
  session_id: string;
  hook_event_name: string;
  cwd?: string;
  transcript_path?: string;
  permission_mode?: string;
  prompt_id?: string;
  agent_id?: string;
  agent_type?: string;
  // SessionStart
  source?: string;
  model?: string;
  session_title?: string;
  // UserPromptSubmit
  prompt?: string;
  // Ferramentas
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  tool_response?: unknown;
  error?: string;
  is_interrupt?: boolean;
  // Notification
  message?: string;
  title?: string;
  notification_type?: string;
  // Stop / StopFailure
  last_assistant_message?: string;
  error_details?: string;
  // SessionEnd / PermissionDenied
  reason?: string;
  // Tarefas
  task_id?: string;
  task_subject?: string;
  // CwdChanged
  new_cwd?: string;
  // Acrescentado pelo hook de comando do Claude Hub (não vem do Claude Code)
  hub_env?: { host_app?: string; term_program?: string };
  /**
   * Qual agente originou o evento. Ausente = Claude Code. Os adaptadores do
   * Codex e do OpenCode traduzem os eventos deles para este formato e marcam aqui.
   */
  hub_agent?: AgentKind;
  [key: string]: unknown;
}

export function parseHookPayload(input: unknown): HookPayload | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  if (typeof o.session_id !== 'string' || !o.session_id || o.session_id.length > 200) return null;
  if (typeof o.hook_event_name !== 'string' || !/^[A-Za-z]{1,64}$/.test(o.hook_event_name)) {
    return null;
  }
  if (o.hub_agent !== undefined && o.hub_agent !== 'claude-code' && o.hub_agent !== 'codex' && o.hub_agent !== 'opencode') {
    return null;
  }
  return o as HookPayload;
}

export function projectNameFromCwd(cwd: string | undefined): string {
  if (!cwd) return 'sessão';
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? 'sessão';
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function field(input: unknown, key: string): string | null {
  if (!input || typeof input !== 'object') return null;
  return str((input as Record<string, unknown>)[key]);
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Texto completo do que a ferramenta vai fazer — é o que aparece na caixa de
 * código do pedido de permissão. Nunca é truncado aqui: a aprovação precisa
 * mostrar o comando inteiro.
 */
export function describeToolCall(toolName: string, toolInput: unknown): string {
  const f = (k: string) => field(toolInput, k);
  switch (toolName) {
    case 'Bash':
    case 'BashOutput':
    case 'PowerShell':
      return f('command') ?? toolName;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return f('file_path') ?? f('notebook_path') ?? toolName;
    case 'Glob':
    case 'Grep':
      return [f('pattern'), f('path')].filter(Boolean).join('  em  ') || toolName;
    case 'WebFetch':
      return f('url') ?? toolName;
    case 'WebSearch':
      return f('query') ?? toolName;
    case 'Task':
    case 'Agent':
      return f('description') ?? f('prompt') ?? toolName;
    default: {
      const first = f('command') ?? f('file_path') ?? f('url') ?? f('query') ?? f('description');
      if (first) return first;
      if (toolInput && typeof toolInput === 'object' && Object.keys(toolInput).length > 0) {
        return JSON.stringify(toolInput, null, 2);
      }
      return toolName;
    }
  }
}

/** Nome curto da ferramenta para títulos ("Bash", "memory · create_entities"). */
export function toolLabel(toolName: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) return `${mcp[1]} · ${mcp[2]}`;
  return toolName;
}

/** Resumo de uma linha para listas e histórico. */
export function summarizeToolCall(toolName: string, toolInput: unknown): string {
  const f = (k: string) => field(toolInput, k);
  const label = toolLabel(toolName);
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return truncate(f('command') ?? label, 140);
    case 'Read':
      return `Lendo ${baseName(f('file_path') ?? '')}`.trim();
    case 'Write':
      return `Escrevendo ${baseName(f('file_path') ?? '')}`.trim();
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editando ${baseName(f('file_path') ?? f('notebook_path') ?? '')}`.trim();
    case 'Glob':
    case 'Grep':
      return truncate(`Procurando ${f('pattern') ?? ''}`.trim(), 140);
    case 'WebFetch':
      return truncate(`Abrindo ${f('url') ?? ''}`.trim(), 140);
    case 'WebSearch':
      return truncate(`Pesquisando ${f('query') ?? ''}`.trim(), 140);
    case 'Task':
    case 'Agent':
      return truncate(`Subagente: ${f('description') ?? ''}`.trim(), 140);
    case 'TodoWrite':
      return 'Atualizando lista de tarefas';
    default:
      return truncate(`${label}: ${describeToolCall(toolName, toolInput)}`, 140);
  }
}

/** Ferramentas que pedem uma resposta sua, e não uma autorização de execução. */
export const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * Progresso mensurável a partir da lista de tarefas do agente (TodoWrite).
 * Retorna null quando a ferramenta não carrega uma lista.
 */
export function todoProgress(toolInput: unknown): { done: number; total: number } | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const todos = (toolInput as Record<string, unknown>).todos;
  if (!Array.isArray(todos) || todos.length === 0) return null;
  let done = 0;
  for (const t of todos) {
    if (t && typeof t === 'object' && (t as Record<string, unknown>).status === 'completed') done++;
  }
  return { done, total: todos.length };
}

/** Primeira linha útil de uma mensagem, sem marcação pesada. */
export function firstLine(text: string | undefined | null, max = 220): string | null {
  if (!text) return null;
  const cleaned = text
    .split('\n')
    .map((l) => l.replace(/^[#>*\-\s`]+/, '').trim())
    .filter(Boolean)
    .join(' ');
  return cleaned ? truncate(cleaned, max) : null;
}
