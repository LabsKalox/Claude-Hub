'use client';
import { useEffect } from 'react';
import { Island } from '@/components/Island';
import { hub, useHub } from '@/lib/hub';

/**
 * Ilha no navegador. Abra pelo Mac em
 *   http://127.0.0.1:4317/island/#token=<localToken de ~/.claude-hub/config.json>
 * (o token sai da URL assim que a página carrega).
 */
export default function IslandPage() {
  const state = useHub();
  useEffect(() => hub.start(), []);
  return (
    <main className="desktop">
      <div className="desktop-sky" />
      {state.connection === 'unpaired' ? (
        <div className="island mode-compact">
          <div className="island-pill small">
            <span className="pill-dim">Abra esta página com #token=… do hub local</span>
          </div>
        </div>
      ) : (
        <Island state={state} />
      )}
      <div className="desktop-dock" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
    </main>
  );
}
