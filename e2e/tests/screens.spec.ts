import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { axe, completeIssuerSignIn } from './support.js';

/**
 * KURO-T-6.3: every screen in the UX inventory, signed in as the owner auth.spec created — first
 * with nothing imported (the empty states), then with synthetic shows from `kuro seed-dev` — and axe
 * over each in dark and in light. Serious and critical violations fail the run.
 */
test.describe.configure({ mode: 'serial' });

const DATABASE_URL = process.env['E2E_DATABASE_URL'] ?? 'postgresql://kuro:kuro@127.0.0.1:5432/kuro_e2e_test';
const SECRET_KEY = Buffer.alloc(32, 3).toString('base64');

/** Go to a screen and wait until it has finished loading: no skeleton left. */
async function visit(page: Page, path: string, heading: string | RegExp) {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  if (await page.getByRole('heading', { name: 'Up Next' }).isVisible({ timeout: 3000 }).catch(() => false)) return;
  await page.getByRole('button', { name: 'Sign in with D3 Auth' }).click();
  await completeIssuerSignIn(page);
});

test('with nothing imported, every screen says so, and passes axe', async ({ page }) => {
  await visit(page, '/library', 'Library');
  await expect(page.getByText('Your history hasn’t imported yet.')).toBeVisible();
  await axe(page, 'Library, empty');
  await visit(page, '/you/stats', 'Stats');
  await expect(page.getByText('Needs history')).toBeVisible();
  await axe(page, 'Stats, empty');
  await visit(page, '/review', 'Which show is this?');
  await axe(page, 'Match review, empty');
  await visit(page, '/you/changes', 'Change log');
  await axe(page, 'Change log');
});

test('with shows imported, every screen passes axe in dark and light', async ({ page }) => {
  const seeded = spawnSync(process.execPath, [join(import.meta.dirname, '../../apps/server/dist/cli/main.js'), 'seed-dev'], { env: { ...process.env, NODE_ENV: 'test', DATABASE_URL, KURO_SECRET_KEY: SECRET_KEY }, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);

  await visit(page, '/', 'Up Next');
  await expect(page.getByText('Paper Kite Academy').first()).toBeVisible();
  await axe(page, 'Up Next');
  await visit(page, '/season', 'This Season');
  await axe(page, 'This Season');
  await visit(page, '/library', 'Library');
  await axe(page, 'Library');
  await visit(page, `/show/${encodeURIComponent('cr:GDEVLANT')}`, 'Lantern Road');
  await axe(page, 'Show detail');
  await visit(page, `/franchise/${encodeURIComponent('fr:cr:GDEVLANT')}`, 'Lantern Road');
  await axe(page, 'Franchise');
  await visit(page, '/discover', 'Discover');
  await axe(page, 'Discover');
  await visit(page, '/you', 'You');
  await axe(page, 'You and sync settings');
  await visit(page, '/you/taste', 'Your taste');
  await axe(page, 'Taste profile');
  await visit(page, '/you/stats', 'Stats');
  await axe(page, 'Stats');
  const year = await page.getByRole('button', { name: /^\d{4}/ }).first().textContent();
  await visit(page, `/you/year/${(year ?? '').slice(0, 4)}`, (year ?? '').slice(0, 4));
  await axe(page, 'Year in review');
  await visit(page, '/you/changes', 'Change log');
  await axe(page, 'Change log');
});

test('signed out, every screen is the sign-in screen, and it passes axe', async ({ page }) => {
  await page.goto('/you');
  await page.getByRole('button', { name: 'Sign out' }).click();
  for (const path of ['/library', `/show/${encodeURIComponent('cr:GDEVLANT')}`, '/you/stats']) {
    await page.goto(path);
    await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();
  }
  await axe(page, 'Sign in');
});
