// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { loadLibrary } from '../src/domain/library';
import { changeProject, serializeProject, type WorkshopProject } from '../src/domain/project';
import { createStandardProject } from '../src/editor/setup-defaults';
import { placePiece } from '../src/editor/operations';
import { ADA, BOB, DRAFT_KEY, button, click, close, dialog, draft, field, notice, open, seedDraft, service, signedIn, signedOut,
  storeDraft, submit, type, workspaceHooks, type Call, type Reply, type User } from './workspace-harness';

workspaceHooks();

const RECOVERED_KEY = `${DRAFT_KEY}:recovered`;
type Saved = { id: string; revision: string; name: string; savedAt: string };
const saved = (id: string, name: string, revision: string = crypto.randomUUID()): Saved =>
  ({ id, revision, name, savedAt: new Date().toISOString() });

/** A visitor's layout in the browser: one straight laid on a new project, never saved. */
function visitorDraft(): WorkshopProject {
  const fresh = createStandardProject('New train layout');
  const laid = placePiece(fresh, 'brick_straight_nominal', { x: 600, y: 600 })[0];
  storeDraft(laid, fresh, false);
  return laid;
}
/** Signs in from the header's Sign in; the fake service's `POST /api/auth/login` decides who. */
async function signIn(host: HTMLElement, user: User) {
  await click(button(host, 'Sign in'));
  const form = dialog('Sign in')!;
  await type(field(form, 'Email'), user.email);
  await type(field(form, 'Password'), 'correct horse battery');
  await submit(form);
}
const posts = (calls: Call[], path: string) => calls.filter(call => call.method === 'POST' && call.path === path);
const projectName = (host: HTMLElement) => host.querySelector('.brand-project')?.textContent;

describe('drafts and accounts', { timeout: 30_000 }, () => {
  it('saves a visitor’s layout to the account they sign in to, unchanged, and only once', async () => {
    const layout = visitorDraft();
    let me: () => Reply = signedOut;
    const created = saved(crypto.randomUUID(), layout.name);
    const calls = service({ 'GET /api/auth/me': () => me(), 'POST /api/auth/login': signedIn(ADA),
      'POST /api/projects': () => ({ status: 201, body: created }) });
    const host = await open();
    await signIn(host, ADA);
    const [post] = posts(calls, '/api/projects');
    expect(posts(calls, '/api/projects')).toHaveLength(1);
    expect(post.body).toEqual(JSON.parse(serializeProject(layout)));
    expect(draft()).toMatchObject({ id: created.id, parentRevision: created.revision, provenance: { account: ADA.id }, routes: layout.routes });
    expect(host.querySelector('.save-status')?.textContent).toBe('Saved');
    close(host);
    me = signedIn(ADA);
    await open();
    expect(posts(calls, '/api/projects')).toHaveLength(1);
  });

  it('signing in with an untouched new project creates no project', async () => {
    storeDraft(createStandardProject('New train layout'), undefined, false);
    const calls = service({ 'GET /api/auth/me': signedOut, 'POST /api/auth/login': signedIn(ADA) });
    const host = await open();
    await signIn(host, ADA);
    expect(calls.filter(call => call.path.startsWith('/api/projects'))).toEqual([]);
    expect(draft().provenance).toEqual({ account: ADA.id });
  });

  it('after A signs out, B signing in on the same browser gets a new project, not A’s', async () => {
    seedDraft(false, ADA);
    let me: () => Reply = signedIn(ADA);
    const calls = service({ 'GET /api/auth/me': () => me(), 'POST /api/auth/logout': () => { me = signedOut; return { body: {} }; },
      'POST /api/auth/login': signedIn(BOB), 'GET /api/projects': () => ({ body: [] }) });
    const host = await open();
    await click(button(host, 'Ada'));
    await click(button(dialog('Your account')!, 'Sign out'));
    await signIn(host, BOB);
    expect(projectName(host)).toBe('New train layout');
    await click(button(host, 'Open'));
    expect(dialog('Open project')?.textContent).toContain('No saved projects yet.');
    expect(calls.some(call => call.method === 'POST' && call.path.startsWith('/api/projects'))).toBe(false);
  });

  it('never saves another account’s draft into the account signing in, and keeps its unsaved work aside', async () => {
    const theirs = seedDraft(true, ADA);  // Ada's session ended in this browser without signing out
    const calls = service({ 'GET /api/auth/me': signedOut, 'POST /api/auth/login': signedIn(BOB) });
    const host = await open();
    expect(projectName(host)).toBe('Harbour loop v2');
    await signIn(host, BOB);
    expect(calls.some(call => call.method === 'POST' && call.path.startsWith('/api/projects'))).toBe(false);
    expect(projectName(host)).toBe('New train layout');
    expect(draft().provenance).toEqual({ account: BOB.id });
    expect(JSON.parse(JSON.parse(localStorage.getItem(RECOVERED_KEY)!).project)).toMatchObject({ id: theirs.id, name: 'Harbour loop v2' });
  });

  it('keeps a draft that cannot be read under the recovered key and says so', async () => {
    for (const raw of ['{"project":"{not json', JSON.stringify({ project: JSON.stringify({ version: 999 }) })]) {
      localStorage.clear();
      localStorage.setItem(DRAFT_KEY, raw);
      service({ 'GET /api/auth/me': signedOut });
      const host = await open();
      expect(localStorage.getItem(RECOVERED_KEY)).toBe(raw);
      expect(notice(host)).toContain('kept in this browser');
      expect(projectName(host)).toBe('New train layout');
      close(host);
    }
    // A second unreadable draft never replaces the first one kept.
    const first = localStorage.getItem(RECOVERED_KEY);
    localStorage.setItem(DRAFT_KEY, 'not a draft');
    service({ 'GET /api/auth/me': signedOut });
    await open();
    expect(localStorage.getItem(RECOVERED_KEY)).toBe(first);
    expect(Object.keys(localStorage).filter(key => key.startsWith(`${RECOVERED_KEY}:`)).map(key => localStorage.getItem(key))).toEqual(['not a draft']);
  });

  it('opens a layout with a piece the library no longer has, says so, and saves the piece unchanged', async () => {
    const mine = seedDraft(false, ADA);
    const laid = placePiece(mine, 'brick_straight_nominal', { x: 600, y: 600 })[0];
    const stored = JSON.parse(serializeProject(laid));
    stored.routes[0].pieces[0] = { ...stored.routes[0].pieces[0], family: 'community_viaduct_v3', params: { arches: 4 } };
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ project: JSON.stringify(stored), baseline: { revision: mine.revision, saved: true } }));
    const revisions = `/api/projects/${mine.id}/revisions`;
    const calls = service({ 'GET /api/auth/me': signedIn(ADA), [`POST ${revisions}`]: () => ({ status: 201, body: saved(mine.id, mine.name) }) });
    const host = await open();
    expect(notice(host)).toContain('1 piece in this layout is not in the library');
    await click(button(host, 'Save'));
    expect((posts(calls, revisions)[0].body as WorkshopProject).routes).toEqual(stored.routes);
  });

  it('says quietly when the community library did not load, and why a layout’s community piece shows as unavailable', async () => {
    const index = '/api/library/index.json';
    service({ [`GET ${index}`]: () => ({ status: 503, body: { detail: 'Unavailable' } }) });
    try {
      expect((await loadLibrary().indexed).loaded).toBe(false);
      service({ 'GET /api/auth/me': signedOut });
      let host = await open();
      expect(notice(host)).toBe('The community library didn’t load; built-in pieces work. Reload the page to try again.');
      close(host);
      const laid = placePiece(createStandardProject('Community'), 'brick_straight_nominal', { x: 600, y: 600 })[0];
      const stored = JSON.parse(serializeProject(laid));
      stored.routes[0].pieces[0].family = 'community_sample_curve_90';
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ project: JSON.stringify(stored), baseline: { revision: '', saved: false } }));
      host = await open();
      expect(notice(host)).toContain('1 piece in this layout shows as unavailable because the community library didn’t load');
    } finally {
      // The load's outcome is page state: later cases start from a library that loaded.
      service({ [`GET ${index}`]: () => ({ status: 200, body: { format: 1, items: [] } }) });
      await loadLibrary().settled;
    }
  });

  it('a save based on an older revision offers “Keep both” or “Use newer”', async () => {
    vi.stubGlobal('confirm', () => { throw new Error('No confirm: the dialog already asked'); });
    const mine = seedDraft(true, ADA);
    const newer = saved(mine.id, 'Harbour loop (other tab)');
    const copy = saved(crypto.randomUUID(), 'Harbour loop v2 (copy)');
    const revisions = `/api/projects/${mine.id}/revisions`;
    const calls = service({ 'GET /api/auth/me': signedIn(ADA),
      [`POST ${revisions}`]: () => ({ status: 409, body: { detail: 'A newer save of this project exists.', latest: newer } }),
      'POST /api/projects': () => ({ status: 201, body: copy }),
      [`GET /api/projects/${mine.id}/${newer.revision}`]: () => ({ body: { ...JSON.parse(serializeProject(mine)), name: newer.name, revision: newer.revision } }) });
    const host = await open();
    await click(button(host, 'Save'));
    const ask = dialog('Newer save exists')!;
    expect(ask.textContent).toContain('Harbour loop (other tab)');
    expect(draft()).toMatchObject({ name: 'Harbour loop v2', parentRevision: mine.parentRevision });
    await click(button(ask, 'Keep both'));
    const [kept] = posts(calls, '/api/projects');
    expect(kept.body).toMatchObject({ name: 'Harbour loop v2 (copy)', parentRevision: null, routes: mine.routes });
    expect((kept.body as WorkshopProject).id).not.toBe(mine.id);
    expect(draft()).toMatchObject({ id: copy.id, parentRevision: copy.revision, name: 'Harbour loop v2 (copy)' });

    seedDraft(true, ADA);
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...JSON.parse(localStorage.getItem(DRAFT_KEY)!),
      project: serializeProject({ ...mine, name: 'Harbour loop v2' }) }));
    close(host);
    const again = await open();
    await click(button(again, 'Save'));
    await click(button(dialog('Newer save exists')!, 'Use newer'));
    expect(draft()).toMatchObject({ id: mine.id, name: 'Harbour loop (other tab)', parentRevision: newer.revision });
    expect(again.querySelector('.save-status')?.textContent).toBe('Saved');
  });

  it('opening an older save and saving it makes it the newest save of that project', async () => {
    vi.stubGlobal('confirm', () => true);
    const mine = seedDraft(false, ADA);
    const latest = saved(mine.id, mine.name, mine.parentRevision!);
    const older = saved(mine.id, mine.name);
    older.savedAt = new Date(Date.now() - 86_400_000).toISOString();
    const body = JSON.parse(serializeProject(changeProject(mine, draft => { draft.name = 'Harbour loop'; })));
    const revisions = `/api/projects/${mine.id}/revisions`;
    const calls = service({ 'GET /api/auth/me': signedIn(ADA), 'GET /api/projects': () => ({ body: [latest, older] }),
      [`GET /api/projects/${mine.id}/${older.revision}`]: () => ({ body: { ...body, revision: older.revision } }),
      [`POST ${revisions}`]: () => ({ status: 201, body: saved(mine.id, mine.name) }) });
    const host = await open();
    await click(button(host, 'Open'));
    const list = dialog('Open project')!;
    await click(list.querySelector('summary') ?? undefined);
    await click(Array.from(list.querySelectorAll<HTMLButtonElement>('.saved-row-older'))[0]);
    expect(draft()).toMatchObject({ revision: older.revision, parentRevision: latest.revision, provenance: { account: ADA.id } });
    await click(host.querySelector<HTMLButtonElement>('.brand-project') ?? undefined);
    const name = host.querySelector<HTMLInputElement>('.brand-project-input')!;
    await type(name, 'Restored');
    await act(async () => { name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await click(button(host, 'Save'));
    expect(posts(calls, revisions).map(call => (call.body as WorkshopProject).parentRevision)).toEqual([latest.revision]);
  });

  it('a first save of a draft another tab already saved asks which to keep, and saves nothing on top', async () => {
    vi.stubGlobal('confirm', () => { throw new Error('No confirm: the dialog already asked'); });
    const layout = { ...visitorDraft(), provenance: { account: ADA.id } };
    storeDraft(layout, layout, false);
    const there = saved(crypto.randomUUID(), 'Harbour loop (other tab)');
    const calls = service({ 'GET /api/auth/me': signedIn(ADA), 'POST /api/projects': () => ({ status: 200, body: there }),
      [`POST /api/projects/${there.id}/revisions`]: () => ({ status: 201, body: saved(there.id, layout.name) }) });
    const host = await open();
    await click(button(host, 'Save'));
    await submit(dialog('Save project'));
    expect(posts(calls, `/api/projects/${there.id}/revisions`)).toHaveLength(0);
    expect(dialog('Newer save exists')?.textContent).toContain('Harbour loop (other tab)');
    expect(draft()).toMatchObject({ id: layout.id, parentRevision: null });
    expect(host.querySelector('.save-status')?.textContent).not.toBe('Saved');
  });

  it('a layout prepare is for the project the save made: the service links the job and the Print step follows it', async () => {
    const fresh = { ...createStandardProject('Printed straight'), provenance: { account: ADA.id } };
    const layout = placePiece(fresh, 'printed_straight', { x: 500, y: 500 })[0];
    storeDraft(layout, layout, false);
    const created = saved(crypto.randomUUID(), layout.name);
    const limits = { layout: { limit: 10, remaining: 7, resetsAt: null }, sample: { limit: 20, remaining: 20, resetsAt: null } };
    /** As the service does: a job is linked to a project only when the manifest names a revision the service saved. */
    const savedHere = (body: unknown) => {
      const manifest = body && typeof body === 'object' && 'manifest' in body ? body.manifest : null;
      const project = manifest && typeof manifest === 'object' && 'project' in manifest ? manifest.project : null;
      return !!project && typeof project === 'object' && 'id' in project && project.id === created.id &&
        'revision' in project && project.revision === created.revision;
    };
    const calls = service({ 'GET /api/auth/me': signedIn(ADA), 'POST /api/projects': () => ({ status: 201, body: created }),
      'GET /api/packages': () => ({ body: [] }), 'GET /api/jobs': () => ({ body: { active: null, limits } }),
      'POST /api/jobs': call => {
        const linked = savedHere(call.body);
        return { status: 202, body: { id: 'job-1', kind: 'layout', state: 'queued', position: 1, stage: null, detail: null, progress: null,
          error: null, packageId: null, cancelling: false, projectId: linked ? created.id : null, projectName: linked ? layout.name : null,
          interruptions: 0 } };
      } });
    const host = await open();
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Go to Print"]') ?? undefined);
    await click(host.querySelector<HTMLButtonElement>('#prepare-plates') ?? undefined);
    expect(posts(calls, '/api/projects')).toHaveLength(1);
    expect(posts(calls, '/api/jobs')[0].body).toMatchObject({ manifest: { project: { id: created.id, revision: created.revision } } });
    expect(host.textContent).not.toContain('Preparing another layout');
    expect(host.querySelector('.export-progress strong')?.textContent).toBe('Waiting — 1 ahead of you');
  });
});
