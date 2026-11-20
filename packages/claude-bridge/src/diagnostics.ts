/**
 * Relatório de diagnóstico em texto, para o botão "Copiar diagnóstico" do app.
 *
 * Serve para a pessoa mandar o estado da instalação sem abrir o Terminal.
 * Não contém segredos: tokens e chaves nunca entram, e o caminho da pasta
 * pessoal é trocado por "~".
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hubHome, loadConfig, type HubConfig } from './config.js';
import { clientReportText, selftest, type PushStatus } from './selftest.js';
import { setupStatus } from './setup.js';

function macVersion(): string {
  if (process.platform !== 'darwin') return `${process.platform} ${release()}`;
  try {
    return `macOS ${execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 4000 }).trim()}`;
  } catch {
    return `macOS (Darwin ${release()})`;
  }
}

/** Tira do texto qualquer coisa com cara de segredo e o caminho da pasta pessoal. */
export function redact(text: string, cfg: Pick<HubConfig, 'localToken' | 'hookToken' | 'vapid'>): string {
  let out = text;
  for (const secret of [cfg.localToken, cfg.hookToken, cfg.vapid?.privateKey, cfg.vapid?.publicKey]) {
    if (secret) out = out.split(secret).join('«oculto»');
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer «oculto»');
  const home = homedir();
  if (home && home !== '/') out = out.split(home).join('~');
  return out;
}

function tail(path: string, lines: number): string {
  try {
    if (!existsSync(path)) return '(arquivo não existe)';
    const size = statSync(path).size;
    const text = readFileSync(path, 'utf8');
    const all = text.split('\n').filter((l) => l.trim());
    return all.length === 0 ? `(vazio, ${size} bytes)` : all.slice(-lines).join('\n');
  } catch (err) {
    return `(não consegui ler: ${(err as Error).message})`;
  }
}

/** Estado do push, para o diagnóstico. Sem endereços de inscrição nem chaves. */
async function pushLines(cfg: HubConfig): Promise<string[]> {
  let status: PushStatus;
  try {
    const res = await fetch(`http://${cfg.localHost}:${cfg.localPort}/local/push`, {
      headers: { authorization: `Bearer ${cfg.localToken}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [`o hub respondeu ${res.status} ao pedido de estado do push`];
    status = (await res.json()) as PushStatus;
  } catch {
    return ['hub fora do ar: sem dados de push'];
  }
  const lines = [`chaves configuradas: ${status.configured ? 'sim' : 'NÃO'} · subject: ${status.subject ?? '(nenhum)'}`];
  if (status.devices.length === 0) lines.push('nenhum aparelho pareado');
  for (const d of status.devices) {
    lines.push(`${d.name} (${d.id}): ${d.subscriptions} inscrição(ões)${d.subscriptions === 0 ? ' — PAREADO SEM NOTIFICAÇÕES' : ''}`);
    lines.push(`  último relato do aparelho: ${d.lastClientReport ? clientReportText(d.lastClientReport) : 'nenhum'}`);
  }
  if (status.last) {
    lines.push(`último envio: ${new Date(status.last.at).toISOString()} · tipo ${status.last.kind} · entregues ${status.last.delivered}/${status.last.targets}`);
    for (const f of status.last.failures) lines.push(`  recusa de ${f.host}: ${f.status ?? 'sem resposta'} ${f.reason}`);
  } else {
    lines.push('último envio: nenhum');
  }
  return lines;
}

export async function diagnostics(): Promise<{ ok: boolean; report: string; logPath: string; dataDir: string }> {
  const cfg = loadConfig() as HubConfig;
  const st = await setupStatus();
  const health = await selftest();
  const logPath = join(hubHome(), 'hub.log');
  const yes = (v: boolean) => (v ? 'sim' : 'NÃO');
  const lines: string[] = [
    `Diagnóstico do Claude Hub ${st.version} — ${new Date().toISOString()}`,
    `${macVersion()} · ${process.arch} · Node ${st.runtime.nodeVersion}${st.runtime.bundled ? ' (embutido)' : ''}`,
    '',
    '[Aplicativo]',
    `local: ${st.runtime.appPath ?? '(desconhecido)'}`,
    `em Aplicativos: ${yes(st.runtime.inApplications)} · translocado: ${st.runtime.translocated ? 'SIM' : 'não'}`,
    '',
    '[Claude Code]',
    `encontrado: ${yes(st.claude.found)}${st.claude.found ? ` · versão ${st.claude.version ?? '?'} · ${st.claude.path}` : ''}`,
    `settings.json: ${st.claude.settingsPath} · existe: ${yes(st.claude.settingsExists)} · válido: ${yes(st.claude.settingsValid)} · hooks de terceiros: ${st.claude.otherHooks}`,
    '',
    '[Serviço e hub]',
    `serviço instalado: ${yes(st.service.installed)} · carregado: ${yes(st.service.loaded)} · aponta para este app: ${yes(st.service.current)}`,
    `hub no ar: ${yes(st.hub.running)}${st.hub.version ? ` · v${st.hub.version}` : ''} · portas ${st.hub.localPort}/${st.hub.publicPort}`,
    `último evento real: ${st.hub.lastHookAt ? new Date(st.hub.lastHookAt).toISOString() : 'nenhum'}`,
    '',
    '[Hooks]',
    `instalados: ${yes(st.hooks.installed)} · eventos: ${st.hooks.events} · atuais: ${yes(st.hooks.current)}`,
    '',
    '[iPhone]',
    `Tailscale: ${st.tunnel.tailscale} · HTTPS na rede: ${st.tunnel.httpsEnabled === null ? 'não informado' : yes(st.tunnel.httpsEnabled)} · publicando a porta: ${yes(st.tunnel.serving)} · URL: ${st.tunnel.publicUrl ?? '(nenhuma)'}`,
    ...(st.tunnel.detail && st.tunnel.tailscale !== 'running' ? [`resposta do Tailscale: ${st.tunnel.detail}`] : []),
    `dispositivos pareados: ${st.devices}`,
    '',
    '[Notificações]',
    ...(await pushLines(cfg)),
    '',
    `[Verificação de saúde] ${health.ok ? 'OK' : 'COM PROBLEMAS'}`,
    ...health.checks.map((c) => `${c.ok ? '✓' : c.optional ? '·' : '✗'} ${c.title} — ${c.detail} (${c.ms} ms)`),
    '',
    '[Últimas linhas do log do hub]',
    tail(logPath, 40),
  ];
  return { ok: true, report: redact(lines.join('\n'), cfg), logPath, dataDir: hubHome() };
}
