// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ADA, CSRF, DRAFT_KEY, button, click, dialog, draft, field, open, seedDraft, service, settle, signedIn, signedOut, submit, type,
  workspaceHooks, type User } from './workspace-harness';

workspaceHooks();

describe('account UI', { timeout: 30_000 }, () => {
  it('signed out, Save opens sign-up and leaves the draft as it was', async () => {
    const project = seedDraft(true);
    const before = localStorage.getItem(DRAFT_KEY);
    const calls = service({ 'GET /api/auth/me': signedOut });
    const host = await open();
    expect(button(host, 'Sign in')).toBeDefined();
    await click(button(host, 'Save'));
    const signUp = dialog('Create an account')!;
    expect(signUp).not.toBeNull();
    expect(signUp.textContent).toContain('save');
    expect(field(signUp, 'Display name')).toBeDefined();
    // Signing up accepts the terms and privacy policy, which open in a new tab so the draft and the dialog stay.
    const legal = Array.from(signUp.querySelectorAll('a'), link => [link.textContent, link.getAttribute('href'), link.target]);
    expect(legal).toEqual([['terms', '/legal/terms.html', '_blank'], ['privacy policy', '/legal/privacy.html', '_blank']]);
    await click(button(signUp, 'Cancel'));
    expect(dialog('Create an account')).toBeNull();
    expect(localStorage.getItem(DRAFT_KEY)).toBe(before);
    expect(draft().revision).toBe(project.revision);
    expect(calls.some(call => call.path === '/api/projects')).toBe(false);
  });

  it('a 401 from any call says "Signed out — sign in again" and keeps the draft', async () => {
    const project = seedDraft(true);
    service({ 'GET /api/auth/me': signedIn(ADA), [`POST /api/projects/${project.id}/revisions`]: signedOut });
    const host = await open();
    await click(button(host, 'Save'));
    expect(host.querySelector('.inline-notice')?.textContent).toBe('Signed out — sign in again');
    expect(button(host, 'Sign in')).toBeDefined();
    expect(draft()).toMatchObject({ id: project.id, revision: project.revision, name: 'Harbour loop v2' });
  });

  it('the account page checks the display name, then shows the service’s "name taken"', async () => {
    seedDraft(false);
    const calls = service({ 'GET /api/auth/me': signedIn(ADA),
      'PATCH /api/account': () => ({ status: 409, body: { detail: 'That display name is taken.' } }) });
    const host = await open();
    await click(button(host, 'Ada'));
    const page = dialog('Your account')!;
    const name = field(page, 'Display name');
    await type(name, 'a!');
    await submit(page.querySelector('form[aria-label="Display name"]'));
    expect(page.querySelector('[role="alert"]')?.textContent).toBe('Use a display name of 3 to 30 letters, digits, spaces, dots, dashes or underscores.');
    expect(calls.some(call => call.method === 'PATCH')).toBe(false);
    await type(name, 'Grace');
    await submit(page.querySelector('form[aria-label="Display name"]'));
    expect(page.querySelector('[role="alert"]')?.textContent).toBe('That display name is taken.');
    expect(calls.find(call => call.method === 'PATCH')).toMatchObject({ body: { displayName: 'Grace' }, headers: { 'X-Workshop-Session': CSRF } });
  });

  it('deleting the account needs the current password and the display name before it calls the service', async () => {
    seedDraft(false);
    const calls = service({ 'GET /api/auth/me': signedIn(ADA), 'DELETE /api/account': () => ({ body: { status: 'deleted' } }) });
    const host = await open();
    await click(button(host, 'Ada'));
    const page = dialog('Your account')!;
    await click(button(page, 'Delete account…'));
    const remove = () => button(page, 'Delete account')!;
    expect(remove().disabled).toBe(true);
    await type(field(page, 'Current password'), 'correct horse battery');
    expect(remove().disabled).toBe(true);
    await type(field(page, 'Type Ada to confirm'), 'ada');
    expect(remove().disabled).toBe(true);
    await submit(page.querySelector('form[aria-label="Delete account"]'));
    expect(calls.some(call => call.method === 'DELETE')).toBe(false);
    await type(field(page, 'Type Ada to confirm'), 'Ada');
    expect(remove().disabled).toBe(false);
    await click(remove());
    expect(calls.filter(call => call.method === 'DELETE')).toEqual([expect.objectContaining({ path: '/api/account',
      body: { password: 'correct horse battery' }, headers: expect.objectContaining({ 'X-Workshop-Session': CSRF }) })]);
    expect(dialog('Your account')).toBeNull();
    expect(button(host, 'Sign in')).toBeDefined();
  });

  it('signing out with unsaved changes asks "Save before signing out?", then starts fresh', async () => {
    const project = seedDraft(true);
    const calls = service({ 'GET /api/auth/me': signedIn(ADA), 'POST /api/auth/logout': () => ({ body: { status: 'signed-out' } }) });
    const host = await open();
    await click(button(host, 'Ada'));
    await click(button(dialog('Your account')!, 'Sign out'));
    const ask = dialog('Save before signing out?')!;
    expect(ask).not.toBeNull();
    expect(calls.some(call => call.path === '/api/auth/logout')).toBe(false);
    await click(button(ask, 'Sign out without saving'));
    expect(calls.some(call => call.path === '/api/auth/logout')).toBe(true);
    expect(button(host, 'Sign in')).toBeDefined();
    expect(draft().id).not.toBe(project.id);
    expect(draft().name).toBe('New train layout');
    expect(host.querySelector('.brand-project')?.textContent).toBe('New train layout');
  });

  it('"Save and sign out" saves the changes before signing out', async () => {
    const project = seedDraft(true), revisions = `/api/projects/${project.id}/revisions`;
    const calls = service({ 'GET /api/auth/me': signedIn(ADA),
      [`POST ${revisions}`]: () => ({ status: 201, body: { id: project.id, revision: crypto.randomUUID(), name: project.name, savedAt: new Date().toISOString() } }),
      'POST /api/auth/logout': () => ({ body: { status: 'signed-out' } }) });
    const host = await open();
    await click(button(host, 'Ada'));
    await click(button(dialog('Your account')!, 'Sign out'));
    await click(button(dialog('Save before signing out?')!, 'Save and sign out'));
    expect(calls.filter(call => call.method === 'POST').map(call => call.path)).toEqual([revisions, '/api/auth/logout']);
    expect(calls.find(call => call.path === revisions)!.body).toMatchObject({ name: 'Harbour loop v2', parentRevision: project.parentRevision });
  });

  it('an unverified member sees the purge date, and Resend asks the service for a new link', async () => {
    seedDraft(false);
    const calls = service({ 'GET /api/auth/me': signedIn({ ...ADA, verified: false, purgeAt: '2026-10-15T12:00:00Z' }),
      'POST /api/auth/resend-verification': () => ({ status: 202, body: { status: 'check-email' } }) });
    const host = await open();
    const banner = host.querySelector<HTMLElement>('[aria-label="Verify your email"]')!;
    expect(banner.textContent).toContain('Unverified accounts and their projects are deleted on 15 October 2026.');
    await click(button(banner, 'Resend'));
    expect(calls.find(call => call.path === '/api/auth/resend-verification')).toMatchObject({ method: 'POST', headers: { 'X-Workshop-Session': CSRF } });
    expect(banner.textContent).toContain('We sent a new link to ada@example.com.');
  });

  it('a verify link opened signed out verifies, leaves the address at /app/, and asks to sign in rather than signing in', async () => {
    vi.stubEnv('BASE_URL', '/app/');
    window.history.replaceState(null, '', '/app/#verify=token-123');
    const project = seedDraft(true);
    const calls = service({ 'GET /api/auth/me': signedOut, 'POST /api/auth/verify-email': () => ({ body: { verified: true, signedIn: false } }),
      'POST /api/auth/login': signedIn(ADA) });
    const host = await open();
    expect(calls.find(call => call.path === '/api/auth/verify-email')?.body).toEqual({ token: 'token-123' });
    expect(window.location.pathname + window.location.hash).toBe('/app/');
    const signIn = dialog('Sign in')!;
    expect(signIn.textContent).toContain('Email verified');
    expect(button(host, 'Sign in')).toBeDefined();
    expect(button(host, 'Ada')).toBeUndefined();
    expect(draft().revision).toBe(project.revision);
    expect(calls.some(call => call.path === '/api/projects')).toBe(false);
    await type(field(signIn, 'Email'), ADA.email);
    await type(field(signIn, 'Password'), 'correct horse battery');
    await submit(signIn);
    expect(button(host, 'Ada')).toBeDefined();
  });

  it('a verify link opened while signed in sends that session’s CSRF token', async () => {
    window.history.replaceState(null, '', '/#verify=token-456');
    seedDraft(false);
    const calls = service({ 'GET /api/auth/me': signedIn({ ...ADA, verified: false, purgeAt: '2026-10-15T12:00:00Z' }),
      'POST /api/auth/verify-email': call => call.headers['X-Workshop-Session'] === CSRF ? { body: { verified: true, signedIn: true, user: ADA, csrf: CSRF } } :
        { status: 403, body: { detail: 'Session required' } } });
    const host = await open();
    expect(dialog('Email verified')).not.toBeNull();
    expect(host.querySelector('[aria-label="Verify your email"]')).toBeNull();
    expect(calls.filter(call => call.path === '/api/auth/verify-email')).toHaveLength(1);
  });

  it('after verifying in another tab, this tab shows the verified state when it regains focus', async () => {
    seedDraft(false);
    let user: User = { ...ADA, verified: false, purgeAt: '2026-10-15T12:00:00Z' };
    service({ 'GET /api/auth/me': () => ({ body: { user, csrf: CSRF } }) });
    const host = await open();
    expect(host.querySelector('[aria-label="Verify your email"]')).not.toBeNull();
    user = { ...ADA };
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    expect(host.querySelector('[aria-label="Verify your email"]')).toBeNull();
  });
});
