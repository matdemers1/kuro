import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';

const signedIn = { authenticated: true, oidcAvailable: false, user: { id: 'u', email: 'o@example.com', displayName: 'Owner' }, totpEnrolled: true };

describe('App shell', () => {
  it('shows Up Next when signed in', () => {
    expect(renderToStaticMarkup(<App initial={signedIn} />)).toContain('Up Next');
  });
  it('shows the sign-in form, with D3 Auth only when available', () => {
    const without = renderToStaticMarkup(<App initial={{ authenticated: false, oidcAvailable: false }} />);
    expect(without).toContain('Sign in');
    expect(without).not.toContain('D3 Auth');
    expect(renderToStaticMarkup(<App initial={{ authenticated: false, oidcAvailable: true }} />)).toContain('Sign in with D3 Auth');
  });
  it('shows setup while no owner exists', () => {
    expect(renderToStaticMarkup(<App initial={{ authenticated: false, oidcAvailable: false, setupRequired: true }} />)).toContain('Welcome to Kurō');
  });
});
