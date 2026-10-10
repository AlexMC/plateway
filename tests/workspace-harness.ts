/** The workspace on happy-dom against a fake service; test files using it declare `// @vitest-environment happy-dom`. */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, vi } from 'vitest';
import { changeProject, parseProject, serializeProject, type WorkshopProject } from '../src/domain/project';
import { createStandardProject } from '../src/editor/setup-defaults';
import { Workspace } from '../src/editor/workspace';
import { setCsrf } from '../src/net/api';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

export const DRAFT_KEY = 'train-layout-workshop:current';
export const CSRF = 'csrf-token-1';
export type User = { id: string; email: string; displayName: string; verified: boolean; purgeAt: string | null };
export const ADA: User = { id: 'u1', email: 'ada@example.com', displayName: 'Ada', verified: true, purgeAt: null };
export const BOB: User = { id: 'u2', email: 'bob@example.com', displayName: 'Bob', verified: true, purgeAt: null };
export type Call = { method: string; path: string; headers: Record<string, string>; body: unknown };
export type Reply = { status?: number; body?: unknown };

/** A fake service: `routes['POST /api/projects']` answers that call; anything else is a 404. Every call is recorded. */
export function service(routes: Record<string, (call: Call) => Reply>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), window.location.href);
    const call: Call = { method: init.method ?? 'GET', path: url.pathname, headers: { ...init.headers as Record<string, string> },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    const reply = route ? route(call) : { status: 404, body: { detail: 'Not Found' } };
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}
export const signedIn = (user: User) => () => ({ body: { user, csrf: CSRF } });
export const signedOut = () => ({ status: 401, body: { detail: 'Sign in first' } });

/** Stores `project` as the browser draft, clean against `baseline` (its last save). */
export function storeDraft(project: WorkshopProject, baseline: WorkshopProject = project, saved = true) {
  localStorage.setItem(DRAFT_KEY, JSON.stringify({ project: serializeProject(project),
    baseline: { revision: baseline.revision, saved }, startDismissed: project.id }));
}
/** A member's saved project in the browser; `dirty`: edited since its last save. */
export function seedDraft(dirty: boolean, owner: User = ADA): WorkshopProject {
  const saved = { ...createStandardProject('Harbour loop'), provenance: { account: owner.id }, parentRevision: crypto.randomUUID() };
  const project = dirty ? changeProject(saved, draft => { draft.name = 'Harbour loop v2'; }) : saved;
  storeDraft(project, saved);
  return project;
}
export const draft = () => parseProject(JSON.parse(localStorage.getItem(DRAFT_KEY)!).project);

const mounted: { root: Root; host: HTMLElement }[] = [];
export async function open() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Workspace)));
  await settle();
  mounted.push({ root, host });
  return host;
}
export function close(host: HTMLElement) {
  const index = mounted.findIndex(item => item.host === host);
  const [{ root }] = mounted.splice(index, 1);
  act(() => root.unmount());
  host.remove();
}
/** Lets the fake service's replies and the renders they cause land (each round drains the microtask queue). */
export async function settle() { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); }
export const buttons = (root: ParentNode) => Array.from(root.querySelectorAll<HTMLButtonElement>('button'));
export const button = (root: ParentNode, text: string) => buttons(root).find(item => item.textContent?.trim() === text);
export async function click(target: Element | undefined) {
  if (!target) throw new Error('Nothing to click');
  await act(async () => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await settle();
}
export function field(root: ParentNode, label: string): HTMLInputElement {
  const found = Array.from(root.querySelectorAll('label')).find(item => item.firstChild?.textContent?.trim() === label)?.querySelector('input');
  if (!found) throw new Error(`No field ${label}`);
  return found;
}
export async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
export async function submit(form: Element | null) {
  await act(async () => { form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await settle();
}
export const dialog = (label: string) => document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${label}"]`);
export const notice = (host: HTMLElement) => host.querySelector('.inline-notice')?.textContent ?? '';

/** A fresh page for each test: no session, empty storage, the site root; mounted workspaces and stubs go afterwards. */
export function workspaceHooks() {
  beforeEach(() => {
    setCsrf('');
    localStorage.clear();
    window.history.replaceState(null, '', '/');
  });
  afterEach(() => {
    for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove(); }
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
}
