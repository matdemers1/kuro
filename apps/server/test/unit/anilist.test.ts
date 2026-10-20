import { describe, expect, it } from 'vitest';
import { crunchyrollKeys } from '../../src/adapters/anilist.js';

describe('crunchyrollKeys', () => {
  const keys = (...urls: string[]) => [...crunchyrollKeys({ externalLinks: urls.map((url) => ({ site: 'Crunchyroll', url })) })].sort();

  it('reads the old slug form AniList mostly holds', () => {
    expect(keys('https://www.crunchyroll.com/demon-slayer-kimetsu-no-yaiba')).toEqual(['demon-slayer-kimetsu-no-yaiba']);
  });

  it('reads the series id and slug from the current form, with or without a locale', () => {
    expect(keys('https://www.crunchyroll.com/series/GY5P48XEY/demon-slayer-kimetsu-no-yaiba')).toEqual(['demon-slayer-kimetsu-no-yaiba', 'gy5p48xey']);
    expect(keys('https://www.crunchyroll.com/en-gb/series/G4PH0WXVJ')).toEqual(['g4ph0wxvj']);
  });

  it('ignores other sites and broken URLs', () => {
    expect([...crunchyrollKeys({ externalLinks: [{ site: 'Netflix', url: 'https://www.netflix.com/title/1' }, { site: 'Crunchyroll', url: 'not a url' }] })]).toEqual([]);
  });
});
