// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { button, click, close, open, service, signedOut, workspaceHooks } from './workspace-harness';

workspaceHooks();

const NOTICE = 'Plateway works best on a computer; you can look around, test drive and browse here.';
const notice = (host: HTMLElement) => host.querySelector('[role="note"]')?.textContent ?? '';
const menu = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[aria-controls="top-menu-items"]')!;

describe('on a phone', { timeout: 30_000 }, () => {
  it('the “works best on a computer” notice stays away on this browser once dismissed', async () => {
    service({ 'GET /api/auth/me': signedOut });
    const first = await open();
    expect(notice(first)).toContain(NOTICE);
    await click(first.querySelector('[role="note"] button[aria-label="Dismiss"]')!);
    expect(notice(first)).toBe('');
    close(first);
    const again = await open();
    expect(notice(again)).toBe('');
    close(again);
    localStorage.clear();
    expect(notice(await open())).toContain(NOTICE);
  });

  it('the header menu closes when an item is chosen, on Escape and on a tap outside it', async () => {
    service({ 'GET /api/auth/me': signedOut });
    const host = await open();
    await click(menu(host));
    expect(menu(host).getAttribute('aria-expanded')).toBe('true');
    await click(button(host, 'Gallery'));
    expect(document.querySelector('.gallery-dialog')).not.toBeNull();
    expect(menu(host).getAttribute('aria-expanded')).toBe('false');

    await click(menu(host));
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(menu(host).getAttribute('aria-expanded')).toBe('false');

    await click(menu(host));
    await act(async () => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
    expect(menu(host).getAttribute('aria-expanded')).toBe('false');
    await click(menu(host));
    await act(async () => { button(host, 'Setup')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
    expect(menu(host).getAttribute('aria-expanded')).toBe('true');
  });
});
