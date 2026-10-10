import { describe, expect, it } from 'vitest';
import { createProject, parseProject, serializeProject, type RoutePiece, type WorkshopProject } from '../src/domain/project';
import { TRACK_KINDS, kindOfFamily, pieceDefinition, piecePaths, primaryEnd, type TrackKind } from '../src/domain/pieces';
import { BRICK_LAYOUT } from '../src/domain/track';
import { portsMatch } from '../src/domain/route';
import { fitProject } from '../src/fitting/fit';
import { flipPiece, placePiece, rebuildPiecePoints, setPieceShape } from '../src/editor/operations';
import { routePath } from '../src/drive/traversal';
import { partStations, splitPath } from '../src/editor/track-preview';

const kind = (id: TrackKind['id']) => TRACK_KINDS.find(item => item.id === id)!;
const DEG = Math.PI / 180;
function single(family: string, extra: Partial<RoutePiece> = {}): WorkshopProject {
  const project = createProject('Kinds');
  const route = { id: 'route', name: 'Track', pieces: [{ id: 'piece', family, x: 500, y: 500, z: 0, heading: 0, ...extra }], points: [] };
  rebuildPiecePoints(project, route); project.routes = [route];
  return project;
}
/** The chain end of `pieces` laid one after another from the origin. */
function chainEnd(pieces: Partial<RoutePiece>[]): { x: number; y: number; heading: number } {
  let at = { x: 0, y: 0, z: 0, heading: 0 };
  const project = createProject('Chain');
  for (const piece of pieces) at = primaryEnd({ id: 'p', family: '', ...at, ...piece } as RoutePiece, project);
  return at;
}
const localEnd = (piece: Partial<RoutePiece>) => chainEnd([piece]);
const trackOf = (family: string, params: Record<string, number> = {}) =>
  pieceDefinition(family).composite!({ id: 'p', family, x: 0, y: 0, z: 0, heading: 0, params }, createProject('Track'));
const turn = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
/** Fit a piece alone: every bed part fits, parts meet end to start, and the route ends where the piece does. */
function expectPrintable(project: WorkshopProject) {
  const fit = fitProject(project), parts = fit.partInstances.filter(part => part.family === 'composite_track');
  expect(fit.issues.filter(issue => issue.severity === 'error')).toEqual([]);
  expect(parts.length).toBeGreaterThan(0);
  for (let index = 1; index < parts.length; index++) {
    const before = parts[index-1], after = parts[index];
    if (before.interfaceKind !== 'rail' || after.interfaceKind !== 'rail') throw new Error('rail parts expected');
    expect(portsMatch(before.endPort, after.startPort, 1e-6)).toBe(true);
  }
  // The composite CAD accepts nothing tighter than R22 (1/176 per mm).
  for (const part of parts) for (let i = 0; i < part.parameters.segments; i++)
    expect(Math.max(Math.abs(part.parameters[`s${i}_k0`]), Math.abs(part.parameters[`s${i}_k1`]))).toBeLessThanOrEqual(1/176);
  expect(routePath(fit.sections, 'route').gap).toBeNull();
  return parts;
}

describe('straight kind', () => {
  const straight = kind('straight');
  it('uses the owned brick straight only at 128 mm and prints every other length as one composite piece', () => {
    expect(straight.shape({ length: 128 }, 'owned')).toEqual({ family: 'brick_straight_nominal' });
    expect(straight.shape({ length: 64 }, 'owned')).toBeNull();
    expect(straight.shape({ length: 128 }, 'printed')).toEqual({ family: 'printed_brick_straight' });
    expect(straight.shape({ length: 160 }, 'printed')).toEqual({ family: 'track_straight', params: { length: 160 } });
    expect(straight.shape({ length: 160 }, 'printed', true)).toEqual({ family: 'printed_straight' });
    expect(straight.shape({ length: 64 }, 'printed', true)).toBeNull();
    expect(straight.rows[0].choices.map(choice => choice.values.length)).toEqual([32, 64, 128, 160, 192, 256]);
    for (const length of [24, 37.5, 192, 2000]) expect(localEnd({ family: 'track_straight', params: { length } })).toMatchObject({ x: expect.closeTo(length, 9), y: 0, heading: 0 });
  });

  it('splits a long straight into bed-sized parts on both printers', () => {
    const project = single('track_straight', { params: { length: 1000 } });
    for (const printer of ['X1 Carbon', 'A1 mini'] as const) {
      project.printer = printer;
      expect(expectPrintable(project).length).toBeGreaterThan(printer === 'X1 Carbon' ? 3 : 5);
    }
  });
});

describe('curve kind', () => {
  const curve = kind('curve');
  it('follows the sector convention: 22.5° to R56, 11.25° from R72, 5.625° from R136', () => {
    const sectors = Object.fromEntries(curve.rows[0].choices.map(choice => [choice.label, choice.values.sweep]));
    expect(sectors).toEqual({ R24: 22.5, R32: 22.5, R40: 22.5, R56: 22.5, R72: 11.25, R88: 11.25, R104: 11.25, R120: 11.25,
      R136: 5.625, R152: 5.625, R168: 5.625, R184: 5.625 });
  });

  it('keeps the official R40 and wide R56 families, owned only for R40 22.5°, and composes every other radius', () => {
    expect(curve.shape({ radius: 320, sweep: -22.5 }, 'owned')).toEqual({ family: 'brick_curve_r40', sweep: -BRICK_LAYOUT.curveSweep });
    expect(curve.shape({ radius: 320, sweep: 11.25 }, 'owned')).toBeNull();
    expect(curve.shape({ radius: 320, sweep: 22.5 }, 'printed')).toEqual({ family: 'printed_curve_r40', sweep: BRICK_LAYOUT.curveSweep });
    expect(curve.shape({ radius: 448, sweep: 22.5 }, 'printed')).toEqual({ family: 'printed_curve_r56', sweep: BRICK_LAYOUT.curveSweep });
    expect(curve.shape({ radius: 320, sweep: 11.25 }, 'printed')).toEqual({ family: 'track_curve', params: { radius: 320, sweep: 11.25 } });
    expect(curve.shape({ radius: 576, sweep: 22.5 }, 'printed', true)).toBeNull();
    for (const [radius, sweep] of [[192, 22.5], [576, -11.25], [1472, 5.625], [1000, 37]]) {
      const end = localEnd({ family: 'track_curve', params: { radius, sweep } }), angle = sweep * DEG;
      expect(end.x).toBeCloseTo(radius * Math.sin(Math.abs(angle)), 6);
      expect(end.y).toBeCloseTo(Math.sign(angle) * radius * (1 - Math.cos(angle)), 6);
      expect(end.heading).toBeCloseTo(angle, 12);
    }
  });

  it('closes a circle from sixteen, thirty-two or sixty-four pieces of each radius', () => {
    for (const choice of curve.rows[0].choices) {
      const count = Math.round(360 / choice.values.sweep), shape = curve.shape(choice.values, 'printed')!;
      const end = chainEnd(Array.from({ length: count }, () => ({ family: shape.family, sweep: shape.sweep, params: shape.params })));
      expect(Math.hypot(end.x, end.y), choice.label).toBeLessThan(1e-6);
      expect(turn(end.heading), choice.label).toBeCloseTo(0, 9);
    }
  });

  it('reads saved official and wide curves as kind values', () => {
    const project = single('printed_curve_r40', { sweep: -Math.PI / 8 });
    const loaded = parseProject(serializeProject(project)).routes[0].pieces[0];
    expect(kindOfFamily(loaded.family)?.values(loaded)).toEqual({ radius: 320, sweep: -22.5 });
    expect(curve.values({ ...loaded, family: 'printed_curve_r56', sweep: Math.PI / 4 })).toEqual({ radius: 448, sweep: 45 });
  });

  it('prints a wide curve split to the bed', () => {
    expectPrintable(single('track_curve', { params: { radius: 1472, sweep: 22.5 } }));
  });
});

describe('S-bend kind', () => {
  const sbend = kind('sbend');
  it('lands every grid preset exactly on its stud offset, on two arcs of the named radius', () => {
    const expected = ['8 · R34', '16 · R40', '16 · R104', '16 · R200', '16 · R328', '24 · R60'];
    expect(sbend.rows[0].choices.map(choice => choice.label)).toEqual(expected);
    for (const choice of sbend.rows[0].choices) {
      const end = localEnd({ family: 'track_sbend', params: choice.values });
      expect(end.x, choice.label).toBeCloseTo(choice.values.length, 6);
      expect(end.y, choice.label).toBeCloseTo(choice.values.offset, 6);
      expect(end.heading, choice.label).toBeCloseTo(0, 12);
      expect(sbend.problem(choice.values)).toBeNull();
    }
    const r40 = trackOf('track_sbend', { offset: 128, length: 384 });
    expect(r40.segments.map(segment => [segment.len, segment.k0])).toEqual([[expect.closeTo(320 * Math.atan2(3, 4), 9), expect.closeTo(1/320, 12)],
      [expect.closeTo(320 * Math.atan2(3, 4), 9), expect.closeTo(-1/320, 12)]]);
  });

  it('solves a custom offset with a straight between the arcs, and refuses one too tight to print', () => {
    for (const values of [{ offset: -100, length: 500, middle: 120 }, { offset: 40, length: 200, middle: 0 }]) {
      const end = localEnd({ family: 'track_sbend', params: values });
      expect(end).toMatchObject({ x: expect.closeTo(values.length, 6), y: expect.closeTo(values.offset, 6), heading: expect.closeTo(0, 12) });
    }
    expect(sbend.problem({ offset: 128, length: 160, middle: 0 })).toMatch(/Too tight/);
    expect(sbend.problem({ offset: 128, length: 200, middle: 200 })).toMatch(/does not fit/);
  });

  it('flips to the other side and prints split at the middle', () => {
    let project = single('track_sbend', { params: { offset: 128, length: 384, middle: 0 } });
    expectPrintable(project);
    project = flipPiece(project, 'piece');
    expect(primaryEnd(project.routes[0].pieces[0], project)).toMatchObject({ x: expect.closeTo(884, 6), y: expect.closeTo(372, 6) });
  });
});

describe('easement kind', () => {
  const easement = kind('easement');
  /** Straight `lead` + a 22.5° curve, or (exit) the curve then the straight, as ordinary pieces. */
  const combo = (lead: number, radius: number, sign: number, exit: boolean) => {
    const pieces: Partial<RoutePiece>[] = [{ family: 'track_straight', params: { length: lead } }, { family: 'track_curve', params: { radius, sweep: sign * 22.5 } }];
    return chainEnd(exit ? pieces.reverse() : pieces);
  };

  it('replaces a straight + curve with the same end pose (≤ 0.25 mm, ≤ 0.05°) and a slightly tighter arc', () => {
    for (const choice of easement.rows[0].choices) for (const sign of [1, -1]) for (const reverse of [0, 1]) {
      const values: Record<string, number> = { ...choice.values, sweep: sign * choice.values.sweep, reverse };
      const end = localEnd({ family: 'track_easement', params: values });
      const target = combo(values.lead, values.radius, sign, reverse === 1), label = `${choice.label} ${sign} ${reverse}`;
      expect(Math.hypot(end.x - target.x, end.y - target.y), label).toBeLessThanOrEqual(0.25);
      expect(Math.abs(turn(end.heading - target.heading)) / DEG, label).toBeLessThanOrEqual(0.05);
      expect(easement.problem(values), label).toBeNull();
    }
    // The CrazyIdeas S16 + R40 example: a 111 mm clothoid needs an arc near R300 and an ~80 mm straight.
    const s16 = trackOf('track_easement');
    expect(s16.segments[0].len).toBeGreaterThan(78); expect(s16.segments[0].len).toBeLessThan(84);
    expect(s16.segments[1]).toMatchObject({ len: 111, k0: 0 });
    expect(1 / s16.segments[2].k0).toBeGreaterThan(290); expect(1 / s16.segments[2].k0).toBeLessThan(320);
  });

  it('shortens a transition too long for the replaced pieces instead of missing the end pose', () => {
    const values = { dropin: 1, lead: 64, radius: 448, sweep: 22.5, clothoid: 600, reverse: 0 };
    const end = localEnd({ family: 'track_easement', params: values }), target = combo(64, 448, 1, false);
    expect(Math.hypot(end.x - target.x, end.y - target.y)).toBeLessThanOrEqual(0.25);
    expect(trackOf('track_easement', values).segments[1].len).toBeLessThan(600);
  });

  it('builds a custom clothoid into any radius that turns exactly the requested angle', () => {
    const values = { dropin: 0, radius: 600, sweep: -30, clothoid: 200, reverse: 0 };
    const track = trackOf('track_easement', values);
    expect(track.segments).toMatchObject([{ len: 200, k0: 0, k1: expect.closeTo(-1/600, 12) }, { k0: expect.closeTo(-1/600, 12) }]);
    expect(localEnd({ family: 'track_easement', params: values }).heading).toBeCloseTo(-30 * DEG, 9);
  });

  it('is the same physical piece when authored from its far end', () => {
    const definition = pieceDefinition('track_easement'), piece = { id: 'p', family: 'track_easement', x: 0, y: 0, z: 0, heading: 0,
      params: { dropin: 1, lead: 128, radius: 320, sweep: 22.5, clothoid: 111, reverse: 0 } } as RoutePiece;
    const end = primaryEnd(piece, createProject('R'));
    const back = { ...piece, ...end, heading: end.heading + Math.PI, params: definition.reverseParams!(piece.params!) };
    const start = primaryEnd(back, createProject('R'));
    expect(Math.hypot(start.x, start.y)).toBeLessThan(0.01);
    expect(turn(start.heading - Math.PI)).toBeCloseTo(0, 6);
  });

  it('prints as bed-sized composite parts', () => {
    expectPrintable(single('track_easement'));
  });
});

describe('composite preview', () => {
  it('cuts the previewed path exactly where fit splits the piece into bed parts', () => {
    const project = single('track_sbend', { params: { offset: 128, length: 640, middle: 0 } });
    const fit = fitProject(project), parts = fit.partInstances.filter(part => part.family === 'composite_track');
    const cuts = partStations(fit.partInstances, 'piece');
    expect(cuts).toHaveLength(parts.length - 1);
    const pieces = splitPath(piecePaths(project.routes[0].pieces[0], project)[0].points, cuts);
    expect(pieces).toHaveLength(parts.length);
    pieces.forEach((points, index) => {
      const part = parts[index];
      if (part.interfaceKind !== 'rail') throw new Error('rail part expected');
      for (const [pose, port] of [[points[0], part.startPort.pose], [points.at(-1)!, part.endPort.pose]] as const) {
        expect(Math.hypot(pose.x - port.x, pose.y - port.y)).toBeLessThan(0.05);
        expect(turn(pose.heading - port.heading)).toBeCloseTo(0, 3);
      }
    });
  });
});

describe('track options on kind pieces', () => {
  it('builds optioned pieces on the composite family, which prints the options, even at the official sizes', () => {
    expect(kind('straight').shape({ length: 128 }, 'printed', false, true)).toEqual({ family: 'track_straight', params: { length: 128 } });
    expect(kind('curve').shape({ radius: 320, sweep: -22.5 }, 'printed', false, true)).toEqual({ family: 'track_curve', params: { radius: 320, sweep: -22.5 } });
    expect(kind('curve').shape({ radius: 448, sweep: 22.5 }, 'printed', false, true)?.family).toBe('track_curve');
  });

  it('keeps a colour marker on the same tie when the piece is authored from its far end', () => {
    const reverse = pieceDefinition('track_straight').reverseParams!;
    expect(reverse({ length: 192, marker: 10, marker_s: 32 })).toEqual({ length: 192, marker: 10, marker_s: 160 });
    expect(reverse({ length: 192, marker: 10 })).toMatchObject({ marker_s: 128 });
    expect(reverse({ length: 192 })).toEqual({ length: 192 });
  });
});

describe('reshaping a placed piece', () => {
  it('swaps family within a kind in one undoable edit, carries the chain and keeps print style and track options', () => {
    let [project] = placePiece(createProject('Shape'), 'printed_brick_straight', { x: 100, y: 100, style: 'fast' });
    const id = project.routes[0].pieces[0].id;
    [project] = placePiece(project, 'printed_brick_straight', { x: 228, y: 100 });
    const shorter = setPieceShape(project, id, kind('straight').shape({ length: 64 }, 'printed')!);
    expect(shorter.routes[0].pieces[0]).toMatchObject({ family: 'track_straight', params: { length: 64 }, style: 'fast' });
    expect(shorter.routes[0].pieces[1]).toMatchObject({ x: 164, y: 100 });
    expect(setPieceShape(shorter, id, { family: 'track_straight', params: { length: 64 } })).toBe(shorter);
    const ballast = setPieceShape({ ...shorter, routes: shorter.routes.map(route => ({ ...route, pieces: route.pieces.map(piece =>
      piece.id === id ? { ...piece, params: { ...piece.params, ballast: 1 } } : piece) })) }, id, { family: 'track_straight', params: { length: 96 } });
    expect(ballast.routes[0].pieces[0].params).toEqual({ length: 96, ballast: 1 });
    const back = setPieceShape(shorter, id, kind('straight').shape({ length: 128 }, 'owned')!);
    expect(back.routes[0].pieces[0]).not.toHaveProperty('params');
    expect(back.routes[0].pieces[0]).not.toHaveProperty('style');
    expect(() => setPieceShape(project, id, { family: 'track_curve', params: { radius: 100 } })).toThrow(/Radius/);
    expect(() => setPieceShape(project, id, { family: 'printed_curve_r40' })).toThrow(/sweep/);
  });
});
