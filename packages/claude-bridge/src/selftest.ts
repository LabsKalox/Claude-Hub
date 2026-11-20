/**
 * Verificação de saúde: prova, com tráfego de verdade, que o caminho inteiro
 * funciona — hub no ar, evento de hook chegando por WebSocket e um pedido de
 * permissão sendo respondido de ponta a ponta.
 *
 * O pedido do autoteste é sintético: não existe comando por trás dele e a
 * resposta enviada é sempre "negar". Nada é executado e nada é aprovado.
 */
import { randomBytes } from 'node:crypto';
import { APPROVAL_MODE_LABEL, SELFTEST_PREFIX, type ServerMessage } from '@claude-hub/shared';
import { hookUrl, loadConfig, type HubConfig } from './config.js';
import { detectClaude } from './detect.js';
import { installedEvents, readSettings, settingsPath } from './install.js';
import { hooksAreCurrent, runtimeInfo } from './setup.js';

export interface Check {
  id: string;
  title: string;
  ok: boolean;
  detail: string;
  ms: number;
  /** Informativo: não derruba o resultado geral. */
  optional?: boolean;
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172_800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} dias`;
}

export async function selftest(): Promise<{ ok: boolean; checks: Check[] }> {
  const cfg = loadConfig() as HubConfig;
  const base = `http://127.0.0.1:${cfg.localPort}`;
  const checks: Check[] = [];
  const run = async (id: string, title: string, fn: () => Promise<string>, optional = false): Promise<boolean> => {
    const start = Date.now();
    try {
      checks.push({ id, title, ok: true, detail: await fn(), ms: Date.now() - start, ...(optional ? { optional } : {}) });
      return true;
    } catch (err) {
      checks.push({ id, title, ok: false, detail: (err as Error).message, ms: Date.now() - start, ...(optional ? { optional } : {}) });
      return false;
    }
  };
  const finish = () => ({ ok: checks.filter((c) => !c.optional).every((c) => c.ok), checks });
  const local = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${cfg.localToken}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`o hub respondeu ${res.status} em ${path}`);
    return (await res.json()) as T;
  };
  const hook = (body: Record<string, unknown>, timeoutMs: number) =>
    fetch(hookUrl(cfg), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.hookToken}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

  // 1. Hub no ar.
  const up = await run('hub', 'Hub local no ar', async () => {
    let res: Response;
    try {
      res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    } catch {
      throw new Error(`o hub não respondeu em 127.0.0.1:${cfg.localPort}`);
    }
    if (!res.ok) throw new Error(`o hub respondeu ${res.status}`);
    return `v${((await res.json()) as { version: string }).version} em 127.0.0.1:${cfg.localPort}`;
  });
  if (!up) return finish();

  // 2. Canal em tempo real autenticado.
  const messages: ServerMessage[] = [];
  let socket: WebSocket | null = null;
  const waitMessage = async <T extends ServerMessage>(match: (m: ServerMessage) => m is T, ms: number, what: string): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const found = messages.find(match);
      if (found) return found;
      if (Date.now() > end) throw new Error(`${what} não chegou pelo WebSocket em ${ms / 1000} s`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const wsOk = await run('realtime', 'Canal em tempo real autenticado', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${cfg.localPort}/ws`);
    socket = ws;
    ws.addEventListener('message', (ev) => {
      try {
        messages.push(JSON.parse(String(ev.data)) as ServerMessage);
      } catch {
        /* ignora */
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('não consegui abrir o WebSocket')));
      setTimeout(() => reject(new Error('o WebSocket não abriu em 3 s')), 3000);
    });
    ws.send(JSON.stringify({ type: 'auth', token: cfg.localToken, client: 'selftest' }));
    const snap = await waitMessage((m): m is Extract<ServerMessage, { type: 'snapshot' }> => m.type === 'snapshot', 3000, 'o estado inicial');
    return `${snap.sessions.length} sessão(ões) acompanhada(s); modo de aprovação: ${APPROVAL_MODE_LABEL[snap.settings.approvalMode] ?? snap.settings.approvalMode}`;
  });
  const mode = (messages.find((m) => m.type === 'snapshot') as Extract<ServerMessage, { type: 'snapshot' }> | undefined)?.settings.approvalMode;

  const sessionId = `${SELFTEST_PREFIX}${randomBytes(4).toString('hex')}`;
  const common = { session_id: sessionId, cwd: '/claude-hub/autoteste', session_title: 'Autoteste do Claude Hub' };
  if (wsOk) {
    // 3. Um evento de hook entra e aparece do outro lado.
    await run('event', 'Recebimento de eventos de hook', async () => {
      const start = Date.now();
      const res = await hook({ ...common, hook_event_name: 'UserPromptSubmit', prompt: 'Autoteste do Claude Hub' }, 5000);
      if (res.status === 401) throw new Error('o hub recusou o token de hook');
      if (!res.ok) throw new Error(`o hub respondeu ${res.status} ao evento`);
      await waitMessage(
        (m): m is Extract<ServerMessage, { type: 'session' }> => m.type === 'session' && m.session.id === sessionId && m.session.status === 'WORKING',
        3000,
        'o evento',
      );
      return `evento entregue e refletido como "Trabalhando" em ${Date.now() - start} ms`;
    });

    // 4. Pedido de permissão de ponta a ponta (sintético, sempre negado).
    await run('approval', 'Pedido de aprovação de ponta a ponta', async () => {
      const tool = { tool_name: 'Bash', tool_input: { command: 'echo claude-hub-autoteste' } };
      const held = hook({ ...common, hook_event_name: 'PermissionRequest', ...tool }, 15_000);
      if (mode === 'notify') {
        const res = await held;
        const text = await res.text();
        if (text.trim()) throw new Error('no modo "Só avisar" o hub não deveria responder ao pedido');
        await waitMessage((m): m is Extract<ServerMessage, { type: 'alert' }> => m.type === 'alert' && m.alert.sessionId === sessionId, 3000, 'o aviso');
        return 'modo "Só avisar": o hub avisou e devolveu a decisão ao terminal, como esperado';
      }
      const pending = await waitMessage(
        (m): m is Extract<ServerMessage, { type: 'approval' }> => m.type === 'approval' && m.approval.sessionId === sessionId && m.approval.status === 'pending',
        3000,
        'o pedido',
      );
      const start = Date.now();
      // Uma decisão tomada à mão na ilha durante o teste também vale.
      await local(`/api/approvals/${pending.approval.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'deny' }) }).catch(() => null);
      const out = (await (await held).json()) as { hookSpecificOutput?: { decision?: { behavior?: string } } };
      const behavior = out.hookSpecificOutput?.decision?.behavior;
      if (behavior !== 'deny' && behavior !== 'allow') throw new Error('o hook não recebeu uma decisão válida');
      const again = await fetch(`${base}/api/approvals/${pending.approval.id}/decision`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.localToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'allow' }),
      });
      if (again.status !== 409) throw new Error('uma segunda decisão para o mesmo pedido deveria ser recusada');
      return `pedido sintético respondido com "${behavior === 'deny' ? 'negar' : 'permitir'}" em ${Date.now() - start} ms; decisão repetida recusada`;
    });
    await hook({ ...common, hook_event_name: 'SessionEnd', reason: 'other' }, 3000).catch(() => null);
  }
  (socket as WebSocket | null)?.close();

  // 5. Hooks no settings.json do Claude Code.
  await run('hooks', 'Hooks instalados no Claude Code', async () => {
    const path = settingsPath('user');
    let settings;
    try {
      settings = readSettings(path);
    } catch {
      throw new Error(`${path} não é um JSON válido`);
    }
    const events = installedEvents(settings);
    if (events.length === 0) throw new Error(`nenhum hook do Claude Hub em ${path}`);
    if (!hooksAreCurrent(settings, cfg, runtimeInfo())) {
      throw new Error('os hooks apontam para outra porta, outro token ou outro local do app — use "Reparar"');
    }
    return `${events.length} eventos em ${path}`;
  });

  // 6. Claude Code presente.
  await run('claude', 'Claude Code instalado', async () => {
    const claude = detectClaude();
    if (!claude.found) throw new Error('não encontrei o comando "claude" nesta máquina');
    return `${claude.version ?? 'versão desconhecida'} em ${claude.path}`;
  });

  // 7. Já chegou algum evento de uma sessão de verdade?
  await run(
    'real-event',
    'Evento real de uma sessão do Claude Code',
    async () => {
      const info = await local<{ lastHookAt?: number | null }>('/local/info');
      if (!info.lastHookAt) throw new Error('ainda nenhum — abra uma sessão do Claude Code e envie um pedido para confirmar');
      return `último há ${ago(info.lastHookAt)}`;
    },
    true,
  );

  // 8. Notificações no iPhone: há inscrição? O último envio foi aceito?
  await run(
    'push',
    'Notificações no iPhone',
    async () => {
      const status = await local<PushStatus>('/local/push');
      const problem = pushProblem(status);
      if (problem) throw new Error(problem);
      return pushSummary(status);
    },
    true,
  );

  return finish();
}

/** Resposta de GET /local/push. */
export interface PushStatus {
  configured: boolean;
  subject: string | null;
  publicUrl: string | null;
  devices: Array<{
    id: string;
    name: string;
    lastSeenAt: number | null;
    subscriptions: number;
    lastClientReport: {
      at: number;
      step: string;
      outcome: string;
      permission: string;
      serviceWorker: string;
      standalone: string;
      subscribed: string;
      detail: string;
    } | null;
  }>;
  last: {
    at: number;
    kind: string;
    targets: number;
    delivered: number;
    removed: number;
    failures: Array<{ status: number | null; reason: string; host: string; deviceId: string | null }>;
  } | null;
}

const STEP_LABEL: Record<string, string> = {
  support: 'verificação do aparelho',
  permission: 'pedido de permissão do iOS',
  'service-worker': 'ativação do service worker',
  key: 'leitura da chave do hub',
  subscribe: 'inscrição no serviço de push',
  register: 'registro da inscrição no hub',
  done: 'conclusão',
};

/** "parou em <etapa> (<resultado>)" a partir do último relato de um aparelho. */
export function clientReportText(report: NonNullable<PushStatus['devices'][number]['lastClientReport']>): string {
  const outcome = report.outcome === 'ok' ? 'concluiu' : report.outcome === 'stalled' ? 'sem resposta' : 'falhou';
  const step = STEP_LABEL[report.step] ?? report.step;
  return `${step}: ${outcome} há ${ago(report.at)} (permissão ${report.permission}, service worker ${report.serviceWorker}, app instalado ${report.standalone})${report.detail ? ` — ${report.detail}` : ''}`;
}

/** O que impede as notificações de chegar, ou null se nada impede. */
export function pushProblem(status: PushStatus): string | null {
  if (!status.configured) return 'o hub está sem chaves de push';
  if (status.devices.length === 0) return null;
  const without = status.devices.filter((d) => d.subscriptions === 0);
  if (without.length > 0) {
    const names = without
      .map((d) => `${d.name}${d.lastClientReport ? ` [${clientReportText(d.lastClientReport)}]` : ' [nenhuma tentativa registrada pelo aparelho]'}`)
      .join('; ');
    return `aparelho pareado sem notificações ativas: ${names}. No iPhone: Ajustes → Ativar notificações`;
  }
  const failed = status.last?.failures.filter((f) => f.status !== 404 && f.status !== 410) ?? [];
  if (status.last && status.last.delivered === 0 && failed.length > 0) {
    const f = failed[0]!;
    return `o último envio foi recusado por ${f.host}: ${f.status ?? 'sem resposta'} ${f.reason} (há ${ago(status.last.at)})`;
  }
  return null;
}

export function pushSummary(status: PushStatus): string {
  if (status.devices.length === 0) return 'nenhum iPhone pareado ainda';
  const subs = status.devices.reduce((n, d) => n + d.subscriptions, 0);
  const last = status.last ? `último envio: ${status.last.delivered}/${status.last.targets} entregue(s) há ${ago(status.last.at)}` : 'nenhum envio até agora';
  return `${subs} inscrição(ões) em ${status.devices.length} aparelho(s); ${last}`;
}
