# Re-link Crunchyroll

**Symptom:** Up Next and You → Sync show *Crunchyroll session expired — re-link to resume sync*, and
the *Crunchyroll session expired* alert arrives. The connection's state is `paused`.

**Cause:** Crunchyroll revoked Kurō's refresh token: a password change, a "sign out of all devices",
or Crunchyroll expiring old sessions. Kurō never stored the password (KURO-ADR-001), so only the owner
can link it again. Nothing is lost: the history vault keeps every play, and the next sync starts from
the newest play Kurō has (the high-water mark), so nothing in between is missed as long as
Crunchyroll still lists it.

## Steps

1. Open **You**, then **Re-link Crunchyroll**.
2. Enter the Crunchyroll email and password. Kurō exchanges them once for a refresh token, sealed
   under `KURO_SECRET_KEY`, and forgets the password.
3. Kurō runs a delta sync straight away. Watch **Import progress**: it reports the plays it found.
4. Check You → Sync: the state is *linked*, *Last sync* is just now, and *Last error* is empty.
5. Check the change log: *Re-linked Crunchyroll* is the newest entry.

**If the link fails:**
- *Wrong email or password*: sign in at crunchyroll.com to confirm them, then try again.
- *Blocked* (a 403 or a Cloudflare page): follow [Blocked sync](blocked-sync.md) first.
- *The account has a different Crunchyroll profile*: Kurō links the account's main profile; switch
  profiles on Crunchyroll, then re-link.

## Drill log

| Date | Where | Result |
|---|---|---|
| — | production | **Not yet followed:** it needs the owner's Crunchyroll password, which only the owner enters. |
