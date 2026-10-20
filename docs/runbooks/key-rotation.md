# Key rotation

**When:** `KURO_SECRET_KEY` may have leaked (a copied env file, a screenshot, a shell history), or
once a year as hygiene.

**What it protects** (KURO-ADR-008): the Crunchyroll refresh token and the owner's TOTP secret, both
sealed with AES-256-GCM under `KURO_SECRET_KEY`. `AUTH_PEPPER` is separate: rotating it would sign
everyone out and invalidate the password hash, so it is not part of this runbook.

`kuro rotate-key` re-seals both values under a new key in one transaction, and checks that each one
opens under the new key before it commits. Between running it and the redeploy (about a minute) the
running server still holds the old key, so a sync or a sign-in in that window fails. Run it when
nothing is syncing.

## Steps

1. **Make a new key** on the Shipyard host, and never echo it anywhere else:
   `NEW=$(openssl rand -base64 32)`.
2. **Back up first:** `docker exec kuro-kuro-server-1 node dist/cli/backup.js`. This prints the dump's name.
3. **Re-seal:** `docker exec -e KURO_SECRET_KEY_NEW="$NEW" kuro-kuro-server-1 node dist/cli/main.js rotate-key`.
   It prints *re-encrypted 1 Crunchyroll link(s) and 1 TOTP secret(s)*. If it fails, nothing has
   changed.
4. **Switch the key:** replace the `KURO_SECRET_KEY=` line in `/DATA/kuro/server.env` with the new
   value (keep the file mode 600), then `unset NEW`.
5. **Redeploy** the current SHA with Shipyard, labelled *key rotation*.
6. **Verify:** sign out and sign in again with password and authenticator code, which proves the TOTP
   secret opens. Then press **Sync now**, which proves the refresh token opens. You → Sync should
   show *linked* and a fresh *Last sync*.
7. Destroy any copy of the old key.

**If it goes wrong:** the old key still opens the backup from step 2. Put the old key back in
`server.env`, restore that dump with Shipyard's restore step, and redeploy.

## Drill log

| Date | Where | Result |
|---|---|---|
| 2026-10-20 | Local instance on the real export | Signed in with password and TOTP under the old key, then ran `rotate-key`, which re-encrypted 1 link and 1 TOTP secret. With the new key in the env file and the server restarted, password and TOTP sign-in succeeded and the stored refresh token opened under the new key. `test/integration/rotate.test.ts` covers the same path, plus the refusals. |
