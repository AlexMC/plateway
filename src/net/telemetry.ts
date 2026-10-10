/**
 * Anonymous usage counts and error reports (docs: site/legal/privacy.html). The service keeps only per-day totals: no
 * cookie, id or address goes with them, and nothing here is stored in the browser.
 *
 * - `track(name)` counts a feature used: each name at most once per page load, so a day's count reads "page loads that
 *   used it". Names wait and go together in one beacon when the page hides, or after `BATCH_DELAY`.
 * - `reportError` (and `installErrorReporter`, for uncaught errors and rejections) sends an error's message, where it
 *   was thrown (`/app/assets/index-….js:12:34`, or a component's name) and the build, each one once, at most five.
 *
 * Only the built app sends, and never with Do Not Track on. Sending never blocks and never throws.
 */
import { apiUrl } from './api';

declare const __BUILD_ID__: string;
/** This build: the git commit it was built from, or its build time (vite.config.ts). */
export const BUILD_ID: string = __BUILD_ID__;

/** The names the service counts (cad/service/usage.py `EVENTS`); it ignores any other. */
export const EVENTS = [
  'app_open', 'start_example', 'start_describe', 'start_hand', 'describe_run', 'test_drive', 'print_open', 'prepare_request',
  'gallery_open', 'gallery_layout_open', 'remix', 'contribute_open', 'community_item_placed', 'signup_open', 'signin_open',
  'feedback_open'
] as const;
export type UsageEvent = typeof EVENTS[number];

const KNOWN = new Set<string>(EVENTS);
/** The longest a counted name waits for the page to hide. */
const BATCH_DELAY = 15_000;
/** The service takes at most this many names per request. */
const MAX_BATCH = 20;
const MAX_ERRORS = 5;

const sending = () => import.meta.env.PROD && navigator.doNotTrack !== '1';

/** A beacon (it outlives the page, and can carry only text, which the service reads as JSON); without one, a
 * cookieless keepalive fetch. Failures are dropped. */
function post(path: string, payload: unknown) {
  const url = apiUrl(path), body = JSON.stringify(payload);
  try { if (navigator.sendBeacon(url, body)) return; } catch { /* no beacon here: fetch instead */ }
  try {
    fetch(url, { method: 'POST', body, keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'application/json' } })
      .catch(() => {});
  } catch { /* the count is lost, never the app's problem */ }
}

const counted = new Set<string>();
let waiting: string[] = [];
let timer: number | undefined;
let listening = false;

function flush() {
  window.clearTimeout(timer);
  timer = undefined;
  if (!waiting.length) return;
  const events = waiting;
  waiting = [];
  post('events', { events });
}

/** Count `name` for this page load; again in the same page load counts nothing. */
export function track(name: UsageEvent): void {
  if (!KNOWN.has(name) || counted.has(name) || !sending()) return;
  counted.add(name);
  waiting.push(name);
  if (!listening) {
    listening = true;
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  }
  if (waiting.length >= MAX_BATCH) flush();
  else timer ??= window.setTimeout(flush, BATCH_DELAY);
}

/** A script's path, line and column: no origin, query or hash. A frame with no address (`<anonymous>`) stays as it is. */
function location(url: string, line: number | string, column: number | string): string {
  let path = url.replace(/[?#].*/, '');
  if (/^[a-z][\w+.-]*:/i.test(url)) try { path = new URL(url).pathname; } catch { /* not a URL: keep it as it is */ }
  return `${path}:${line}:${column}`;
}

/** Where `error` was thrown: its stack's first frame (`at f (url:1:2)` in Chromium, `f@url:1:2` elsewhere); '' unknown. */
function thrownAt(error: unknown): string {
  if (!(error instanceof Error) || !error.stack) return '';
  for (const line of error.stack.split('\n')) {
    const frame = /(\S+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (frame) return location(frame[1].replace(/^\(/, '').replace(/^[^\s@]*@(?=[a-z][\w+.-]*:)/i, ''), frame[2], frame[3]);
  }
  return '';
}

const reported = new Set<string>();

/** Report `error` once per page load, at most `MAX_ERRORS` in all, at its stack's first frame; `otherwise` (a script
 * position, a component's name) when it has none. */
export function reportError(error: unknown, otherwise = ''): void {
  try {
    if (reported.size >= MAX_ERRORS || !sending()) return;
    const text = error instanceof Error ? error.message : String(error);
    const message = text.replaceAll(window.location.origin, '').slice(0, 300), at = (thrownAt(error) || otherwise).slice(0, 200);
    const key = JSON.stringify([message, at]);
    if (reported.has(key)) return;
    reported.add(key);
    post('client-errors', { message, where: at, version: BUILD_ID.slice(0, 40) });
  } catch { /* reporting an error never raises another */ }
}

/** Report uncaught errors and unhandled rejections; returns the removal. */
export function installErrorReporter(): () => void {
  const failed = (event: ErrorEvent) => reportError(event.error ?? event.message,
    event.filename ? location(event.filename, event.lineno, event.colno) : '');
  const rejected = (event: PromiseRejectionEvent) => reportError(event.reason);
  window.addEventListener('error', failed);
  window.addEventListener('unhandledrejection', rejected);
  return () => {
    window.removeEventListener('error', failed);
    window.removeEventListener('unhandledrejection', rejected);
  };
}
