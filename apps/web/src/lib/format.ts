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
