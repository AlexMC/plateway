// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error The landing site's plain-JS module has no type declarations.
import { mountFeedbackForm, sourcePage } from '../site/js/feedback-form.js';

type Call = { url: string; init: RequestInit | undefined };
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** A stand-in for the service: `me` answers the session (401 signed out), `feedback` the send. */
function service({ me = () => new Response('{"detail":"Sign in first"}', { status: 401 }),
  feedback = () => new Response('{"status":"sent"}', { status: 202 }) }: { me?: () => Response; feedback?: () => Response } = {}) {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url === '/api/auth/me') return me();
    if (url === '/api/feedback') return feedback();
    throw new Error(`unexpected ${url}`);
  };
  return { fetcher, calls };
}

/** The page's markup, mounted; `submit` submits the form as a click would, then awaits the send it started. */
function page(fetcher: Fetcher, from = '/') {
  document.body.innerHTML = `<form data-feedback-form>
    <textarea name="message"></textarea><input type="email" name="email"><input name="website">
    <p data-feedback-error hidden></p><button type="submit">Send feedback</button>
  </form><div data-feedback-sent hidden tabindex="-1"></div>`;
  const form = document.querySelector('form')!;
  const mounted = mountFeedbackForm(form, { fetcher, page: from, version: 'site' });
  return {
    form,
    field: (name: string) => form.querySelector(`[name="${name}"]`) as HTMLInputElement,
    error: form.querySelector('[data-feedback-error]') as HTMLElement,
    sent: document.querySelector('[data-feedback-sent]') as HTMLElement,
    button: form.querySelector('button')!,
    async submit() {
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await mounted.sending;
    }
  };
}

const posted = (calls: Call[]) => calls.find(call => call.url === '/api/feedback');

describe('the site feedback form', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('sends the message, the optional email, the page and the version, then thanks the sender', async () => {
    const { fetcher, calls } = service();
    const view = page(fetcher, '/gallery.html');
    view.field('message').value = '  The gallery cards overlap on my phone.  ';
    view.field('email').value = 'tester@example.org';
    await view.submit();
    const send = posted(calls)!;
    expect(send.init?.method).toBe('POST');
    expect(JSON.parse(String(send.init?.body))).toEqual({ message: 'The gallery cards overlap on my phone.', email: 'tester@example.org',
      page: '/gallery.html', version: 'site', website: '' });
    expect(new Headers(send.init?.headers).get('X-Workshop-Session')).toBeNull();
    expect(view.form.hidden).toBe(true);
    expect(view.sent.hidden).toBe(false);
  });

  it('a signed-in member sends the session’s CSRF token, as the app does', async () => {
    const { fetcher, calls } = service({ me: () => Response.json({ user: { id: 'u1' }, csrf: 'token-1' }) });
    const view = page(fetcher);
    view.field('message').value = 'Signed in and writing feedback.';
    await view.submit();
    expect(new Headers(posted(calls)!.init?.headers).get('X-Workshop-Session')).toBe('token-1');
    expect(posted(calls)!.init?.credentials).toBe('same-origin');
  });

  it('asks for 10 characters before sending anything', async () => {
    const { fetcher, calls } = service();
    const view = page(fetcher);
    view.field('message').value = '   too short   ';
    await view.submit();
    expect(calls).toEqual([]);
    expect(view.error.hidden).toBe(false);
    expect(view.error.textContent).toBe('Write at least 10 characters.');
  });

  it('shows the service’s reason when it refuses and keeps what was written', async () => {
    const { fetcher } = service({ feedback: () => Response.json({ detail: 'You sent a lot of feedback this hour. Try again later.' }, { status: 429 }) });
    const view = page(fetcher);
    view.field('message').value = 'Feedback that will be refused.';
    await view.submit();
    expect(view.error.textContent).toBe('You sent a lot of feedback this hour. Try again later.');
    expect(view.form.hidden).toBe(false);
    expect(view.sent.hidden).toBe(true);
    expect(view.field('message').value).toBe('Feedback that will be refused.');
    expect(view.button.disabled).toBe(false);
  });

  it('says so when the service does not answer', async () => {
    const view = page(async () => { throw new TypeError('Failed to fetch'); });
    view.field('message').value = 'Feedback while offline.';
    await view.submit();
    expect(view.error.textContent).toBe('The service did not answer. Check your connection and try again.');
  });

  it('names the site page the sender came from, never another site', () => {
    expect(sourcePage('https://plateway.example/gallery.html?x=1', 'https://plateway.example', '/feedback.html')).toBe('/gallery.html');
    expect(sourcePage('https://elsewhere.example/post/1', 'https://plateway.example', '/feedback.html')).toBe('/feedback.html');
    expect(sourcePage('', 'https://plateway.example', '/feedback.html')).toBe('/feedback.html');
  });
});
