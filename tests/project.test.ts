import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROJECT_VERSION, createProject, parseProject, serializeProject, changeProject, missingPrintMeasurements, setMeasurement,
  carsNeededForClearance, trainEnvelope, unavailablePieces, type Car } from '../src/domain/project';
import { pieceDefinition, piecePaths, primaryEnd } from '../src/domain/pieces';
import { fitProject } from '../src/fitting/fit';
import { placePiece } from '../src/editor/operations';

const WAGON: Car = { id: 'wagon', name: 'Wagon', length: 200, width: 62, height: 74, wheelbase: 120, couplerGap: 8 };

describe('editable workshop project', () => {
  it('preserves authored routes, crossings, cars and measurements across a save and reload', () => {
    let project = createProject('Crossing');
    project = placePiece(project, 'printed_straight', { x: 100, y: 500 })[0];
    project = placePiece(project, 'printed_brick_straight', { x: 180, y: 400, heading: Math.PI / 2 }, 0)[0];
    project = setMeasurement(project, 'roomWidth', 3000);
    project.crossings = [{ id: 'cross-1', upperRouteId: project.routes[0].id, lowerRouteId: project.routes[1].id }];
    project.furniture = [{ id: 'shelf-1', family: 'kallax_5x5', x: 1200, y: 1050, quarterTurns: 1 }];
    project.cars = [WAGON, { ...WAGON, id: 'demo', example: true }];
    expect(parseProject(serializeProject(project))).toEqual(project);
  });

  it('changes the layout revision only for edits that change generated parts', () => {
    const project = placePiece(createProject('Before'), 'printed_straight', { x: 500, y: 500 })[0];
    const renamed = changeProject(project, draft => { draft.name = 'After'; });
    expect(project.name).toBe('Before');
    expect(renamed.revision).not.toBe(project.revision);
    expect(renamed.layoutRevision).toBe(project.layoutRevision);
    for (const edit of [
      (draft: typeof project) => { draft.cars.push(WAGON); },
      (draft: typeof project) => { draft.inventory.brick_straight_nominal = 4; },
      (draft: typeof project) => { draft.measurements.roomWidth = { value: 3000, source: 'Entered in Setup', measuredAt: '2026-09-25' }; }
    ]) expect(changeProject(project, edit).layoutRevision).toBe(project.layoutRevision);
    const moved = changeProject(project, draft => { draft.routes[0].pieces[0].x += 10; draft.routes[0].points.forEach(point => { point.x += 10; }); });
    expect(moved.layoutRevision).toBe(moved.revision);
    expect(changeProject(project, draft => { draft.material = 'PETG'; }).layoutRevision).not.toBe(project.layoutRevision);
    expect(changeProject(project, draft => { draft.printer = 'A1 mini'; }).layoutRevision).not.toBe(project.layoutRevision);
    expect(changeProject(project, draft => { draft.routes[0].pieces[0].style = 'fast'; }).layoutRevision).not.toBe(project.layoutRevision);
  });

  it('treats a typed value as measured and asks for rail measurements only for custom-joiner track', () => {
    const project = createProject('Custom');
    expect(missingPrintMeasurements(project)).toEqual([]);
    project.trackSystem = 'custom-joiner-v1';
    expect(missingPrintMeasurements(project)).toContain('railGauge');
    project.measurements.railGauge = { value: 40, source: 'Default', status: 'estimate' };
    expect(missingPrintMeasurements(project)).toContain('railGauge');
    const typed = setMeasurement(project, 'railGauge', 40);
    expect(missingPrintMeasurements(typed)).not.toContain('railGauge');
    expect(missingPrintMeasurements(setMeasurement(typed, 'railGauge', null))).toContain('railGauge');
  });

  it('derives the train envelope from real cars and asks for them only when a layout has an overpass', () => {
    const project = createProject('Cars');
    project.routes = [{ id: 'loop', name: 'Loop', points: [], pieces: [] }];
    project.cars = [{ ...WAGON, id: 'demo', height: 150, width: 90, example: true }];
    expect(trainEnvelope(project)).toBeNull();
    expect(carsNeededForClearance(project)).toBe(false);
    project.crossings = [{ id: 'self', upperRouteId: 'loop', lowerRouteId: 'loop' }];
    expect(carsNeededForClearance(project)).toBe(true);
    project.cars.push(WAGON, { ...WAGON, id: 'long', length: 260, height: 60 });
    expect(trainEnvelope(project)).toEqual({ width: 62, height: 74, length: 260 });
    expect(carsNeededForClearance(project)).toBe(false);
    expect(parseProject(serializeProject(project)).crossings).toEqual(project.crossings);
  });

  it('rejects malformed or unsupported saved projects', () => {
    expect(() => parseProject('{"version":999}')).toThrow(/version/i);
    expect(() => parseProject('{"version":1,"routes":[]}')).toThrow(/project/i);
  });

  it('upgrades v1 and v2 shelves while preserving other collections and authored routes', () => {
    const current = createProject('Recorded earlier');
    current.routes = [{
      id: 'line', name: 'Line',
      points: [{ id: 'a', x: 0, y: 0, z: 0 }, { id: 'b', x: 128, y: 0, z: 0 }],
      pieces: [{ id: 'tile', family: 'brick_straight_nominal', x: 0, y: 0, z: 0, heading: 0 }]
    }];
    current.crossings = [];
    current.observations = [{
      id: 'trial', kind: 'fit', passed: true, material: 'PLA', printer: 'X1 Carbon',
      orientation: 'flat', consistId: 'loco', notes: '', recordedAt: '2026-09-25'
    }];
    current.inventory.brick_straight_nominal = 14;
    current.measurements.roomWidth = { value: 3000, source: 'Room measurement', measuredAt: '2026-09-25' };
    current.measurements.roomDepth = { value: 2200, source: 'Room measurement', measuredAt: '2026-09-25' };
    for (const version of [1, 2]) {
      const prior = structuredClone(current) as unknown as Record<string, unknown>;
      prior.version = version;
      delete prior.furniture;
      (prior.measurements as Record<string, unknown>).kallaxOpeningWidth = { value: 335, source: 'estimate', status: 'estimate' };
      (prior.measurements as Record<string, unknown>).kallaxOpeningHeight = { value: 335, source: 'estimate', status: 'estimate' };
      (prior.measurements as Record<string, unknown>).behindShelfDepth = { value: 300, source: 'estimate', status: 'estimate' };
      if (version === 1) {
        delete prior.printSettings;
      }
      for (const shelfFlag of [undefined, 1, 2]) {
        const saved = structuredClone(prior);
        saved.partDesign = shelfFlag === undefined ? { deck_width: 60 } : { deck_width: 60, setup_shelf_crossing: shelfFlag };
        const reopened = parseProject(JSON.stringify(saved));
        expect(reopened.version).toBe(PROJECT_VERSION);
        expect(reopened.routes).toEqual(current.routes);
        expect(reopened.observations).toEqual(current.observations);
        expect(reopened.inventory).toEqual(current.inventory);
        expect(reopened.layoutRevision).toBe(current.layoutRevision);
        expect(reopened.partDesign).toEqual({ deck_width: 60 });
        expect(reopened.furniture).toEqual(shelfFlag === 2 ? [] : [{
          id: 'kallax-5x5-legacy', family: 'kallax_5x5', x: 1500, y: 1100, quarterTurns: 0
        }]);
        expect(reopened.measurements).not.toHaveProperty('kallaxOpeningWidth');
        expect(reopened.measurements).not.toHaveProperty('kallaxOpeningHeight');
        expect(reopened.measurements).not.toHaveProperty('behindShelfDepth');
      }
    }
  });
  it('centres an inherited shelf in the default room when legacy dimensions are unmeasured', () => {
    const prior = createProject('Unmeasured legacy') as unknown as Record<string, unknown>;
    prior.version = 1;
    delete prior.furniture;
    delete prior.partDesign;
    delete prior.printSettings;
    expect(parseProject(JSON.stringify(prior)).furniture).toEqual([{
      id: 'kallax-5x5-legacy', family: 'kallax_5x5', x: 1200, y: 1050, quarterTurns: 0
    }]);
  });
  it('rejects missing, repeated, non-finite, and unsupported furniture', () => {
    const project = createProject('Invalid furniture');
    project.furniture = [{ id: 'shelf', family: 'kallax_5x5', x: 1200, y: 1050, quarterTurns: 0 }];
    const invalid = [
      { furniture: undefined },
      { furniture: [project.furniture[0], project.furniture[0]] },
      { furniture: [{ ...project.furniture[0], id: '' }] },
      { furniture: [{ ...project.furniture[0], family: '' }] },
      { furniture: [{ ...project.furniture[0], x: null }] },
      { furniture: [{ ...project.furniture[0], y: '200' }] },
      { furniture: [{ ...project.furniture[0], quarterTurns: -1 }] },
      { furniture: [{ ...project.furniture[0], quarterTurns: 4 }] },
      { furniture: [{ ...project.furniture[0], quarterTurns: 1.5 }] }
    ];
    for (const mutation of invalid) {
      expect(() => parseProject(JSON.stringify({ ...project, ...mutation }))).toThrow(/furniture|collections/);
    }
    expect(() => serializeProject({ ...project, furniture: [{ ...project.furniture[0], x: Infinity }] })).toThrow(/furniture/);
    expect(() => serializeProject({ ...project, furniture: [{ ...project.furniture[0], y: NaN }] })).toThrow(/furniture/);
  });
  it('drops retired settings and waypoint-only routes from saved projects', () => {
    const project = placePiece(createProject('Saved v4'), 'brick_curve_r40', { x: 500, y: 500 })[0];
    const kept = project.routes[0].id;
    const saved = JSON.parse(serializeProject(project));
    saved.measurements.trainHeight = { value: 118, source: 'Planning estimate', status: 'estimate' };
    saved.measurements.locomotiveLength = { value: null, source: 'unknown' };
    saved.railSource = { [kept]: 'print-only' };
    saved.trialTarget = null;
    saved.printSettings.orientation = 'side';
    saved.routes.push({ id: 'waypoints', name: 'Old', points: [{ id: 'a', x: 0, y: 0, z: 0 }, { id: 'b', x: 500, y: 0, z: 0 }] });
    saved.crossings = [{ id: 'old', upperRouteId: 'waypoints', lowerRouteId: kept }];
    const reopened = parseProject(JSON.stringify(saved));
    expect(reopened.routes.map(route => route.id)).toEqual([kept]);
    expect(reopened.crossings).toEqual([]);
    expect(Object.keys(reopened.measurements)).not.toContain('trainHeight');
    expect(Object.keys(reopened.measurements)).not.toContain('locomotiveLength');
    expect(reopened.printSettings.orientation).toBe('flat');
    expect(reopened).not.toHaveProperty('railSource');
    expect(reopened).not.toHaveProperty('trialTarget');
    expect(reopened.layoutRevision).toBe(project.layoutRevision);
  });
  it('turns a saved project-wide fast style into fast printed pieces and leaves owned brick track alone', () => {
    let project = createProject('Before per-piece styles');
    project.inventory.brick_straight_nominal = 1;
    project = placePiece(project, 'brick_straight_nominal', { x: 100, y: 100 })[0];
    project = placePiece(project, 'printed_straight', { x: 700, y: 700 })[0];
    const saved = JSON.parse(serializeProject(project));
    saved.printSettings.trackStyle = 'fast';
    const reopened = parseProject(JSON.stringify(saved));
    expect(reopened.routes.flatMap(route => route.pieces).map(piece => [piece.family, piece.style]))
      .toEqual([['brick_straight_nominal', undefined], ['printed_straight', 'fast']]);
    expect(reopened.printSettings).not.toHaveProperty('trackStyle');
    saved.printSettings.trackStyle = 'detailed';
    expect(parseProject(JSON.stringify(saved)).routes.flatMap(route => route.pieces).every(piece => piece.style === undefined)).toBe(true);
  });
  it('accepts the fast style only on printed pieces', () => {
    let project = createProject('Styles');
    project.inventory.brick_straight_nominal = 1;
    project = placePiece(project, 'brick_straight_nominal', { x: 100, y: 100 })[0];
    project = placePiece(project, 'printed_straight', { x: 700, y: 700 })[0];
    const saved = JSON.parse(serializeProject(project));
    saved.routes[1].pieces[0].style = 'fast';
    expect(parseProject(JSON.stringify(saved)).routes[1].pieces[0].style).toBe('fast');
    saved.routes[1].pieces[0].style = 'draft';
    expect(() => parseProject(JSON.stringify(saved))).toThrow(/authored pieces/);
    delete saved.routes[1].pieces[0].style;
    saved.routes[0].pieces[0].style = 'fast';
    expect(() => parseProject(JSON.stringify(saved))).toThrow(/authored pieces/);
  });
  it('round-trips authored tiles while rejecting malformed family and contradictory topology',()=>{
    const project=createProject('Builder save');
    project.inventory.brick_curve_r40=1;
    const placed=placePiece(project,'brick_curve_r40',{x:200,y:300})[0];
    expect(parseProject(serializeProject(placed)).routes[0].pieces).toEqual(placed.routes[0].pieces);
    const bad=structuredClone(placed) as unknown as { routes: { pieces: Record<string, unknown>[]; points: unknown[] }[] };
    for (const family of ['', 42, null]) {
      bad.routes[0].pieces[0].family=family;
      expect(()=>parseProject(JSON.stringify(bad))).toThrow(/authored pieces/);
    }
    bad.routes[0].pieces[0].family='brick_curve_r40';
    bad.routes[0].points.pop();
    expect(()=>parseProject(JSON.stringify(bad))).toThrow(/topology/);
  });

  it('upgrades a version-4 project and changes nothing else', () => {
    const saved = readFileSync(new URL('./fixtures/task2-junction.json', import.meta.url), 'utf8');
    expect(JSON.parse(saved).version).toBe(4);
    const upgraded = parseProject(saved);
    expect(upgraded.version).toBe(5);
    expect(JSON.parse(serializeProject(upgraded))).toEqual({ ...JSON.parse(saved), version: 5, provenance: { account: null }, parentRevision: null });
    expect(parseProject(serializeProject(upgraded))).toEqual(upgraded);
  });

  it('keeps a member’s draft with its account and saved revision', () => {
    const project = { ...createProject('Mine'), provenance: { account: 'u1' }, parentRevision: crypto.randomUUID() };
    expect(parseProject(serializeProject(project))).toEqual(project);
    expect(createProject('Fresh')).toMatchObject({ provenance: { account: null }, parentRevision: null });
    for (const bad of [{ provenance: null }, { provenance: { account: '' } }, { parentRevision: 7 }])
      expect(() => parseProject(JSON.stringify({ ...project, ...bad }))).toThrow(/identity/);
  });

  it('opens a piece the library no longer has as an unavailable placeholder on its saved footprint and saves it unchanged', () => {
    let project = createProject('Community piece');
    project = placePiece(project, 'printed_straight', { x: 300, y: 400 })[0];
    const open = primaryEnd(project.routes[0].pieces[0], project);
    project = placePiece(project, 'printed_curve_r40', { x: open.x, y: open.y, heading: open.heading })[0];
    expect(project.routes.map(route => route.pieces.length)).toEqual([2]);
    const saved = JSON.parse(serializeProject(project));
    const [first, second] = saved.routes[0].pieces;
    Object.assign(first, { family: 'community_viaduct_v3', params: { arches: 4 }, state: 'open' });
    const text = JSON.stringify(saved);
    const opened = parseProject(text);
    expect(unavailablePieces(opened)).toEqual([{ id: first.id, family: 'community_viaduct_v3' }]);
    const placeholder = opened.routes[0].pieces[0];
    expect(pieceDefinition(placeholder.family).label).toBe('Unavailable piece');
    const end = primaryEnd(placeholder, opened), [path] = piecePaths(placeholder, opened);
    expect(end.x).toBeCloseTo(saved.routes[0].points[1].x);
    expect(end.y).toBeCloseTo(saved.routes[0].points[1].y);
    expect(end.heading).toBeCloseTo(second.heading);
    expect(path.points[0]).toMatchObject({ x: first.x, y: first.y });
    const fit = fitProject(opened);
    expect(fit.issues).toContainEqual(expect.objectContaining({ code: 'piece-not-in-library', span: [`${first.id}:start`, `${first.id}:end`] }));
    expect(fit.issues.some(issue => issue.code === 'piece-pose-mismatch')).toBe(false);
    expect(JSON.parse(serializeProject(opened))).toEqual(saved);
    const renamed = changeProject(opened, draft => { draft.name = 'Still there'; });
    expect(JSON.parse(serializeProject(renamed)).routes).toEqual(saved.routes);
  });
});
