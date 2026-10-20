#!/usr/bin/env node
// KURO-REQ-057: the repo is public, so CI fails if anything that looks like the owner's real
// Crunchyroll data or a credential is tracked. Synthetic fixtures use account and profile IDs
// that start with `00000000-0000-`, which this scan allows.
//
// Usage: node scripts/scan-personal-data.mjs [--files a b c]   (default: every git-tracked file)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const FAKE_UUID_PREFIX = '00000000-0000-';

export const RULES = [
  { id: 'jwt', why: 'a JSON Web Token (Crunchyroll access token?)', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: 'etp-rt', why: 'a Crunchyroll etp_rt cookie value', re: /etp_rt["']?\s*[=:]\s*["']?[A-Za-z0-9._-]{20,}/gi },
  { id: 'refresh-token', why: 'a refresh token value', re: /"refresh_token"\s*:\s*"[A-Za-z0-9._-]{20,}"/g },
  { id: 'foreman-token', why: 'a Foreman API token', re: /\bfrm_[A-Za-z0-9_-]{20,}/g },
  { id: 'basic-auth', why: 'an HTTP Basic credential', re: /Basic\s+[A-Za-z0-9+/]{24,}={0,2}/g },
];

/** Field names whose UUID value identifies a real Crunchyroll account or profile. */
const ID_FIELDS = /"(?:account_id|accountId|profile_id|profileId|external_id)"\s*:\s*"([^"]+)"/g;

export function scanText(path, text) {
  const hits = [];
  if (path.startsWith('fixtures/real/') && !path.endsWith('.gitkeep')) {
    hits.push({ path, rule: 'real-fixture', why: 'a file under fixtures/real/ is tracked' });
  }
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) hits.push({ path, rule: rule.id, why: rule.why, at: m.index });
  }
  for (const m of text.matchAll(ID_FIELDS)) {
    const value = m[1] ?? '';
    for (const u of value.matchAll(UUID)) {
      if (!u[0].toLowerCase().startsWith(FAKE_UUID_PREFIX)) {
        hits.push({ path, rule: 'account-id', why: 'a real-looking Crunchyroll account or profile ID', at: m.index });
      }
    }
  }
  return hits;
}

const SKIP = [/^pnpm-lock\.yaml$/, /^Cargo\.lock$/, /(^|\/)Cargo\.lock$/, /^LICENSE$/, /\.(png|jpg|jpeg|gif|webp|ico|woff2?)$/i, /^scripts\/scan-personal-data(\.test)?\.mjs$/];

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
}

function main(argv) {
  const i = argv.indexOf('--files');
  const files = i >= 0 ? argv.slice(i + 1) : trackedFiles();
  const hits = [];
  for (const f of files) {
    if (SKIP.some((re) => re.test(f))) continue;
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch (err) {
      throw new Error(`cannot read ${f}`, { cause: err });
    }
    hits.push(...scanText(f, text));
  }
  if (hits.length > 0) {
    for (const h of hits) console.error(`✗ ${h.path}: ${h.why} [${h.rule}]`);
    console.error(`\n${hits.length} finding(s). Real history belongs in fixtures/real/ (gitignored); synthetic IDs start with ${FAKE_UUID_PREFIX}.`);
    process.exit(1);
  }
  console.log(`✓ personal-data scan clean (${files.length} files)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
