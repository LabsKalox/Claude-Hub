import { createECDH, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { root, seedReferenceSessions, shots, startHub, type RunningHub } from './harness.js';

mkdirSync(shots, { recursive: true });

let hub: RunningHub;
test.beforeEach(async () => {
  hub = await startHub();
});
test.afterEach(() => hub.stop());

const BUILD = { tool_name: 'Bash', tool_input: { command: 'npm run build' } };
const BUILD_PROD = { tool_name: 'Bash', tool_input: { command: 'npm install && npm run build -- --prod' } };
const phone = { viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 };

async function pairPhone(page: Page): Promise<void> {
  await page.goto(`${hub.publicUrl}/`);
  await expect(page).toHaveURL(/\/pair\//);
  await page.getByLabel('Código de pareamento').fill(await hub.pairingCode());
  await page.getByRole('button', { name: 'Parear' }).click();
  await expect(page.getByText('Conectado')).toBeVisible();
}

test.describe('iPhone (PWA)', () => {
  test.use(phone);

  test('pareia, mostra as sessões e permite um pedido — o hook recebe allow', async ({ page }) => {
    await page.goto(`${hub.publicUrl}/`);
    await expect(page).toHaveURL(/\/pair\//);
    await page.screenshot({ path: join(shots, 'iphone-01-pareamento.png') });
    await page.getByLabel('Código de pareamento').fill(await hub.pairingCode());
    await page.getByRole('button', { name: 'Parear' }).click();
    await expect(page.getByText('Conectado')).toBeVisible();

    await seedReferenceSessions(hub);
    await expect(page.locator('.session-card')).toHaveCount(4);
    await expect(page.getByText('EDIÇÃO DE VÍDEOS M')).toBeVisible();
    await page.screenshot({ path: join(shots, 'iphone-02-sessoes.png') });

    await hub.hook('s-site', 'UserPromptSubmit', { cwd: '/Users/dev/projetos/site', prompt: 'Publicar o site' });
    const held = hub.hook('s-site', 'PermissionRequest', BUILD);
    const card = page.getByTestId('approval-card');
    await expect(card).toBeVisible();
    await expect(card.getByText('Claude quer usar Bash')).toBeVisible();
    await expect(card.locator('.code-box')).toHaveText('npm run build');
    await expect(page.locator('.session-card[data-status="APPROVAL_REQUIRED"]')).toHaveCount(1);
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shots, 'iphone-03-pedido-de-permissao.png') });

    await card.getByRole('button', { name: 'Permitir' }).click();
    const output = (await (await held).json()) as { hookSpecificOutput: { decision: { behavior: string } } };
    expect(output.hookSpecificOutput.decision.behavior).toBe('allow');
    await expect(card).toHaveCount(0);
    await expect(page.locator('.session-card[data-status="APPROVAL_REQUIRED"]')).toHaveCount(0);

    await hub.hook('s-site', 'Stop', { last_assistant_message: 'Vídeo pronto para revisar.' });
    const alert = page.getByTestId('alert-card');
    await expect(alert).toBeVisible();
    await expect(alert.getByText('Terminou · site')).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shots, 'iphone-04-tarefa-concluida.png') });
  });

  test('negar pelo iPhone devolve deny ao Claude Code e fica no histórico', async ({ page }) => {
    await pairPhone(page);
    await hub.hook('s-site', 'UserPromptSubmit', { prompt: 'Publicar o site' });
    const held = hub.hook('s-site', 'PermissionRequest', BUILD_PROD);
    const card = page.getByTestId('approval-card');
    await card.getByRole('button', { name: 'Ver detalhes' }).click();
    await expect(card.getByText('/Users/dev/projetos/site')).toBeVisible();
    await card.getByRole('button', { name: 'Negar' }).click();
    const output = (await (await held).json()) as { hookSpecificOutput: { decision: { behavior: string } } };
    expect(output.hookSpecificOutput.decision.behavior).toBe('deny');

    await page.getByRole('button', { name: 'Histórico' }).click();
    await expect(page.locator('.chip.denied')).toHaveText('Negado');
    await expect(page.locator('.history code')).toHaveText('npm install && npm run build -- --prod');
    await page.screenshot({ path: join(shots, 'iphone-05-historico.png') });
  });

  test('pedido respondido no terminal some do iPhone sem deixar botão órfão', async ({ page }) => {
    await pairPhone(page);
    const ctrl = new AbortController();
    void hub.hook('s-site', 'PermissionRequest', BUILD, ctrl.signal).catch(() => null);
    await expect(page.getByTestId('approval-card')).toBeVisible();
    ctrl.abort();
    await expect(page.getByTestId('approval-card')).toHaveCount(0);
  });

  test('abrir o link de uma notificação de pedido já respondido explica o motivo', async ({ page }) => {
    await pairPhone(page);
    const held = hub.hook('s-site', 'PermissionRequest', BUILD);
    await expect(page.getByTestId('approval-card')).toBeVisible();
    const { approvals } = await hub.local<{ approvals: Array<{ id: string }> }>('/api/approvals?status=pending');
    const id = approvals[0]?.id as string;
    await hub.local(`/api/approvals/${id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'allow' }) });
    await held;
    await page.goto(`${hub.publicUrl}/?approval=${id}`);
    await expect(page.getByText('Esse pedido não está mais pendente: permitido.')).toBeVisible();
    await expect(page.getByTestId('approval-card')).toHaveCount(0);
  });

  test('detalhe da sessão mostra status, progresso e histórico de eventos', async ({ page }) => {
    await pairPhone(page);
    await hub.hook('s-site', 'UserPromptSubmit', { prompt: 'Renderizar o vídeo' });
    const todos = Array.from({ length: 10 }, (_, i) => ({ content: `etapa ${i}`, status: i < 7 ? 'completed' : 'pending' }));
    await hub.hook('s-site', 'PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos } });
    await hub.hook('s-site', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ffmpeg -i entrada.mov saida.mp4' } });
    await page.locator('.session-card').click();
    const sheet = page.getByTestId('session-sheet');
    await expect(sheet.getByText('70% (7/10)')).toBeVisible();
    await expect(sheet.getByText('ffmpeg -i entrada.mov saida.mp4')).toBeVisible();
    await expect(sheet.getByText('Pedido: Renderizar o vídeo')).toBeVisible();
    await expect(sheet.locator('.code-box.resume')).toHaveText('claude --resume s-site');
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'iphone-06-detalhe-da-sessao.png') });
  });

  test('ajustes: modo de aprovação e "Estou longe do PC" chegam ao hub', async ({ page }) => {
    await pairPhone(page);
    await page.getByRole('button', { name: 'Ajustes' }).click();
    await page.getByRole('radio', { name: 'Só avisar' }).click();
    await page.getByText('Estou longe do PC').click();
    await expect
      .poll(async () => (await hub.local<{ settings: unknown }>('/api/settings')).settings)
      .toEqual({ approvalMode: 'notify', away: true });
    await expect(page.getByRole('radio', { name: 'Só avisar' })).toHaveAttribute('aria-checked', 'true');
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(shots, 'iphone-07-ajustes.png') });
  });

  test('aba Uso: sem dado diz que não há dado; com dado mostra exatamente o que o Claude Code informou', async ({ page }) => {
    await pairPhone(page);
    await page.getByRole('button', { name: 'Uso', exact: true }).click();
    const tab = page.getByTestId('usage-tab');
    // Preferências desligadas (padrão): nenhum número de consumo ou limite na tela.
    await expect(tab.getByText('A leitura de limites está desligada.', { exact: false })).toBeVisible();
    await expect(tab.getByText('A medição de consumo está desligada.', { exact: false })).toBeVisible();
    await expect(tab.locator('.limits li')).toHaveCount(0);
    await expect(tab.getByTestId('consumption')).toHaveCount(0);

    // Métricas reais capturadas do Claude Code 2.1.329 + limites no formato da linha de status.
    const metrics = readFileSync(join(root, 'tests/fixtures/otel-metrics-claude-code-2.1.329.jsonl'), 'utf8').trim().split('\n');
    const nowSec = Math.floor(Date.now() / 1000);
    await hub.reportUsage(metrics, {
      session_id: 's-uso',
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: nowSec + 3 * 3600 + 20 * 60 },
        seven_day: { used_percentage: 91.2, resets_at: nowSec + 4 * 86400 + 2 * 3600 },
      },
      context_window: { used_percentage: 8 },
    });
    await hub.hook('s-uso', 'UserPromptSubmit', { prompt: 'atualiza' });
    const five = tab.getByTestId('limit-five_hour');
    await expect(five).toContainText('Janela de 5 horas');
    await expect(five).toContainText('23,5%');
    await expect(five).toContainText(/Reinicia em 3 h (19|20) min/);
    const seven = tab.getByTestId('limit-seven_day');
    await expect(seven).toContainText('91,2%');
    await expect(seven).toContainText(/Reinicia em 4 d [12] h/);
    await expect(seven.locator('.limit-bar i')).toHaveClass(/crit/);
    const cells = tab.getByTestId('consumption').locator('.usage-cell');
    await expect(cells.filter({ hasText: 'Saída' }).locator('strong')).toHaveText('4');
    await expect(cells.filter({ hasText: 'Custo estimado' }).locator('strong')).toHaveText('US$ 0,0044');
    await expect(cells.filter({ hasText: 'Cache lido' }).locator('strong')).toHaveText('26,8 mil');
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'iphone-09-uso.png') });
  });

  test('dispositivo revogado no Mac volta para a tela de pareamento', async ({ page }) => {
    await pairPhone(page);
    const { devices } = await hub.local<{ devices: Array<{ id: string }> }>('/local/devices');
    await hub.local(`/local/devices/${devices[0]?.id}`, { method: 'DELETE' });
    await page.reload();
    await expect(page).toHaveURL(/\/pair\//);
  });

  test('sem token, a PWA não mostra nenhum dado', async ({ page }) => {
    await seedReferenceSessions(hub);
    await page.goto(`${hub.publicUrl}/`);
    await expect(page).toHaveURL(/\/pair\//);
    await expect(page.getByText('EDIÇÃO DE VÍDEOS M')).toHaveCount(0);
  });
});

test.describe('pareamento por QR Code', () => {
  const iphoneSafari = {
    ...phone,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  };

  test('abrir o link do QR pareia sozinho e o código não serve duas vezes', async ({ browser }) => {
    const code = await hub.pairingCode();
    const ctx = await browser.newContext(phone);
    const page = await ctx.newPage();
    await page.goto(`${hub.publicUrl}/pair/?code=${code}`);
    await expect(page.getByText('Conectado')).toBeVisible();
    await expect(page).not.toHaveURL(/code=/);
    await ctx.close();

    const other = await browser.newContext(phone);
    const second = await other.newPage();
    await second.goto(`${hub.publicUrl}/pair/?code=${code}`);
    await expect(second.getByText('Código inválido ou expirado')).toBeVisible();
    await other.close();
  });

  test('no Safari do iPhone: orienta a instalar e o manifesto leva o código para o app', async ({ browser }) => {
    const code = await hub.pairingCode();
    const ctx = await browser.newContext(iphoneSafari);
    const page = await ctx.newPage();
    await page.goto(`${hub.publicUrl}/pair/?code=${code}`);
    await expect(page.getByTestId('install-hint')).toBeVisible();
    await expect(page.getByText('Adicionar à Tela de Início')).toBeVisible();
    // Nada foi pareado ainda: o código continua valendo para o app instalado.
    expect((await hub.local<{ devices: unknown[] }>('/local/devices')).devices).toHaveLength(0);

    const href = await page.locator('link[rel="manifest"]').first().getAttribute('href');
    expect(href).toBe(`/manifest.webmanifest?pair=${code}`);
    const manifest = (await (await fetch(`${hub.publicUrl}${href}`)).json()) as { start_url: string; display: string };
    expect(manifest.start_url).toBe(`/pair/?code=${code}`);
    expect(manifest.display).toBe('standalone');
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots, 'iphone-08-qr-instalar-app.png') });

    // Quem preferir o Safari ainda pode parear ali mesmo.
    await page.getByRole('button', { name: 'Prefiro usar pelo Safari, sem instalar' }).click();
    await page.getByRole('button', { name: 'Parear' }).click();
    await expect(page.getByText('Conectado')).toBeVisible();
    await ctx.close();
  });

  test('app já pareado que abre na URL antiga do QR segue direto para as sessões', async ({ page, browser }) => {
    const ctx = await browser.newContext(phone);
    const p = await ctx.newPage();
    const code = await hub.pairingCode();
    await p.goto(`${hub.publicUrl}/pair/?code=${code}`);
    await expect(p.getByText('Conectado')).toBeVisible();
    await p.goto(`${hub.publicUrl}/pair/?code=${code}`);
    await expect(p.getByText('Conectado')).toBeVisible();
    await expect(p).not.toHaveURL(/pair/);
    await ctx.close();
    void page;
  });

  test('parâmetro de pareamento malformado não entra no manifesto nem na página', async () => {
    const evil = encodeURIComponent('"><script>alert(1)</script>');
    const manifest = (await (await fetch(`${hub.publicUrl}/manifest.webmanifest?pair=${evil}`)).json()) as { start_url: string };
    expect(manifest.start_url).toBe('/');
    const html = await (await fetch(`${hub.publicUrl}/pair/?code=${evil}`)).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('href="/manifest.webmanifest"');
  });
});

test.describe('ilha (réplica web do app macOS)', () => {
  test.use(desktop);

  const openIsland = async (page: Page) => {
    await page.goto(`${hub.localUrl}/island/#token=${hub.localToken}`);
    await expect(page.getByTestId('island')).toBeVisible();
    // O token sai da barra de endereços assim que a página o lê (após hidratar).
    await expect(page).not.toHaveURL(/token/);
  };

  test('compacta: "Trabalhando" com progresso mensurável (frame 00:08)', async ({ page }) => {
    await openIsland(page);
    await expect(page.getByTestId('island-idle')).toBeVisible();
    await hub.hook('s-site', 'UserPromptSubmit', { prompt: 'Renderizar o vídeo' });
    await expect(page.getByTestId('island-working')).toContainText('Trabalhando');
    await expect(page.locator('.pill-pct')).toHaveCount(0);
    const todos = Array.from({ length: 10 }, (_, i) => ({ content: `etapa ${i}`, status: i < 7 ? 'completed' : 'pending' }));
    await hub.hook('s-site', 'PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos } });
    await expect(page.locator('.pill-pct')).toHaveText('70%');
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shots, 'ilha-01-trabalhando.png'), clip: { x: 0, y: 0, width: 1280, height: 240 } });
  });

  test('"Esperando você" com botão Responder (frame 00:10)', async ({ page }) => {
    await openIsland(page);
    await hub.hook('s-site', 'UserPromptSubmit', { prompt: 'x' });
    await hub.hook('s-site', 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    const pill = page.getByTestId('island-waiting');
    await expect(pill).toContainText('Esperando você');
    await expect(pill.getByText('Responder')).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shots, 'ilha-02-esperando-voce.png'), clip: { x: 0, y: 0, width: 1280, height: 240 } });
  });

  test('"Terminou" aparece ao concluir (frame 00:10)', async ({ page }) => {
    await openIsland(page);
    await hub.hook('s-site', 'UserPromptSubmit', { prompt: 'x' });
    await hub.hook('s-site', 'Stop', { last_assistant_message: 'Pronto.' });
    await expect(page.getByTestId('island-completed')).toContainText('Terminou');
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shots, 'ilha-03-terminou.png'), clip: { x: 0, y: 0, width: 1280, height: 240 } });
  });

  test('pedido de permissão na ilha; Negar devolve deny (frame 00:13)', async ({ page }) => {
    await openIsland(page);
    await hub.hook('s-site', 'UserPromptSubmit', { prompt: 'Publicar' });
    const held = hub.hook('s-site', 'PermissionRequest', BUILD_PROD);
    const card = page.getByTestId('island-approval');
    await expect(card).toContainText('Claude quer usar Bash · site');
    await expect(card.locator('.code-box')).toHaveText('npm install && npm run build -- --prod');
    await expect(card.getByText('Responder no Claude')).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shots, 'ilha-04-pedido-de-permissao.png'), clip: { x: 0, y: 0, width: 1280, height: 300 } });
    await card.getByRole('button', { name: 'Negar' }).click();
    const output = (await (await held).json()) as { hookSpecificOutput: { decision: { behavior: string; message: string } } };
    expect(output.hookSpecificOutput.decision.behavior).toBe('deny');
    await expect(card).toHaveCount(0);
  });

  test('painel com quatro sessões e seletor de aprovações (frame 00:05)', async ({ page }) => {
    await seedReferenceSessions(hub);
    await openIsland(page);
    await page.getByTestId('island').click();
    const panel = page.getByTestId('island-panel');
    await expect(panel.locator('.session-card')).toHaveCount(4);
    await expect(panel.getByRole('tab', { name: 'Claude' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByRole('radio', { name: 'Sempre aqui' })).toHaveAttribute('aria-checked', 'true');
    await expect(panel.getByText('Todo pedido de permissão vem para a ilha e para o celular.')).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(shots, 'ilha-05-painel-de-sessoes.png'), clip: { x: 0, y: 0, width: 1280, height: 560 } });

    await panel.getByRole('radio', { name: 'Automático' }).click();
    await expect.poll(async () => (await hub.local<{ settings: { approvalMode: string } }>('/api/settings')).settings.approvalMode).toBe('auto');
    await panel.getByRole('tab', { name: 'Uso' }).click();
    await expect(panel.getByText('Pedidos')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  });

  test('decisão tomada no iPhone fecha o pedido na ilha (e vice-versa)', async ({ page, browser }) => {
    await openIsland(page);
    const phoneCtx = await browser.newContext(phone);
    const phonePage = await phoneCtx.newPage();
    await pairPhone(phonePage);
    const held = hub.hook('s-site', 'PermissionRequest', BUILD);
    await expect(page.getByTestId('island-approval')).toBeVisible();
    await expect(phonePage.getByTestId('approval-card')).toBeVisible();
    await phonePage.getByTestId('approval-card').getByRole('button', { name: 'Permitir' }).click();
    await held;
    await expect(page.getByTestId('island-approval')).toHaveCount(0);
    await phoneCtx.close();
  });

  test('hub fora do ar: a ilha avisa em vez de mostrar estado velho', async ({ page }) => {
    await openIsland(page);
    await hub.hook('s-site', 'UserPromptSubmit', { prompt: 'x' });
    await expect(page.getByTestId('island-working')).toBeVisible();
    hub.stop();
    await expect(page.getByTestId('island-offline')).toContainText('Hub offline');
  });
});

test.describe('notificações no iPhone — "Ativar notificações" nunca fica sem resposta', () => {
  test.use(phone);

  interface PushState {
    devices: Array<{
      subscriptions: number;
      lastClientReport: { step: string; outcome: string; permission: string; serviceWorker: string; detail: string } | null;
    }>;
    last: { delivered: number; failures: Array<{ status: number | null; reason: string; host: string }> } | null;
  }
  const pushState = () => hub.local<PushState>('/local/push');
  /** O Chromium sem interface sempre responde "negada": aqui a permissão já vem concedida. */
  const granted = (page: Page) =>
    page.addInitScript(() => {
      Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' });
    });
  const openSettings = async (page: Page) => {
    await pairPhone(page);
    await page.getByRole('button', { name: 'Ajustes' }).click();
  };

  test('o service worker é registrado ao abrir o app, e a tela mostra permissão, serviço e inscrição', async ({ page }) => {
    await granted(page);
    await openSettings(page);
    const diag = page.getByTestId('push-diag');
    await expect(diag).toContainText('Permissão do iPhone');
    await expect(diag.locator('dd').nth(0)).toHaveText('concedida');
    // Ninguém tocou em "Ativar notificações" ainda e o serviço já está ativo.
    await expect.poll(async () => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration('/'))?.active))).toBe(true);
    await page.reload();
    await page.getByRole('button', { name: 'Ajustes' }).click();
    await expect(page.getByTestId('push-diag').locator('dd').nth(1)).toHaveText('ativo');
    await expect(page.getByTestId('push-diag').locator('dd').nth(2)).toHaveText('não');
  });

  test('pedido de permissão que nunca responde: botão em "Ativando…", motivo na tela em até 15 s e relato no hub', async ({ page }) => {
    // Imita o sintoma do iPhone: requestPermission() não mostra aviso e nunca resolve.
    await page.addInitScript(() => {
      Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'default' });
      Notification.requestPermission = () => new Promise<NotificationPermission>(() => {});
    });
    await openSettings(page);
    const started = Date.now();
    await page.getByRole('button', { name: 'Ativar notificações' }).click();
    const button = page.getByRole('button', { name: 'Ativando…' });
    await expect(button).toBeDisabled();
    await expect(page.getByTestId('push-step')).toContainText('Etapa 1 de 5 · Pedindo permissão ao iPhone…');
    await expect(page.getByTestId('push-note')).toContainText('O iPhone não respondeu ao pedido de permissão', { timeout: 15_000 });
    expect(Date.now() - started).toBeLessThan(15_000);
    await expect
      .poll(async () => (await pushState()).devices[0]?.lastClientReport, { timeout: 8000 })
      .toMatchObject({ step: 'permission', outcome: 'stalled', permission: 'default' });
    await page.screenshot({ path: join(shots, 'iphone-10-notificacoes-sem-resposta.png') });
  });

  test('permissão negada: diz onde liberar, sem ficar esperando', async ({ page }) => {
    await page.addInitScript(() => {
      let state: NotificationPermission = 'default';
      Object.defineProperty(Notification, 'permission', { configurable: true, get: () => state });
      Notification.requestPermission = async () => (state = 'denied');
    });
    await openSettings(page);
    await page.getByRole('button', { name: 'Ativar notificações' }).click();
    await expect(page.getByTestId('push-note')).toContainText('As notificações estão bloqueadas para este app');
    await expect.poll(async () => (await pushState()).devices[0]?.lastClientReport).toMatchObject({ step: 'permission', outcome: 'failed', permission: 'denied' });
  });

  test('serviço de push que não devolve a inscrição: avisa em até 15 s e o hub fica sabendo a etapa', async ({ page }) => {
    await granted(page);
    await page.addInitScript(() => {
      PushManager.prototype.subscribe = () => new Promise<PushSubscription>(() => {});
    });
    await openSettings(page);
    const started = Date.now();
    await page.getByRole('button', { name: 'Ativar notificações' }).click();
    await expect(page.getByTestId('push-note')).toContainText('A Apple não devolveu a inscrição de push', { timeout: 15_000 });
    expect(Date.now() - started).toBeLessThan(15_000);
    await expect(page.getByRole('button', { name: 'Ativar notificações' })).toBeEnabled();
    await expect
      .poll(async () => (await pushState()).devices[0]?.lastClientReport)
      .toMatchObject({ step: 'subscribe', outcome: 'stalled', permission: 'granted', serviceWorker: 'active' });
    expect((await pushState()).devices[0]?.subscriptions).toBe(0);
  });

  test('caminho completo: inscreve, registra no hub, e "Enviar teste" mostra o motivo quando o serviço de push recusa', async ({ page }) => {
    await granted(page);
    // Inscrição com chaves de verdade e um serviço de push que não existe (.invalid nunca resolve).
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const fake = {
      endpoint: 'https://push.invalid/aparelho-de-teste',
      keys: { p256dh: ecdh.getPublicKey('base64url'), auth: randomBytes(16).toString('base64url') },
    };
    await page.addInitScript((sub) => {
      let current: unknown = null;
      const made = { endpoint: sub.endpoint, toJSON: () => sub, unsubscribe: async () => ((current = null), true) };
      PushManager.prototype.subscribe = async () => (current = made) as unknown as PushSubscription;
      PushManager.prototype.getSubscription = async () => current as PushSubscription | null;
    }, fake);
    await openSettings(page);
    await page.getByRole('button', { name: 'Ativar notificações' }).click();
    await expect(page.getByTestId('push-note')).toHaveText('Notificações ativadas.', { timeout: 15_000 });
    await expect(page.getByTestId('push-diag').locator('dd').nth(2)).toHaveText('sim');
    await expect.poll(async () => (await pushState()).devices[0]?.subscriptions).toBe(1);
    await expect.poll(async () => (await pushState()).devices[0]?.lastClientReport).toMatchObject({ step: 'done', outcome: 'ok' });

    await page.getByRole('button', { name: 'Enviar teste' }).click();
    await expect(page.getByTestId('push-note')).toContainText('o serviço de push (push.invalid) recusou o envio', { timeout: 15_000 });
    const last = (await pushState()).last;
    expect(last?.delivered).toBe(0);
    expect(last?.failures[0]).toMatchObject({ status: null, host: 'push.invalid' });

    await page.getByRole('button', { name: 'Desativar' }).click();
    await expect(page.getByTestId('push-note')).toHaveText('Notificações desativadas.');
    await expect.poll(async () => (await pushState()).devices[0]?.subscriptions).toBe(0);
  });
});
