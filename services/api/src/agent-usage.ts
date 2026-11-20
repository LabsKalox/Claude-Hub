/**
 * Consumo do Codex e do OpenCode — só com dados que os próprios agentes gravam
 * ou emitem. Nada é estimado aqui.
 *
 *  - Codex: o leitor do arquivo de sessão (`codex-rollout.ts`) entrega o
 *    `last_token_usage` de cada `token_count` e os limites do plano ChatGPT.
 *  - OpenCode: o plugin entrega os tokens e o custo de cada resposta concluída.
 */
import type { AgentUsageStats, LimitWindowStats } from '@claude-hub/shared';
import type { Db } from './db.js';
import { localDay } from './consumption.js';

export const AGENT_USAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_consumption (
  day TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  PRIMARY KEY (day, agent, model, kind)
);
`;

export type UsageAgent = AgentUsageStats['agent'];
export const USAGE_AGENTS: readonly UsageAgent[] = ['codex', 'opencode'];
const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'costUsd'] as const;
type Kind = (typeof KINDS)[number];

export interface AgentUsageReport {
  agent: UsageAgent;
  model?: string | null;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  costUsd?: number | null;
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** Valida o corpo de POST /hooks/agent-usage. */
export function parseAgentUsage(body: unknown): AgentUsageReport | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.agent !== 'codex' && b.agent !== 'opencode') return null;
  const out: AgentUsageReport = { agent: b.agent, model: typeof b.model === 'string' ? b.model.slice(0, 80) : null };
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const) {
    const v = finite(b[k]);
    if (v !== null) out[k] = v;
  }
  const cost = finite(b.costUsd);
  if (cost !== null) out.costUsd = cost;
  return out;
}

/** Rótulo de uma janela de limite pelo tamanho que o agente informou. */
export function windowLabel(minutes: number | null): string {
  if (minutes === 300) return 'Janela de 5 horas';
  if (minutes === 10080) return 'Janela semanal';
  if (minutes === null) return 'Limite do plano';
  if (minutes % 1440 === 0) return `Janela de ${minutes / 1440} dias`;
  if (minutes % 60 === 0) return `Janela de ${minutes / 60} horas`;
  return `Janela de ${minutes} min`;
}

export class AgentUsageStore {
  private readonly limits = new Map<UsageAgent, { windows: LimitWindowStats[]; updatedAt: number }>();
  private readonly updatedAt = new Map<UsageAgent, number>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(AGENT_USAGE_SCHEMA);
    for (const agent of USAGE_AGENTS) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`agentLimits.${agent}`) as { value: string } | undefined;
      if (row) {
        try {
          this.limits.set(agent, JSON.parse(row.value));
        } catch {
          /* valor antigo ilegível */
        }
      }
      const at = db.prepare('SELECT value FROM settings WHERE key = ?').get(`agentUsageAt.${agent}`) as { value: string } | undefined;
      if (at && Number(at.value)) this.updatedAt.set(agent, Number(at.value));
    }
  }

  private setting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Soma um incremento de consumo. Devolve se algo foi registrado. */
  record(r: AgentUsageReport): boolean {
    const now = this.now();
    const day = localDay(now);
    const model = r.model || 'desconhecido';
    let used = false;
    for (const kind of KINDS) {
      const amount = r[kind];
      if (typeof amount !== 'number' || amount <= 0) continue;
      this.db
        .prepare(
          `INSERT INTO agent_consumption (day, agent, model, kind, amount) VALUES (?,?,?,?,?)
           ON CONFLICT(day, agent, model, kind) DO UPDATE SET amount = amount + excluded.amount`,
        )
        .run(day, r.agent, model, kind, amount);
      used = true;
    }
    if (used) {
      this.updatedAt.set(r.agent, now);
      this.setting(`agentUsageAt.${r.agent}`, String(now));
    }
    return used;
  }

  /** Limites do plano exatamente como o agente informou (percentual e horário de renovação). */
  setLimits(agent: UsageAgent, windows: LimitWindowStats[]): void {
    if (windows.length === 0) return;
    const value = { windows, updatedAt: this.now() };
    this.limits.set(agent, value);
    this.setting(`agentLimits.${agent}`, JSON.stringify(value));
  }

  stats(since: number): AgentUsageStats[] {
    const now = this.now();
    return USAGE_AGENTS.map((agent) => {
      const rows = this.db
        .prepare('SELECT model, kind, SUM(amount) AS amount FROM agent_consumption WHERE agent = ? AND day >= ? GROUP BY model, kind')
        .all(agent, localDay(since)) as unknown as Array<{ model: string; kind: Kind; amount: number }>;
      const totals: Record<Kind, number> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };
      const byModel = new Map<string, { model: string; inputTokens: number; outputTokens: number; costUsd: number | null }>();
      let anyCost = false;
      for (const r of rows) {
        totals[r.kind] += r.amount;
        const m = byModel.get(r.model) ?? { model: r.model, inputTokens: 0, outputTokens: 0, costUsd: null };
        if (r.kind === 'input') m.inputTokens = Math.round(r.amount);
        if (r.kind === 'output') m.outputTokens = Math.round(r.amount);
        if (r.kind === 'costUsd') {
          m.costUsd = r.amount;
          anyCost = true;
        }
        byModel.set(r.model, m);
      }
      const saved = this.limits.get(agent);
      return {
        agent,
        inputTokens: Math.round(totals.input),
        outputTokens: Math.round(totals.output),
        cacheReadTokens: Math.round(totals.cacheRead),
        cacheCreationTokens: Math.round(totals.cacheWrite),
        reasoningTokens: Math.round(totals.reasoning),
        costUsd: anyCost ? totals.costUsd : null,
        byModel: [...byModel.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
        updatedAt: rows.length > 0 ? (this.updatedAt.get(agent) ?? null) : null,
        // OpenCode não tem limites de plano; o Codex só tem quando informou.
        limits:
          agent === 'opencode'
            ? null
            : {
                // Janela cujo horário de renovação já passou não vale mais.
                windows: (saved?.windows ?? []).filter((w) => w.resetsAt === null || w.resetsAt > now),
                updatedAt: saved?.updatedAt ?? null,
              },
      };
    });
  }
}
