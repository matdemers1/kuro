# Runbooks

What to do when Kurō needs a hand, step by step (KURO-T-6.4). Each runbook ends with a log of the
times it was followed end to end.

| Runbook | When |
|---|---|
| [Re-link Crunchyroll](relink.md) | Up Next says *Crunchyroll session expired — re-link to resume sync* |
| [Blocked sync](blocked-sync.md) | Up Next says *Crunchyroll is refusing sync right now*, or the *Crunchyroll is blocking sync* alert arrives |
| [Catalog swap](catalog-swap.md) | The catalog's source stops publishing, or the alert *The anime catalog is out of date* arrives |
| [Key rotation](key-rotation.md) | `KURO_SECRET_KEY` may have leaked, or once a year |

Conventions used in all four:

- **Deploys and restarts go through Shipyard**, never `docker compose up` by hand. From the Shipyard
  host: `cd /DATA/shipyard && DOCKER_CONFIG=/DATA/.docker docker compose -p shipyard run --rm --no-deps --entrypoint shipyard-run agent deploy kuro <sha> --label "<why>"`.
- **Operator commands run inside the server container:** `docker exec kuro-kuro-server-1 node dist/cli/main.js <command>`.
- **Secrets live in `/DATA/kuro/server.env`** (mode 600). Never paste one into a chat, a commit or a log.
- Every runbook leaves the change log and the sync health panel (You → Sync) telling the truth; check both at the end.
