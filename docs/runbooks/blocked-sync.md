# Blocked sync

**Symptom:** Up Next shows *Crunchyroll is refusing sync right now — Kurō keeps retrying*. You → Sync
shows the state *blocked* and a *Last error* beginning `blocked:`. After two blocked runs in a row,
the hourly alert check sends *Crunchyroll is blocking sync*.

**Cause:** Crunchyroll, or Cloudflare in front of it, answered the sidecar with a 403 or a challenge
page. Usually that is a short-lived bot rule against the home connection's IP. Less often, Crunchyroll
changed its API and `crunchyroll-rs` (the `kuro-cr` sidecar) needs an update.

Nothing is lost while it lasts: the vault keeps every play, and the next successful sync carries on
from the high-water mark.

## Steps

1. **Wait for one more attempt.** The nightly sync at 03:00 retries, and so does **Sync now**
   (Up Next → Import progress). Most blocks clear within a day. A successful run sets the state back
   to *linked* and the banner goes away by itself.
2. **Still blocked after a day?** Read the sidecar's last error on the Shipyard host:
   `docker logs --since 24h kuro-kuro-cr-1 | grep -i -E 'status|403|cloudflare' | tail -20`.
   - **403 with an HTML body** (a Cloudflare challenge): the IP is being rate-limited. Leave it alone
     for 24 h, and don't press Sync now repeatedly, since every attempt extends the block.
   - **401 / invalid_grant:** the session has gone, not the IP. Follow [Re-link Crunchyroll](relink.md).
   - **404 or a parse error on a known endpoint:** Crunchyroll changed its API. Update
     `crunchyroll-rs` in `crates/kuro-cr`, ship it through CI, and deploy with Shipyard.
3. **Check from a browser on the same network** that crunchyroll.com loads and plays. If it doesn't,
   the block is upstream of Kurō: wait.
4. After the first successful sync, confirm You → Sync shows *linked*, and that the plays from the
   blocked days are in (Stats → the heatmap's recent days).

## Drill log

| Date | Where | Result |
|---|---|---|
| 2026-10-20 | Local instance on the real export | Two consecutive `blocked:` runs marked the connection *blocked*. Up Next showed the banner, the health panel reported `blockedTwice: true`, and the hourly check decided *Crunchyroll is blocking sync*. Returning the connection to *linked*, as a successful run does, cleared the banner. The drill rows were removed afterwards. |
