import { useEffect, useState } from 'react';
import { ApiError, apiFetch } from '../net/api';
import { BUILD_ID, track } from '../net/telemetry';
import './feedback.css';

/** The service's limits (cad/service/feedback.py). */
export const MESSAGE_MIN = 10, MESSAGE_MAX = 4000;

/** Feedback to the admins (`POST /api/feedback`), from anyone: a signed-in member's carries the session's CSRF token, as
 * every member request does. `view` names where the app is (the step, and an open gallery or contribute page). */
export function FeedbackDialog({ view, onClose }: { view: string; onClose: () => void }) {
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  useEffect(() => { track('feedback_open'); }, []);

  async function send() {
    if (busy) return;
    if (message.trim().length < MESSAGE_MIN) { setError(`Write at least ${MESSAGE_MIN} characters.`); return; }
    setBusy(true); setError('');
    try {
      await apiFetch('feedback', { json: { message: message.trim(), email: email.trim(), page: view, version: BUILD_ID },
        fallback: 'Could not send the feedback. Try again.' });
      setSent(true);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : 'Could not send the feedback. Try again.');
    } finally { setBusy(false); }
  }

  const heading = <div className="dialog-heading"><h2>Send feedback</h2><button type="button" aria-label="Close" onClick={onClose}>×</button></div>;
  return <div className="dialog-backdrop" onClick={onClose}>
    {sent ? <div className="saved-dialog save-dialog feedback-dialog" role="dialog" aria-modal="true" aria-label="Send feedback"
      onClick={event => event.stopPropagation()}>
      {heading}
      <p className="feedback-text" role="status">Thanks, it’s sent. We read every message{email.trim() ? ' and reply to the address you gave' : ''}.</p>
      <div className="save-actions"><button type="button" className="primary-button" autoFocus onClick={onClose}>Close</button></div>
    </div> :
      <form className="saved-dialog save-dialog feedback-dialog" role="dialog" aria-modal="true" aria-label="Send feedback"
        onClick={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); void send(); }}>
        {heading}
        <p className="feedback-text">Something broke, confused you or is missing? Tell us.</p>
        <label className="save-name">Your feedback
          <textarea value={message} autoFocus rows={6} maxLength={MESSAGE_MAX} onChange={event => setMessage(event.target.value)} /></label>
        <label className="save-name feedback-email">Email (optional)
          <input type="email" value={email} autoComplete="email" maxLength={254} onChange={event => setEmail(event.target.value)} /></label>
        <p className="save-hint">Only if you want a reply. Sent with your feedback: the view you are on ({view}) and the app
          version ({BUILD_ID}).</p>
        {error && <p className="feedback-error" role="alert">{error}</p>}
        <div className="save-actions">
          <button type="button" className="quiet-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={busy}>{busy ? 'Sending…' : 'Send'}</button></div>
      </form>}
  </div>;
}
