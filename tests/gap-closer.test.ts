import { describe, expect, it } from 'vitest';
import { createProject, parseProject, serializeProject, type Route, type RoutePiece, type WorkshopProject } from '../src/domain/project';
import { piecePorts, primaryEnd, type ShapePort } from '../src/domain/pieces';
import { GAP_CLOSER_FAMILY } from '../src/domain/pieces/families/gap-closer';
import { GAP_HEADING_TOLERANCE, GAP_POSITION_TOLERANCE, solveGap, type GapEnd } from '../src/domain/solver/gap';
import { closeGap, gapOptions, nearestGap, openEnds, planGap } from '../src/editor/gap-closer';
import { rebuildPiecePoints } from '../src/editor/operations';

const DEG = Math.PI / 180;
const ORIGIN: GapEnd = { x: 100, y: 200, z: 0, heading: 0.3 };
/** An open end at (x, y) in ORIGIN's frame whose outward heading is `heading` there. */
function endAt(x: number, y: number, heading: number, z = 0): GapEnd {
  const c = Math.cos(ORIGIN.heading), s = Math.sin(ORIGIN.heading);
  return { x: ORIGIN.x + c * x - s * y, y: ORIGIN.y + s * x + c * y, z, heading: ORIGIN.heading + heading };
}

/** A route of pieces chained from `start`; `sweep` makes a curve. */
function route(id: string, start: { x: number; y: number; heading: number }, families: [string, number?][]): Route {
  const pieces: RoutePiece[] = [];
  let pose = { ...start, z: 0 };
  const project = createProject('chain');
  families.forEach(([family, sweep], index) => {
    const piece: RoutePiece = { id: `${id}-${index}`, family, ...pose, ...(sweep === undefined ? {} : { sweep }) };
    pieces.push(piece);
    pose = primaryEnd(piece, project);
  });
  return { id, name: id, points: [], pieces };
}
function layout(...routes: Route[]): WorkshopProject {
  const project = createProject('Gap');
  project.trackSystem = 'brick-v1';
  project.routes = routes;
  for (const item of routes) rebuildPiecePoints(project, item);
  return project;
}
/** The closer's own ports, each within the solver tolerance of the port it meets. */
function expectMated(project: WorkshopProject, id: string, ends: readonly ShapePort[]): void {
  const closer = project.routes.flatMap(item => item.pieces).find(piece => piece.id === id)!;
  expect(closer.family).toBe(GAP_CLOSER_FAMILY);
  for (const own of piecePorts(closer, project)) {
    const other = ends.find(end => Math.hypot(end.x - own.x, end.y - own.y) < 1)!;
    expect(other, own.id).toBeDefined();
    expect(Math.hypot(other.x - own.x, other.y - own.y, other.z - own.z)).toBeLessThan(GAP_POSITION_TOLERANCE);
    expect(Math.abs(Math.atan2(Math.sin(other.heading - own.heading - Math.PI), Math.cos(other.heading - own.heading - Math.PI)))).toBeLessThan(GAP_HEADING_TOLERANCE);
  }
}

describe('gap solver', () => {
  it('bridges collinear facing ends with one straight of exactly the gap', () => {
    const solution = solveGap(ORIGIN, endAt(97.967, 0, Math.PI));
    expect(solution.ok && solution.segments).toEqual([{ len: expect.closeTo(97.967, 9), k0: 0, k1: 0 }]);
  });

  it('turns a square corner with one arc of the corner radius', () => {
    const solution = solveGap(ORIGIN, endAt(320, 320, -Math.PI / 2));
    expect(solution.ok && solution.segments).toEqual([{ len: expect.closeTo(160 * Math.PI, 6), k0: expect.closeTo(1 / 320, 12), k1: expect.closeTo(1 / 320, 12) }]);
  });

  it('turns an uneven corner with the widest arc and the leftover as straight, never a reverse curve', () => {
    const solution = solveGap(ORIGIN, endAt(500, -320, Math.PI / 2));
    expect(solution.ok && solution.segments).toEqual([{ len: expect.closeTo(180, 6), k0: 0, k1: 0 },
      { len: expect.closeTo(160 * Math.PI, 6), k0: expect.closeTo(-1 / 320, 12), k1: expect.closeTo(-1 / 320, 12) }]);
  });

  it('joins offset parallel ends with a symmetric S of the largest possible radius', () => {
    for (const [run, offset] of [[400, 16], [512, 128], [480, -64]]) {
      const solution = solveGap(ORIGIN, endAt(run, offset, Math.PI));
      const radius = (run * run + offset * offset) / (4 * Math.abs(offset));
      expect(solution.ok, `${run}/${offset}`).toBe(true);
      if (!solution.ok) continue;
      expect(solution.minRadius).toBeCloseTo(radius, 3);
      expect(solution.segments.map(segment => Math.sign(segment.k0))).toEqual([Math.sign(offset), -Math.sign(offset)]);
      expect(solution.segments[0].len).toBeCloseTo(solution.segments[1].len, 3);
    }
  });

  it('keeps a skewed gap to one arc plus straight when that meets the minimum', () => {
    const solution = solveGap(ORIGIN, endAt(600, 100, Math.PI + 30 * DEG));
    expect(solution.ok && solution.segments.length).toBe(2);
    expect(solution.ok && solution.minRadius).toBeCloseTo(200 / Math.tan(15 * DEG), 6);
  });

  it('explains every gap it cannot close in one line', () => {
    const cases: [GapEnd, string, number?][] = [
      [endAt(100, 100, -Math.PI / 2), 'Needs a 100 mm radius; the minimum is 320 mm.'],
      [endAt(200, 200, -Math.PI / 2), 'Needs a 200 mm radius; the minimum is 320 mm (lower it to allow this).'],
      [endAt(128, 32, Math.PI), 'Needs a 136 mm radius; the minimum is 192 mm.', 192],
      [endAt(10, 0, Math.PI), 'The ends are only 10.0 mm apart; a printed piece needs at least 24 mm.'],
      [endAt(200, 0, Math.PI, 8), 'The ends are at different heights (8.0 mm apart); a gap closer joins level ends.'],
      [endAt(300, 0, 0), 'The ends face away from each other; turn one of them first.'],
      [endAt(-300, 0, Math.PI), 'The ends face away from each other; turn one of them first.'],
      [endAt(2400, 0, Math.PI), 'The path would be 2400 mm; a gap closer is at most 2000 mm.']
    ];
    for (const [to, reason, minRadius] of cases) expect(solveGap(ORIGIN, to, { minRadius })).toMatchObject({ ok: false, reason });
  });

  it('accepts a tighter corner once the minimum is lowered to 192 mm', () => {
    expect(solveGap(ORIGIN, endAt(200, 200, -Math.PI / 2), { minRadius: 192 })).toMatchObject({ ok: true, minRadius: expect.closeTo(200, 6) });
  });
});

describe('closing a gap in a layout', () => {
  it('closes the 98 mm gap in the user\'s oval with a straight and leaves no open ends', () => {
    // .projects/7b7e13fd-…-69e47124-….json: 16 printed R40 curves and 6 printed straights, 97.97 mm short of a loop.
    const sequence = 'LLLLLSLLLSSLLLSLLLLLSS'.split('').map((kind): [string, number?] =>
      kind === 'S' ? ['printed_brick_straight'] : ['printed_curve_r40', Math.PI / 8]);
    const project = layout(route('oval', { x: 891.6780904908171, y: 602.7335052198389, heading: -4.440892098500626e-16 }, sequence));
    const gap = nearestGap(project);
    expect(gap).not.toBeNull();
    const plan = planGap(project, ...gap!);
    expect(plan.solution).toMatchObject({ ok: true, length: expect.closeTo(97.967, 3), minRadius: Infinity });
    const ends = openEnds(project).map(end => end.port);
    const [next, id] = closeGap(project, plan);
    expect(next.routes).toHaveLength(1);
    expect(next.routes[0].pieces.map(piece => piece.id)).toEqual([...project.routes[0].pieces.map(piece => piece.id), id]);
    expect(openEnds(next)).toEqual([]);
    expectMated(next, id, ends);
    // The saved project reloads with the closer's params intact.
    expect(openEnds(parseProject(serializeProject(next)))).toEqual([]);
  });

  it('merges two routes through a curved closer, keeping the first route\'s direction', () => {
    const first = route('a', { x: 200, y: 200, heading: 0 }, [['printed_brick_straight'], ['printed_brick_straight']]);
    const second = route('b', { x: 800, y: 600, heading: Math.PI / 2 }, [['printed_brick_straight']]);
    const project = layout(first, second);
    const ends = openEnds(project);
    const plan = planGap(project, ends.find(end => end.pieceId === 'b-0' && end.portId === 'in')!, ends.find(end => end.pieceId === 'a-1' && end.portId === 'out')!);
    expect(plan.from.pieceId).toBe('a-1');
    expect(plan.solution.ok).toBe(true);
    const [next, id] = closeGap(project, plan);
    expect(next.routes.map(item => item.pieces.map(piece => piece.id))).toEqual([['a-0', 'a-1', id, 'b-0']]);
    expect(openEnds(next)).toHaveLength(2);
    expectMated(next, id, ends.map(end => end.port));
  });

  it('merges head-to-head routes by reversing one, the closer included', () => {
    const first = route('a', { x: 200, y: 200, heading: 0 }, [['printed_brick_straight']]);
    // Route b runs towards route a, so both open ends at the gap are route ends ('out').
    const second = route('b', { x: 1000, y: 420, heading: Math.PI }, [['printed_brick_straight']]);
    const project = layout(first, second);
    const ends = openEnds(project);
    const plan = planGap(project, ends.find(end => end.pieceId === 'a-0' && end.portId === 'out')!, ends.find(end => end.pieceId === 'b-0' && end.portId === 'out')!);
    expect(plan.solution).toMatchObject({ ok: true });
    expect(plan.solution.ok && plan.solution.segments.length).toBe(2);
    const [next, id] = closeGap(project, plan);
    expect(next.routes).toHaveLength(1);
    expect(openEnds(next)).toHaveLength(2);
    expectMated(next, id, ends.map(end => end.port));
  });

  it('offers only facing pairs within 400 mm, never a piece\'s own two ends', () => {
    const project = layout(route('a', { x: 200, y: 200, heading: 0 }, [['printed_brick_straight']]),
      route('b', { x: 800, y: 200, heading: 0 }, [['printed_brick_straight']]));
    expect(nearestGap(project)).toBeNull();
    expect(nearestGap(project, 500)?.map(end => `${end.pieceId}:${end.portId}`)).toEqual(['a-0:out', 'b-0:in']);
  });
});

/** Route a's end (328, 200) heading +x, and route b starting at `start`: the ends Close gap is asked to join. */
function gapTo(start: { x: number; y: number; heading: number }, inventory: Record<string, number>): WorkshopProject {
  const project = layout(route('a', { x: 200, y: 200, heading: 0 }, [['printed_brick_straight']]), route('b', start, [['printed_brick_straight']]));
  project.inventory = inventory;
  return project;
}
const endsOf = (project: WorkshopProject) => [openEnds(project).find(end => end.pieceId === 'a-0' && end.portId === 'out')!,
  openEnds(project).find(end => end.pieceId === 'b-0' && end.portId === 'in')!] as const;

describe('ways to close a gap', () => {
  it('offers spare owned straights with a printed rest first for a 336 mm gap in line, then the one printed straight', () => {
    const project = gapTo({ x: 664, y: 200, heading: 0 }, { brick_straight_nominal: 2 });
    const options = gapOptions(project, ...endsOf(project));
    expect(options.map(option => option.label)).toEqual(['2 owned straights (256 mm) + 80 mm printed', '1 printed straight 336 mm']);
    expect(options[0]).toMatchObject({ owned: 2, printed: 1, printedLength: expect.closeTo(80, 3), bent: false });
    const [first] = options, open = openEnds(first.next);
    // Both ends are joined: only the routes' far ends stay open.
    expect(open.map(end => `${end.pieceId}:${end.portId}`).sort()).toEqual(['a-0:in', 'b-0:out']);
    expect(first.next.routes).toHaveLength(1);
    expect(first.pieces.map(piece => piece.family)).toEqual(['brick_straight_nominal', 'brick_straight_nominal', GAP_CLOSER_FAMILY]);
  });

  it('uses no more owned straights than are spare, and none where the rest would be too short to print', () => {
    expect(gapOptions(...withEnds(gapTo({ x: 664, y: 200, heading: 0 }, { brick_straight_nominal: 1 })))[0].label).toBe('1 owned straight (128 mm) + 208 mm printed');
    // 266 mm: two straights would leave 10 mm, less than a printed piece can be.
    expect(gapOptions(...withEnds(gapTo({ x: 594, y: 200, heading: 0 }, { brick_straight_nominal: 5 })))[0].label).toBe('1 owned straight (128 mm) + 138 mm printed');
    expect(gapOptions(...withEnds(gapTo({ x: 664, y: 200, heading: 0 }, {}))).map(option => option.label)).toEqual(['1 printed straight 336 mm']);
  });

  it('turns a whole number of 22.5° steps on spare owned R40 curves before the printed rest, and each way closes', () => {
    // 90° left then 200 mm ahead: four R40 curves (320 mm radius) and the 200 mm left over.
    const project = gapTo({ x: 648, y: 720, heading: Math.PI / 2 }, { brick_curve_r40: 4, brick_straight_nominal: 1 });
    const options = gapOptions(project, ...endsOf(project));
    expect(options.map(option => option.label)).toEqual(['4 owned curves (90°) + 1 owned straight (128 mm) + 72 mm printed',
      '4 owned curves (90°) + 200 mm printed', expect.stringMatching(/^1 printed bend \d+ mm · R\d+ min$/)]);
    expect(options[2].bent).toBe(true);
    for (const option of options) expect(openEnds(option.next).map(end => `${end.pieceId}:${end.portId}`).sort()).toEqual(['a-0:in', 'b-0:out']);
  });
});
function withEnds(project: WorkshopProject): [WorkshopProject, ...ReturnType<typeof endsOf>] {
  return [project, ...endsOf(project)];
}
