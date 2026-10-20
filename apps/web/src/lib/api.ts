/** A tiny fetch wrapper: same-origin, JSON in and out, cookies carried by the browser. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  const body = (text.length > 0 ? JSON.parse(text) : {}) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, typeof body['error'] === 'string' ? body['error'] : `request failed (${String(res.status)})`, body);
  return body as T;
}

export interface SessionInfo {
  authenticated: boolean;
  setupRequired?: boolean;
  oidcAvailable: boolean;
  user?: { id: string; email: string; displayName: string };
  totpEnrolled?: boolean;
  d3AuthLinked?: boolean;
}

export async function getSession(): Promise<SessionInfo> {
  try {
    return await api<SessionInfo>('/auth/session');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return err.body as unknown as SessionInfo;
    throw err;
  }
}
