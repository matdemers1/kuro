// A stand-in for D3 Auth: oidc-provider (the library D3 Auth is built on) with its development
// login form. Any login name is accepted and becomes the subject, so a test chooses who it is.
import Provider from 'oidc-provider';

const port = Number(process.env.ISSUER_PORT ?? 4545);
const appBase = process.env.APP_BASE ?? 'http://localhost:3399';

const provider = new Provider(`http://localhost:${port}`, {
  clients: [
    {
      client_id: 'kuro-e2e',
      client_secret: 'kuro-e2e-secret',
      redirect_uris: [`${appBase}/auth/oidc/callback`],
      post_logout_redirect_uris: [`${appBase}/`],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
    },
  ],
  claims: { openid: ['sub'], email: ['email'], profile: ['name'] },
  cookies: { keys: ['e2e-only-cookie-key'] },
  pkce: { required: () => true },
  features: { devInteractions: { enabled: true } },
  findAccount: (_ctx, id) => ({ accountId: id, claims: () => ({ sub: id, email: `${id}@d3auth.test`, name: id }) }),
});
provider.proxy = false;
provider.listen(port, () => {
  console.log(`mock issuer on http://localhost:${port}`);
});
