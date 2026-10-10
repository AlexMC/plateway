// The site's feedback form (feedback.html): the same `POST /api/feedback` the app's Feedback dialog sends. A signed-in
// member's request carries the session's CSRF token, as every member POST does; a visitor's needs none.
export const MESSAGE_MIN = 10;
const OFFLINE = 'The service did not answer. Check your connection and try again.';

/** The site page the sender came from (its path), when the referrer is this site; otherwise `fallback`. */
export function sourcePage(referrer, origin, fallback) {
  try {
    const url = new URL(referrer);
    return url.origin === origin ? url.pathname : fallback;
  } catch {
    return fallback;
  }
}

async function csrfToken(fetcher) {
  const response = await fetcher('/api/auth/me', { credentials: 'same-origin' });
  if (!response.ok) return '';
  const body = await response.json().catch(() => null);
  return body && typeof body.csrf === 'string' ? body.csrf : '';
}

/** Wire `form` ([data-feedback-form]: `message`, `email`, the `website` honeypot, [data-feedback-error], a submit
 * button) to send; on success the form hides and [data-feedback-sent] shows. `sending` is the send under way, if any. */
export function mountFeedbackForm(form, { fetcher = fetch, page, version }) {
  const mounted = { sending: null };
  const error = form.querySelector('[data-feedback-error]');
  const button = form.querySelector('button[type="submit"]');
  const sent = document.querySelector('[data-feedback-sent]');
  const field = name => form.elements.namedItem(name);
  const fail = text => { error.textContent = text; error.hidden = false; };

  async function send() {
    const message = field('message').value.trim();
    if (message.length < MESSAGE_MIN) { fail(`Write at least ${MESSAGE_MIN} characters.`); return; }
    error.hidden = true;
    button.disabled = true;
    const label = button.textContent;
    button.textContent = 'Sending…';
    try {
      const csrf = await csrfToken(fetcher);
      const response = await fetcher('/api/feedback', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-Workshop-Session': csrf } : {}) },
        body: JSON.stringify({ message, email: field('email').value.trim(), page, version, website: field('website').value })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        fail(body && typeof body.detail === 'string' ? body.detail : 'Could not send the feedback. Try again.');
        return;
      }
      form.hidden = true;
      sent.hidden = false;
      sent.focus();
    } catch {
      fail(OFFLINE);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (button.disabled) return;
    mounted.sending = send();
  });
  return mounted;
}
