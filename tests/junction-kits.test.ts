import { describe, expect, it } from 'vitest';
import { createProject, type WorkshopProject } from '../src/domain/project';
import { pieceDefinition, piecePaths, piecePorts, type ShapePort } from '../src/domain/pieces';
import { CROSSOVER_RADII, SCISSORS_RADII, crossoverGeometry } from '../src/domain/pieces/families/crossover';
import { SLIP_MIN_RADIUS, slipLength, slipRadius } from '../src/domain/pieces/families/slip';
import { fitProject } from '../src/fitting/fit';
import { routePath } from '../src/drive/traversal';
import { placePiece, setPieceState, unoccupiedPiecePorts } from '../src/editor/operations';
import { layLadder, placeLadder, planLadder, type LadderOptions } from '../src/editor/ladder';
import { placeTriple } from '../src/editor/triple';
import { setSetupMeasurement } from '../src/editor/setup-defaults';

const DEG = Math.PI / 180;
const brick = (): WorkshopProject => ({ ...createProject('Junctions'), trackSystem: 'brick-v1' });
function single(family: string, params: Record<string, number> = {}, state?: string) {
  const project = brick();
  const [placed, id] = placePiece(project, family, { x: 500, y: 500, params, ...(state ? { state } : {}) });
  return { project: placed, piece: placed.routes[0].pieces.find(piece => piece.id === id)! };
}
const port = (project: WorkshopProject, id: string, portId: string): ShapePort =>
  piecePorts(project.routes.flatMap(route => route.pieces).find(piece => piece.id === id)!, project).find(item => item.id === portId)!;
/** Lay a plain straight on an open port; returns the project and the straight's id. */
function extend(project: WorkshopProject, from: ShapePort, length = 128): [WorkshopProject, string] {
  return placePiece(project, 'track_straight', { x: from.x, y: from.y, heading: from.heading, params: { length } }, -1);
}
/** The piece ids a Test-drive train visits from the route holding `startId`, in order. */
function driven(project: WorkshopProject, startId: string): string[] {
  const route = project.routes.find(item => item.pieces.some(piece => piece.id === startId))!;
  const path = routePath(fitProject(project).sections, route.id);
  return [...new Set(path.sections.map(section => section.pieceId ?? section.id))];
}

describe('junction route and port consistency', () => {
  it('starts and ends every route exactly on its ports, heading along the track, in every family and size', () => {
    const cases: [string, Record<string, number>][] = [['crossover_single', { spacing: 136, radius: 448 }], ['crossover_scissors', { spacing: 192, radius: 576, hand: -1 }],
      ['slip_single', { angle: 22.5 }], ['slip_double', { angle: 60, hand: -1 }]];
    for (const [family, params] of cases) {
      const { project, piece } = single(family, params);
      const ports = new Map(piecePorts(piece, project).map(item => [item.id, item]));
      for (const path of piecePaths(piece, project)) {
        const from = ports.get(path.from)!, to = ports.get(path.to)!, first = path.points[0], last = path.points.at(-1)!;
        expect([first.x - from.x, first.y - from.y, Math.cos(first.heading + Math.PI - from.heading)].map(value => Number(value.toFixed(9))), `${family} ${path.id}`).toEqual([0, 0, 1]);
        expect([last.x - to.x, last.y - to.y, Math.cos(last.heading - to.heading)].map(value => Number(value.toFixed(9))), `${family} ${path.id}`).toEqual([0, 0, 1]);
      }
    }
  });
});

describe('crossovers at any spacing', () => {
  it('keeps the 7996 layout at 16 studs and R40: 384 mm long, diagonals on the double crossover\'s arcs', () => {
    const scissors = single('crossover_scissors', {}, 'diverging'), legacy = single('printed_double_crossover', {}, 'diverging');
    const ports = (item: typeof scissors) => piecePorts(item.piece, item.project).map(({ id, x, y, heading }) => ({ id, x, y, heading }));
    expect(ports(scissors)).toEqual(ports(legacy).map(item => ({ ...item, x: expect.closeTo(item.x, 9), y: expect.closeTo(item.y, 9) })));
    for (const id of ['cross', 'cross-back']) {
      const ours = piecePaths(scissors.piece, scissors.project).find(path => path.id === id)!.points;
      const theirs = piecePaths(legacy.piece, legacy.project).find(path => path.id === id)!.points;
      expect(ours).toHaveLength(theirs.length);
      ours.forEach((point, index) => { expect(point.x).toBeCloseTo(theirs[index].x, 6); expect(point.y).toBeCloseTo(theirs[index].y, 6); });
    }
  });

  it('solves every spacing and radius on the stud grid, never tighter than the chosen radius or steeper than 45°', () => {
    for (const radius of CROSSOVER_RADII) for (let spacing = 128; spacing <= 512; spacing += 8) {
      const geometry = crossoverGeometry(spacing, radius);
      expect(geometry.length % 8).toBe(0);
      expect(geometry.radius).toBeGreaterThanOrEqual(radius - 1e-6);
      expect(geometry.angle).toBeLessThanOrEqual(Math.PI / 4 + 1e-9);
      // The S-bend lands on the parallel track: offset and length both close.
      const { angle, middle } = geometry, r = geometry.radius;
      expect(2 * r * (1 - Math.cos(angle)) + middle * Math.sin(angle)).toBeCloseTo(spacing, 6);
      expect(2 * r * Math.sin(angle) + middle * Math.cos(angle)).toBeCloseTo(geometry.length, 6);
    }
  });

  it('offers the scissors only at spacing and radius pairs that print, and says why elsewhere', () => {
    const problem = (params: Record<string, number>) => { const { piece } = single('crossover_scissors', params); return pieceDefinition('crossover_scissors').problem!(piece); };
    for (const [spacing, radii] of Object.entries(SCISSORS_RADII)) for (const radius of CROSSOVER_RADII)
      expect(problem({ spacing: Number(spacing), radius }) === null, `${spacing} R${radius / 8}`).toBe(radii.includes(radius));
    expect(problem({ spacing: 184, radius: 448 })).toMatch(/prints only with R40 diagonals/);
    expect(problem({ spacing: 128, radius: 576 })).toMatch(/R40 or R56/);
  });

  it('opens lanes or diagonals per state and mirrors to the right with Flip', () => {
    const enabled = (family: string, state: string, params: Record<string, number> = {}) => {
      const { project, piece } = single(family, params, state);
      return piecePaths(piece, project).filter(path => path.enabled).map(path => path.id);
    };
    expect(enabled('crossover_single', 'straight')).toEqual(['main', 'parallel']);
    expect(enabled('crossover_single', 'diverging')).toEqual(['cross']);
    expect(enabled('crossover_scissors', 'diverging')).toEqual(['cross', 'cross-back']);
    expect(() => single('crossover_scissors', { spacing: 200 })).toThrow(/128 to 192/);
    const right = single('crossover_single', { hand: -1, spacing: 200 });
    expect(port(right.project, right.piece.id, 'parallel-out').y).toBeCloseTo(500 - 200, 9);
    expect(pieceDefinition('crossover_single').flip!({ hand: -1 }).hand).toBe(1);
  });

  it('drives from the in track to the parallel track when crossed, and straight on otherwise', () => {
    let { project, piece } = single('crossover_single', { spacing: 192 });
    const [withLead, lead] = placePiece(project, 'track_straight', { x: 372, y: 500, params: { length: 128 } }, 5);
    project = withLead;
    let straightOn: string, crossed: string;
    [project, straightOn] = extend(project, port(project, piece.id, 'out'));
    [project, crossed] = extend(project, port(project, piece.id, 'parallel-out'));
    expect(driven(project, lead)).toEqual([lead, piece.id, straightOn]);
    project = setPieceState(project, piece.id, 'diverging');
    expect(driven(project, lead)).toEqual([lead, piece.id, crossed]);
  });
});

describe('triple crossover kit', () => {
  it('lays two scissors in a row so a train crosses from track 1 to track 3 through the middle track', () => {
    for (const hand of [1, -1] as const) {
      let [project, ids] = placeTriple(brick(), { x: 300, y: 1000, heading: 0 }, { spacing: 160, radius: 320, hand });
      const [first, second] = ids;
      const ends = unoccupiedPiecePorts(project).map(({ port: open }) => [Math.round(open.x), Math.round(hand * (open.y - 1000)) + 0]);
      const length = crossoverGeometry(160, 320).length;
      expect(ends.sort((a, b) => a[0] - b[0] || a[1] - b[1])).toEqual([[300, 0], [300, 160], [300, 320], [300 + 2 * length, 0], [300 + 2 * length, 160], [300 + 2 * length, 320]]);
      expect(fitProject(project).issues.filter(issue => issue.severity === 'error')).toEqual([]);
      project = setPieceState(setPieceState(project, first, 'diverging'), second, 'diverging');
      let lead: string;
      [project, lead] = placePiece(project, 'track_straight', { x: 172, y: 1000, params: { length: 128 } }, 5);
      // From track 1, over the first scissors onto track 2, then over the second onto track 3.
      expect(driven(project, lead)).toEqual([lead, first, second]);
    }
  });
});

describe('single and double slips', () => {
  it('turns each slip curve tangent to both tracks, at R40 or wider, for every angle', () => {
    for (let degrees = 15; degrees <= 60; degrees += 0.5) {
      const length = slipLength(degrees * DEG);
      expect(length % 8).toBe(0);
      expect(slipRadius(length, degrees * DEG)).toBeGreaterThanOrEqual(SLIP_MIN_RADIUS - 1e-9);
    }
    for (const hand of [1, -1]) {
      const { project, piece } = single('slip_double', { angle: 30, hand }, 'slip-both');
      const paths = new Map(piecePaths(piece, project).map(path => [path.id, path.points]));
      const crossing = paths.get('crossing')!;
      for (const [id, from, to] of [['slip', paths.get('main')![0], crossing.at(-1)!], ['slip-back', crossing[0], paths.get('main')!.at(-1)!]] as const) {
        const curve = paths.get(id)!;
        expect(curve[0]).toMatchObject({ x: expect.closeTo(from.x, 9), y: expect.closeTo(from.y, 9), heading: expect.closeTo(from.heading, 9) });
        // The last sample before the pinned end must already head where the far track does.
        expect(curve.at(-2)!.heading).toBeCloseTo(to.heading, 1);
        expect(curve.at(-1)).toMatchObject({ x: expect.closeTo(to.x, 9), y: expect.closeTo(to.y, 9), heading: expect.closeTo(to.heading, 9) });
      }
    }
  });

  it('keeps every set of points clear of the other straight track at every angle', () => {
    /** Ray-cast point-in-polygon. */
    const inside = (point: { x: number; y: number }, polygon: readonly { x: number; y: number }[]) => polygon.reduce((hit, a, index) => {
      const b = polygon[(index + 1) % polygon.length];
      return (a.y > point.y) !== (b.y > point.y) && point.x < a.x + (point.y - a.y) * (b.x - a.x) / (b.y - a.y) ? !hit : hit;
    }, false);
    for (const angle of [15, 17.5, 22.5, 30, 45, 60]) {
      const { project, piece } = single('slip_double', { angle });
      const definition = pieceDefinition('slip_double'), paths = new Map(definition.paths(piece, project).map(path => [path.id, path.points]));
      const envelopes = definition.envelopes!(piece, project);
      expect(envelopes).toHaveLength(4);
      // Points at `in`/`out` sit on track A and must miss track B's rails; those at `cross-in`/`cross-out` the reverse.
      for (const [index, other] of [[0, 'crossing'], [1, 'main'], [2, 'main'], [3, 'crossing']] as const) {
        const [a, b] = [paths.get(other)![0], paths.get(other)!.at(-1)!], length = Math.hypot(b.x - a.x, b.y - a.y);
        const heading = Math.atan2(b.y - a.y, b.x - a.x);
        for (let s = 0; s <= length; s += 2) for (const side of [-20, 20]) {
          const rail = { x: a.x + s * Math.cos(heading) - side * Math.sin(heading), y: a.y + s * Math.sin(heading) + side * Math.cos(heading) };
          expect(inside(rail, envelopes[index]), `${angle}° points ${index} over ${other} rail at ${s}`).toBe(false);
        }
      }
    }
  });

  it('lists two states on a single slip and four on a double slip (two independent throws)', () => {
    const open = (family: string, state: string) => {
      const { project, piece } = single(family, {}, state);
      return piecePaths(piece, project).filter(path => path.enabled).map(path => path.id);
    };
    expect(pieceDefinition('slip_single').states!.map(state => state.id)).toEqual(['straight', 'slip']);
    expect(open('slip_single', 'straight')).toEqual(['main', 'crossing']);
    expect(open('slip_single', 'slip')).toEqual(['slip']);
    expect(pieceDefinition('slip_double').states!.map(state => state.id)).toEqual(['straight', 'slip', 'slip-back', 'slip-both']);
    expect(open('slip_double', 'slip')).toEqual(['slip']);
    expect(open('slip_double', 'slip-back')).toEqual(['slip-back']);
    expect(open('slip_double', 'slip-both')).toEqual(['slip', 'slip-back']);
  });

  it('drives across the diamond when straight and onto the crossing track when slipped', () => {
    let { project, piece } = single('slip_single');
    const [withLead, lead] = placePiece(project, 'track_straight', { x: 372, y: 500, params: { length: 128 } }, 5);
    project = withLead;
    let straightOn: string, turned: string;
    [project, straightOn] = extend(project, port(project, piece.id, 'out'));
    [project, turned] = extend(project, port(project, piece.id, 'cross-out'));
    expect(driven(project, lead)).toEqual([lead, piece.id, straightOn]);
    project = setPieceState(project, piece.id, 'slip');
    expect(driven(project, lead)).toEqual([lead, piece.id, turned]);
  });
});

describe('siding ladder kit', () => {
  const options: LadderOptions = { turnout: 'printed_switch_left', sidings: 4, spacing: 128, length: 384, hand: 1, buffers: true };

  it('lays every track exactly one spacing apart, ending flush on a buffer stop, with only the throat open', () => {
    for (const hand of [1, -1] as const) for (const [sidings, spacing] of [[2, 128], [4, 128], [5, 160], [8, 136]]) {
      // An 8-track ladder runs about 3 m: a 4 × 3 m room holds every one.
      const room = setSetupMeasurement(setSetupMeasurement(brick(), 'roomWidth', 4000), 'roomDepth', 3000);
      const [project, ids] = placeLadder(room, { x: 400, y: 1200, heading: 0 }, { ...options, hand, sidings, spacing });
      const ends = ids.map(id => project.routes.flatMap(route => route.pieces).find(piece => piece.id === id)!)
        .filter(piece => piece.family === 'buffer_stop').map(piece => piecePorts(piece, project).find(item => item.id === 'out')!);
      expect(ends).toHaveLength(sidings);
      const offsets = ends.map(end => hand * (end.y - 1200)).sort((a, b) => a - b);
      offsets.forEach((offset, index) => expect(offset).toBeCloseTo(index * spacing, 0));
      for (const end of ends) { expect(end.x).toBeCloseTo(ends[0].x, 6); expect(Math.cos(end.heading)).toBeCloseTo(1, 9); }
      expect(unoccupiedPiecePorts(project).map(({ port: open }) => open.id)).toEqual(['in']);
      expect(fitProject(project).issues.filter(issue => issue.severity === 'error')).toEqual([]);
    }
  }, 30_000);

  it('routes a Test-drive train to the siding its turnouts are set for', () => {
    let [project, ids] = placeLadder(brick(), { x: 400, y: 1200, heading: 0 }, options);
    const pieces = ids.map(id => project.routes.flatMap(route => route.pieces).find(piece => piece.id === id)!);
    const [first, second] = pieces.filter(piece => pieceDefinition(piece.family).group === 'junction');
    const bufferAt = (visited: string[]) => port(project, visited.at(-1)!, 'out').y - 1200;
    project = setPieceState(setPieceState(project, first.id, 'diverging'), second.id, 'diverging');
    const visited = driven(project, first.id);
    expect(pieceDefinition(pieces.find(piece => piece.id === visited.at(-1))!.family).family).toBe('buffer_stop');
    expect(bufferAt(visited)).toBeCloseTo(128, 0);
  });

  it('refuses spacings that would overlap the ladder turnouts or leave an unprintable filler', () => {
    expect(() => planLadder(brick(), { ...options, spacing: 96 })).toThrow(/too tight/);
    expect(() => planLadder(brick(), { ...options, spacing: 112 })).toThrow(/gap/);
    expect(layLadder(brick(), { x: 0, y: 0, z: 0, heading: 0 }, options).filter(piece => piece.family === 'track_straight')
      .every(piece => (piece.params?.length ?? 0) >= 24)).toBe(true);
  });
});
