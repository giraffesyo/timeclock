import { fromResponseBody, problemMiddleware } from '@parallelworks/problem';
import createClient, { type Middleware } from 'openapi-fetch';
import { basePath } from '@/lib/base';
import type { components, paths } from './schema';

export type Schemas = components['schemas'];

export { ApiError } from '@parallelworks/problem';

/** Sends a signed-out browser to sign in, returning to where it is now. */
async function signIn() {
  const res = await fetch(`${basePath}/api/v1/info`).catch(() => null);
  const info = res?.ok ? ((await res.json()) as Schemas['Info']) : null;
  if (!info?.signInUrl) return; // nowhere to sign in: the caller's error says so
  const back = window.location.pathname + window.location.search;
  window.location.assign(info.signInUrl + encodeURIComponent(back));
}

let signingIn = false;

// A session can end while a tab stays open: the next request's 401 sends the
// browser to sign in again.
const signInOn401: Middleware = {
  onResponse({ response }) {
    if (response.status === 401 && !signingIn) {
      signingIn = true;
      void signIn();
    }
    return response;
  },
};

/** The typed API client, generated from the server's OpenAPI document (pnpm gen:api). */
export const api = createClient<paths>({ baseUrl: basePath || '/' });
api.use(problemMiddleware, signInOn401);

/** Returns data, or throws an ApiError built from the problem the API sent. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error === undefined && result.response.ok) {
    return result.data as T;
  }
  throw fromResponseBody(result.error, result.response.status);
}

/** The URL of an API path, for links the browser downloads itself. */
export function apiUrl(path: string, query: Record<string, string | undefined> = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v) params.set(k, v);
  }
  const qs = params.toString();
  return `${basePath}/api/v1${path}${qs ? `?${qs}` : ''}`;
}
