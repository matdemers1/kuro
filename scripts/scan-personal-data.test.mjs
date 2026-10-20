import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanText } from './scan-personal-data.mjs';

test('a planted real-looking account ID fails', () => {
  const hits = scanText('fixtures/synthetic/history.json', '{"account_id": "4b7e2c1a-9f3d-4e8a-b2c6-1d0e5f7a9b3c"}');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rule, 'account-id');
});

test('a synthetic account ID passes', () => {
  assert.deepEqual(scanText('fixtures/synthetic/history.json', '{"account_id": "00000000-0000-4000-8000-000000000001"}'), []);
});

test('a JWT fails', () => {
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl';
  assert.equal(scanText('apps/server/test/x.ts', `const t = "${jwt}"`)[0]?.rule, 'jwt');
});

test('an etp_rt cookie fails', () => {
  assert.equal(scanText('notes.md', 'Cookie: etp_rt=abcdefghijklmnopqrstuvwxyz0123')[0]?.rule, 'etp-rt');
});

test('any tracked file under fixtures/real fails', () => {
  assert.equal(scanText('fixtures/real/export.json', '{}')[0]?.rule, 'real-fixture');
  assert.deepEqual(scanText('fixtures/real/.gitkeep', ''), []);
});
