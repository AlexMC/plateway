/**
 * The one way the app talks to the service. Requests ride the session cookie; unsafe ones also carry the session's
 * CSRF token in `X-Workshop-Session`. A failed request throws an `ApiError` holding the service's `detail` and reply.
 *
 * The API sits at the site root (`/api/`), beside the app: the app moves under `import.meta.env.BASE_URL` (`/app/`
 * when hosted) but the service's routes do not.
 */
export const API_ROOT = '/api/';
export const SIGNED_OUT = 'Signed out — sign in again';

export class ApiError extends Error {
  /** `status`: the HTTP status, 0 when the service did not answer; `body`: the service's JSON reply, if any (a 409's newer save). */
  constructor(message: string, readonly status: number, readonly body: unknown = null) { super(message); }
}

let csrf = '';
const signedOutListeners = new Set<() => void>();

/** The session's CSRF token, from `me`, sign-in or verification; '' once signed out. */
export function setCsrf(token: string) { csrf = token; }

/** Runs when a call finds the session gone (any 401 outside sign-in itself). */
export function onSignedOut(listener: () => void): () => void {
  signedOutListeners.add(listener);
  return () => { signedOutListeners.delete(listener); };
}

/** `path` is relative to the API root (`projects/<id>`), or a URL this function already built (a receipt's file). */
export function apiUrl(path: string): string {
  return path.startsWith(API_ROOT) ? path : `${API_ROOT}${path}`;
}

export type ApiOptions = {
  method?: string;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as is, as JSON (already serialized). */
  body?: string;
  signal?: AbortSignal;
  /** The message when the service gives no detail. */
  fallback?: string;
  /** A 401 here means wrong credentials, not an ended session (sign-in, verify, reset). */
  authenticating?: boolean;
};

async function reply(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

/** The response when it is OK; otherwise an `ApiError`. A 401 also ends the session in the app. */
export async function apiFetch(path: string, options: ApiOptions = {}): Promise<Response> {
  const method = options.method ?? (options.json !== undefined || options.body !== undefined ? 'POST' : 'GET');
  const headers: Record<string, string> = {};
  if (options.json !== undefined || options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD' && csrf) headers['X-Workshop-Session'] = csrf;
  let response: Response;
  try {
    response = await fetch(apiUrl(path), { method, headers, credentials: 'same-origin', signal: options.signal,
      body: options.json !== undefined ? JSON.stringify(options.json) : options.body });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError('The service did not answer. Check your connection and try again.', 0);
  }
  if (response.ok) return response;
  if (response.status === 401 && !options.authenticating) {
    const wasSignedIn = csrf !== '';
    csrf = '';
    if (wasSignedIn) for (const listener of signedOutListeners) listener();
    throw new ApiError(SIGNED_OUT, 401);
  }
  const body = await reply(response);
  const detail = body && typeof body === 'object' && 'detail' in body && typeof body.detail === 'string' ? body.detail : null;
  throw new ApiError(detail ?? options.fallback ?? `The service returned ${response.status}.`, response.status, body);
}

export async function apiJson<T>(path: string, options: ApiOptions = {}): Promise<T> {
  return await (await apiFetch(path, options)).json() as T;
}
