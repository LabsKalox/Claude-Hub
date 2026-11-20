import type { AddressInfo } from 'node:net';
import { defaultConfig, type HubConfig } from '@claude-hub/claude-bridge';
import { Audit } from '../src/audit.js';
import { Auth } from '../src/auth.js';
import { ConsumptionStore } from '../src/consumption.js';
import { openDb, type Db } from '../src/db.js';
import { Hub } from '../src/hub.js';
import { WebPushSender, type PushPayload, type PushResult, type PushSender, type WebPushOptions } from '../src/push.js';
import { createServers } from '../src/server.js';

export class FakePush implements PushSender {
  readonly publicKey = 'fake-public-key';
  sent: PushPayload[] = [];
  async send(payload: PushPayload): Promise<PushResult> {
    this.sent.push(payload);
    return { at: Date.now(), kind: payload.kind, targets: 1, delivered: 1, removed: 0, failures: [] };
  }
}

export interface TestHub {
  config: HubConfig;
  db: Db;
  hub: Hub;
  auth: Auth;
  audit: Audit;
  push: FakePush;
  /** Linhas que iriam para o hub.log. */
  pushLog: string[];
  localUrl: string;
  publicUrl: string;
  /** Envia um evento de hook como o Claude Code faria. */
  hook(event: string, extra?: Record<string, unknown>, init?: RequestInit): Promise<Response>;
  local(path: string, init?: RequestInit): Promise<Response>;
  /** Pareia um dispositivo e devolve o token. */
  pairDevice(name?: string): Promise<string>;
  device(token: string, path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/** Par de chaves VAPID de teste (formato válido; não assina nada de verdade). */
export const TEST_VAPID = {
  publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
  privateKey: 'UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls',
  subject: 'mailto:claude-hub@example.com',
};

export async function startHub(opts: { approvalTimeoutSec?: number; pushTransport?: WebPushOptions['transport'] } = {}): Promise<TestHub> {
  const config = { ...defaultConfig(), approvalTimeoutSec: opts.approvalTimeoutSec ?? 30 };
  const db = openDb(':memory:');
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  const push = new FakePush();
  const pushLog: string[] = [];
  // Com `pushTransport`, usa o remetente de verdade com a rede trocada pelo teste.
  const sender: PushSender = opts.pushTransport
    ? new WebPushSender(db, TEST_VAPID, TEST_VAPID.subject, { log: (m) => pushLog.push(m), audit, transport: opts.pushTransport })
    : push;
  const hub = new Hub({ db, audit, push: sender, approvalTimeoutSec: config.approvalTimeoutSec });
  const consumption = new ConsumptionStore(db);
  const servers = createServers({ hub, auth, audit, db, push: sender, pushLog: (m) => pushLog.push(m), consumption, config });
  await servers.local.listen({ host: '127.0.0.1', port: 0 });
  await servers.public.listen({ host: '127.0.0.1', port: 0 });
  const localUrl = `http://127.0.0.1:${(servers.local.server.address() as AddressInfo).port}`;
  const publicUrl = `http://127.0.0.1:${(servers.public.server.address() as AddressInfo).port}`;
  const json = (init: RequestInit | undefined, token: string): RequestInit => ({
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });

  const t: TestHub = {
    config,
    db,
    hub,
    auth,
    audit,
    push,
    pushLog,
    localUrl,
    publicUrl,
    hook: (event, extra = {}, init = {}) =>
      fetch(`${localUrl}/hooks/claude-code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.hookToken}` },
        body: JSON.stringify({ session_id: 's1', cwd: '/Users/dev/projetos/site', hook_event_name: event, ...extra }),
        ...init,
      }),
    local: (path, init) => fetch(`${localUrl}${path}`, json(init, config.localToken)),
    pairDevice: async (name = 'iPhone de teste') => {
      const { code } = (await (await t.local('/local/pairing', { method: 'POST', body: '{}' })).json()) as { code: string };
      const res = await fetch(`${publicUrl}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, deviceName: name }),
      });
      return ((await res.json()) as { deviceToken: string }).deviceToken;
    },
    device: (token, path, init) => fetch(`${publicUrl}${path}`, json(init, token)),
    close: async () => {
      hub.close();
      // Conexões keep-alive de clientes de teste (o plugin do OpenCode, por exemplo) não seguram o encerramento.
      const closing = Promise.all([servers.local.close(), servers.public.close()]);
      servers.local.server.closeAllConnections();
      servers.public.server.closeAllConnections();
      await closing;
      db.close();
    },
  };
  return t;
}

export const BASH = { tool_name: 'Bash', tool_input: { command: 'npm install && npm run build -- --prod' } };

export async function waitFor<T>(fn: () => T | undefined | null | false, ms = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('waitFor: tempo esgotado');
    await new Promise((r) => setTimeout(r, 10));
  }
}
