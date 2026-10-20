import { useState } from 'react';

/** A gradient picked from the title — the stand-in while an image loads, or when there is none. */
const ART = [['#E5483A', '#3B1F2B'], ['#7C93E0', '#14263B'], ['#E8B75A', '#2A2412'], ['#7FB77E', '#16281C'], ['#B07CE0', '#2B1838'], ['#F08A4B', '#331A12']] as const;

function gradient(title: string): string {
  let h = 0;
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [a, b] = ART[h % ART.length] ?? ART[0];
  return `linear-gradient(160deg, ${a}, ${b})`;
}

/** Key art from the local cache (KURO-REQ-021); the gradient shows until it loads or if it fails. */
export function Poster({ title, src, className = '' }: { title: string; src?: string | undefined; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div aria-hidden="true" className={`overflow-hidden rounded-[10px] ${className}`} style={{ background: gradient(title) }}>
      {src !== undefined && !failed && <img src={src} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" onError={() => { setFailed(true); }} />}
    </div>
  );
}

/** A Show's poster: its Crunchyroll series' key art, whether it is matched (`show:`) or not (`cr:`). */
export function posterFor(showKey: string): string | undefined {
  return showKey.startsWith('cr:') || showKey.startsWith('show:') ? `/img/show/${encodeURIComponent(showKey)}/poster` : undefined;
}
