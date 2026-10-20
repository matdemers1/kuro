import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * oidc-provider's development login, then its consent screen when it asks. Wait for whichever comes
 * next — the consent screen or Kurō's own page (every screen is a <main>; the issuer's are not) —
 * rather than guessing how long a cold CI start takes to show consent.
 */
export async function signInAtIssuer(page: Page, subject: string) {
  await page.locator('input[name="login"]').fill(subject);
  await page.locator('input[name="password"]').fill('anything');
  await page.locator('button[type="submit"]').click();
  const consent = page.locator('button[type="submit"]', { hasText: /continue/i });
  await expect(consent.or(page.locator('main'))).toBeVisible({ timeout: 15_000 });
  if (await consent.isVisible()) await consent.click();
}

/**
 * After "Sign in with D3 Auth": the issuer's login form if it holds no session, else straight back to
 * Up Next. Wait for whichever renders — a fixed timeout guesses wrong on a cold CI start.
 */
export async function completeIssuerSignIn(page: Page) {
  const login = page.locator('input[name="login"]');
  const upNext = page.getByRole('heading', { name: 'Up Next' });
  await expect(login.or(upNext)).toBeVisible({ timeout: 15_000 });
  if (await login.isVisible()) await signInAtIssuer(page, 'owner-sub');
  await expect(upNext).toBeVisible();
}

/** axe over the page in dark and in light (KURO-T-6.3): any serious or critical violation fails. */
export async function axe(page: Page, where: string) {
  for (const colorScheme of ['dark', 'light'] as const) {
    // Reduced motion: a colour still transitioning from the other scheme is not what anyone reads.
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const serious = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${where} (${colorScheme}): ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')} — ${(v.nodes[0]?.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 220)}`)).toEqual([]);
  }
}
