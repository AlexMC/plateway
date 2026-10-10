import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkshopProject } from '../src/domain/project';

/** The sample library (tests/fixtures/library): a 90° curve of radius 120 mm, a locomotive, a plain table and a tombstone. */
const FIXTURES = new URL('./fixtures/library/', import.meta.url);
const INDEX_URL = 'https://library.test/plateway-library/index.json';
const CURVE = 'community_sample_curve_90', LOCO = 'community_sample_loco', TABLE = 'community_plain_table', REMOVED = 'community_takedown_viaduct';
type Index = { format: number; items: Array<Record<string, unknown>> };
const sample = (): Index => JSON.parse(readFileSync(new URL('index.json', FIXTURES), 'utf8'));
/** The sample index with `change` applied to each item. */
/** One palette group's section of the sidebar; '' when the group isn't shown. */
const section = (html: string, group: string) => html.split(`id="builder-palette-group-${group}"`)[1]?.split('</section>')[0] ?? '';
const edited = (change: (item: Record<string, unknown>) => Record<string, unknown>): Index => ({ ...sample(), items: sample().items.map(change) });

/** What the library bucket answers: an index, an error status, or no connection. */
type Source = Index | 'fail' | 'offline';
/** A bucket serving `index` at INDEX_URL (`fail`: an error status) and the sample files beside it; each URL asked for joins `requests`. */
function bucket(index: Source, requests: string[] = []) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    requests.push(url);
    if (index === 'offline') throw new TypeError('Failed to fetch');
    if (url === INDEX_URL) return index === 'fail' ? new Response('', { status: 503 }) : new Response(JSON.stringify(index));
    const path = url.replace('https://library.test/plateway-library/', '');
    try { return new Response(readFileSync(new URL(path, FIXTURES))); } catch { return new Response('', { status: 404 }); }
  };
}
/** The sample bucket, except that the train's file arrives only once `release` is called, and fails when its download times out. */
function slowTrain() {
  let release = () => {};
  const arrived = new Promise<void>(resolve => { release = resolve; });
  const serve = bucket(sample());
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (String(input).endsWith('.glb')) await new Promise<void>((resolve, reject) => {
      void arrived.then(resolve);
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    });
    return serve(input);
  };
  return { fetcher: fetcher as typeof fetch, release };
}

/**
 * The app's modules, fresh: the registries start with only the built-in catalogue. Imported after `vi.resetModules`
 * because the library registers into module state once per page load; each case is a new page load.
 */
async function app() {
  vi.resetModules();
  const [library, pieces, project, fit, operations, editor, checks, panel, piecePanel, furniture, tiles, trains, traversal, manifest] = await Promise.all([
    import('../src/domain/library'), import('../src/domain/pieces'), import('../src/domain/project'), import('../src/fitting/fit'),
    import('../src/editor/operations'), import('../src/editor/app'), import('../src/editor/checks'), import('../src/export/panel'),
    import('../src/editor/piece-panel'), import('../src/domain/furniture'), import('../src/editor/furniture-tiles'), import('../src/domain/trains'),
    import('../src/drive/traversal'), import('../src/export/manifest')]);
  const { createStandardProject } = await import('../src/editor/setup-defaults');
  /** The whole load, once every train and furniture file has settled. */
  const load = (index: Source, options: { fetcher?: typeof fetch; fileTimeout?: number } = {}) =>
    library.loadLibrary({ url: INDEX_URL, fetcher: bucket(index) as typeof fetch, ...options }).settled;
  /** The Pieces sidebar of the Build view. */
  const sidebar = (layout: WorkshopProject) => renderToStaticMarkup(createElement(editor.RouteEditor, { project: layout, fit: fit.fitProject(layout),
    account: { status: 'offline' }, onChange: () => {}, onOpenSetup: () => {}, inventoryCue: false, startDismissed: true, onDismissStart: () => {} }))
    .split('aria-label="Pieces sidebar"')[1].split('</aside>')[0];
  /** A straight, `family` laid on its end, and a straight laid on that: each placed where the open end is, as the palette drops it. */
  const throughCurve = (family: string): WorkshopProject => {
    let layout = operations.placePiece(createStandardProject('Community curve'), 'printed_straight', { x: 600, y: 600 })[0];
    for (const next of [family, 'printed_straight']) {
      const end = pieces.primaryEnd(layout.routes[0].pieces.at(-1)!, layout);
      layout = operations.placePiece(layout, next, { x: end.x, y: end.y, heading: end.heading })[0];
    }
    return layout;
  };
  return { library, pieces, project, fit, operations, checks, panel, piecePanel, furniture, tiles, trains, traversal, manifest,
    createStandardProject, load, sidebar, throughCurve };
}

/** A layout through the sample curve, saved by an app that had the library. */
async function savedCurveLayout(): Promise<string> {
  const { load, throughCurve, project } = await app();
  await load(sample());
  return project.serializeProject(throughCurve(CURVE));
}

beforeEach(() => {
  // The bundled train catalogue (public/trains/index.json), empty: only community trains are offered.
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ version: 1, sets: [] })));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the library index', () => {
  it('registers its piece, train and furniture before a project is parsed; the palette shows a credited Community group that prints as uploaded', async () => {
    const { load, sidebar, createStandardProject, pieces, furniture, trains, project } = await app();
    expect(await load(sample())).toEqual({ loaded: true, refused: [] });
    expect(pieces.pieceDefinition(CURVE)).toMatchObject({ label: 'Sample 90° curve', group: 'community', styles: [],
      community: { id: CURVE, version: 1, credit: 'Plateway sample', licence: 'CC-BY-4.0', retired: false,
        folder: 'https://github.com/AlexMC/plateway-library/tree/main/pieces/community_sample_curve_90/1/' } });
    const community = section(sidebar(createStandardProject('Palette')), 'community');
    expect(community).toContain('Prints as uploaded: print style and fit adjustment don’t apply.');
    expect(community).toContain('Sample 90° curve');
    expect(community).toMatch(/90° curve · 188 mm/);
    expect(furniture.furnitureType(TABLE)).toMatchObject({ label: 'Plain table', community: { credit: 'Plateway sample',
      folder: 'https://github.com/AlexMC/plateway-library/tree/main/furniture/community_plain_table/1/' } });
    const catalogue = await trains.loadTrainCatalogue();
    expect(catalogue.sets.map(set => [set.name, set.theme, set.source, set.community?.folder])).toEqual([['Sample locomotive', 'Community',
      { kind: 'library', authors: ['LDraw: Michael Heidemann, Douglas Taylor, Jr., Guy Vivan'], license: 'CC-BY-2.0' },
      'https://github.com/AlexMC/plateway-library/tree/main/trains/community_sample_loco/1/']]);
    // The train's car names its model by id and digest only, and a saved layout keeps that reference.
    const [car] = catalogue.sets[0].cars;
    expect(car.asset).toBe(`library:${LOCO}@${sample().items[1].digest}`);
    expect(trains.libraryModel(car.asset)?.byteLength).toBe(readFileSync(new URL('trains/community_sample_loco/1/car.glb', FIXTURES)).byteLength);
    const withCar = { ...createStandardProject('Shunting'), cars: [trains.catalogueCar(catalogue.sets[0], car)] };
    expect(project.parseProject(project.serializeProject(withCar)).cars.map(item => item.model?.asset)).toEqual([car.asset]);
  });

  it('snaps a contributed 90° curve at both marked ends as a built-in piece does, and Test drive follows its arc', async () => {
    const { load, throughCurve, pieces, fit, traversal } = await app();
    await load(sample());
    const layout = throughCurve(CURVE);
    expect(layout.routes.map(item => item.pieces.map(piece => piece.family))).toEqual([['printed_straight', CURVE, 'printed_straight']]);
    const [before, curve, after] = layout.routes[0].pieces;
    // Each marked end mates its neighbour's end exactly: same point, facing each other.
    for (const [a, b] of [[before, curve], [curve, after]]) {
      const out = pieces.piecePorts(a, layout).find(port => port.id === 'out')!, into = pieces.piecePorts(b, layout).find(port => port.id === 'in')!;
      expect(Math.hypot(out.x - into.x, out.y - into.y, out.z - into.z)).toBeLessThan(1e-6);
      expect(Math.cos(out.heading - into.heading)).toBeCloseTo(-1, 9);
    }
    const fitted = fit.fitProject(layout);
    expect(fitted.issues.filter(issue => issue.severity === 'error')).toEqual([]);
    expect(fitted.partInstances.map(part => part.family)).toEqual(['printed_straight', CURVE, 'printed_straight']);
    const path = traversal.routePath(fitted.sections, layout.routes[0].id);
    const straight = pieces.pieceRun(before, layout);
    expect(path.gap).toBeNull();
    expect(path.length).toBeCloseTo(2 * straight + 120 * Math.PI / 2, 0);
    // Halfway round the arc the train faces 45° left, 120 mm from the curve's centre (left of its start).
    const centre = { x: curve.x - 120 * Math.sin(curve.heading), y: curve.y + 120 * Math.cos(curve.heading) };
    for (const share of [0.25, 0.5, 0.75]) {
      const pose = traversal.samplePath(path, straight + share * 120 * Math.PI / 2)!;
      expect(Math.hypot(pose.x - centre.x, pose.y - centre.y)).toBeCloseTo(120, 0);
      expect(Math.cos(pose.heading - curve.heading - share * Math.PI / 2)).toBeCloseTo(1, 3);
    }
  });

  it('registers a piece from its index entry without downloading its STL: the prepare checks the STL against the digest', async () => {
    const { load, pieces } = await app();
    const requests: string[] = [], digest = '0'.repeat(64);
    // Even a digest that the STL doesn't match: the app never sees the STL.
    const index = edited(item => item.id === CURVE ? { ...item, digest } : item);
    expect(await load(index, { fetcher: bucket(index, requests) as typeof fetch })).toEqual({ loaded: true, refused: [] });
    expect(requests.map(url => url.replace('https://library.test/plateway-library/', '')).sort())
      .toEqual(['furniture/community_plain_table/1/table.json', 'index.json', 'trains/community_sample_loco/1/car.glb']);
    expect(pieces.pieceDefinition(CURVE)).toMatchObject({ label: 'Sample 90° curve', community: { id: CURVE, digest } });
  });

  it('is ready to render once the index is in, its pieces registered, while slow train and furniture files register later; a timed-out train alone is refused', async () => {
    const { library, pieces, furniture, trains } = await app();
    const slow = slowTrain();
    const { indexed, settled } = library.loadLibrary({ url: INDEX_URL, fetcher: slow.fetcher });
    let changes = 0;
    library.onLibraryChange(() => changes++);
    expect(await indexed).toEqual({ loaded: true, refused: [] });
    expect(pieces.findPieceDefinition(CURVE)?.label).toBe('Sample 90° curve');
    // The furniture file is not slow: it registers while the train's is still held back.
    await vi.waitFor(() => expect(furniture.furnitureType(TABLE).placeholder).toBeUndefined());
    expect(changes).toBe(1);
    expect(trains.libraryModel(`library:${LOCO}@${sample().items[1].digest}`)).toBeUndefined();
    slow.release();
    expect(await settled).toEqual({ loaded: true, refused: [] });
    expect(changes).toBe(2);
    expect(trains.libraryModel(`library:${LOCO}@${sample().items[1].digest}`)).toBeDefined();
    expect((await trains.loadTrainCatalogue()).sets.map(set => set.id)).toEqual([LOCO]);

    const again = await app();
    const timedOut = await again.load(sample(), { fetcher: slowTrain().fetcher, fileTimeout: 50 });
    expect(timedOut).toEqual({ loaded: true, refused: [{ id: LOCO, reason: expect.stringMatching(/^Its file did not download \(.+\)\.$/) }] });
    expect(again.library.libraryLoad()).toEqual(timedOut);
    expect(again.pieces.findPieceDefinition(CURVE)).toBeDefined();
    expect(again.furniture.furnitureType(TABLE).placeholder).toBeUndefined();
    expect((await again.trains.loadTrainCatalogue()).sets).toEqual([]);
  });

  it('refuses a train or furniture file whose digest differs from the index: that train is not offered and its model never loads', async () => {
    const { load, trains, furniture } = await app();
    const wrong = '0'.repeat(64);
    const loaded = await load(edited(item => item.id === LOCO || item.id === TABLE ? { ...item, digest: wrong } : item));
    expect(loaded.loaded).toBe(true);
    // Trains and furniture settle independently, so the refusals come in either order.
    expect(loaded.refused.sort((a, b) => a.id.localeCompare(b.id))).toEqual([{ id: TABLE, reason: 'Its file does not match the index digest.' },
      { id: LOCO, reason: 'Its file does not match the index digest.' }]);
    expect((await trains.loadTrainCatalogue()).sets).toEqual([]);
    expect(trains.libraryModel(`library:${LOCO}@${wrong}`)).toBeUndefined();
    expect(trains.libraryModel(`library:${LOCO}@${sample().items[1].digest}`)).toBeUndefined();
    expect(furniture.furnitureType(TABLE).placeholder).toBe(true);
  });

  it('keeps a saved car model reference to a bundled or library-pinned file only', async () => {
    const { project } = await app();
    const digest = 'a'.repeat(64);
    for (const asset of ['trains/60052-1/loco.glb', `library:${LOCO}@${digest}`]) expect(project.CAR_ASSET.test(asset), asset).toBe(true);
    for (const asset of [`library:${LOCO}`, `library:${LOCO}@${digest.toUpperCase()}`, `library:train@${digest}`, `library:${LOCO}@${digest}x`,
      'https://evil.example/loco.glb', `library:${LOCO}@${digest}/../x.glb`]) expect(project.CAR_ASSET.test(asset), asset).toBe(false);
  });

  it('leaves a retired item out of the palette and picker, but a layout that uses it still opens, shows and fits it', async () => {
    const saved = await savedCurveLayout();
    const { load, sidebar, project, pieces, fit, tiles, furniture, trains } = await app();
    await load(edited(item => item.state === 'live' ? { ...item, state: 'retired' } : item));
    const opened = project.parseProject(saved);
    expect(project.unavailablePieces(opened)).toEqual([]);
    expect(pieces.pieceDefinition(CURVE).label).toBe('Sample 90° curve');
    expect(fit.fitProject(opened).issues.filter(issue => issue.severity === 'error')).toEqual([]);
    expect(section(sidebar(opened), 'community')).toBe('');
    expect(tiles.furnitureTiles().map(tile => tile.family)).not.toContain(TABLE);
    expect(furniture.furnitureType(TABLE).placeholder).toBeUndefined();
    expect((await trains.loadTrainCatalogue()).sets).toEqual([]);
    expect(trains.libraryModel(`library:${LOCO}@${sample().items[1].digest}`)).toBeDefined();
  });

  it('freezes a layout through a retired community piece for printing: the piece by id and digest, without print settings', async () => {
    const saved = await savedCurveLayout();
    const { load, project, fit, manifest } = await app();
    await load(edited(item => item.id === CURVE ? { ...item, state: 'retired' } : item));
    const opened = project.parseProject(saved);
    const frozen = manifest.freezeManifest(opened, fit.fitProject(opened));
    expect(frozen.library).toEqual([{ id: CURVE, version: 1, digest: sample().items[0].digest }]);
    expect(frozen.instances.map(part => [part.family, part.parameters])).toEqual([
      ['printed_straight', expect.objectContaining({ connector_version: 1 })], [CURVE, {}], ['printed_straight', expect.objectContaining({ connector_version: 1 })]]);
    expect(frozen.pieceNames[opened.routes[0].pieces[1].id]).toBe('Sample 90° curve');
  });

  it('opens a layout that uses a removed item with the placeholder: selectable, listed in Checks, deletable, and Prepare disabled with the reload message', async () => {
    const saved = JSON.parse(await savedCurveLayout());
    // Owned brick track either side: the placeholder is the layout's only printed piece.
    saved.routes[0].pieces[1].family = REMOVED;
    saved.routes[0].pieces[0].family = saved.routes[0].pieces[2].family = 'brick_straight_nominal';
    const { load, project, pieces, fit, checks, panel, piecePanel, operations } = await app();
    await load(sample());
    const opened = project.parseProject(JSON.stringify(saved));
    const placeholder = opened.routes[0].pieces[1];
    expect(project.unavailablePieces(opened)).toEqual([{ id: placeholder.id, family: REMOVED }]);
    expect(pieces.pieceDefinition(REMOVED).label).toBe('Unavailable piece');
    const fitted = fit.fitProject(opened);
    const reload = 'A piece is not in the library: reload the page to load the library again, or replace the piece.';
    expect(checks.buildChecks(opened, fitted)).toContainEqual(expect.objectContaining({ severity: 'error', title: reload,
      targets: expect.objectContaining({ pieceIds: [placeholder.id] }) }));
    const none = () => {};
    const selected = renderToStaticMarkup(createElement(piecePanel.SelectedPiecePanel, { project: opened, piece: placeholder, committed: placeholder,
      fit: fitted, account: { status: 'offline' }, fastAvailable: true, stock: () => undefined, actions: [], onChange: none, onDraft: none,
      onCommitDraft: none, onClose: none }));
    expect(selected).toContain('Unavailable piece');
    expect(selected).toContain('This piece is not in the library any more.');
    const print = renderToStaticMarkup(createElement(panel.ExportPanel, { project: opened, fit: fitted,
      account: { status: 'member', member: { id: 'u1', email: 'ada@example.com', displayName: 'Ada', verified: true, purgeAt: null } },
      onNeedAccount: none, saveRevision: async () => null, onReceipt: none, onChange: none, onEditMeasurement: none, receipts: [] }));
    expect(print).toMatch(/<button id="prepare-plates" disabled="">Prepare plates<\/button>/);
    expect(print).toMatch(/<p class="export-gate" role="status">Fix the track first: [^<]*A piece is not in the library: reload the page/);
    const removed = operations.removePiece(opened, placeholder.id);
    expect(removed.routes.flatMap(item => item.pieces).map(piece => piece.family)).toEqual(['brick_straight_nominal', 'brick_straight_nominal']);
    expect(project.unavailablePieces(removed)).toEqual([]);
  });

  it('leaves the built-in palette working when the index does not load, and community pieces open as placeholders', async () => {
    const saved = await savedCurveLayout();
    for (const failure of ['fail', 'offline', { format: 2, items: [] }] satisfies Source[]) {
      const { load, sidebar, createStandardProject, project, pieces, operations, fit } = await app();
      const loaded = await load(failure);
      expect(loaded.loaded).toBe(false);
      expect(loaded.error).toBeTruthy();
      const shown = sidebar(createStandardProject('Built-in'));
      expect(section(shown, 'community')).toBe('');
      expect(section(shown, 'track')).toContain('title="Straight');
      const laid = operations.placePiece(createStandardProject('Still works'), 'printed_straight', { x: 600, y: 600 })[0];
      expect(fit.fitProject(laid).issues.filter(issue => issue.severity === 'error')).toEqual([]);
      const opened = project.parseProject(saved);
      expect(project.unavailablePieces(opened).map(piece => piece.family)).toEqual([CURVE]);
      expect(pieces.pieceDefinition(CURVE).label).toBe('Unavailable piece');
    }
  });
});
