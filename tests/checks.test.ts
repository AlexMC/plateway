import { describe, expect, it } from 'vitest';
import { createProject, parseProject, setMeasurement, type Car, type WorkshopProject } from '../src/domain/project';
import { piecePorts, primaryEnd } from '../src/domain/pieces';
import { fitProject } from '../src/fitting/fit';
import { buildChecks, targetBounds, type Check } from '../src/editor/checks';
import { layClimb, placeKitPieces } from '../src/editor/elevation-kits';
import { layHelix, minimumRise, type HelixOptions } from '../src/editor/helix';
import { placeFurniture } from '../src/editor/furniture';
import { placePiece, type TileFamily } from '../src/editor/operations';
import { cubbyPose } from '../src/plan/build';
import { overpass, WAGON } from './overpass';
import task2 from './fixtures/task2-junction.json';

const checksOf = (project: WorkshopProject) => buildChecks(project, fitProject(project));
const brick = (cars: Car[] = []): WorkshopProject => ({ ...createProject('Checks'), trackSystem: 'brick-v1', cars });
const pieceIds = (project: WorkshopProject, route = 0) => project.routes[route].pieces.map(piece => piece.id);
function extend(project: WorkshopProject, family: TileFamily, params?: Record<string, number>): WorkshopProject {
  const end = primaryEnd(project.routes[0].pieces.at(-1)!, project);
  return placePiece(project, family, { x: end.x, y: end.y, z: end.z, heading: end.heading, ...(params ? { params } : {}) })[0];
}
const TALL: Car = { id: 'tall', name: 'Double-decker', length: 230, width: 62, height: 120, wheelbase: 140, couplerGap: 8 };
const HELIX: HelixOptions = { radius: 576, turns: 2, rise: minimumRise(576), hand: 1, direction: 1, columns: 8, side: 1, offset: 56 };
/** Level track run in under a helix (inside the default room): its first turn passes over the entry, so the route crosses itself there. */
function helixLayout(cars: Car[], options: Partial<HelixOptions> = {}): WorkshopProject {
  let project = placePiece(brick(cars), 'track_straight', { x: 1500, y: 850, params: { length: 256 } })[0];
  const end = primaryEnd(project.routes[0].pieces[0], project);
  [project] = placeKitPieces(project, layHelix(project, end, { ...HELIX, ...options }));
  return project;
}

describe('Build checks', () => {
  it('puts every piece past a wall into one room row that offers the room size', () => {
    let project = setMeasurement(setMeasurement(createProject('Room'), 'roomWidth', 1000), 'roomDepth', 1000);
    [project] = placePiece(project, 'printed_straight', { x: 1500, y: 300 });
    [project] = placePiece(project, 'printed_straight', { x: 1500, y: 700 });
    const checks = checksOf(project), room = checks.filter(check => check.id === 'room');
    expect(room).toHaveLength(1);
    expect(room[0]).toMatchObject({ severity: 'error', title: 'Track leaves the room', action: 'room-size' });
    expect(room[0].detail).toMatch(/leaves the 1000 × 1000 mm room: \d+ mm past x = 1000/);
    expect(room[0].targets.pieceIds.sort()).toEqual([...pieceIds(project, 0), ...pieceIds(project, 1)].sort());
    expect(checks.filter(check => check.severity === 'error')).toHaveLength(1);
  });

  it('holds track and its supports to the default room, outlining only what leaves it', () => {
    let project = placePiece(createProject('Default room'), 'vertical_transition', { x: 1300, y: 500, rise: 40 })[0];
    for (let index = 0; index < 4; index++) project = extend(project, 'printed_straight');
    const fit = fitProject(project), room = buildChecks(project, fit).find(check => check.id === 'room')!;
    const ids = pieceIds(project), stray = fit.supports.filter(support => support.pose.x > 2400.5).map(support => support.id);
    expect(room.detail).toMatch(/^Track \(.+\) leaves the 2400 × 2100 mm room: \d+ mm past x = 2400/);
    expect(room.targets.pieceIds).not.toContain(ids[0]);
    expect(room.targets.pieceIds).toContain(ids.at(-1));
    expect(stray.length).toBeGreaterThan(0);
    expect(room.targets.supportIds).toEqual(stray);
  });

  it('has no room or shelf row while the track stays in the room and clear of the shelves', () => {
    const [project] = placePiece(createProject('Inside'), 'printed_straight', { x: 500, y: 500 });
    expect(checksOf(project).filter(check => check.id === 'room' || check.id.startsWith('shelf'))).toEqual([]);
  });

  it('flags track through a KALLAX\'s panels but not track entering a cubby on its floor', () => {
    const [shelved, shelfId] = placeFurniture(brick(), { x: 1200, y: 1800 }, 0);
    const shelf = shelved.furniture.find(item => item.id === shelfId)!;
    // Floor level, a clear straight and then one into the bottom panel of the middle cubby (its floor is 38 mm up).
    const through = extend(placePiece(shelved, 'track_straight', { x: 1200, y: 1300, heading: Math.PI / 2, params: { length: 256 } })[0], 'track_straight', { length: 256 });
    const hit = checksOf(through).filter(check => check.id.startsWith('shelf'));
    expect(hit).toEqual([expect.objectContaining({ id: 'shelf:K1', severity: 'error', title: 'Track runs into K1' })]);
    expect(hit[0].detail).toMatch(/^Track \(.+\) runs into K1's panels around \(\d+, \d+\) at z \d+–\d+ mm\.$/);
    expect(hit[0].targets.pieceIds).toEqual([pieceIds(through)[1]]);
    const pose = cubbyPose(shelf, 1, 3, 'front');
    const [cubby] = placePiece(shelved, 'track_straight', { ...pose, params: { length: 256 } });
    expect(checksOf(cubby).filter(check => check.id === 'room' || check.id.startsWith('shelf'))).toEqual([]);
  });

  it('points an owned shortfall at the extra pieces and switches them to printed in one change', () => {
    let project = createProject('Shortfall');
    project.inventory.brick_straight_nominal = 1;
    [project] = placePiece(project, 'brick_straight_nominal', { x: 500, y: 500 });
    project = extend(extend(project, 'brick_straight_nominal'), 'brick_straight_nominal');
    const shortfall = checksOf(project).find(check => check.id.startsWith('shortfall:'))!;
    expect(shortfall).toMatchObject({ severity: 'warning', title: '2 more Straights than you own' });
    expect(shortfall.targets.pieceIds).toEqual(pieceIds(project).slice(1));
    const fixed = shortfall.fix!.apply(project);
    expect(checksOf(fixed).some(check => check.id.startsWith('shortfall:'))).toBe(false);
  });

  it('shows the steepest ramp and the grade advice for it as one row over every steep piece', () => {
    let project = placePiece(brick(), 'track_straight', { x: 300, y: 1000, params: { length: 128 } })[0];
    const start = piecePorts(project.routes[0].pieces[0], project).find(port => port.id === 'out')!;
    [project] = placeKitPieces(project, layClimb(start, { target: 96, grade: 5 }).pieces);
    const fit = fitProject(project), checks = buildChecks(project, fit);
    const steep = fit.issues.filter(issue => issue.code === 'grade-steep');
    expect(steep.length).toBeGreaterThan(0);
    const ramps = checks.filter(check => /ramp|grade/i.test(check.title));
    expect(ramps).toHaveLength(1);
    expect(ramps[0]).toMatchObject({ severity: 'warning', title: 'Steepest ramp 5.0%' });
    expect(ramps[0].detail).toMatch(/^Long or heavy trains may stall/);
    expect(ramps[0].targets.pieceIds.sort()).toEqual([...new Set(steep.map(issue => issue.span![0].split(':')[0]))].sort());
  });

  it('points a crossing at its two crossing pieces and says what its clearance is measured against', () => {
    const project = overpass();
    const [ramp, deck] = pieceIds(project), [lower] = pieceIds(project, 1);
    const clear = checksOf(project).find(check => check.id.startsWith('crossing:'))!;
    // Clear for these cars; the standard-clearance advice for the same crossing folds into its row.
    expect(clear.severity).toBe('warning');
    expect(clear.detail).toMatch(/standard clearance is 118 mm/);
    expect(clear.title).toMatch(/^Crossing clear: \d+ mm, needs 74 mm$/);
    expect(clear.targets.pieceIds.sort()).toEqual([deck, lower].sort());
    expect(clear.targets.pieceIds).not.toContain(ramp);
    expect(clear.targets.points).toHaveLength(2);
    const noCars = checksOf(overpass({ cars: [] })).find(check => check.id.startsWith('crossing:'))!;
    expect(noCars).toMatchObject({ severity: 'warning', title: 'Crossing not checked: no cars', action: 'add-cars' });
    const noDeck = checksOf(overpass({ deck: 'printed_straight' })).find(check => check.id.startsWith('crossing:'))!;
    expect(noDeck).toMatchObject({ severity: 'warning', title: 'Crossing not checked: no bridge deck' });
    expect(noDeck.detail).toMatch(/Bridge piece/);
  });

  it('points a support collision at the support and the track it stands in', () => {
    const project = overpass({ cars: [{ ...WAGON, width: 500 }] });
    const fit = fitProject(project);
    const support = buildChecks(project, fit).find(check => check.title.startsWith('A support stands'))!;
    expect(support.targets.supportIds!.length).toBeGreaterThan(0);
    expect(support.targets.supportIds!.every(id => fit.supports.some(item => item.id === id))).toBe(true);
    expect(support.targets.pieceIds).toContain(pieceIds(project, 1)[0]);
    expect(support.targets.pieceIds.some(id => pieceIds(project).includes(id))).toBe(true);
  });

  it('points open ends at the ends, with the gap closer as their action', () => {
    const [project] = placePiece(createProject('Ends'), 'printed_straight', { x: 500, y: 500 });
    const ends = checksOf(project).find(check => check.id === 'open-ends')!;
    expect(ends).toMatchObject({ severity: 'info', title: '2 open ends', action: 'close-gap' });
    expect(ends.targets.pieceIds).toEqual(pieceIds(project));
    expect(ends.targets.points!.map(point => Math.round(point.x)).sort((a, b) => a - b)).toEqual([500, 500 + Math.round(primaryEnd(project.routes[0].pieces[0], project).x - 500)]);
  });

  it('points a 9V power gap at the joints where power stops', () => {
    let project = placePiece(createProject('Mixed'), 'track_straight', { x: 0, y: 0, params: { metal: 1 } })[0];
    project = extend(extend(project, 'track_straight'), 'track_straight', { metal: 1 });
    const gap = checksOf(project).find(check => check.title.startsWith('Track power stops'))!;
    expect(gap.severity).toBe('warning');
    expect(gap.targets.pieceIds.sort()).toEqual(pieceIds(project).sort());
    expect(gap.targets.points).toHaveLength(2);
  });

  it('frames a check from its pieces, points and supports', () => {
    const project = overpass(), fit = fitProject(project);
    const crossing = buildChecks(project, fit).find(check => check.id.startsWith('crossing:'))!;
    const bounds = targetBounds(project, fit, crossing.targets)!;
    for (const point of crossing.targets.points!) {
      expect(point.x).toBeGreaterThanOrEqual(bounds.min.x);
      expect(point.x).toBeLessThanOrEqual(bounds.max.x);
    }
    expect(bounds.max.z).toBeCloseTo(90, 0);
    expect(targetBounds(project, fit, { pieceIds: [] })).toBeNull();
  });
});

describe('helix clearance check', () => {
  it('blocks a crossing under a helix turn the tallest car does not fit under, and clears it once it fits', { timeout: 30000 }, () => {
    const low = fitProject(helixLayout([TALL], { rise: 128 }));
    expect(low.crossings).toHaveLength(1);
    expect(low.crossings[0]).toMatchObject({ status: 'blocked', needed: 120 });
    expect(low.crossings[0].clearance!).toBeLessThan(120);
    const clear = fitProject(helixLayout([WAGON], { rise: 128 }));
    expect(clear.crossings[0]).toMatchObject({ status: 'digitally-clear', needed: WAGON.height });
    const unknown = fitProject(helixLayout([], { rise: 128 }));
    expect(unknown.crossings[0].status).toBe('unknown');
    expect(unknown.crossings[0].clearance).toBeCloseTo(low.crossings[0].clearance!, 6);
  });

  it('is one row over the helix and the crossing under it, whose fix raises the rise per turn until it clears', { timeout: 30000 }, () => {
    const project = helixLayout([TALL], { rise: 128 });
    const checks = checksOf(project);
    const helix = checks.find(check => check.id.startsWith('helix:'))!;
    expect(checks.some(check => check.id.startsWith('crossing:'))).toBe(false);
    expect(helix.severity).toBe('error');
    expect(helix.targets.pieceIds.length).toBeGreaterThan(0);
    expect(helix.targets.pieceIds.every(id => pieceIds(project).includes(id))).toBe(true);
    expect(helix.targets.points!.length).toBeGreaterThanOrEqual(3);
    expect(helix.fix!.label).toMatch(/^Raise helix to [\d.]+ mm per turn$/);
    const fixed = helix.fix!.apply(project), fit = fitProject(fixed);
    expect(fit.issues.filter(issue => issue.code === 'helix-clearance')).toEqual([]);
    expect(fit.crossings[0].status).toBe('digitally-clear');
    expect(buildChecks(fixed, fit).some((check: Check) => check.id.startsWith('helix:') || check.severity === 'error')).toBe(false);
  });
});

describe('a fix\'s consequences', () => {
  it('says before the click that the junction fix runs the siding into K1, and still offers it', () => {
    // The "Task2" save: a climb starting right at a left turnout, its siding ending just short of a KALLAX's panels.
    const project = parseProject(JSON.stringify(task2)), junction = checksOf(project).find(check => check.id.includes('junction-on-slope'))!;
    expect(checksOf(project).some(check => check.id.startsWith('shelf'))).toBe(false);
    expect(junction.fix).toMatchObject({ label: 'Level first: 128 mm', note: 'Then track runs into K1.' });
    const fixed = junction.fix!.apply(project);
    expect(checksOf(fixed).find(check => check.id === 'shelf:K1')?.severity).toBe('error');
    expect(checksOf(fixed).some(check => check.id.includes('junction-on-slope'))).toBe(false);
  });
});
