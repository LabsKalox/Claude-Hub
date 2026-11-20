#!/usr/bin/env node
/**
 * Pergunta ao serviço de push da Apple como ele reage a cada "subject" VAPID.
 *
 * Usa um par de chaves gerado na hora e um endereço de aparelho inventado:
 * nenhuma notificação é entregue a ninguém e nada do hub de alguém é usado.
 * O que interessa é o motivo da recusa: se a Apple rejeitar o JWT (BadJwtToken)
 * para um subject e não para outro, o subject é o problema.
 *
 *   node .github/scripts/apple-vapid-probe.mjs "mailto:a@b.c" "https://exemplo.com"
 */
import crypto from 'node:crypto';

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });
const rawPublic = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);

function vapidHeader(audience, subject) {
  const head = b64(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 3600, ...(subject === null ? {} : { sub: subject }) }));
  const signature = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64(signature)}, k=${b64(rawPublic)}`;
}

const token = `Q${crypto.randomBytes(120).toString('base64url')}`;
const endpoint = `https://web.push.apple.com/${token}`;
const subjects = process.argv.slice(2);
if (subjects.length === 0) {
  subjects.push(
    'mailto:claude-hub@localhost.localdomain',
    'mailto:claude-hub@example.com',
    'https://localhost',
    'https://example.com',
    'https://github.com',
    'https://nao-existe-7f3a9c.example.com',
    'https://macbook.exemplo.ts.net',
    'https://macbook.tail1a2b3c.ts.net',
    'https://macbook.exemplo.ts.net',
    'https://example.com',
    '(sem subject)',
  );
}

for (const subject of subjects) {
  const started = Date.now();
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: vapidHeader('https://web.push.apple.com', subject === '(sem subject)' ? null : subject), ttl: '60', 'content-length': '0' },
      signal: AbortSignal.timeout(20_000),
    });
    console.log(`${subject} => HTTP ${res.status} ${(await res.text()).slice(0, 200)} (${Date.now() - started} ms)`);
  } catch (err) {
    console.log(`${subject} => sem resposta: ${err.cause?.code ?? err.message} (${Date.now() - started} ms)`);
  }
}
// Controle: JWT com assinatura estragada tem de ser recusado como JWT inválido.
try {
  const broken = vapidHeader('https://web.push.apple.com', 'mailto:claude-hub@example.com').replace(/\.([A-Za-z0-9_-]{6})/, '.AAAAAA');
  const res = await fetch(endpoint, { method: 'POST', headers: { authorization: broken, ttl: '60', 'content-length': '0' }, signal: AbortSignal.timeout(20_000) });
  console.log(`(controle: JWT adulterado) => HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
} catch (err) {
  console.log(`(controle) => sem resposta: ${err.cause?.code ?? err.message}`);
}
