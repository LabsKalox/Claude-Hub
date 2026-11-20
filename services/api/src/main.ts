#!/usr/bin/env node
/** Ponto de entrada do hub local. */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbPath, loadConfig, saveConfig, type HubConfig } from '@claude-hub/claude-bridge';
import { Audit } from './audit.js';
import { Auth } from './auth.js';
import { ConsumptionStore } from './consumption.js';
import { AgentUsageStore } from './agent-usage.js';
import { CodexRolloutReader } from './codex-rollout.js';
import { openDb } from './db.js';
import { Hub } from './hub.js';
import { WebPushSender, ensureVapid, resolveVapidSubject } from './push.js';
import { VERSION, createServers } from './server.js';

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const config = loadConfig() as HubConfig;
  {
    // Gera o par de chaves de push uma única vez e guarda junto dos demais segredos.
    // Quem vem de uma versão antiga mantém as chaves (as inscrições continuam
    // valendo) e só troca o "subject" local, que o serviço da Apple recusa.
    const stored = loadConfig() as HubConfig;
    const vapid = ensureVapid(stored);
    if (!stored.vapid || stored.vapid.subject !== vapid.subject) saveConfig({ ...stored, vapid });
    config.vapid = vapid;
  }

  const db = openDb(process.env.CLAUDE_HUB_DB || dbPath());
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  // O serviço de push da Apple recusa o JWT quando o "subject" é local ou malformado.
  const subject = resolveVapidSubject(config.vapid.subject, config.publicUrl);
  const pushLog = (m: string) => console.log(`${new Date().toISOString()} [push] ${m}`);
  const push = new WebPushSender(db, config.vapid, subject, { log: pushLog, audit });
  const hub = new Hub({ db, audit, push, approvalTimeoutSec: config.approvalTimeoutSec });

  // PWA: variável de ambiente, ao lado do hub (runtime embutido no app) ou no repositório.
  const candidates = [process.env.CLAUDE_HUB_WEB_DIR, join(here, 'web'), join(here, '../../../apps/web/out')].filter(Boolean) as string[];
  const webDir = candidates.find((d) => existsSync(join(d, 'index.html')));

  const consumption = new ConsumptionStore(db);
  const agentUsage = new AgentUsageStore(db);
  const codexRollout = new CodexRolloutReader({ usage: agentUsage, emit: (p) => hub.ingestHook(p) });
  codexRollout.start();
  const servers = createServers({ hub, auth, audit, db, push, pushLog, consumption, agentUsage, codexRollout, config, webDir });
  await servers.local.listen({ host: config.localHost, port: config.localPort });
  await servers.public.listen({ host: config.publicHost, port: config.publicPort });

  const sweep = setInterval(() => hub.sweep(), 10 * 60 * 1000);
  sweep.unref();

  console.log(`Claude Hub ${VERSION}`);
  console.log(`  local   http://${config.localHost}:${config.localPort}  (hooks, app macOS, CLI)`);
  console.log(`  iPhone  http://${config.publicHost}:${config.publicPort}${config.publicUrl ? `  →  ${config.publicUrl}` : ''}`);
  console.log(`  PWA     ${webDir ?? 'não compilada (rode "pnpm build")'}`);
  console.log(`  push    subject ${subject}`);

  const shutdown = async () => {
    clearInterval(sweep);
    hub.close();
    await Promise.allSettled([servers.local.close(), servers.public.close()]);
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'EADDRINUSE') {
    console.error('A porta do Claude Hub já está em uso — provavelmente ele já está rodando.');
  } else {
    console.error(err);
  }
  process.exit(1);
});
