import type { CSSProperties } from 'react';

/** Estrela de 8 raios — símbolo próprio do Claude Hub (não usa marcas de terceiros). */
export const SPARK_COLOR = '#E8704F';

export function Spark({ size = 16, color = SPARK_COLOR, style }: { size?: number; color?: string; style?: CSSProperties }) {
  const rays = Array.from({ length: 8 }, (_, i) => i * 45);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style} aria-hidden="true">
      {rays.map((deg, i) => (
        <line
          key={deg}
          x1="12"
          y1={i % 2 === 0 ? 2.2 : 4.2}
          x2="12"
          y2="9.4"
          stroke={color}
          strokeWidth="2.6"
          strokeLinecap="round"
          transform={`rotate(${deg} 12 12)`}
        />
      ))}
    </svg>
  );
}

/** Ícone do app: quadrado coral arredondado com a estrela branca. */
export function AppIcon({ size = 22 }: { size?: number }) {
  return (
    <span className="app-icon" style={{ width: size, height: size, borderRadius: size * 0.26 }} aria-hidden="true">
      <Spark size={size * 0.72} color="#fff" />
    </span>
  );
}

export function PhoneIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <line x1="11" y1="18" x2="13" y2="18" />
    </svg>
  );
}

export function SwapIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8h14M14 4l4 4-4 4" />
      <path d="M20 16H6M10 12l-4 4 4 4" />
    </svg>
  );
}

export function ChevronIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

export function CloseIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** Anel de progresso laranja da ilha compacta. Gira quando o progresso é indeterminado. */
export function Ring({ size = 14, percent }: { size?: number; percent: number | null }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  const frac = percent === null ? 0.72 : Math.max(0.04, percent / 100);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={percent === null ? 'ring spin' : 'ring'} aria-hidden="true">
      <circle cx="12" cy="12" r={r} fill="none" stroke="rgba(245,165,36,0.22)" strokeWidth="3" />
      <circle
        cx="12"
        cy="12"
        r={r}
        fill="none"
        stroke="var(--orange)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={`${c * frac} ${c}`}
        transform="rotate(-90 12 12)"
      />
    </svg>
  );
}
