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
  /** It is entered only through its own single sign-on. */
  ssoRequired: boolean;
}

export interface AccountSession {
  account: Account;
  workspaces: Membership[];
  /** The key of the workspace the session is looking at. */
  workspace: string;
  /** It came in through one workspace's single sign-on: it sees that workspace only, and can't change how the account signs in. */
  limited: boolean;
}

/** What signing in with a password, a reset or an invitation answers: done, or a second step is owed. */
export interface Entered {
  secondStep: boolean;
  /** The account also has a passkey, which would do instead of a code. */
  passkey: boolean;
}

export interface Passkey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface Security {
  totp: boolean;
  recoveryCodes: number;
  password: boolean;
  passkeys: Passkey[];
}

export interface SSOSettings {
  configured: boolean;
  redirectUrl: string;
  /** Goes straight to the workspace's provider. */
  loginUrl: string;
  issuer?: string;
  clientId?: string;
  required?: boolean;
  autoJoin?: boolean;
}

const entered = (out: Partial<Entered> | undefined): Entered => ({
  secondStep: !!out?.secondStep,
  passkey: !!out?.passkey,
});

// --- Passkeys: the browser speaks in bytes, the server in base64url. ---

const toBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const toText = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

type Described = { id: string; type: 'public-key'; transports?: AuthenticatorTransport[] };
const described = (list?: Described[]) => list?.map((c) => ({ ...c, id: toBytes(c.id) }));

interface CreationJSON extends Omit<PublicKeyCredentialCreationOptions, 'challenge' | 'user' | 'excludeCredentials'> {
  challenge: string;
  user: { id: string; name: string; displayName: string };
  excludeCredentials?: Described[];
}
interface RequestJSON extends Omit<PublicKeyCredentialRequestOptions, 'challenge' | 'allowCredentials'> {
  challenge: string;
  allowCredentials?: Described[];
}

async function createPasskey(options: CreationJSON): Promise<unknown> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: toBytes(options.challenge),
      user: { ...options.user, id: toBytes(options.user.id) },
      excludeCredentials: described(options.excludeCredentials),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('no passkey was made');
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: toText(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    response: {
      clientDataJSON: toText(response.clientDataJSON),
      attestationObject: toText(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}

async function assertPasskey(options: RequestJSON): Promise<unknown> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: toBytes(options.challenge),
      allowCredentials: described(options.allowCredentials),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('no passkey was chosen');
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: toText(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    response: {
      clientDataJSON: toText(response.clientDataJSON),
      authenticatorData: toText(response.authenticatorData),
      signature: toText(response.signature),
      userHandle: response.userHandle ? toText(response.userHandle) : undefined,
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}

/** Whether this browser can make and use passkeys. */
export const passkeysSupported = () => typeof window.PublicKeyCredential === 'function';

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
  /** How an address signs in: its workspaces' single sign-on, and whether a password will do. */
  start: (email: string) =>
    call<{ sso: { workspace: string; name: string }[]; password: boolean }>('POST', '/login/start', { email }),
  login: async (email: string, password: string) =>
    entered(await call<Partial<Entered> | undefined>('POST', '/login', { email, password })),
  /** The second step: a code from the authenticator, or a recovery code. */
  second: (code: { code: string } | { recovery: string }) => call<void>('POST', '/login/second', code),
  /** Signs in with a passkey: the browser asks which, and the passkey says whose it is. */
  async passkeyLogin(): Promise<void> {
    const options = await call<{ publicKey: RequestJSON }>('POST', '/passkeys/login/begin', {});
    await call<void>('POST', '/passkeys/login/finish', await assertPasskey(options.publicKey));
  },
  security: () => call<Security>('GET', '/security'),
  totpSetup: (password: string) => call<{ secret: string; uri: string }>('POST', '/totp/setup', { password }),
  totpConfirm: async (code: string) =>
    (await call<{ recoveryCodes: string[] }>('POST', '/totp/confirm', { code })).recoveryCodes,
  totpDisable: (password: string) => call<void>('POST', '/totp/disable', { password }),
  renewRecoveryCodes: async (password: string) =>
    (await call<{ recoveryCodes: string[] }>('POST', '/recovery-codes', { password })).recoveryCodes,
  async addPasskey(password: string, name: string): Promise<Passkey> {
    const options = await call<{ publicKey: CreationJSON }>('POST', '/passkeys/register/begin', { password });
    const credential = await createPasskey(options.publicKey);
    return call<Passkey>('POST', '/passkeys/register/finish', { name, credential });
  },
  removePasskey: (id: string) => call<void>('DELETE', `/passkeys/${id}`),
  sso: () => call<SSOSettings>('GET', '/sso'),
  saveSSO: (settings: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    required: boolean;
    autoJoin: boolean;
  }) => call<void>('PUT', '/sso', settings),
  removeSSO: () => call<void>('DELETE', '/sso'),
  workspaceSSOUrl: (workspace: string, next: string) =>
    `${BASE}/sso/login?workspace=${encodeURIComponent(workspace)}&next=${encodeURIComponent(next)}`,
  switchWorkspace: (workspace: string) => call<void>('POST', '/workspace', { workspace }),
  invitation: (token: string) =>
    call<{ email: string; workspace: string; hasAccount: boolean }>(
      'GET',
      `/invite?token=${encodeURIComponent(token)}`,
    ),
  acceptInvite: async (token: string, name: string, password: string) =>
    entered(await call<Partial<Entered> | undefined>('POST', '/invite/accept', { token, name, password })),
  forgotPassword: (email: string) => call<void>('POST', '/password/forgot', { email }),
  resetPassword: async (token: string, password: string) =>
    entered(await call<Partial<Entered> | undefined>('POST', '/password/reset', { token, password })),
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
