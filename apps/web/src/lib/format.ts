export function hours(seconds: number): string {
  const h = Math.round(seconds / 3600);
  return h >= 1 ? `${String(h)}h` : `${String(Math.max(1, Math.round(seconds / 60)))}m`;
}

export function se(season: number | null, episode: number | null): string {
  if (season === null) return '';
  return episode === null ? `S${String(season)}` : `S${String(season)} · E${String(episode)}`;
}

const LOCALES: Record<string, string> = { 'en-US': 'English dub', 'ja-JP': 'Japanese', 'es-419': 'Spanish dub', 'pt-BR': 'Portuguese dub', 'de-DE': 'German dub', 'fr-FR': 'French dub' };
export function audio(locale: string | null): string {
  return locale === null ? '' : (LOCALES[locale] ?? locale);
}

/** The seven statuses (KURO-REQ-033), as the owner reads them. */
export const STATUS_LABEL: Record<string, string> = {
  plan_to_watch: 'Plan to watch',
  watching: 'Watching',
  caught_up: 'Caught up',
  paused: 'Paused',
  completed: 'Completed',
  dropped: 'Dropped',
  rewatching: 'Rewatching',
};
export const statusLabel = (s: string): string => STATUS_LABEL[s] ?? s;
