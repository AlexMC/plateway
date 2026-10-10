import { describe, expect, it } from 'vitest';
import saved from './fixtures/session-fix-me.json';
import { createProject, parseProject, type Route, type RoutePiece, type WorkshopProject } from '../src/domain/project';
import { primaryEnd } from '../src/domain/pieces';
import { fitProject } from '../src/fitting/fit';
import { buildChecks, type Check } from '../src/editor/checks';
import { rebuildPiecePoints, unoccupiedPiecePorts } from '../src/editor/operations';

const CURVE = Math.PI / 8;
const checksOf = (project: WorkshopProject) => buildChecks(project, fitProject(project));
const loopRow = (project: WorkshopProject) => checksOf(project).find(check => check.id.startsWith('loop:'));
const families = (project: WorkshopProject) => project.routes.flatMap(route => route.pieces.map(piece => piece.family));
const count = (list: readonly string[], family: string) => list.filter(item => item === family).length;
/** The `.projects` save "Session: fix me": an R40 oval whose left bend has 7 curves and whose top side has one straight less. */
const fixMe = () => parseProject(JSON.stringify(saved));

/** One route of pieces chained from (x, y) heading +x: `S` a straight, `L` an R40 curve to the left, `W` a wide R56 curve. */
function oval(sequence: string, inventory: Record<string, number> = {}): WorkshopProject {
  const project = { ...createProject('Oval'), trackSystem: 'brick-v1' as const };
  project.inventory = { ...project.inventory, ...inventory };
  const pieces: RoutePiece[] = [];
  let pose = { x: 600, y: 300, z: 0, heading: 0 };
  [...sequence].forEach((kind, index) => {
    const piece: RoutePiece = { id: `p${index}`, family: kind === 'S' ? 'brick_straight_nominal' : kind === 'L' ? 'brick_curve_r40' : 'printed_curve_r56', ...pose,
      ...(kind === 'S' ? {} : { sweep: CURVE }) };
    pieces.push(piece);
    const end = primaryEnd(piece, project);
    pose = { x: end.x, y: end.y, z: end.z, heading: end.heading };
  });
  const route: Route = { id: 'loop', name: 'Route 1', points: [], pieces };
  project.routes = [route];
  rebuildPiecePoints(project, route);
  return project;
}
function applyFix(project: WorkshopProject, check: Check): WorkshopProject {
  expect(check.fix).toBeDefined();
  return check.fix!.apply(project);
}

describe('a loop that doesn\'t close', () => {
  it('says the fix-me oval is a curve short and its top side a straight short, pointing at both ends and that side', () => {
    const project = fixMe(), row = loopRow(project)!;
    expect(row).toMatchObject({ severity: 'warning', title: 'Loop doesn\'t close', action: 'close-gap' });
    expect(row.detail).toBe('The loop is 1 curve piece short (22.5°): the left bend has 7 R40 curves, the right bend 8. ' +
      'The top side is 1 straight (128 mm) shorter than the bottom side.');
    const [route] = project.routes, first = route.pieces[0].id, last = route.pieces.at(-1)!.id;
    // The ends face away from each other: no made-to-measure piece can join them, so only the whole-piece fix is offered.
    expect(row.gap).toBeUndefined();
    // Both ends, and the top side's four straights where the straight goes.
    const top = route.pieces.filter(piece => piece.family === 'brick_straight_nominal' && Math.abs(piece.y - 1390) < 1).map(piece => piece.id);
    expect(top).toHaveLength(4);
    expect(row.targets.pieceIds).toEqual(expect.arrayContaining([first, last, ...top]));
    expect(row.targets.points).toHaveLength(2);
  });

  it('keeps the siding\'s dead end a plain open end, with nothing to join it to', () => {
    const project = fixMe(), checks = checksOf(project), ends = checks.find(check => check.id === 'open-ends')!;
    const siding = project.routes[1].pieces.at(-1)!.id;
    expect(ends).toMatchObject({ severity: 'info', title: '1 open end', targets: { pieceIds: [siding] } });
    expect(ends.gap).toBeUndefined();
  });

  it('closes the fix-me loop in one change: the spare owned straight first, a printed curve once all owned curves are in use', () => {
    const project = fixMe(), row = loopRow(project)!;
    expect(row.fix!.label).toBe('Add 1 × 128 mm straight on the top side and 1 curve piece');
    // The far bend moves 128 mm left, past the default room's wall: said before the click, and still offered.
    expect(row.fix!.note).toBe('Straight from your stock (7 of 8 in use) · Curve printed (all 16 owned in use) · ' +
      'Then track leaves the room, 102 mm past the wall at x = 0.');
    expect(checksOf(project).some(check => check.id === 'room')).toBe(false);
    const next = applyFix(project, row), before = families(project), after = families(next);
    expect(count(after, 'brick_straight_nominal')).toBe(count(before, 'brick_straight_nominal') + 1);
    expect(count(after, 'printed_curve_r40')).toBe(count(before, 'printed_curve_r40') + 1);
    expect(count(after, 'brick_curve_r40')).toBe(count(before, 'brick_curve_r40'));
    expect(loopRow(next)).toBeUndefined();
    expect(checksOf(next).find(check => check.id === 'room')?.severity).toBe('error');
    // Only the siding's end is left open.
    expect(unoccupiedPiecePorts(next).map(({ part }) => part.id)).toEqual([project.routes[1].pieces.at(-1)!.id]);
  });

  it('lays an owned curve for the missing one while the stock has one spare', () => {
    const project = fixMe();
    project.inventory = { ...project.inventory, brick_curve_r40: 17 };
    const row = loopRow(project)!;
    expect(row.fix!.note).toMatch(/^Straight from your stock \(7 of 8 in use\) · Curve from your stock \(16 of 17 in use\) · Then track leaves the room/);
    const next = applyFix(project, row);
    expect(count(families(next), 'brick_curve_r40')).toBe(count(families(project), 'brick_curve_r40') + 1);
    expect(count(families(next), 'printed_curve_r40')).toBe(0);
    expect(loopRow(next)).toBeUndefined();
  });

  it('finds the side one straight shorter than its opposite side and closes the loop with a straight there', () => {
    // Three straights along the bottom (the top view has y up), four along the top: the ends stop 128 mm apart, in line.
    const project = oval('SSSLLLLLLLLSSSSLLLLLLLL'), row = loopRow(project)!;
    expect(row.detail).toBe('The bottom side is 1 straight (128 mm) shorter than the top side.');
    expect(row.fix!.label).toBe('Add 1 × 128 mm straight on the bottom side');
    expect(row.fix!.note).toBe('Straight printed (none owned)');
    expect(row.targets.pieceIds).toEqual(expect.arrayContaining(['p0', 'p1', 'p2']));
    const next = applyFix(project, row);
    expect(unoccupiedPiecePorts(next)).toEqual([]);
    expect(checksOf(next).some(check => check.id.startsWith('loop:') || check.id === 'open-ends')).toBe(false);
  });

  it('counts both parts of a side the gap splits', () => {
    // Two straights after the start and one before the end on the bottom side, four on the top side.
    const project = oval('SSLLLLLLLLSSSSLLLLLLLLS', { brick_straight_nominal: 10 }), row = loopRow(project)!;
    expect(row.detail).toBe('The bottom side is 1 straight (128 mm) shorter than the top side.');
    expect(row.fix!.note).toBe('Straight from your stock (7 of 10 in use)');
    expect(unoccupiedPiecePorts(applyFix(project, row))).toEqual([]);
  });

  it('explains ends offset sideways and offers only the made-to-measure closer', () => {
    // A wide R56 bend on one side, an R40 bend on the other and two straights fewer along the bottom: the ends miss sideways.
    const project = oval('SSWWWWWWWWSSSSLLLLLLLL'), row = loopRow(project)!;
    expect(row.detail).toBe('The ends are offset sideways by 256 mm and 256 mm apart along the line (an S-bend or a wider curve on one end would fix it).');
    expect(row.fix).toBeUndefined();
    expect(row.action).toBe('close-gap');
    expect(row.gap!.map(end => `${end.pieceId}:${end.portId}`).sort()).toEqual(['p0:in', 'p21:out']);
  });
});
