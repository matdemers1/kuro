# Catalog swap

**Symptom:** the alert *The anime catalog is out of date*, meaning no new catalog release in 21 days; or the weekly
import (Tuesdays 04:00) failing in the server log with `catalog import failed`.

**Cause:** the catalog's GitHub source (`cedya77/anime-offline-database` by default, KURO-ADR-002)
stopped publishing weekly releases, or changed its file format.

**What makes a swap safe:** catalog entry IDs are stable across sources (`anilist:` / `mal:` keys,
then a source-URL match back to the existing row). An entry the new source lacks is *retired*, never
deleted. Mappings, Shows and the owner's choices all survive, and swapping back un-retires them.

## Steps

1. **Pick the fallback:** `athanasso/anime-offline-database` publishes the same data as minified
   JSON. Check that it has a recent release on GitHub.
2. **Try it first without changing anything:**
   `docker exec -e KURO_CATALOG_REPO=athanasso/anime-offline-database kuro-kuro-server-1 node dist/cli/main.js catalog-import --force`.
   It prints the release it read and how many entries were added and retired.
3. **Make it stick:** set `KURO_CATALOG_REPO=athanasso/anime-offline-database` in
   `/DATA/kuro/server.env`, then redeploy the current SHA with Shipyard so the weekly job uses it.
4. **Re-match:** the import's own job queues a match; or press Sync now. Then open **Match review**:
   anything the new source places differently shows up there as *weak*.
5. Check the out-of-date alert stops (it is checked hourly), and Up Next for anything surprising.
6. **Swapping back** when the original source returns is the same steps with
   `cedya77/anime-offline-database`.

## Drill log

| Date | Where | Result |
|---|---|---|
| 2026-10-20 | Local instance on the real export (239 Shows, 433 accepted mappings) | Imported athanasso 2026-42: 37,974 entries, 465 newer ones retired, 0 mappings broken. A re-match left 432 accepted and 60 in review, with 0 remapped; one Show's state changed because the older release lacks an entry. Swapped back to cedya77 2026-43: 38,250 entries, and a re-match restored exactly the original Show states (identical hash over every Show's key, next episode and status). |
