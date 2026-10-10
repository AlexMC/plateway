// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Beacon = { url: string; body: unknown };
let beacons: Beacon[] = [];

/** A fresh page load: the module's once-per-load memory starts empty, as a built (production) app. Imported dynamically
 * after `resetModules`, since a static import would share one page load across every test. */
async function load(env: { mode?: string; doNotTrack?: string | null } = {}) {
  vi.resetModules();
  vi.stubEnv('MODE', env.mode ?? 'production');
  vi.stubEnv('PROD', (env.mode ?? 'production') === 'production');
  vi.stubEnv('DEV', (env.mode ?? 'production') !== 'production');
  Object.defineProperty(navigator, 'doNotTrack', { value: env.doNotTrack ?? null, configurable: true });
  return await import('../src/net/telemetry');
}

function hidePage() {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
}

const events = () => beacons.filter(beacon => beacon.url === '/api/events').map(beacon => (beacon.body as { events: string[] }).events);
const errors = () => beacons.filter(beacon => beacon.url === '/api/client-errors').map(beacon => beacon.body as Record<string, string>);

function errorWith(message: string, stack: string) {
  const error = new Error(message);
  error.stack = stack;
  return error;
}
const raise = (error: unknown) => window.dispatchEvent(new ErrorEvent('error', { error, message: error instanceof Error ? error.message : String(error) }));
function reject(reason: unknown) {
  const event = new Event('unhandledrejection') as Event & { reason: unknown };
  event.reason = reason;
  window.dispatchEvent(event);
}

beforeEach(() => {
  beacons = [];
  vi.useFakeTimers();
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: (url: string, body: string) => {
    beacons.push({ url, body: JSON.parse(body) });
    return true;
  } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('usage counts', () => {
  it('sends each name once per page load, batched into one beacon when the page hides', async () => {
    const { track } = await load();
    track('app_open'); track('test_drive'); track('app_open'); track('print_open');
    expect(beacons).toEqual([]);
    hidePage();
    expect(events()).toEqual([['app_open', 'test_drive', 'print_open']]);

    // Already counted this page load: nothing new to send.
    track('test_drive');
    hidePage();
    expect(events()).toHaveLength(1);

    // A new name later goes in the next batch, on its own.
    track('remix');
    window.dispatchEvent(new Event('pagehide'));
    expect(events()).toEqual([['app_open', 'test_drive', 'print_open'], ['remix']]);
  });

  it('sends a waiting batch after a while even when the page never hides', async () => {
    const { track } = await load();
    track('gallery_open');
    vi.advanceTimersByTime(14_000);
    track('gallery_layout_open');
    expect(beacons).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(events()).toEqual([['gallery_open', 'gallery_layout_open']]);
  });

  it('never sends a name outside the allowlist', async () => {
    const { track } = await load();
    track('layout_named_after_my_street' as never);
    hidePage();
    expect(beacons).toEqual([]);
    track('signup_open'); track('nope' as never);
    hidePage();
    expect(events()).toEqual([['signup_open']]);
  });

  it('falls back to a cookieless keepalive fetch when the beacon is refused', async () => {
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: () => false });
    const fetched = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetched);
    try {
      const { track } = await load();
      track('describe_run');
      hidePage();
      expect(fetched).toHaveBeenCalledTimes(1);
      const [url, init] = fetched.mock.calls[0];
      expect(url).toBe('/api/events');
      expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'omit' });
      expect(JSON.parse(init!.body as string)).toEqual({ events: ['describe_run'] });
    } finally { vi.unstubAllGlobals(); }
  });

  it('swallows a failing send', async () => {
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: () => { throw new TypeError('blocked'); } });
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')));
    try {
      const { track } = await load();
      track('app_open');
      expect(() => hidePage()).not.toThrow();
      await vi.runAllTimersAsync();
    } finally { vi.unstubAllGlobals(); }
  });

  it('sends nothing with Do Not Track on, nor from tests or the dev server', async () => {
    for (const env of [{ doNotTrack: '1' }, { mode: 'test' }, { mode: 'development' }]) {
      const { track, installErrorReporter } = await load(env);
      const remove = installErrorReporter();
      track('app_open');
      hidePage();
      vi.advanceTimersByTime(60_000);
      raise(new Error('boom'));
      remove();
    }
    expect(beacons).toEqual([]);
  });
});

describe('error reports', () => {
  it('reports where the error was thrown, without the origin, query or hash', async () => {
    const { installErrorReporter, BUILD_ID } = await load();
    const remove = installErrorReporter();
    try {
      raise(errorWith('Cannot read properties of undefined', 'TypeError: Cannot read properties of undefined\n' +
        `    at fit (${location.origin}/app/assets/index-abc123.js?v=2#top:12:345)\n    at render (${location.origin}/app/assets/index-abc123.js:1:2)`));
      // Firefox and Safari write frames as `name@url:line:col`.
      reject(errorWith('Load failed', `load@${location.origin}/app/assets/library-9f.js?token=secret:7:8\n@${location.origin}/app/x.js:1:1`));
      expect(errors()).toEqual([
        { message: 'Cannot read properties of undefined', where: '/app/assets/index-abc123.js:12:345', version: BUILD_ID },
        { message: 'Load failed', where: '/app/assets/library-9f.js:7:8', version: BUILD_ID }
      ]);
      expect(BUILD_ID).toMatch(/\S/);
    } finally { remove(); }
  });

  it('falls back to the event location, and reports a rejection that is not an Error', async () => {
    const { installErrorReporter } = await load();
    const remove = installErrorReporter();
    try {
      window.dispatchEvent(new ErrorEvent('error', { message: 'Script error', filename: `${location.origin}/app/main.js?q=1`, lineno: 3, colno: 9 }));
      reject('quota exceeded');
      // Code with no script address (eval, the console) keeps its frame as the engine wrote it.
      raise(errorWith('boom', 'Error: boom\n    at <anonymous>:1:26'));
      expect(errors().map(({ message, where }) => ({ message, where }))).toEqual([
        { message: 'Script error', where: '/app/main.js:3:9' }, { message: 'quota exceeded', where: '' },
        { message: 'boom', where: '<anonymous>:1:26' }]);
    } finally { remove(); }
  });

  it('truncates long messages and locations to the service limits', async () => {
    const { reportError } = await load();
    reportError(errorWith('x'.repeat(1000), `at f (${location.origin}/${'a'.repeat(500)}.js:1:1)`));
    const [sent] = errors();
    expect(sent.message).toHaveLength(300);
    expect(sent.where.length).toBeLessThanOrEqual(200);
  });

  it('reports each error once per page load, and at most five', async () => {
    const { installErrorReporter } = await load();
    const remove = installErrorReporter();
    try {
      const same = errorWith('again', `at f (${location.origin}/app/a.js:1:1)`);
      raise(same); raise(same); reject(same);
      expect(errors()).toHaveLength(1);
      for (let index = 0; index < 10; index++) raise(errorWith(`error ${index}`, `at f (${location.origin}/app/a.js:${index}:1)`));
      expect(errors()).toHaveLength(5);
      expect(errors().map(error => error.message)).toEqual(['again', 'error 0', 'error 1', 'error 2', 'error 3']);
    } finally { remove(); }
  });
});

describe('error boundary', () => {
  it('reports a render error where it was thrown, else by component name, and shows the reload fallback', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await load();
    // Imported with the page load above, so it reports through that load's telemetry module.
    const { ErrorBoundary } = await import('../src/editor/error-boundary');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A built app's component names are minified, so the thrown position (with the version) is what locates the bug.
    function BrokenTable(): never { throw errorWith('table exploded', `Error: table exploded\n    at qe0 (${location.origin}/app/assets/index-x.js?v=1:40:7)`); }
    function BrokenShelf(): never { throw errorWith('shelf exploded', 'Error: shelf exploded'); }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      for (const broken of [BrokenTable, BrokenShelf]) {
        await act(async () => { root.render(createElement(ErrorBoundary, { key: broken.name, children: createElement(broken) })); });
        expect(host.textContent).toContain('Something went wrong');
        expect(Array.from(host.querySelectorAll('button')).some(button => /reload/i.test(button.textContent ?? ''))).toBe(true);
      }
      expect(errors()).toEqual([expect.objectContaining({ message: 'table exploded', where: '/app/assets/index-x.js:40:7' }),
        expect.objectContaining({ message: 'shelf exploded', where: 'BrokenShelf' })]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      quiet.mockRestore();
    }
  });
});
