/**
 * Registro de auditoria só-acréscimo com cadeia de hashes: cada registro
 * inclui o hash do anterior, então qualquer edição ou remoção posterior
 * quebra a verificação (`claude-hub audit --verify`).
 */
import { createHash } from 'node:crypto';
import type { Db } from './db.js';

export interface AuditEntry {
  id: number;
  at: number;
  actor: string;
  action: string;
  approvalId: string | null;
  sessionId: string | null;
  detail: string;
  hash: string;
}

interface AuditRow {
  id: number;
  at: number;
  actor: string;
  action: string;
  approval_id: string | null;
  session_id: string | null;
  detail: string;
  prev_hash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

function digest(prev: string, r: Omit<AuditRow, 'id' | 'prev_hash' | 'hash'>): string {
  return createHash('sha256')
    .update(prev)
    .update('\n')
    .update(JSON.stringify([r.at, r.actor, r.action, r.approval_id, r.session_id, r.detail]))
    .digest('hex');
}

export class Audit {
  constructor(private readonly db: Db) {}

  record(input: {
    at: number;
    actor: string;
    action: string;
    approvalId?: string | null;
    sessionId?: string | null;
    detail?: string;
  }): void {
    const last = this.db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get() as
      | { hash: string }
      | undefined;
    const prev = last?.hash ?? GENESIS;
    const row = {
      at: input.at,
      actor: input.actor,
      action: input.action,
      approval_id: input.approvalId ?? null,
      session_id: input.sessionId ?? null,
      detail: input.detail ?? '',
    };
    this.db
      .prepare(
        'INSERT INTO audit (at, actor, action, approval_id, session_id, detail, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(row.at, row.actor, row.action, row.approval_id, row.session_id, row.detail, prev, digest(prev, row));
  }

  list(limit = 100): AuditEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?')
      .all(Math.min(500, Math.max(1, limit))) as unknown as AuditRow[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      actor: r.actor,
      action: r.action,
      approvalId: r.approval_id,
      sessionId: r.session_id,
      detail: r.detail,
      hash: r.hash,
    }));
  }

  verify(): { ok: boolean; entries: number; brokenAt: number | null } {
    const rows = this.db.prepare('SELECT * FROM audit ORDER BY id ASC').all() as unknown as AuditRow[];
    let prev = GENESIS;
    for (const r of rows) {
      if (r.prev_hash !== prev || r.hash !== digest(prev, r)) {
        return { ok: false, entries: rows.length, brokenAt: r.id };
      }
      prev = r.hash;
    }
    return { ok: true, entries: rows.length, brokenAt: null };
  }
}
