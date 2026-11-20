/**
 * Consumo do Claude (tokens e custo) e limites do plano — somente dados que o
 * próprio Claude Code informa, por dois mecanismos oficiais:
 *
 *  - métricas OpenTelemetry (`claude_code.token.usage`, `claude_code.cost.usage`),
 *    exportadas pelo Claude Code para este hub quando a medição está ligada;
 *  - o JSON da linha de status (`rate_limits`, `context_window`), repassado pela
 *    ponte de linha de status quando a leitura de limites está ligada.
 *
 * Nada aqui é estimado pelo hub: sem dado recebido, o campo fica vazio.
 * Atributos pessoais das métricas (e-mail, conta, organização) são descartados.
 */
import type { Db } from './db.js';

export const CONSUMPTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS consumption (
  day TEXT NOT NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  PRIMARY KEY (day, model, kind)
);
`;

export type TokenKind = 'input' | 'output' | 'cacheRead' | 'cacheCreation';
const TOKEN_KINDS: readonly string[] = ['input', 'output', 'cacheRead', 'cacheCreation'];

export interface ModelConsumption {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
}

export interface Consumption extends Omit<ModelConsumption, 'model'> {
  enabled: boolean;
  source: 'otel' | null;
  since: number;
  byModel: ModelConsumption[];
  updatedAt: number | null;
}

export interface LimitWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: number | null;
}

export interface Limits {
  enabled: boolean;
  source: 'statusline' | null;
  updatedAt: number | null;
  windows: LimitWindow[];
  context: { usedPercent: number; windowSize: number | null; sessionId: string | null } | null;
}

const WINDOW_LABEL: Record<string, string> = {
  five_hour: 'Janela de 5 horas',
  seven_day: 'Janela de 7 dias',
  spend_limit: 'Limite de gasto',
};

/** Dia local (AAAA-MM-DD) de um instante. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface OtlpAttribute {
  key?: string;
  value?: { stringValue?: string; intValue?: string | number; doubleValue?: number };
}
interface OtlpPoint {
  asDouble?: number;
  asInt?: string | number;
  attributes?: OtlpAttribute[];
}
interface OtlpMetric {
  name?: string;
  sum?: { aggregationTemporality?: number | string; dataPoints?: OtlpPoint[] };
}

function attr(point: OtlpPoint, key: string): string | null {
  const found = point.attributes?.find((a) => a.key === key)?.value;
  if (!found) return null;
  if (typeof found.stringValue === 'string') return found.stringValue;
  if (found.intValue !== undefined) return String(found.intValue);
  return null;
}

function num(point: OtlpPoint): number | null {
  const v = point.asDouble ?? (point.asInt !== undefined ? Number(point.asInt) : undefined);
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export class ConsumptionStore {
  /** Último valor visto por série, para converter métricas cumulativas em incrementos. */
  private readonly lastCumulative = new Map<string, number>();
  private limits: Omit<Limits, 'enabled'> = { source: null, updatedAt: null, windows: [], context: null };
  private updatedAt: number | null = null;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(CONSUMPTION_SCHEMA);
    const saved = db.prepare("SELECT value FROM settings WHERE key = 'limits'").get() as { value: string } | undefined;
    if (saved) {
      try {
        this.limits = JSON.parse(saved.value) as Omit<Limits, 'enabled'>;
      } catch {
        /* ignora valor antigo ilegível */
      }
    }
    const at = db.prepare("SELECT value FROM settings WHERE key = 'consumptionUpdatedAt'").get() as { value: string } | undefined;
    this.updatedAt = at ? Number(at.value) || null : null;
  }

  private add(day: string, model: string, kind: string, amount: number): void {
    if (amount <= 0) return;
    this.db
      .prepare(
        `INSERT INTO consumption (day, model, kind, amount) VALUES (?,?,?,?)
         ON CONFLICT(day, model, kind) DO UPDATE SET amount = amount + excluded.amount`,
      )
      .run(day, model, kind, amount);
  }

  /** Recebe um corpo OTLP/HTTP JSON de métricas. Devolve quantos pontos foram aproveitados. */
  ingestOtlpMetrics(body: unknown): number {
    const now = this.now();
    const day = localDay(now);
    let used = 0;
    const resourceMetrics = (body as { resourceMetrics?: Array<{ scopeMetrics?: Array<{ metrics?: OtlpMetric[] }> }> })?.resourceMetrics;
    if (!Array.isArray(resourceMetrics)) return 0;
    for (const rm of resourceMetrics) {
      for (const sm of rm?.scopeMetrics ?? []) {
        for (const metric of sm?.metrics ?? []) {
          const isTokens = metric?.name === 'claude_code.token.usage';
          const isCost = metric?.name === 'claude_code.cost.usage';
          if (!isTokens && !isCost) continue;
          const temporality = metric.sum?.aggregationTemporality;
          const cumulative = temporality === 2 || temporality === 'AGGREGATION_TEMPORALITY_CUMULATIVE';
          for (const point of metric.sum?.dataPoints ?? []) {
            const value = num(point);
            if (value === null) continue;
            const model = (attr(point, 'model') ?? 'desconhecido').slice(0, 80);
            const kind = isCost ? 'costUsd' : attr(point, 'type');
            if (!kind || (isTokens && !TOKEN_KINDS.includes(kind))) continue;
            let delta = value;
            if (cumulative) {
              const series = `${metric.name}|${attr(point, 'session.id') ?? ''}|${model}|${kind}`;
              const last = this.lastCumulative.get(series);
              delta = last === undefined || value < last ? value : value - last;
              this.lastCumulative.set(series, value);
            }
            this.add(day, model, kind, delta);
            used++;
          }
        }
      }
    }
    if (used > 0) {
      this.updatedAt = now;
      this.db
        .prepare("INSERT INTO settings (key, value) VALUES ('consumptionUpdatedAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(now));
    }
    return used;
  }

  /** Recebe o JSON da linha de status do Claude Code (só os campos de limites e contexto). */
  ingestStatusLine(input: unknown): boolean {
    if (!input || typeof input !== 'object') return false;
    const data = input as {
      session_id?: unknown;
      rate_limits?: Record<string, { used_percentage?: unknown; resets_at?: unknown } | null | undefined>;
      context_window?: { used_percentage?: unknown; context_window_size?: unknown };
    };
    const now = this.now();
    const windows: LimitWindow[] = [];
    if (data.rate_limits && typeof data.rate_limits === 'object') {
      for (const [id, w] of Object.entries(data.rate_limits)) {
        const used = finite(w?.used_percentage);
        if (used === null || used < 0) continue;
        const resets = finite(w?.resets_at);
        windows.push({
          id: id.slice(0, 40),
          label: WINDOW_LABEL[id] ?? id.slice(0, 40),
          usedPercent: used,
          // O Claude Code informa em segundos desde 1970.
          resetsAt: resets !== null && resets > 0 ? Math.round(resets * 1000) : null,
        });
      }
    }
    const ctxUsed = finite(data.context_window?.used_percentage);
    const context =
      ctxUsed === null
        ? null
        : {
            usedPercent: ctxUsed,
            windowSize: finite(data.context_window?.context_window_size),
            sessionId: typeof data.session_id === 'string' ? data.session_id.slice(0, 200) : null,
          };
    // Sem janelas neste envio (ex.: antes da primeira resposta), mantém as últimas informadas.
    this.limits = {
      source: 'statusline',
      updatedAt: now,
      windows: windows.length > 0 ? windows : this.limits.windows,
      context: context ?? this.limits.context,
    };
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('limits', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(this.limits));
    return true;
  }

  consumption(since: number, enabled: boolean): Consumption {
    const rows = this.db
      .prepare('SELECT model, kind, SUM(amount) AS amount FROM consumption WHERE day >= ? GROUP BY model, kind')
      .all(localDay(since)) as unknown as Array<{ model: string; kind: string; amount: number }>;
    const byModel = new Map<string, ModelConsumption>();
    for (const r of rows) {
      const m =
        byModel.get(r.model) ??
        ({ model: r.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null } as ModelConsumption);
      if (r.kind === 'input') m.inputTokens = Math.round(r.amount);
      else if (r.kind === 'output') m.outputTokens = Math.round(r.amount);
      else if (r.kind === 'cacheRead') m.cacheReadTokens = Math.round(r.amount);
      else if (r.kind === 'cacheCreation') m.cacheCreationTokens = Math.round(r.amount);
      else if (r.kind === 'costUsd') m.costUsd = r.amount;
      byModel.set(r.model, m);
    }
    const list = [...byModel.values()].sort((a, b) => b.inputTokens + b.outputTokens + b.cacheReadTokens - (a.inputTokens + a.outputTokens + a.cacheReadTokens));
    const sum = (f: (m: ModelConsumption) => number) => list.reduce((acc, m) => acc + f(m), 0);
    const anyCost = list.some((m) => m.costUsd !== null);
    return {
      enabled,
      source: list.length > 0 ? 'otel' : null,
      since,
      inputTokens: sum((m) => m.inputTokens),
      outputTokens: sum((m) => m.outputTokens),
      cacheReadTokens: sum((m) => m.cacheReadTokens),
      cacheCreationTokens: sum((m) => m.cacheCreationTokens),
      costUsd: anyCost ? sum((m) => m.costUsd ?? 0) : null,
      byModel: list,
      updatedAt: list.length > 0 ? this.updatedAt : null,
    };
  }

  getLimits(enabled: boolean): Limits {
    const now = this.now();
    // Uma janela cujo horário de renovação já passou não vale mais: o Claude Code
    // também a descarta. Mostrar o percentual antigo seria inventar um número.
    const windows = this.limits.windows.filter((w) => w.resetsAt === null || w.resetsAt > now);
    return { enabled, source: this.limits.source, updatedAt: this.limits.updatedAt, windows, context: this.limits.context };
  }
}
