'use client';
import { useEffect, useState } from 'react';
import { AppIcon } from '@/components/icons';
import { HubError, hub } from '@/lib/hub';

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  return 'Navegador';
}

/** No iPhone, fora do app instalado na Tela de Início. */
function iosInSafari(): boolean {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  return ios && !standalone;
}

export default function PairPage() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installHint, setInstallHint] = useState(false);

  const pair = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      await hub.pair(value, defaultDeviceName());
      window.location.replace('/');
    } catch (err) {
      const status = err instanceof HubError ? err.status : 0;
      setError(
        status === 429
          ? 'Muitas tentativas. Espere um minuto e gere um novo código.'
          : status === 401
            ? 'Código inválido ou expirado. Gere um novo no Mac.'
            : 'Não consegui falar com o hub. Confira se o Mac está ligado e acessível.',
      );
      setBusy(false);
    }
  };

  useEffect(() => {
    // O app instalado sempre abre nesta URL (com o código do QR): se já está pareado, segue direto.
    try {
      if (window.localStorage.getItem('claude-hub.token')) {
        window.location.replace('/');
        return;
      }
    } catch {
      /* armazenamento indisponível */
    }
    const fromUrl = new URLSearchParams(window.location.search).get('code');
    if (!fromUrl) return;
    const value = fromUrl.toUpperCase();
    setCode(value);
    // O manifesto precisa carregar o código para o app instalado abrir já pareando.
    document.querySelectorAll<HTMLLinkElement>('link[rel="manifest"]').forEach((link) => {
      link.href = `/manifest.webmanifest?pair=${encodeURIComponent(value)}`;
    });
    if (iosInSafari()) {
      // No Safari do iPhone, parear aqui não vale para o app instalado: orienta a instalar primeiro.
      setInstallHint(true);
    } else {
      void pair(value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!busy) void pair(code);
  };

  if (installHint) {
    return (
      <main className="phone pair" data-testid="install-hint">
        <AppIcon size={64} />
        <h1>Instale o app para parear</h1>
        <ol className="steps">
          <li>
            Toque em <strong>Compartilhar</strong> (o quadrado com a seta) e depois em <strong>Adicionar à Tela de Início</strong>.
          </li>
          <li>
            Abra o <strong>Claude Hub</strong> pelo ícone novo. Ele pareia sozinho com este código.
          </li>
        </ol>
        <p className="hint center">
          Código <strong className="mono">{code}</strong> · vale 10 minutos e só pode ser usado uma vez.
        </p>
        <button type="button" className="link" onClick={() => setInstallHint(false)}>
          Prefiro usar pelo Safari, sem instalar
        </button>
      </main>
    );
  }

  return (
    <main className="phone pair">
      <AppIcon size={64} />
      <h1>Parear com o Mac</h1>
      <p className="lead">
        No Mac, abra o Claude Hub → <strong>Configuração e saúde</strong> → <strong>iPhone</strong> e escaneie o QR, ou digite aqui o código de 8 caracteres.
      </p>
      <form onSubmit={submit} className="pair-form">
        <input
          className="code-input"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 9))}
          placeholder="ABCD-EFGH"
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="one-time-code"
          spellCheck={false}
          aria-label="Código de pareamento"
        />
        {error ? <p className="error-text">{error}</p> : null}
        <button type="submit" className="btn primary block" disabled={busy || code.replace(/[^A-Z0-9]/g, '').length < 8}>
          {busy ? 'Pareando…' : 'Parear'}
        </button>
      </form>
      <p className="hint center">O código vale 10 minutos e só pode ser usado uma vez.</p>
    </main>
  );
}
