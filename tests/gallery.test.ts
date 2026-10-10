// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { calibrationKey, type CalibrationProfile } from '../src/domain/calibration';
import { changeProject, remixOf, serializeProject, stripForPublish, type LayoutCredit, type WorkshopProject } from '../src/domain/project';
import { THUMBNAIL_BYTES, THUMBNAIL_POINTS, galleryThumbnail, remixLayout, remixSetup, type GalleryLayout, type GalleryThumbnail } from '../src/gallery/gallery';
import { createStandardProject, setSetupPrinter } from '../src/editor/setup-defaults';
import { START_EXAMPLES, pickExample, thumbnail } from '../src/editor/start-examples';
import { ADA, CSRF, DRAFT_KEY, button, click, dialog, draft, open, service, signedIn, signedOut, storeDraft, submit, workspaceHooks, type Call } from './workspace-harness';

workspaceHooks();

const LAYOUT_ID = '7f1c6a52-5d0e-4b8e-9f43-2f0b1d3c4e5a';
const ORIGINAL: LayoutCredit = { id: '0b9d4c1e-7a2f-4e6b-8c3d-5f1a2b3c4d5e', title: 'Harbour loop', author: 'Grace', licence: 'CC-BY-4.0' };

/** An author's oval on an X1 Carbon with everything private filled in: inventory, an observation and a +0.10 mm fit. */
function authorsLayout(): WorkshopProject {
  const oval = pickExample(START_EXAMPLES[0], createStandardProject('Harbour loop with yard'));
  return changeProject(oval, project => {
    project.connectorFit = { adjustmentMm: 0.1, settingsKey: calibrationKey(oval), calibrationId: 'cal-author' };
    project.observations = [{ id: 'o1', kind: 'fit', passed: true, material: 'PLA', printer: 'X1 Carbon', orientation: 'flat',
      consistId: 'c1', notes: 'snug', recordedAt: '2026-10-01' }];
    project.provenance = { account: 'author' };
    project.parentRevision = crypto.randomUUID();
  });
}

/** The gallery's record of the author's layout, a remix of Grace's: its shared copy as the service stores it. */
function galleryLayout(project = authorsLayout()): GalleryLayout {
  const shared = { ...stripForPublish(project), id: LAYOUT_ID };
  return { id: LAYOUT_ID, title: 'Harbour loop with yard', description: 'Two stations.', author: 'Ada', licence: 'CC-BY-4.0',
    publishedAt: '2026-10-08T10:00:00.000Z', pieces: shared.routes.flatMap(route => route.pieces).length, thumbnail: null,
    remixOf: ORIGINAL, mine: false, project: JSON.parse(serializeProject(shared)), ancestors: [ORIGINAL], canModerate: false };
}

function fits(project: WorkshopProject, id: string, adjustmentMm: number, recordedAt: string): CalibrationProfile {
  return { id, settingsKey: calibrationKey(project), trackSystem: project.trackSystem, adjustmentMm, result: 'fits', notes: '',
    receiptId: `receipt-${id}`, recordedAt, conditions: { printer: project.printer, material: '', nozzleMm: 0.4, printProfile: '', orientation: 'flat' } };
}

const shared = (layout: GalleryLayout) => layout.project as WorkshopProject;

/** The oval laid out `copies` times side by side: about 22 points and one track per piece. */
function sprawl(copies: number): WorkshopProject {
  return changeProject(pickExample(START_EXAMPLES[0], createStandardProject('Sprawl')), project => {
    project.routes = Array.from({ length: copies }, (_, copy) => project.routes.map(route => ({ ...route, id: `${route.id}-${copy}`,
      pieces: route.pieces.map(piece => ({ ...piece, id: `${piece.id}-${copy}`, x: piece.x + (copy % 10) * 3000, y: piece.y + Math.floor(copy / 10) * 3000 })) }))).flat();
  });
}

/** Each track's first and last point, as the service would get them unsimplified. */
const trackEnds = (project: WorkshopProject) => thumbnail(project).tracks.map(track => {
  const numbers = (track.d.match(/-?\d+/g) ?? []).map(Number);
  return [...numbers.slice(0, 2), ...numbers.slice(-2)].join(' ');
});

function expectWithinBounds(view: GalleryThumbnail) {
  expect(view.tracks.reduce((sum, track) => sum + track.points.length / 2, 0)).toBeLessThanOrEqual(THUMBNAIL_POINTS);
  expect(JSON.stringify(view).length).toBeLessThanOrEqual(THUMBNAIL_BYTES);
  expect(view.tracks.every(track => track.points.length >= 4 && track.points.every(Number.isInteger))).toBe(true);
}

describe('publishing and remixing', () => {
  it('shares no inventory, observations, fit calibration, printer, material or print settings', () => {
    const author = setSetupPrinter(authorsLayout(), 'A1 mini');
    const copy = stripForPublish(author);
    expect(copy).toMatchObject({ inventory: {}, observations: [], connectorFit: { adjustmentMm: 0, settingsKey: null, calibrationId: null },
      printer: 'X1 Carbon', material: null, printSettings: { profile: null, nozzleMm: null, orientation: 'flat' },
      provenance: { account: null }, parentRevision: null });
    expect(copy.routes).toEqual(author.routes);
    expect(copy.cars).toEqual(author.cars);
  });

  it('gives a member’s remix their own fit, never the author’s +0.10 mm (AE7)', () => {
    const layout = galleryLayout();
    const setup = createStandardProject('Mine');
    const unfitted = remixOf(shared(layout), [], setup, ADA.id);
    const remix = remixLayout(layout, shared(layout), { setup, calibrations: [fits(unfitted, 'mine', -0.05, '2026-10-02T00:00:00.000Z')] }, ADA.id);
    expect(remix.connectorFit).toMatchObject({ adjustmentMm: -0.05, calibrationId: 'mine' });
    expect(remix).toMatchObject({ inventory: {}, observations: [], provenance: { account: ADA.id }, parentRevision: null });
    expect(remix.id).not.toBe(LAYOUT_ID);
    expect(remix.ancestors).toEqual([{ id: LAYOUT_ID, title: 'Harbour loop with yard', author: 'Ada', licence: 'CC-BY-4.0' }, ORIGINAL]);
  });

  it('remixes an X1 Carbon layout with the A1 mini setup of the member’s most recent project and their newest A1 mini fit (AE7)', async () => {
    const layout = galleryLayout();
    const recent = setSetupPrinter(changeProject(createStandardProject('Shelf run'), project => { project.material = 'PETG'; }), 'A1 mini');
    const a1 = remixOf(shared(layout), [], recent, ADA.id);
    const x1 = remixOf(shared(layout), [], createStandardProject('Other'), ADA.id);
    service({
      'GET /api/projects': () => ({ body: [{ id: 'p1', revision: 'r2', name: 'Shelf run', savedAt: '2026-10-07T00:00:00.000Z' },
        { id: 'p0', revision: 'r1', name: 'Older', savedAt: '2026-09-01T00:00:00.000Z' }] }),
      'GET /api/projects/p1/r2': () => ({ body: JSON.parse(serializeProject(recent)) }),
      'GET /api/calibrations': () => ({ body: [fits(a1, 'a1-old', -0.05, '2026-09-01T00:00:00.000Z'),
        fits(a1, 'a1-new', 0.05, '2026-10-01T00:00:00.000Z'), fits(x1, 'x1', 0.12, '2026-10-05T00:00:00.000Z')] })
    });
    const remix = remixLayout(layout, shared(layout), await remixSetup(true), ADA.id);
    expect(remix).toMatchObject({ printer: 'A1 mini', material: 'PETG', printSettings: recent.printSettings });
    expect(remix.connectorFit).toMatchObject({ adjustmentMm: 0.05, calibrationId: 'a1-new' });
  });

  it('gives a visitor’s remix a new project’s print setup and no fit', async () => {
    const layout = galleryLayout();
    const calls = service({});
    const remix = remixLayout(layout, shared(layout), await remixSetup(false), null);
    const fresh = createStandardProject('');
    expect(remix).toMatchObject({ printer: fresh.printer, material: fresh.material, printSettings: fresh.printSettings,
      connectorFit: { adjustmentMm: 0, settingsKey: null, calibrationId: null }, provenance: { account: null } });
    expect(calls).toEqual([]);
  });

  it('simplifies a big layout’s thumbnail to the service’s 4,000 points and 64 KB, keeping every track and its ends', () => {
    const big = sprawl(40);
    const view = galleryThumbnail(big);
    expectWithinBounds(view);
    expect(view.tracks.map(track => [...track.points.slice(0, 2), ...track.points.slice(-2)].join(' '))).toEqual(trackEnds(big));
  });

  it('keeps the longest tracks of a layout with more tracks than a thumbnail holds', () => {
    const huge = sprawl(120);
    const view = galleryThumbnail(huge), ends = trackEnds(huge);
    expectWithinBounds(view);
    expect(view.tracks.length).toBeGreaterThan(1000);
    expect(view.tracks.length).toBeLessThan(ends.length);
    expect(view.tracks.every(track => track.points.length === 4 && ends.includes(track.points.join(' ')))).toBe(true);
  });
});

describe('the gallery in the workspace', { timeout: 30_000 }, () => {
  /** A visitor's own layout in the browser: one straight, never saved. */
  function visitorsDraft() {
    const fresh = createStandardProject('My shelf line');
    const own = pickExample(START_EXAMPLES[1], fresh);
    storeDraft(own, fresh, false);
    return localStorage.getItem(DRAFT_KEY);
  }
  const atLayout = () => window.history.replaceState(null, '', `/#gallery=${LAYOUT_ID}`);
  const writes = (calls: Call[]) => calls.filter(call => call.method !== 'GET');

  it('lets a visitor open and test drive a shared layout without touching their draft', async () => {
    const before = visitorsDraft();
    const calls = service({ 'GET /api/auth/me': signedOut, [`GET /api/gallery/${LAYOUT_ID}`]: () => ({ body: galleryLayout() }) });
    atLayout();
    const host = await open();
    const page = host.querySelector('.gallery-page')!;
    expect(page.textContent).toContain('Harbour loop with yard');
    expect(page.textContent).toContain('Remix of “Harbour loop” by Grace');
    expect(host.querySelector('.builder-plan, .builder-scene')).toBeNull();
    await click(button(page, 'Test drive'));
    expect(page.querySelector('.drive-panel')).not.toBeNull();
    await click(button(page, 'Back to your layout'));
    expect(host.querySelector('.gallery-page')).toBeNull();
    expect(window.location.hash).toBe('');
    expect(localStorage.getItem(DRAFT_KEY)).toBe(before);
    expect(host.querySelector('.brand-project')?.textContent).toBe('My shelf line');
    expect(writes(calls)).toEqual([]);
  });

  it('asks a visitor with a layout before a remix replaces it; Sign up keeps it', async () => {
    const before = visitorsDraft();
    service({ 'GET /api/auth/me': signedOut, [`GET /api/gallery/${LAYOUT_ID}`]: () => ({ body: galleryLayout() }) });
    atLayout();
    const host = await open();
    await click(button(host.querySelector('.gallery-page')!, 'Remix'));
    const ask = dialog('Replace your layout?')!;
    expect(ask.textContent).toContain('This replaces your current layout in this browser');
    await click(button(ask, 'Sign up to keep it'));
    expect(dialog('Replace your layout?')).toBeNull();
    expect(dialog('Create an account')).not.toBeNull();
    expect(localStorage.getItem(DRAFT_KEY)).toBe(before);
  });

  it('replaces the visitor’s layout with the remix when they choose Replace', async () => {
    visitorsDraft();
    const layout = galleryLayout();
    service({ 'GET /api/auth/me': signedOut, [`GET /api/gallery/${LAYOUT_ID}`]: () => ({ body: layout }) });
    atLayout();
    const host = await open();
    await click(button(host.querySelector('.gallery-page')!, 'Remix'));
    await click(button(dialog('Replace your layout?')!, 'Replace'));
    expect(host.querySelector('.gallery-page')).toBeNull();
    expect(draft()).toMatchObject({ routes: shared(layout).routes, provenance: { account: null }, inventory: {},
      ancestors: [{ id: LAYOUT_ID, title: 'Harbour loop with yard', author: 'Ada', licence: 'CC-BY-4.0' }, ORIGINAL] });
    expect(host.querySelector('.save-status')?.textContent).toBe('Unsaved changes');
  });

  it('publishes a member’s layout stripped, with a thumbnail of whole-millimetre numbers, then opens its page', async () => {
    const own = changeProject(pickExample(START_EXAMPLES[0], createStandardProject('Harbour loop')), project => {
      project.provenance = { account: ADA.id };
    });
    storeDraft(own);
    const published = { ...galleryLayout(), mine: true, ancestors: [], remixOf: null };
    const calls = service({ 'GET /api/auth/me': signedIn(ADA), 'GET /api/gallery': () => ({ body: { layouts: [], next: null } }),
      'POST /api/gallery': () => ({ status: 201, body: published }), [`GET /api/gallery/${LAYOUT_ID}`]: () => ({ body: published }) });
    const host = await open();
    await click(button(host, 'Gallery'));
    const browser = dialog('Community layouts')!;
    expect(browser.textContent).toContain('No shared layouts yet');
    await click(button(browser, 'Publish your layout'));
    await submit(dialog('Publish to the gallery'));
    const [post] = calls.filter(call => call.method === 'POST' && call.path === '/api/gallery');
    expect(post.headers['X-Workshop-Session']).toBe(CSRF);
    const body = post.body as { title: string; project: WorkshopProject; thumbnail: { box: number[]; tracks: { points: number[] }[]; shelves: number[][] } };
    expect(body.title).toBe('Harbour loop');
    expect(body.project).toMatchObject({ inventory: {}, observations: [], printer: 'X1 Carbon', material: null, provenance: { account: null } });
    const numbers = [...body.thumbnail.box, ...body.thumbnail.tracks.flatMap(track => track.points), ...body.thumbnail.shelves.flat()];
    expect(body.thumbnail.tracks.length).toBeGreaterThan(0);
    expect(numbers.every(Number.isInteger)).toBe(true);
    expect(window.location.hash).toBe(`#gallery=${LAYOUT_ID}`);
    expect(host.querySelector('.gallery-page')?.textContent).toContain('Unpublish');
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!).project).toBe(serializeProject(own));
  });
});
