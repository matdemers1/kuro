/** Key art stand-in until the image cache lands (KURO-T-1.11): a gradient picked from the title. */
const ART = [['#E5483A', '#3B1F2B'], ['#7C93E0', '#14263B'], ['#E8B75A', '#2A2412'], ['#7FB77E', '#16281C'], ['#B07CE0', '#2B1838'], ['#F08A4B', '#331A12']] as const;

export function Poster({ title, className = '' }: { title: string; className?: string }) {
  let h = 0;
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [a, b] = ART[h % ART.length] ?? ART[0];
  return <div aria-hidden="true" className={`rounded-[10px] ${className}`} style={{ background: `linear-gradient(160deg, ${a}, ${b})` }} />;
}
