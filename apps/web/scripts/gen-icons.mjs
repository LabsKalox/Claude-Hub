#!/usr/bin/env node
/**
 * Gera os ícones PNG da PWA a partir do desenho vetorial do Claude Hub
 * (quadrado coral + estrela branca de 8 raios). Requer Playwright/Chromium.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// require() respeita NODE_PATH, então serve tanto o Playwright local quanto o global.
const { chromium } = createRequire(import.meta.url)('playwright');

const out = join(dirname(fileURLToPath(import.meta.url)), '../public/icons');
mkdirSync(out, { recursive: true });

const rays = (color, width) =>
  Array.from({ length: 8 }, (_, i) => {
    const y1 = i % 2 === 0 ? 2.2 : 4.2;
    return `<line x1="12" y1="${y1}" x2="12" y2="9.4" stroke="${color}" stroke-width="${width}" stroke-linecap="round" transform="rotate(${i * 45} 12 12)"/>`;
  }).join('');

/** scale = fração do ícone ocupada pela estrela; rounded = cantos arredondados. */
const svg = ({ scale, rounded, transparent = false }) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100%" height="100%">
  <defs><linearGradient id="g" x1="0.2" y1="0" x2="0.8" y2="1">
    <stop offset="0" stop-color="#F08A66"/><stop offset="0.55" stop-color="#E8704F"/><stop offset="1" stop-color="#D85D3E"/>
  </linearGradient></defs>
  ${transparent ? '' : `<rect width="100" height="100" rx="${rounded ? 23 : 0}" fill="url(#g)"/>`}
  <g transform="translate(${50 - 50 * scale} ${50 - 50 * scale}) scale(${(100 * scale) / 24})">${rays('#fff', 2.6)}</g>
</svg>`;

const targets = [
  { file: 'icon-192.png', size: 192, scale: 0.7, rounded: true },
  { file: 'icon-512.png', size: 512, scale: 0.7, rounded: true },
  // iOS aplica a própria máscara: fundo cheio, sem cantos.
  { file: 'apple-touch-icon.png', size: 180, scale: 0.68, rounded: false },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.52, rounded: false },
  { file: 'badge-96.png', size: 96, scale: 0.9, rounded: false, transparent: true },
];

const browser = await chromium.launch();
for (const t of targets) {
  const page = await browser.newPage({ viewport: { width: t.size, height: t.size } });
  await page.setContent(`<body style="margin:0;background:transparent">${svg(t)}</body>`);
  await page.screenshot({ path: join(out, t.file), omitBackground: true });
  await page.close();
  console.log(`✓ ${t.file}`);
}
await browser.close();
