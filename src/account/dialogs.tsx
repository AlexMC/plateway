import { useState, type FormEvent, type ReactNode } from 'react';
import {
  ACCOUNT_EXPORT_URL, PASSWORD_MAX, PASSWORD_MIN, PRIVACY_URL, TERMS_URL, deleteAccount, displayNameProblem, forgotPassword, purgeDate,
  renameAccount, resendVerification, resetPassword, signIn, signUp, type Account, type Member
} from './account';
import './account.css';

export type AuthMode = 'sign-in' | 'sign-up' | 'check-email' | 'forgot' | 'forgot-sent' | 'reset' | 'verified';
/** `reason`: why the dialog opened (the action that needs an account); `email`: where a link went; `token`: a reset link's. */
export type AuthRequest = { mode: AuthMode; reason?: string; email?: string; token?: string };

const TITLES: Record<AuthMode, string> = {
  'sign-in': 'Sign in', 'sign-up': 'Create an account', 'check-email': 'Check your email', forgot: 'Reset your password',
  'forgot-sent': 'Check your email', reset: 'Choose a new password', verified: 'Email verified'
};
const PASSWORD_RULE = `Use a password of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`;
/** After every "we sent you an email": account emails can land in spam. */
const SPAM_HINT = 'Can’t find it? Check your spam folder.';

const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

function Dialog({ label, onClose, onSubmit, children }: {
  label: string; onClose: () => void; onSubmit?: (event: FormEvent) => void; children: ReactNode;
}) {
  const body = <>
    <div className="dialog-heading"><h2>{label}</h2><button type="button" aria-label="Close" onClick={onClose}>×</button></div>
    {children}
  </>;
  return <div className="dialog-backdrop" onClick={onClose}>
    {onSubmit ? <form className="saved-dialog save-dialog account-dialog" role="dialog" aria-modal="true" aria-label={label}
      onClick={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); onSubmit(event); }}>{body}</form> :
      <div className="saved-dialog save-dialog account-dialog" role="dialog" aria-modal="true" aria-label={label}
        onClick={event => event.stopPropagation()}>{body}</div>}
  </div>;
}

function Field({ label, type = 'text', value, onChange, autoComplete, autoFocus, maxLength }: {
  label: string; type?: string; value: string; onChange: (value: string) => void; autoComplete?: string; autoFocus?: boolean; maxLength?: number;
}) {
  return <label className="save-name">{label}<input type={type} value={value} autoComplete={autoComplete} autoFocus={autoFocus}
    maxLength={maxLength} onChange={event => onChange(event.target.value)} /></label>;
}

const Problem = ({ text }: { text: string }) => text ? <p className="account-error" role="alert">{text}</p> : null;
/** A legal page opens in a new tab, so an open dialog and the draft stay as they are. */
const LegalLink = ({ href, children }: { href: string; children: ReactNode }) => <a href={href} target="_blank" rel="noopener">{children}</a>;

/** Sign in, sign up, "check your email", forgot and reset password, and "Email verified". */
export function AuthDialog({ request, onChange, onClose, onSignedIn }: {
  request: AuthRequest; onChange: (next: AuthRequest) => void; onClose: () => void;
  /** A session started (sign-in or a password reset); `note` says what happened. */
  onSignedIn: (account: Account, note: string) => void;
}) {
  const [email, setEmail] = useState(request.email ?? '');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { mode } = request;
  const go = (next: AuthRequest) => { setError(''); setPassword(''); onChange({ reason: request.reason, ...next }); };

  async function submit() {
    if (busy) return;
    if (mode === 'sign-up') {
      const problem = displayNameProblem(name);
      if (problem) { setError(problem); return; }
    }
    if ((mode === 'sign-up' || mode === 'reset') && (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX)) { setError(PASSWORD_RULE); return; }
    setBusy(true); setError('');
    try {
      if (mode === 'sign-in') onSignedIn(await signIn(email.trim(), password), 'Signed in.');
      else if (mode === 'sign-up') { await signUp(email.trim(), password, name.trim()); go({ mode: 'check-email', email: email.trim() }); }
      else if (mode === 'forgot') { await forgotPassword(email.trim()); go({ mode: 'forgot-sent', email: email.trim() }); }
      else if (mode === 'reset' && request.token) onSignedIn(await resetPassword(request.token, password), 'Password changed. You’re signed in.');
    } catch (failure) { setError(message(failure, 'Something went wrong. Try again.')); }
    finally { setBusy(false); }
  }

  const reason = request.reason && (mode === 'sign-in' || mode === 'sign-up') && <p className="save-hint account-reason">{request.reason}</p>;
  const link = (label: string, next: AuthRequest) => <button type="button" className="account-link" onClick={() => go(next)}>{label}</button>;
  const actions = (label: string) => <div className="save-actions">
    <button type="button" className="quiet-button" onClick={onClose}>Cancel</button>
    <button type="submit" className="primary-button" disabled={busy}>{label}</button></div>;

  if (mode === 'check-email' || mode === 'forgot-sent' || mode === 'verified') {
    return <Dialog label={TITLES[mode]} onClose={onClose}>
      {mode === 'check-email' ? <p className="account-text">We sent a link to <strong>{request.email}</strong>. Open it within 24 hours
        to verify your email. Your work stays in this browser meanwhile. {SPAM_HINT}</p> :
        mode === 'forgot-sent' ? <p className="account-text">If an account uses <strong>{request.email}</strong>, we sent it a link to
          choose a new password. The link works for an hour. {SPAM_HINT}</p> :
        <p className="account-text">Your account is ready: save projects and prepare plates.</p>}
      <div className="save-actions">
        {mode === 'check-email' && link('Sign in', { mode: 'sign-in', email: request.email })}
        <button type="button" className="primary-button" autoFocus onClick={onClose}>{mode === 'verified' ? 'Continue' : 'OK'}</button></div>
    </Dialog>;
  }
  return <Dialog label={TITLES[mode]} onClose={onClose} onSubmit={() => void submit()}>
    {reason}
    <div className="account-fields">
      {mode === 'sign-up' && <Field label="Display name" value={name} onChange={setName} autoComplete="nickname" autoFocus maxLength={30} />}
      {mode !== 'reset' && <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" autoFocus={mode !== 'sign-up'} />}
      {mode !== 'forgot' && <Field label={mode === 'reset' ? 'New password' : 'Password'} type="password" value={password} onChange={setPassword}
        autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'} autoFocus={mode === 'reset'} maxLength={PASSWORD_MAX} />}
    </div>
    {mode === 'sign-up' && <p className="save-hint">Your display name appears on anything you share. {PASSWORD_RULE}</p>}
    {mode === 'sign-up' && <p className="account-legal">By creating an account you accept the <LegalLink href={TERMS_URL}>terms</LegalLink> and
      the <LegalLink href={PRIVACY_URL}>privacy policy</LegalLink>.</p>}
    <Problem text={error} />
    {mode === 'sign-in' && <p className="account-links">{link('Forgot password?', { mode: 'forgot', email })}{link('Create an account', { mode: 'sign-up', email })}</p>}
    {mode === 'sign-up' && <p className="account-links">{link('I have an account — sign in', { mode: 'sign-in', email })}</p>}
    {mode === 'forgot' && <p className="account-links">{link('Back to sign in', { mode: 'sign-in', email })}</p>}
    {actions(mode === 'sign-in' ? 'Sign in' : mode === 'sign-up' ? 'Create account' : mode === 'forgot' ? 'Send link' : 'Change password')}
  </Dialog>;
}

/** Display name, data export, sign out and account deletion (R4, R25). */
export function AccountDialog({ member, onClose, onRenamed, onSignOut, onDeleted }: {
  member: Member; onClose: () => void; onRenamed: (member: Member) => void; onSignOut: () => void; onDeleted: () => void;
}) {
  const [name, setName] = useState(member.displayName);
  const [nameError, setNameError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [busy, setBusy] = useState(false);
  const confirmed = password.length > 0 && confirm === member.displayName;

  async function rename() {
    const problem = displayNameProblem(name);
    if (problem) { setNameError(problem); return; }
    if (name.trim() === member.displayName) return;
    setBusy(true); setNameError('');
    try { onRenamed(await renameAccount(name.trim())); }
    catch (failure) { setNameError(message(failure, 'Could not change the display name.')); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!confirmed || busy) return;
    setBusy(true); setDeleteError('');
    try { await deleteAccount(password); onDeleted(); }
    catch (failure) { setDeleteError(message(failure, 'Could not delete the account.')); }
    finally { setBusy(false); }
  }

  return <Dialog label="Your account" onClose={onClose}>
    <p className="account-text">Signed in as <strong>{member.email}</strong>.</p>
    <form className="account-section" aria-label="Display name" onSubmit={event => { event.preventDefault(); void rename(); }}>
      <div className="account-inline">
        <Field label="Display name" value={name} onChange={value => { setName(value); setNameError(''); }} maxLength={30} />
        <button type="submit" className="quiet-button" disabled={busy || name.trim() === member.displayName}>Save name</button>
      </div>
      <p className="save-hint">Shown on anything you share; credits keep the name you had when you shared.</p>
      <Problem text={nameError} />
    </form>
    <div className="account-section account-actions">
      <a className="quiet-button" href={ACCOUNT_EXPORT_URL} download="plateway-export.zip">Export my data</a>
      <button type="button" className="quiet-button" onClick={onSignOut}>Sign out</button>
    </div>
    {!deleting ? <div className="account-section"><button type="button" className="account-link account-danger-link" onClick={() => setDeleting(true)}>Delete account…</button></div> :
      <form className="account-section account-danger" aria-label="Delete account" onSubmit={event => { event.preventDefault(); void remove(); }}>
        <h3>Delete account</h3>
        <p className="save-hint">This deletes your account and its data on the service. It cannot be undone.</p>
        <div className="account-fields">
          <Field label="Current password" type="password" value={password} onChange={setPassword} autoComplete="current-password" autoFocus />
          <Field label={`Type ${member.displayName} to confirm`} value={confirm} onChange={setConfirm} />
        </div>
        <Problem text={deleteError} />
        <div className="save-actions">
          <button type="button" className="quiet-button" onClick={() => { setDeleting(false); setPassword(''); setConfirm(''); setDeleteError(''); }}>Cancel</button>
          <button type="submit" className="account-delete" disabled={!confirmed || busy}>Delete account</button></div>
      </form>}
    <p className="account-legal account-section"><LegalLink href={PRIVACY_URL}>Privacy policy</LegalLink> · <LegalLink href={TERMS_URL}>Terms</LegalLink></p>
  </Dialog>;
}

/** Asked when signing out with unsaved changes: signing out clears this browser's copy. */
export function SignOutDialog({ busy, onSave, onDiscard, onCancel }: {
  busy: boolean; onSave: () => void; onDiscard: () => void; onCancel: () => void;
}) {
  return <Dialog label="Save before signing out?" onClose={onCancel}>
    <p className="account-text">This project has unsaved changes. Signing out clears this browser’s copy of your work.</p>
    <div className="save-actions">
      <button type="button" className="quiet-button" onClick={onCancel}>Cancel</button>
      <button type="button" className="quiet-button" disabled={busy} onClick={onDiscard}>Sign out without saving</button>
      <button type="button" className="primary-button" disabled={busy} autoFocus onClick={onSave}>Save and sign out</button></div>
  </Dialog>;
}

/** Shown to an unverified member until they verify (or the account is purged). */
export function VerifyBanner({ member }: { member: Member }) {
  const [state, setState] = useState<{ busy: boolean; note: string }>({ busy: false, note: '' });
  async function resend() {
    setState({ busy: true, note: '' });
    try { await resendVerification(); setState({ busy: false, note: `We sent a new link to ${member.email}. ${SPAM_HINT}` }); }
    catch (failure) { setState({ busy: false, note: message(failure, 'Could not send a new link.') }); }
  }
  return <div className="verify-banner" role="region" aria-label="Verify your email">
    <span><strong>Verify your email</strong> with the link we sent to {member.email}.
      {member.purgeAt && <> Unverified accounts and their projects are deleted on {purgeDate(member.purgeAt)}.</>}</span>
    {state.note && <span className="verify-note" role="status">{state.note}</span>}
    <button type="button" className="quiet-button" disabled={state.busy} onClick={() => void resend()}>Resend</button>
  </div>;
}
