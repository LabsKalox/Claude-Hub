/**
 * Autenticação.
 *
 *  - Porta local: token local (app macOS/CLI) e token de hook (só envia eventos).
 *  - Porta pública: token de dispositivo, obtido uma única vez por pareamento.
 *
 * Tokens de dispositivo e códigos de pareamento são guardados apenas como
 * SHA-256; o valor em claro só existe no momento da emissão.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { DeviceInfo } from '@claude-hub/shared';
import type { Audit } from './audit.js';
import type { Db } from './db.js';

/** Dez minutos: tempo para escanear o QR, instalar o app na Tela de Início e abri-lo. */
const PAIRING_TTL_MS = 10 * 60 * 1000;
const PAIRING_MAX_ATTEMPTS = 5;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(sha256(a));
  const y = Buffer.from(sha256(b));
  return timingSafeEqual(x, y);
}

export function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m ? (m[1] as string) : null;
}

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Janela deslizante simples para frear tentativas de força bruta. */
export class RateLimiter {
  private hits: number[] = [];
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  blocked(now: number): boolean {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    return this.hits.length >= this.max;
  }
  hit(now: number): void {
    this.hits.push(now);
  }
}

export interface Device {
  id: string;
  name: string;
}

export type PairResult =
  | { ok: true; deviceId: string; deviceToken: string }
  | { ok: false; reason: 'invalid' | 'rate_limited' };

export class Auth {
  private readonly pairFailures = new RateLimiter(10, 60_000);
  readonly authFailures = new RateLimiter(30, 60_000);
  private lastSeenWrite = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
    private readonly now: () => number = Date.now,
  ) {}

  /** Gera um código de uso único. Códigos anteriores ainda ativos são invalidados. */
  createPairing(): { code: string; expiresAt: number } {
    const now = this.now();
    this.db.prepare('DELETE FROM pairing_codes WHERE used_at IS NULL OR expires_at < ?').run(now);
    let raw = '';
    for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const expiresAt = now + PAIRING_TTL_MS;
    this.db.prepare('INSERT INTO pairing_codes (code_hash, expires_at) VALUES (?, ?)').run(sha256(raw), expiresAt);
    this.audit.record({ at: now, actor: 'local', action: 'pairing.created' });
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
  }

  pair(code: string, deviceName: string): PairResult {
    const now = this.now();
    if (this.pairFailures.blocked(now)) return { ok: false, reason: 'rate_limited' };
    const hash = sha256(normalizeCode(String(code ?? '')));
    const row = this.db
      .prepare('SELECT code_hash FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?')
      .get(hash, now) as { code_hash: string } | undefined;
    if (!row) {
      this.pairFailures.hit(now);
      // Cada erro consome tentativas do código ativo; ao estourar, ele morre.
      this.db.prepare('UPDATE pairing_codes SET attempts = attempts + 1 WHERE used_at IS NULL').run();
      this.db.prepare('DELETE FROM pairing_codes WHERE used_at IS NULL AND attempts >= ?').run(PAIRING_MAX_ATTEMPTS);
      this.audit.record({ at: now, actor: 'desconhecido', action: 'pairing.failed' });
      return { ok: false, reason: 'invalid' };
    }
    const used = this.db
      .prepare('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL')
      .run(now, hash);
    if (used.changes !== 1) return { ok: false, reason: 'invalid' };

    const deviceId = `dev_${randomBytes(6).toString('hex')}`;
    const deviceToken = randomBytes(32).toString('base64url');
    const name = String(deviceName || 'iPhone').replace(/[\u0000-\u001f]/g, '').slice(0, 60) || 'iPhone';
    this.db
      .prepare('INSERT INTO devices (id, name, token_hash, created_at) VALUES (?,?,?,?)')
      .run(deviceId, name, sha256(deviceToken), now);
    this.audit.record({ at: now, actor: deviceId, action: 'device.paired', detail: name });
    return { ok: true, deviceId, deviceToken };
  }

  deviceFromToken(token: string | null): Device | null {
    if (!token) return null;
    const row = this.db
      .prepare('SELECT id, name FROM devices WHERE token_hash = ? AND revoked_at IS NULL')
      .get(sha256(token)) as { id: string; name: string } | undefined;
    if (!row) return null;
    const now = this.now();
    if (now - (this.lastSeenWrite.get(row.id) ?? 0) > 60_000) {
      this.lastSeenWrite.set(row.id, now);
      this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, row.id);
    }
    return row;
  }

  listDevices(): DeviceInfo[] {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.name, d.created_at, d.last_seen_at,
                (SELECT COUNT(*) FROM push_subscriptions p WHERE p.device_id = d.id) AS subs
         FROM devices d WHERE d.revoked_at IS NULL ORDER BY d.created_at DESC`,
      )
      .all() as unknown as Array<{ id: string; name: string; created_at: number; last_seen_at: number | null; subs: number }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      pushEnabled: r.subs > 0,
    }));
  }

  revokeDevice(id: string, actor: string): boolean {
    const now = this.now();
    const r = this.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id);
    if (r.changes !== 1) return false;
    this.db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(id);
    this.audit.record({ at: now, actor, action: 'device.revoked', detail: id });
    return true;
  }
}
