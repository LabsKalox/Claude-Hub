import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildHubHooks,
  buildServicePlist,
  defaultConfig,
  detectClaude,
  detectTailscale,
  hooksAreCurrent,
  mergeHubHooks,
  programArgumentsOf,
  runtimeInfo,
  tunnelEnable,
  writeSettings,
  type RuntimeInfo,
} from '../src/index.js';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('serviço de inicialização (plist do launchd)', () => {
  const spec = {
    node: '/Applications/ClaudeHub.app/Contents/Resources/runtime/bin/node',
    hubEntry: '/Applications/ClaudeHub.app/Contents/Resources/runtime/hub.mjs',
    webDir: '/Applications/ClaudeHub.app/Contents/Resources/runtime/web',
    workingDir: '/Applications/ClaudeHub.app/Contents/Resources/runtime',
  };

  it('executa só o Node embutido com o hub, sem shell, e reinicia sozinho', () => {
    const plist = buildServicePlist(spec);
    expect(programArgumentsOf(plist)).toEqual([spec.node, spec.hubEntry]);
    expect(plist).toContain('<string>dev.claudehub.hub</string>');
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toContain('CLAUDE_HUB_WEB_DIR');
    expect(plist).not.toMatch(/\/bin\/(ba|z)?sh/);
    expect(plist).not.toContain('UserName');
  });

  it('escapa caminhos com caracteres especiais', () => {
    const odd = { ...spec, node: '/Users/a&b/<x>/node' };
    const plist = buildServicePlist(odd);
    expect(plist).toContain('/Users/a&amp;b/&lt;x&gt;/node');
    expect(programArgumentsOf(plist)[0]).toBe(odd.node);
  });
});

describe('detecção do Claude Code', () => {
  it('encontra o executável indicado e lê a versão', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-detect-'));
    process.env.CLAUDE_HUB_CLAUDE_PATH = script(dir, 'claude', 'echo "2.1.329 (Claude Code)"');
    expect(detectClaude()).toEqual({ found: true, path: join(dir, 'claude'), version: '2.1.329' });
  });

  it('executável que falha em --version ainda conta como instalado, sem versão', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-detect-'));
    process.env.CLAUDE_HUB_CLAUDE_PATH = script(dir, 'claude', 'exit 3');
    const r = detectClaude();
    expect(r.found).toBe(true);
    expect(r.version).toBeNull();
  });
});

describe('detecção do Tailscale', () => {
  const fake = (statusJson: string, serveJson: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-ts-'));
    writeFileSync(join(dir, 'status.json'), statusJson);
    writeFileSync(join(dir, 'serve.json'), serveJson);
    process.env.CLAUDE_HUB_TAILSCALE_PATH = script(
      dir,
      'tailscale',
      `if [ "$1" = "status" ]; then cat "${dir}/status.json"; elif [ "$1" = "serve" ]; then cat "${dir}/serve.json"; fi`,
    );
  };

  it('conectado e já publicando a porta do iPhone', () => {
    fake(
      '{"BackendState":"Running","Self":{"DNSName":"macbook.exemplo.ts.net."}}',
      '{"Web":{"macbook.exemplo.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:4318"}}}}}',
    );
    expect(detectTailscale(4318)).toMatchObject({ tailscale: 'running', dnsName: 'macbook.exemplo.ts.net', serving: true });
  });

  it('conectado, mas sem publicar a porta', () => {
    fake('{"BackendState":"Running","Self":{"DNSName":"macbook.exemplo.ts.net."}}', '{}');
    expect(detectTailscale(4318)).toMatchObject({ tailscale: 'running', serving: false });
  });

  it('instalado, mas desconectado', () => {
    fake('{"BackendState":"NeedsLogin"}', '{}');
    expect(detectTailscale(4318)).toMatchObject({ tailscale: 'stopped', dnsName: null, serving: false });
  });

  it('desconectado continua "stopped", com o estado que o Tailscale informou', () => {
    fake('{"BackendState":"Stopped","Self":{"DNSName":"macbook.exemplo.ts.net."}}', '{}');
    expect(detectTailscale(4318)).toMatchObject({ tailscale: 'stopped', dnsName: null, detail: 'Stopped' });
  });

  it('saída que não é JSON, com código 0, vira "unknown" com o texto real — não "desconectado"', () => {
    fake('The Tailscale GUI failed to start: The operation couldn’t be completed. (Tailscale.CLIError error 3.)', '');
    const r = detectTailscale(4318);
    expect(r.tailscale).toBe('unknown');
    expect(r.detail).toContain('The Tailscale GUI failed to start');
    expect(r).toMatchObject({ dnsName: null, serving: false, httpsEnabled: null });
  });

  it('JSON sem BackendState também é "unknown"', () => {
    fake('{"qualquer":"coisa"}', '');
    expect(detectTailscale(4318).tailscale).toBe('unknown');
  });

  it('erro do Tailscale (código diferente de 0) aparece como ele escreveu', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-ts-'));
    process.env.CLAUDE_HUB_TAILSCALE_PATH = script(dir, 'tailscale', 'echo "failed to connect to local Tailscale service; is Tailscale running?" >&2; exit 1');
    const r = detectTailscale(4318);
    expect(r.tailscale).toBe('unknown');
    expect(r.detail).toContain('is Tailscale running?');
  });

  it('chama o binário em modo CLI (TAILSCALE_BE_CLI=1), mesmo sem shell em volta', () => {
    // Imita o binário de dentro do Tailscale.app: sem a variável (e sem SHLVL do
    // chamador) ele tenta abrir a interface, imprime um erro e sai com código 0.
    const dir = mkdtempSync(join(tmpdir(), 'hub-ts-'));
    process.env.CLAUDE_HUB_TAILSCALE_PATH = script(
      dir,
      'tailscale',
      `if [ "$TAILSCALE_BE_CLI" != "1" ]; then echo "The Tailscale GUI failed to start: (Tailscale.CLIError error 3.)"; exit 0; fi
if [ "$1" = "status" ]; then echo '{"BackendState":"Running","Self":{"DNSName":"macbook.exemplo.ts.net."},"CertDomains":["macbook.exemplo.ts.net"]}'; else echo '{}'; fi`,
    );
    delete process.env.TAILSCALE_BE_CLI;
    delete process.env.SHLVL;
    expect(detectTailscale(4318)).toMatchObject({ tailscale: 'running', dnsName: 'macbook.exemplo.ts.net', httpsEnabled: true });
  });

  it('HTTPS do tailnet: CertDomains vazio ou nulo = desativado; ausente = não informado', () => {
    fake('{"BackendState":"Running","Self":{"DNSName":"macbook.exemplo.ts.net."},"CertDomains":null}', '{}');
    expect(detectTailscale(4318)).toMatchObject({ tailscale: 'running', httpsEnabled: false });
    fake('{"BackendState":"Running","Self":{"DNSName":"macbook.exemplo.ts.net."},"CertDomains":[]}', '{}');
    expect(detectTailscale(4318)).toMatchObject({ tailscale: 'running', httpsEnabled: false });
    fake('{"BackendState":"Running","Self":{"DNSName":"macbook.exemplo.ts.net."},"CertDomains":["macbook.exemplo.ts.net"]}', '{}');
    expect(detectTailscale(4318)).toMatchObject({ tailscale: 'running', httpsEnabled: true });
    fake('{"BackendState":"Running","Self":{"DNSName":"macbook.exemplo.ts.net."}}', '{}');
    expect(detectTailscale(4318)).toMatchObject({ tailscale: 'running', httpsEnabled: null });
  });
});

describe('ativar o acesso pelo iPhone (tunnel enable)', () => {
  /** Tailscale de mentira que registra cada chamada num arquivo. */
  const fakeTunnel = (statusJson: string, serveBody: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-tunnel-'));
    process.env.CLAUDE_HUB_HOME = mkdtempSync(join(tmpdir(), 'hub-home-'));
    writeFileSync(join(dir, 'status.json'), statusJson);
    process.env.CLAUDE_HUB_TAILSCALE_PATH = script(
      dir,
      'tailscale',
      `echo "$*" >> "${dir}/calls.log"
if [ "$1" = "status" ]; then cat "${dir}/status.json"; exit 0; fi
if [ "$1" = "serve" ] && [ "$2" = "status" ]; then echo '{}'; exit 0; fi
${serveBody}`,
    );
    return () => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n') : []);
  };
  const running = (cert: string) => `{"BackendState":"Running","Self":{"DNSName":"macbook.exemplo.ts.net."},"CertDomains":${cert}}`;

  it('HTTPS desativado no tailnet: explica o passo e nem tenta publicar', async () => {
    const calls = fakeTunnel(running('null'), 'exit 0');
    const r = await tunnelEnable();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('HTTPS Certificates');
    expect(r.detail).toContain('https://login.tailscale.com/admin/dns');
    expect(r.detail).not.toContain('não conectado');
    expect(calls().some((c) => c.startsWith('serve --bg'))).toBe(false);
  });

  it('estado ilegível: mostra o texto do Tailscale em vez de mandar entrar na conta', async () => {
    const calls = fakeTunnel('The Tailscale GUI failed to start: (Tailscale.CLIError error 3.)', 'exit 0');
    const r = await tunnelEnable();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('The Tailscale GUI failed to start');
    expect(r.detail).not.toContain('entre na sua conta');
    expect(calls().some((c) => c.startsWith('serve --bg'))).toBe(false);
  });

  it('deslogado: mantém a mensagem de sempre', async () => {
    fakeTunnel('{"BackendState":"NeedsLogin"}', 'exit 0');
    const r = await tunnelEnable();
    expect(r).toMatchObject({ ok: false, detail: 'O Tailscale está instalado, mas não conectado. Abra o Tailscale e entre na sua conta.' });
  });

  it('serve recusado: a mensagem traz o stdout e o stderr do Tailscale', async () => {
    fakeTunnel(running('["macbook.exemplo.ts.net"]'), 'echo "Serve is not enabled on your tailnet."; echo "visit the admin console" >&2; exit 1');
    const r = await tunnelEnable();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('Serve is not enabled on your tailnet.');
    expect(r.detail).toContain('visit the admin console');
  });

  it('serve com código 0 que não publicou nada não é dado como sucesso', async () => {
    const calls = fakeTunnel(running('["macbook.exemplo.ts.net"]'), 'echo "The Tailscale GUI failed to start"; exit 0');
    const r = await tunnelEnable();
    expect(calls()).toContain('serve --bg 4318');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('a porta não ficou publicada');
    expect(r.detail).toContain('The Tailscale GUI failed to start');
  });
});

describe('hooks apontando para este hub', () => {
  const cfg = { ...defaultConfig(), localPort: 4317, hookToken: 'tok' };
  const rt = { node: '/app/runtime/bin/node', hookCommand: '/app/runtime/claude-hub-hook.mjs' } as RuntimeInfo;
  const install = (c = cfg, r = rt) => mergeHubHooks({}, buildHubHooks(c, { hookCommandPath: r.hookCommand, nodePath: r.node }));

  it('recém-instalados são atuais', () => {
    expect(hooksAreCurrent(install(), cfg, rt)).toBe(true);
  });
  it('token trocado, porta trocada ou app movido deixam de ser atuais', () => {
    expect(hooksAreCurrent(install({ ...cfg, hookToken: 'antigo' }), cfg, rt)).toBe(false);
    expect(hooksAreCurrent(install({ ...cfg, localPort: 5000 }), cfg, rt)).toBe(false);
    expect(hooksAreCurrent(install(cfg, { ...rt, hookCommand: '/outro/lugar/claude-hub-hook.mjs' } as RuntimeInfo), cfg, rt)).toBe(false);
  });
  it('sem hooks do hub, não são atuais', () => {
    expect(hooksAreCurrent({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo x' }] }] } }, cfg, rt)).toBe(false);
  });
});

describe('backup do settings.json', () => {
  it('cada gravação gera um backup próprio: reinstalar não apaga a cópia do original', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-bak-'));
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{"original":true}');
    const first = writeSettings(path, { etapa: 1 }) as string;
    const second = writeSettings(path, { etapa: 2 }) as string;
    expect(first).not.toBe(second);
    expect(JSON.parse(readFileSync(first, 'utf8'))).toEqual({ original: true });
    expect(JSON.parse(readFileSync(second, 'utf8'))).toEqual({ etapa: 1 });
  });
});

describe('runtime', () => {
  it('no repositório, aponta para o hub e o hook compilados', () => {
    const rt = runtimeInfo();
    expect(rt.bundled).toBe(false);
    expect(rt.hubEntry).toMatch(/services\/api\/dist\/main\.js$/);
    expect(rt.hookCommand).toMatch(/hook-command\.js$/);
  });
  it('app fora de Aplicativos ou translocado é reconhecido', () => {
    process.env.CLAUDE_HUB_APP_PATH = '/private/var/folders/xx/AppTranslocation/ABC/d/ClaudeHub.app';
    expect(runtimeInfo()).toMatchObject({ translocated: true, inApplications: false });
    process.env.CLAUDE_HUB_APP_PATH = '/Applications/ClaudeHub.app';
    expect(runtimeInfo()).toMatchObject({ translocated: false, inApplications: true });
    process.env.CLAUDE_HUB_APP_PATH = '/Volumes/Claude Hub/ClaudeHub.app';
    expect(runtimeInfo().inApplications).toBe(false);
  });
});
