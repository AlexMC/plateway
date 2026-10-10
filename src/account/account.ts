import { ApiError, apiFetch, apiJson, apiUrl, setCsrf } from '../net/api';
import { forgetKey } from '../plan/assist';

/** The signed-in member as the service describes them; `purgeAt` (ISO time) is set until the email is verified. */
export type Member = { id: string; email: string; displayName: string; verified: boolean; purgeAt: string | null };
/** `connecting` until the service first answers; `offline` while it does not; visitors design freely (R1). */
export type Account =
  | { status: 'connecting' }
  | { status: 'offline' }
  | { status: 'visitor' }
  | { status: 'member'; member: Member };
export const VISITOR: Account = { status: 'visitor' };
/** The service answers: what visitors may use (shopping list, print presets) works. */
export function serviceOnline(account: Account): boolean {
  return account.status === 'member' || account.status === 'visitor';
}
export const ACCOUNT_EXPORT_URL = apiUrl('account/export');
/** The landing site's legal pages: the site is served at `/`, the app at `/app/`. */
export const PRIVACY_URL = '/legal/privacy.html', TERMS_URL = '/legal/terms.html';
export const PASSWORD_MIN = 8, PASSWORD_MAX = 128;

type SignedIn = { user: Member; csrf: string };

function member(reply: SignedIn): Account {
  setCsrf(reply.csrf);
  return { status: 'member', member: reply.user };
}

/** The account behind this browser's session cookie, if any. */
export async function loadAccount(): Promise<Account> {
  try { return member(await apiJson<SignedIn>('auth/me', { authenticating: true })); }
  catch (error) {
    setCsrf('');
    return error instanceof ApiError && error.status === 401 ? VISITOR : { status: 'offline' };
  }
}

export async function signUp(email: string, password: string, displayName: string): Promise<void> {
  await apiFetch('auth/signup', { json: { email, password, displayName }, fallback: 'Could not create the account.' });
}

export async function signIn(email: string, password: string): Promise<Account> {
  return member(await apiJson<SignedIn>('auth/login', { json: { email, password }, authenticating: true, fallback: 'Could not sign in.' }));
}

/** Ends the session on the service, which also clears this site's stored data (`Clear-Site-Data: "storage"`); the
 * Anthropic key goes here too, so it never outlives the session even where that header is not honoured. */
export async function signOut(): Promise<void> {
  await apiFetch('auth/logout', { method: 'POST', authenticating: true, fallback: 'Could not sign out.' });
  setCsrf('');
  forgetKey();
}

/** Verifies the email a link was sent to. The service signs in only a browser already signed in as that member (the
 * fresh account), never one that just holds the link: null when the link verified but left the session as it was. */
export async function verifyEmail(token: string): Promise<Account | null> {
  const reply = await apiJson<{ signedIn: false } | SignedIn & { signedIn: true }>('auth/verify-email',
    { json: { token }, authenticating: true, fallback: 'Could not verify the email.' });
  return reply.signedIn ? member(reply) : null;
}

export async function resendVerification(): Promise<void> {
  await apiFetch('auth/resend-verification', { method: 'POST', fallback: 'Could not send a new link.' });
}

export async function forgotPassword(email: string): Promise<void> {
  await apiFetch('auth/password/forgot', { json: { email }, fallback: 'Could not send the link.' });
}

export async function resetPassword(token: string, password: string): Promise<Account> {
  return member(await apiJson<SignedIn>('auth/password/reset', { json: { token, password }, authenticating: true,
    fallback: 'Could not change the password.' }));
}

export async function renameAccount(displayName: string): Promise<Member> {
  return (await apiJson<SignedIn>('account', { method: 'PATCH', json: { displayName }, fallback: 'Could not change the display name.' })).user;
}

/** Needs the current password (KTD3); the service also clears this site's stored data, the Anthropic key with it. */
export async function deleteAccount(password: string): Promise<void> {
  await apiFetch('account', { method: 'DELETE', json: { password }, fallback: 'Could not delete the account.' });
  setCsrf('');
  forgetKey();
}

/** The service's rule (`cad/service/accounts.py`): 3–30 characters, starting and ending with a letter or digit. */
const DISPLAY_NAME = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}_ .'-]{1,28}[\p{L}\p{N}]$/u;
export const DISPLAY_NAME_RULE = 'Use a display name of 3 to 30 letters, digits, spaces, dots, dashes or underscores.';
export function displayNameProblem(name: string): string | null {
  return DISPLAY_NAME.test(name.trim()) ? null : DISPLAY_NAME_RULE;
}

/** "31 October 2026": the day an unverified account is deleted, in the visitor's own time zone. */
export function purgeDate(purgeAt: string): string {
  return new Date(purgeAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

export type EmailLink = { kind: 'verify' | 'reset'; token: string };

/** An account email's link (`/app/#verify=…`, `/app/#reset=…`), taken out of the address bar so the token
 * stays out of history; the page then sits at the app's root. */
export function takeEmailLink(): EmailLink | null {
  const match = /^#(verify|reset)=([\w-]+)$/.exec(window.location.hash);
  if (!match) return null;
  window.history.replaceState(null, '', import.meta.env.BASE_URL);
  return { kind: match[1] as EmailLink['kind'], token: match[2] };
}
