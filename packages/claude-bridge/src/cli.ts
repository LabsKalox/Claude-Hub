#!/usr/bin/env node
/**
 * CLI do Claude Hub.
 *
 *   claude-hub install [--scope user|project|local] [--mode http|command] [--minimal]
 *   claude-hub uninstall [--scope ...]
 *   claude-hub status | doctor
 *   claude-hub pair [--url https://...]
 *   claude-hub devices | revoke <id>
 *   claude-hub set-url <https://...>
 *   claude-hub audit [--verify]
 *
 * Usados pelo assistente do app macOS (acrescente --json para saída em JSON):
 *   claude-hub setup status | setup run
 *   claude-hub selftest
 *   claude-hub diagnostics
 *   claude-hub prefs [set <autoOpenIsland|consumption|limits> on|off]
 *   claude-hub service install | restart | uninstall
 *   claude-hub tunnel enable
 *   claude-hub uninstall-all [--purge]
 */
import { execFileSync } from 'node:child_process';
import { configPath, hookUrl, isValidVapidSubject, loadConfig, saveConfig, type HubConfig } from './config.js';
import { diagnostics } from './diagnostics.js';
import { getPrefs, setPref } from './prefs.js';
import { clientReportText, pushProblem, pushSummary, selftest, type PushStatus } from './selftest.js';
import { installService, restartService, uninstallService } from './service.js';
import { agentIntegrations, runtimeInfo, serviceSpec, setAgentIntegration, setupRun, setupStatus, tunnelEnable, uninstallAll, type StepResult } from './setup.js';
import {
  buildHubHooks,
  installedEvents,
  mergeHubHooks,
  readSettings,
  removeHubHooks,
  settingsPath,
  writeSettings,
  type SettingsScope,
} from './install.js';

/** Saída para o app (JSON numa linha) ou para o terminal (texto). */
function emit(json: boolean, value: { ok: boolean }, human: () => void): void {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else human();
  if (!value.ok) process.exitCode = 1;
}

function printSteps(steps: Array<Pick<StepResult, 'title' | 'ok' | 'detail'>>): void {
  for (const st of steps) console.log(`${st.ok ? '✓' : '✗'} ${st.title} — ${st.detail}`);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function scopeOf(args: string[]): SettingsScope {
  const s = flag(args, 'scope') ?? 'user';
  if (s !== 'user' && s !== 'project' && s !== 'local') {
    throw new Error('--scope deve ser user, project ou local');
  }
  return s;
}

async function local<T>(cfg: HubConfig, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${cfg.localPort}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cfg.localToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error(
      `O hub não respondeu em 127.0.0.1:${cfg.localPort}. Inicie com "pnpm start" (ou abra o app Claude Hub).`,
    );
  }
  if (!res.ok) throw new Error(`Hub respondeu ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

function claudeVersion(): string | null {
  try {
    return execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 8000 }).trim();
  } catch {
    return null;
  }
}

async function hubHealth(cfg: HubConfig): Promise<{ version: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.localPort}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? ((await res.json()) as { version: string }) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const cfg = loadConfig() as HubConfig;
  const json = args.includes('--json');

  switch (cmd) {
    case 'setup': {
      if (args[0] === 'run') {
        const r = await setupRun();
        emit(json, r, () => {
          printSteps(r.steps);
          console.log(r.ok ? '\nConfiguração concluída.' : '\nConfiguração incompleta — veja o item marcado com ✗.');
        });
      } else {
        const st = await setupStatus();
        emit(json, { ok: true, ...st }, () => {
          const line = (ok: boolean, text: string) => console.log(`${ok ? '✓' : '✗'} ${text}`);
          line(true, `Claude Hub ${st.version} · Node ${st.runtime.nodeVersion}${st.runtime.bundled ? ' (embutido)' : ''}`);
          line(st.claude.found, st.claude.found ? `Claude Code ${st.claude.version ?? ''} em ${st.claude.path}` : 'Claude Code não encontrado');
          if (st.service.supported) line(st.service.installed && st.service.current, st.service.installed ? `Serviço ${st.service.label}${st.service.current ? '' : ' (aponta para outro local)'}` : 'Serviço de inicialização não instalado');
          line(st.hub.running, st.hub.running ? `Hub no ar (v${st.hub.version})` : 'Hub fora do ar');
          line(st.hooks.current, st.hooks.installed ? `Hooks instalados (${st.hooks.events} eventos)${st.hooks.current ? '' : ' — desatualizados'}` : 'Hooks não instalados');
          line(Boolean(st.tunnel.publicUrl), st.tunnel.publicUrl ? `iPhone: ${st.tunnel.publicUrl}` : `iPhone: sem URL (Tailscale: ${st.tunnel.tailscale})`);
          console.log(st.ready ? '\nPronto para uso.' : '\nRode "setup run" para configurar.');
        });
      }
      break;
    }

    case 'selftest': {
      const r = await selftest();
      emit(json, r, () => {
        for (const c of r.checks) console.log(`${c.ok ? '✓' : c.optional ? '·' : '✗'} ${c.title} — ${c.detail} (${c.ms} ms)`);
        console.log(r.ok ? '\nSaúde: OK' : '\nSaúde: há problemas');
      });
      break;
    }

    case 'prefs': {
      // prefs                       → mostra
      // prefs set <chave> on|off    → altera (autoOpenIsland, consumption, limits)
      if (args[0] === 'set') {
        const value = (args[2] ?? '').toLowerCase();
        if (value !== 'on' && value !== 'off') {
          const usage = { ok: false, detail: 'Uso: prefs set <autoOpenIsland|consumption|limits> on|off', prefs: getPrefs().prefs };
          emit(json, usage, () => console.log(usage.detail));
          break;
        }
        const r = setPref(args[1] ?? '', value === 'on');
        emit(json, r, () => console.log(r.detail));
      } else {
        const r = getPrefs();
        emit(json, r, () => {
          console.log(`Abrir a ilha com o Claude Code: ${r.prefs.autoOpenIsland ? 'sim' : 'não'}`);
          console.log(`Medição de consumo: ${r.prefs.consumption ? 'ligada' : 'desligada'}`);
          console.log(`Leitura de limites: ${r.prefs.limits ? 'ligada' : 'desligada'}`);
        });
      }
      break;
    }

    case 'diagnostics': {
      const r = await diagnostics();
      emit(json, r, () => console.log(r.report));
      break;
    }

    case 'service': {
      const r =
        args[0] === 'install'
          ? await installService(serviceSpec())
          : args[0] === 'restart'
            ? restartService()
            : args[0] === 'uninstall'
              ? await uninstallService()
              : { ok: false, detail: 'Uso: service install | restart | uninstall' };
      emit(json, r, () => console.log(r.detail));
      break;
    }

    case 'tunnel': {
      const r = args[0] === 'enable' ? await tunnelEnable() : { ok: false, detail: 'Uso: tunnel enable', publicUrl: cfg.publicUrl };
      emit(json, r, () => console.log(r.detail));
      break;
    }

    case 'uninstall-all': {
      const r = await uninstallAll(args.includes('--purge'));
      emit(json, r, () => printSteps(r.steps));
      break;
    }

    case 'install': {
      const scope = scopeOf(args);
      const mode = flag(args, 'mode') === 'command' ? 'command' : 'http';
      const path = flag(args, 'settings') ?? settingsPath(scope);
      const rt = runtimeInfo();
      const hubHooks = buildHubHooks(cfg, {
        hookCommandPath: rt.hookCommand,
        nodePath: rt.node,
        mode,
        minimal: args.includes('--minimal'),
      });
      const backup = writeSettings(path, mergeHubHooks(readSettings(path), hubHooks));
      console.log(`Hooks do Claude Hub instalados em ${path}`);
      console.log(`  modo: ${mode} → ${hookUrl(cfg)}`);
      console.log(`  eventos: ${Object.keys(hubHooks).join(', ')}`);
      if (backup) console.log(`  backup do arquivo anterior: ${backup}`);
      console.log('Sessões novas do Claude Code já passam a aparecer no hub.');
      break;
    }

    case 'uninstall': {
      const path = flag(args, 'settings') ?? settingsPath(scopeOf(args));
      const before = readSettings(path);
      if (installedEvents(before).length === 0) {
        console.log(`Nenhum hook do Claude Hub em ${path}`);
        break;
      }
      writeSettings(path, removeHubHooks(before));
      console.log(`Hooks do Claude Hub removidos de ${path} (os demais hooks foram preservados).`);
      break;
    }

    case 'status':
    case 'doctor': {
      const health = await hubHealth(cfg);
      const userEvents = installedEvents(readSettings(settingsPath('user')));
      const major = Number(process.versions.node.split('.')[0]);
      const minor = Number(process.versions.node.split('.')[1]);
      const nodeOk = major > 22 || (major === 22 && minor >= 13);
      const line = (ok: boolean, text: string) => console.log(`${ok ? '✓' : '✗'} ${text}`);
      line(nodeOk, `Node ${process.versions.node} (mínimo 22.13)`);
      const cv = claudeVersion();
      line(Boolean(cv), cv ? `Claude Code ${cv}` : 'Claude Code não encontrado no PATH');
      line(true, `Configuração: ${configPath()}`);
      line(
        Boolean(health),
        health
          ? `Hub no ar em 127.0.0.1:${cfg.localPort} (v${health.version})`
          : `Hub fora do ar em 127.0.0.1:${cfg.localPort}`,
      );
      line(
        userEvents.length > 0,
        userEvents.length > 0
          ? `Hooks instalados (${userEvents.length} eventos) em ${settingsPath('user')}`
          : 'Hooks não instalados — rode "pnpm hub install"',
      );
      line(
        Boolean(cfg.publicUrl),
        cfg.publicUrl
          ? `URL para o iPhone: ${cfg.publicUrl}`
          : 'URL do iPhone não definida — rode "pnpm hub set-url https://…"',
      );
      if (health) {
        const s = await local<{ sessions: unknown[] }>(cfg, 'GET', '/api/sessions');
        const d = await local<{ devices: unknown[] }>(cfg, 'GET', '/local/devices');
        console.log(`  sessões acompanhadas: ${s.sessions.length} · dispositivos pareados: ${d.devices.length}`);
      }
      break;
    }

    case 'set-url': {
      const url = args[0];
      if (!url || !/^https:\/\//.test(url)) {
        throw new Error('Informe uma URL https (ex.: https://meu-mac.tailnet.ts.net)');
      }
      const stored = loadConfig() as HubConfig;
      saveConfig({ ...stored, publicUrl: url.replace(/\/+$/, '') });
      console.log(`URL do iPhone definida: ${url}. Reinicie o hub para aplicar.`);
      break;
    }

    case 'pair': {
      const r = await local<{ code: string; expiresAt: number; url: string | null }>(
        cfg,
        'POST',
        '/local/pairing',
        { baseUrl: flag(args, 'url') },
      );
      const mins = Math.round((r.expiresAt - Date.now()) / 60000);
      console.log(`Código de pareamento: ${r.code}  (vale ${mins} min, uso único)`);
      if (r.url) {
        console.log(`Abra no iPhone: ${r.url}`);
        try {
          const qr = (await import('qrcode-terminal')).default;
          qr.generate(r.url, { small: true });
        } catch {
          /* QR é opcional */
        }
      } else {
        console.log('Defina a URL do iPhone com "pnpm hub set-url https://…" para gerar o link/QR.');
      }
      break;
    }

    case 'agents': {
      // claude-hub agents [set codex|opencode on|off]
      if (args[0] === 'set') {
        const agent = args[1];
        const value = args[2];
        if ((agent !== 'codex' && agent !== 'opencode') || (value !== 'on' && value !== 'off')) {
          throw new Error('uso: agents set codex|opencode on|off');
        }
        const r = setAgentIntegration(agent, value === 'on');
        const agents = agentIntegrations();
        if (json) console.log(JSON.stringify({ ok: r.ok, detail: r.detail, agents }));
        else console.log(r.detail);
        if (!r.ok) process.exitCode = 1;
        break;
      }
      const agents = agentIntegrations();
      if (json) {
        console.log(JSON.stringify({ ok: true, agents }));
        break;
      }
      for (const [name, a] of Object.entries(agents)) {
        const label = name === 'codex' ? 'Codex' : 'OpenCode';
        console.log(
          `${label}: ${a.found ? `encontrado${a.version ? ` (${a.version})` : ''} em ${a.path}` : 'não encontrado'} · integração ${a.installed ? (a.current ? 'ligada' : 'ligada, desatualizada — use "Reparar"') : 'desligada'} · ${a.configPath}`,
        );
      }
      break;
    }

    case 'push': {
      if (args[0] === 'subject') {
        const value = args[1];
        if (!value) {
          console.log(`subject guardado: ${cfg.vapid?.subject ?? '(nenhum — o hub gera na primeira subida)'}`);
          console.log('Para trocar: claude-hub push subject mailto:voce@seudominio.com   (ou https://seu-site.com)');
          break;
        }
        if (!isValidVapidSubject(value)) {
          throw new Error('subject inválido: use "mailto:nome@dominio.com" ou "https://dominio.com" (endereços locais são recusados pelo serviço de push)');
        }
        if (!cfg.vapid) throw new Error('o hub ainda não gerou as chaves de push; inicie o hub uma vez');
        // Só o subject muda: as chaves ficam, então nenhuma inscrição é perdida.
        saveConfig({ ...cfg, vapid: { ...cfg.vapid, subject: value } });
        restartService();
        console.log(`subject trocado para ${value}. As inscrições existentes continuam valendo; o hub foi reiniciado.`);
        break;
      }
      const status = await local<PushStatus>(cfg, 'GET', '/local/push');
      if (json) {
        console.log(JSON.stringify({ ok: pushProblem(status) === null, problem: pushProblem(status), ...status }));
        break;
      }
      console.log(`chaves: ${status.configured ? 'ok' : 'AUSENTES'} · subject: ${status.subject ?? '(nenhum)'}`);
      for (const d of status.devices) {
        console.log(`${d.name} (${d.id}): ${d.subscriptions} inscrição(ões)`);
        console.log(`  último relato do aparelho: ${d.lastClientReport ? clientReportText(d.lastClientReport) : 'nenhum'}`);
      }
      console.log(pushProblem(status) ? `PROBLEMA: ${pushProblem(status)}` : pushSummary(status));
      break;
    }

    case 'devices': {
      const r = await local<{ devices: Array<{ id: string; name: string; lastSeenAt: number | null; pushEnabled: boolean }> }>(
        cfg,
        'GET',
        '/local/devices',
      );
      if (r.devices.length === 0) console.log('Nenhum dispositivo pareado.');
      for (const d of r.devices) {
        const seen = d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString('pt-BR') : 'nunca';
        console.log(`${d.id}  ${d.name}  · visto: ${seen} · push: ${d.pushEnabled ? 'sim' : 'não'}`);
      }
      break;
    }

    case 'revoke': {
      if (!args[0]) throw new Error('Uso: pnpm hub revoke <id-do-dispositivo>');
      await local(cfg, 'DELETE', `/local/devices/${encodeURIComponent(args[0])}`);
      console.log('Dispositivo revogado.');
      break;
    }

    case 'audit': {
      if (args.includes('--verify')) {
        const r = await local<{ ok: boolean; entries: number; brokenAt: number | null }>(
          cfg,
          'GET',
          '/local/audit/verify',
        );
        console.log(
          r.ok
            ? `Auditoria íntegra (${r.entries} registros).`
            : `ATENÇÃO: cadeia de auditoria quebrada no registro ${r.brokenAt}.`,
        );
        if (!r.ok) process.exitCode = 1;
        break;
      }
      const r = await local<{ entries: Array<{ id: number; at: number; actor: string; action: string; detail: string }> }>(
        cfg,
        'GET',
        '/api/audit?limit=30',
      );
      for (const e of r.entries) {
        console.log(`${new Date(e.at).toLocaleString('pt-BR')}  ${e.actor}  ${e.action}  ${e.detail}`);
      }
      break;
    }

    default:
      console.log(
        [
          'Claude Hub — comandos:',
          '  install [--scope user|project|local] [--mode http|command] [--minimal]',
          '  uninstall [--scope user|project|local]',
          '  status            situação do hub, dos hooks e dos dispositivos',
          '  set-url <https>   URL pela qual o iPhone alcança o hub',
          '  pair              gera código/QR de pareamento do iPhone',
          '  devices           lista dispositivos pareados',
          '  revoke <id>       revoga um dispositivo',
          '  audit [--verify]  mostra/valida o registro de auditoria',
          '  setup status|run  situação da instalação / configura serviço e hooks',
          '  selftest          verificação de saúde de ponta a ponta',
          '  diagnostics       relatório de diagnóstico em texto (sem segredos)',
          '  prefs [set k on|off]  abrir a ilha com o Claude Code, medir consumo, ler limites',
          '  service install|restart|uninstall',
          '  tunnel enable     publica a porta do iPhone no Tailscale (https)',
          '  agents [set codex|opencode on|off]  integração com o Codex CLI e o OpenCode',
          '  push              estado das notificações (inscrições, último envio, relato do iPhone)',
          '  push subject [v]  mostra ou troca o "subject" VAPID (mailto:… ou https://…)',
          '  uninstall-all [--purge]',
        ].join('\n'),
      );
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // O app espera sempre um objeto JSON, mesmo quando algo inesperado quebra.
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ ok: false, detail: message })}\n`);
  else console.error(message);
  process.exitCode = 1;
});
