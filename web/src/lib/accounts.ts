// A standalone server's own accounts, under Info.accountsUrl: signing in,
// invitations, passwords and the workspaces to switch between. A host
// application has its own users, and none of this is there.
import { fromResponseBody } from '@parallelworks/problem';
import { basePath } from '@/lib/base';

const BASE = `${basePath}/auth`;

export interface Account {
  id: string;
  email: string;
  name: string;
}

export interface Membership {
  id: string;
  key: string;
  name: string;
  admin: boolean;
}

export interface AccountSession {
  account: Account;
  workspaces: Membership[];
  /** The key of the workspace the session is looking at. */
  workspace: string;
}

export interface Invite {
  id: string;
  email: string;
  admin: boolean;
  expiresAt: string;
}

/** Calls an accounts endpoint; a refusal is thrown as the app's own API error. */
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) throw fromResponseBody(json, res.status);
  return json as T;
}

export const accounts = {
  /** The signed-in session, or what a signed-out browser may know. */
  async session(): Promise<{ session: AccountSession | null; sso: boolean; available: boolean }> {
    const res = await fetch(`${BASE}/session`, { headers: { Accept: 'application/json' } });
    if (res.status === 404) return { session: null, sso: false, available: false };
    const json = (await res.json().catch(() => null)) as
      | (Partial<AccountSession> & { methods?: { sso: boolean } })
      | null;
    // Signed out, the answer has no account: only how to sign in.
    if (res.ok && json?.account) return { session: json as AccountSession, sso: false, available: true };
    return { session: null, sso: !!json?.methods?.sso, available: true };
  },
  login: (email: string, password: string) => call<void>('POST', '/login', { email, password }),
  switchWorkspace: (workspace: string) => call<void>('POST', '/workspace', { workspace }),
  invitation: (token: string) =>
    call<{ email: string; workspace: string; hasAccount: boolean }>(
      'GET',
      `/invite?token=${encodeURIComponent(token)}`,
    ),
  acceptInvite: (token: string, name: string, password: string) =>
    call<void>('POST', '/invite/accept', { token, name, password }),
  forgotPassword: (email: string) => call<void>('POST', '/password/forgot', { email }),
  resetPassword: (token: string, password: string) => call<void>('POST', '/password/reset', { token, password }),
  changePassword: (current: string, password: string) => call<void>('POST', '/password/change', { current, password }),
  invites: async () => (await call<{ invites: Invite[] }>('GET', '/invites')).invites,
  invite: (email: string, admin: boolean) =>
    call<{ id: string; email: string; link: string }>('POST', '/invites', { email, admin }),
  revokeInvite: (id: string) => call<void>('DELETE', `/invites/${id}`),
  ssoUrl: (next: string) => `${BASE}/oidc/login?next=${encodeURIComponent(next)}`,
};

/** A return path that stays on this site. */
export function safeNext(next: string | undefined): string {
  return next?.startsWith('/') && !next.startsWith('//') ? next : `${basePath}/`;
}
