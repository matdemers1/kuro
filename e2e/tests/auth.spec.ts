import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

/**
 * KURO-T-0.3 + KURO-T-0.4: first run, then both login paths (GL-001), driven in a browser against
 * the built server and a mock D3 Auth. One owner, one story, so the steps run in order.
 */
test.describe.configure({ mode: 'serial' });

const OWNER = { name: 'Owner', email: 'owner@example.com', password: 'a long enough password' };
let totp: TOTP;

async function signInAtIssuer(page: Page, subject: string) {
  // oidc-provider's development login, then its consent screen when it asks.
  await page.locator('input[name="login"]').fill(subject);
  await page.locator('input[name="password"]').fill('anything');
  await page.locator('button[type="submit"]').click();
  const consent = page.locator('button[type="submit"]', { hasText: /continue/i });
  if (await consent.isVisible({ timeout: 3000 }).catch(() => false)) await consent.click();
}

/** Each test starts in a fresh browser context; sign out only if this one is signed in. */
async function signOut(page: Page) {
  await page.goto('/you');
  const button = page.getByRole('button', { name: 'Sign out' });
  if (await button.isVisible({ timeout: 3000 }).catch(() => false)) await button.click();
  await page.goto('/');
  await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();
}

test('first run: the setup token creates the owner, then an authenticator, then a D3 Auth link', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Kurō' })).toBeVisible();
  // Password managers save the first password field as the login, so the new password must be the
  // only one and the setup token must not look like a credential.
  const setupForm = page.getByRole('form', { name: 'Create the owner' });
  await expect(setupForm.locator('input[type="password"]')).toHaveCount(1);
  await expect(setupForm.locator('input[type="password"]')).toHaveAttribute('autocomplete', 'new-password');
  await expect(page.getByLabel('Setup token')).toHaveAttribute('type', 'text');
  await expect(page.getByLabel('Setup token')).toHaveAttribute('autocomplete', 'off');
  await page.getByLabel('Setup token').fill('e2e-setup-token-0123456789');
  await page.getByLabel('Your name').fill(OWNER.name);
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Create my account' }).click();

  await expect(page.getByRole('heading', { name: 'Add an authenticator' })).toBeVisible();
  const secret = (await page.getByTestId('totp-secret').textContent()) ?? '';
  totp = new TOTP({ secret: Secret.fromBase32(secret.trim()), digits: 6, period: 30, algorithm: 'SHA1' });
  await page.getByLabel('Code').fill(totp.generate());
  await page.getByRole('button', { name: 'Confirm' }).click();

  await expect(page.getByRole('heading', { name: 'Link D3 Auth' })).toBeVisible();
  await page.getByRole('button', { name: 'Link D3 Auth' }).click();
  await signInAtIssuer(page, 'owner-sub');
  await expect(page.getByRole('heading', { name: 'Up Next' })).toBeVisible();
});

test('setup is closed once the owner exists', async ({ request }) => {
  expect((await request.get('/api/setup')).status()).toBe(404);
});

test('password + TOTP signs the owner in', async ({ page }) => {
  await page.goto('/');
  await signOut(page);
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Authenticator code')).toBeVisible();
  // The step setup confirmed is burned; the next one is inside the window.
  await page.getByLabel('Authenticator code').fill(totp.generate({ timestamp: Date.now() + 30_000 }));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Up Next' })).toBeVisible();
});

test('Sign in with D3 Auth signs the linked owner in, by (iss, sub)', async ({ page }) => {
  await page.goto('/');
  await signOut(page);
  await page.getByRole('button', { name: 'Sign in with D3 Auth' }).click();
  // The issuer may still hold its own session from setup; sign in there only if it asks.
  if (await page.locator('input[name="login"]').isVisible({ timeout: 3000 }).catch(() => false)) await signInAtIssuer(page, 'owner-sub');
  await expect(page.getByRole('heading', { name: 'Up Next' })).toBeVisible();
});

test('offline, the installed app opens read-only from its cache (KURO-REQ-019)', async ({ page, context }) => {
  await page.goto('/');
  if (await page.getByRole('form', { name: 'Sign in' }).isVisible({ timeout: 2000 }).catch(() => false)) {
    await page.getByRole('button', { name: 'Sign in with D3 Auth' }).click();
    if (await page.locator('input[name="login"]').isVisible({ timeout: 3000 }).catch(() => false)) await signInAtIssuer(page, 'owner-sub');
  }
  await expect(page.getByRole('heading', { name: 'Up Next' })).toBeVisible();
  // Wait for the service worker to control the page, then visit once more so reads are cached.
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Up Next' })).toBeVisible();

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Up Next' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('offline');
  await context.setOffline(false);
});

test('an identity nobody linked is refused — no back door around closed signup', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with D3 Auth' }).click();
  await signInAtIssuer(page, 'stranger');
  await expect(page.getByRole('alert')).toContainText('not linked');
  await expect(page.getByRole('heading', { name: 'Up Next' })).toHaveCount(0);
  await context.close();
});
