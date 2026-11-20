#!/usr/bin/env node
/**
 * Ponte da linha de status do Claude Code.
 *
 * O Claude Code entrega no stdin um JSON com, entre outras coisas, os limites
 * do plano (`rate_limits`) e o uso do contexto. Esta ponte:
 *   1. repassa ao hub local só os campos de limites e contexto;
 *   2. mostra a linha de status que o usuário já tinha (rodando o comando
 *      original com o mesmo JSON), ou uma linha curta própria se não havia.
 *
 * Nunca falha a ponto de atrapalhar o Claude Code: qualquer erro vira silêncio.
 */
import { spawnSync } from 'node:child_process';
import { STATUSLINE_PATH, loadConfig } from './config.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

interface StatusInput {
  session_id?: string;
  rate_limits?: Record<string, { used_percentage?: number; resets_at?: number } | null>;
  context_window?: { used_percentage?: number | null; context_window_size?: number };
}

function ownLine(data: StatusInput): string {
  const parts = ['Claude Hub'];
  const ctx = data.context_window?.used_percentage;
  if (typeof ctx === 'number') parts.push(`contexto ${Math.round(ctx)}%`);
  const five = data.rate_limits?.five_hour?.used_percentage;
  if (typeof five === 'number') parts.push(`5 h ${Math.round(five)}%`);
  const week = data.rate_limits?.seven_day?.used_percentage;
  if (typeof week === 'number') parts.push(`7 d ${Math.round(week)}%`);
  return parts.join(' · ');
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const cfg = loadConfig({ create: false });
  let data: StatusInput = {};
  try {
    data = JSON.parse(raw) as StatusInput;
  } catch {
    /* segue: ainda mostra a linha original */
  }

  if (cfg) {
    // Só o necessário sai daqui: nada de caminhos, modelo, custo ou transcrição.
    const payload = { session_id: data.session_id, rate_limits: data.rate_limits, context_window: data.context_window };
    await fetch(`http://127.0.0.1:${cfg.localPort}${STATUSLINE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.hookToken}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(800),
    }).catch(() => null);
  }

  const original = cfg?.statusLineOriginal;
  if (original && typeof original.command === 'string' && original.command.trim()) {
    const r = spawnSync('/bin/sh', ['-c', original.command], { input: raw, encoding: 'utf8', timeout: 5000, env: process.env });
    if (r.status === 0 && typeof r.stdout === 'string') {
      process.stdout.write(r.stdout);
      return;
    }
  }
  process.stdout.write(`${ownLine(data)}\n`);
}

main()
  .catch(() => {
    /* silêncio */
  })
  .finally(() => {
    process.exitCode = 0;
  });
