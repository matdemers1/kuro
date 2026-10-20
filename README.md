# Kurō 苦労

Your anime, by show — not by season.

Kurō is a self-hosted, single-user anime tracker. It mirrors your Crunchyroll watch history into a
local, append-only vault, groups seasons into shows and franchises, and answers two questions every
evening: **what do I watch next**, and **what's dubbed this week**.

> [!warning] Unofficial
> Kurō talks to Crunchyroll's **undocumented** API through [crunchyroll-rs](https://github.com/crunchy-labs/crunchyroll-rs).
> It is not affiliated with or endorsed by Crunchyroll. It only reads your own account's history
> and never plays, downloads or decrypts video — "Watch" always opens Crunchyroll. Use it for your
> own account, at your own risk, and check Crunchyroll's terms.

## Status

Planned. The plan of record is the Foreman project `KURO`.

## Data sources

- Crunchyroll — your watch history, watchlist and Crunchylists (unofficial API).
- [anime-offline-database](https://github.com/cedya77/anime-offline-database) — catalog, ODbL 1.0 / DbCL 1.0.
- [AniList](https://anilist.co) — typed relations and art for shows you have, sparingly. Kurō is not affiliated with AniList.
- [AnimeSchedule.net](https://animeschedule.net) — dub release timetables.

## License

Apache-2.0. See [LICENSE](LICENSE).
