// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BUILD_ID, track } from '../src/net/telemetry';
import type * as Telemetry from '../src/net/telemetry';
import { ADA, CSRF, button, click, dialog, field, open, seedDraft, service, signedIn, signedOut, submit, type,
  workspaceHooks } from './workspace-harness';

vi.mock('../src/net/telemetry', async original => ({ ...await original<typeof Telemetry>(), track: vi.fn() }));

workspaceHooks();

async function write(area: HTMLTextAreaElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Opens the Feedback dialog from the header. */
async function openFeedback(host: HTMLElement) {
  await click(button(host, 'Feedback'));
  const form = dialog('Send feedback')!;
  expect(form).not.toBeNull();
  return { form, message: form.querySelector('textarea')!, email: field(form, 'Email (optional)') };
}

describe('the Feedback dialog', { timeout: 30_000 }, () => {
  it('opens from the header, sends the message, email, view and version, then thanks the sender', async () => {
    const calls = service({ 'GET /api/auth/me': signedOut, 'POST /api/feedback': () => ({ status: 202, body: { status: 'sent' } }) });
    const host = await open();
    const { form, message, email } = await openFeedback(host);
    expect(track).toHaveBeenCalledWith('feedback_open');
    expect(form.textContent).toContain('Only if you want a reply.');
    expect(form.textContent).toContain(BUILD_ID);
    expect(form.textContent).toContain('(Build track)');
    await write(message, '  The turntable piece will not rotate.  ');
    await type(email, 'tester@example.org');
    await submit(form);
    const sent = calls.find(call => call.method === 'POST' && call.path === '/api/feedback')!;
    expect(sent.body).toEqual({ message: 'The turntable piece will not rotate.', email: 'tester@example.org', page: 'Build track', version: BUILD_ID });
    expect(sent.headers['X-Workshop-Session']).toBeUndefined();
    expect(dialog('Send feedback')!.textContent).toContain('Thanks');
    expect(dialog('Send feedback')!.querySelector('textarea')).toBeNull();
    await click(button(dialog('Send feedback')!, 'Close'));
    expect(dialog('Send feedback')).toBeNull();
  });

  it('a signed-in member’s feedback carries the session’s CSRF token', async () => {
    seedDraft(false);
    const calls = service({ 'GET /api/auth/me': signedIn(ADA), 'POST /api/feedback': () => ({ status: 202, body: { status: 'sent' } }) });
    const host = await open();
    const { form, message } = await openFeedback(host);
    await write(message, 'Signed in and sending feedback.');
    await submit(form);
    const sent = calls.find(call => call.path === '/api/feedback')!;
    expect(sent.headers['X-Workshop-Session']).toBe(CSRF);
    expect((sent.body as { email: string }).email).toBe('');
  });

  it('asks for 10 characters before sending anything', async () => {
    const calls = service({ 'GET /api/auth/me': signedOut });
    const host = await open();
    const { form, message } = await openFeedback(host);
    await write(message, ' too short ');
    await submit(form);
    expect(form.querySelector('[role="alert"]')?.textContent).toBe('Write at least 10 characters.');
    expect(calls.some(call => call.path === '/api/feedback')).toBe(false);
  });

  it('shows the service’s reason when it refuses, and keeps what was written', async () => {
    service({ 'GET /api/auth/me': signedOut,
      'POST /api/feedback': () => ({ status: 429, body: { detail: 'You sent a lot of feedback this hour. Try again later.' } }) });
    const host = await open();
    const { form, message } = await openFeedback(host);
    await write(message, 'Feedback that will be refused.');
    await submit(form);
    expect(form.querySelector('[role="alert"]')?.textContent).toBe('You sent a lot of feedback this hour. Try again later.');
    expect(message.value).toBe('Feedback that will be refused.');
    expect(button(form, 'Send')!.disabled).toBe(false);
  });
});

describe('emails the app says it sent', { timeout: 30_000 }, () => {
  const SPAM = 'Can’t find it? Check your spam folder.';

  it('sign-up, password reset and a resent verification link each point at the spam folder', async () => {
    service({ 'GET /api/auth/me': signedOut, 'POST /api/auth/signup': () => ({ status: 202, body: { status: 'check-email' } }),
      'POST /api/auth/password/forgot': () => ({ status: 202, body: { status: 'check-email' } }) });
    const host = await open();
    await click(button(host, 'Sign in'));
    await click(button(dialog('Sign in')!, 'Create an account'));
    const signUp = dialog('Create an account')!;
    await type(field(signUp, 'Display name'), 'Grace');
    await type(field(signUp, 'Email'), 'grace@example.com');
    await type(field(signUp, 'Password'), 'correct horse battery');
    await submit(signUp);
    expect(dialog('Check your email')!.textContent).toContain(SPAM);
    await click(button(dialog('Check your email')!, 'Sign in'));
    await click(button(dialog('Sign in')!, 'Forgot password?'));
    const forgot = dialog('Reset your password')!;
    await type(field(forgot, 'Email'), 'grace@example.com');
    await submit(forgot);
    expect(dialog('Check your email')!.textContent).toContain(SPAM);
  });

  it('the verify banner’s Resend says so too', async () => {
    seedDraft(false);
    service({ 'GET /api/auth/me': signedIn({ ...ADA, verified: false, purgeAt: '2026-10-17T00:00:00Z' }),
      'POST /api/auth/resend-verification': () => ({ status: 202, body: { status: 'check-email' } }) });
    const host = await open();
    await click(button(host.querySelector('.verify-banner')!, 'Resend'));
    expect(host.querySelector('.verify-note')?.textContent).toBe(`We sent a new link to ${ADA.email}. ${SPAM}`);
  });
});
