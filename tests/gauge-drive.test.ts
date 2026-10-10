import { describe, expect, it } from 'vitest';
import { TRACK_KINDS, piecePorts } from '../src/domain/pieces';
import { createProject, parseProject, serializeProject, type Car, type RoutePiece, type WorkshopProject } from '../src/domain/project';
import { routeProblem, trainGauge, trainProblem } from '../src/drive/compat';
import { placeConsist, startingLeadDistance } from '../src/drive/train';
import { routePath } from '../src/drive/traversal';
import { flipPiece, placePiece, rebuildPiecePoints, setPieceState, unoccupiedPiecePorts, type Placement, type TileFamily } from '../src/editor/operations';
import { fitProject } from '../src/fitting/fit';

const car = (id: string, gauge?: Car['gauge']): Car =>
  ({ id, name: id, length: 100, width: 40, height: 60, wheelbase: 70, couplerGap: 8, ...(gauge ? { gauge } : {}) });
const narrowTrain = [car('loco', 'narrow'), car('wagon', 'narrow')];
const standardTrain = [car('loco'), car('wagon')];

/** Each piece snaps onto the previous piece's open end; the first starts well inside the default room. */
function chain(families: readonly (TileFamily | [TileFamily, Partial<Placement>])[]): WorkshopProject {
  let project = createProject('Gauges');
  for (const item of families) {
    const [family, extra] = typeof item === 'string' ? [item, {}] : item;
    const end = unoccupiedPiecePorts(project).find(candidate => candidate.port.id === 'out')?.port ?? { x: 400, y: 400 };
    [project] = placePiece(project, family, { x: end.x, y: end.y, ...extra });
  }
  return project;
}
/** A 128 mm straight of `family` leaving `pieceId`'s port `portId`, as its own route `stall-<portId>`. */
function stall(project: WorkshopProject, pieceId: string, portId: string, family: TileFamily): WorkshopProject {
  const owner = project.routes.flatMap(route => route.pieces).find(piece => piece.id === pieceId)!;
  const target = piecePorts(owner, project).find(port => port.id === portId)!;
  const piece: RoutePiece = { id: `stall-${portId}`, family, x: target.x, y: target.y, z: 0, heading: target.heading, params: { length: 128 } };
  const route = { id: `stall-${portId}`, name: portId, pieces: [piece], points: [] };
  rebuildPiecePoints(project, route);
  return { ...project, routes: [...project.routes, route] };
}
const ids = (path: { sections: readonly { id: string }[] }) => path.sections.map(section => section.id);

describe('train gauge in Test drive', () => {
  it('drives a narrow-gauge train over dual and narrow track', () => {
    const project = chain(['dual_straight', 'narrow_straight', 'narrow_straight']), fit = fitProject(project);
    expect(fit.issues.filter(issue => issue.severity === 'error')).toEqual([]);
    const path = routePath(fit.sections, project.routes[0].id, trainGauge(narrowTrain));
    expect(path.gap).toBeNull();
    expect(path.sections).toHaveLength(3);
    expect(trainProblem(narrowTrain, path.sections)).toBeNull();
    expect(placeConsist(path, narrowTrain, startingLeadDistance(narrowTrain)).cars).toHaveLength(2);
    expect(routeProblem(fit.sections, project.routes[0].id, narrowTrain)).toBeNull();
  });

  it('blocks a standard train on narrow track, naming both gauges', () => {
    const narrow = chain(['narrow_straight', 'narrow_straight']), fit = fitProject(narrow);
    const path = routePath(fit.sections, narrow.routes[0].id, trainGauge(standardTrain));
    // The whole route is the wrong gauge: the train is flagged, not the track.
    expect(path.gap).toBeNull();
    expect(path.sections).toHaveLength(2);
    expect(trainProblem(standardTrain, path.sections))
      .toBe('Narrow-gauge track: this train is standard gauge. Pick Narrow (3 studs) as its cars’ Track in Setup.');
    expect(trainProblem(narrowTrain, path.sections)).toBeNull();
    // Dual track carries it, but its own chain then goes on to narrow track: the path stops there and says why.
    const mixed = chain(['dual_straight', 'narrow_straight']), mixedFit = fitProject(mixed), routeId = mixed.routes[0].id;
    const stopped = routePath(mixedFit.sections, routeId, 'standard');
    expect(stopped.sections).toHaveLength(1);
    expect(stopped.gap).toBe('Narrow-gauge track ahead: a standard train can’t run on it.');
    expect(routePath(mixedFit.sections, routeId).gap).toBeNull();
    expect(routeProblem(mixedFit.sections, routeId, standardTrain)).toBe(stopped.gap);
    // A narrow train needs narrow (or dual) track under it from the start.
    const standard = chain(['brick_straight_nominal']), standardFit = fitProject(standard);
    expect(routeProblem(standardFit.sections, standard.routes[0].id, narrowTrain)).toMatch(/^Standard track: this train is narrow gauge\./);
  });

  it('flags a consist that mixes car gauges on any track', () => {
    const fit = fitProject(chain(['dual_straight']));
    expect(trainProblem([car('loco', 'narrow'), car('wagon')], fit.sections))
      .toBe('This train mixes narrow gauge and standard gauge cars; a train runs on one gauge.');
    expect(trainGauge([car('loco', 'narrow'), car('wagon')])).toBe('narrow');
    expect(trainGauge([])).toBe('standard');
  });

  it('dual-gauge divergence: standard trains run straight on, narrow trains take the branch', () => {
    let project = chain(['dual_straight', 'dual_divergence']);
    const [dual, divergence] = project.routes[0].pieces, routeId = project.routes[0].id;
    project = stall(stall(project, divergence.id, 'out', 'track_straight'), divergence.id, 'branch', 'narrow_straight');
    const fit = fitProject(project);
    expect(fit.issues.filter(issue => issue.severity === 'error')).toEqual([]);
    // Both paths are always laid: only the train's gauge chooses.
    expect(routePath(fit.sections, routeId).gap).toBe('Two tracks leave the same connector.');
    const narrow = routePath(fit.sections, routeId, 'narrow'), standard = routePath(fit.sections, routeId, 'standard');
    expect(ids(narrow)).toEqual([dual.id, `${divergence.id}:branch`, 'stall-branch']);
    expect(ids(standard)).toEqual([dual.id, `${divergence.id}:main`, 'stall-out']);
    expect([narrow.gap, standard.gap]).toEqual([null, null]);
    expect(trainProblem(narrowTrain, narrow.sections)).toBeNull();
    expect(trainProblem(standardTrain, standard.sections)).toBeNull();
    // A standard train set on the branch's own route stays on that route and is flagged, never steered onto the main line.
    const wrong = routePath(fit.sections, 'stall-branch', 'standard');
    expect(ids(wrong)).toEqual([dual.id, `${divergence.id}:branch`, 'stall-branch']);
    expect(trainProblem(standardTrain, wrong.sections)).toMatch(/^Narrow-gauge track: this train is standard gauge\./);
    // The common end is dual; the straight end standard and the branch end narrow, where gauge_junctions.py builds them.
    const local = (piece: RoutePiece, current: WorkshopProject) => Object.fromEntries(piecePorts(piece, current).map(port =>
      [port.id, { gauge: port.gauge, x: port.x - piece.x, y: port.y - piece.y, heading: port.heading - piece.heading }]));
    const ports = local(divergence, project);
    expect(Object.fromEntries(Object.entries(ports).map(([id, port]) => [id, port.gauge]))).toEqual({ in: 'dual', out: 'standard', branch: 'narrow' });
    expect([ports.out.x, ports.out.y]).toEqual([152, 0]);
    expect(ports.branch.x).toBeCloseTo(135.7645, 3);
    expect(ports.branch.y).toBeCloseTo(56.2355, 3);
    expect(ports.branch.heading).toBeCloseTo(Math.PI / 4, 9);
    const flipped = flipPiece(project, divergence.id), mirrored = flipped.routes[0].pieces[1];
    expect(local(mirrored, flipped).branch.y).toBeCloseTo(-56.2355, 3);
    expect(fitProject(flipped).partInstances.find(part => part.id === divergence.id)!.parameters.hand).toBe(-1);
  });

  it('narrow stub switch: a narrow train runs through whichever stub the deck is set to and halts at the other', () => {
    let project = chain(['narrow_straight', ['narrow_stub_switch', { state: 'track1' }]]);
    const switchId = project.routes[0].pieces[1].id;
    project = stall(stall(project, switchId, 'out1', 'narrow_straight'), switchId, 'out', 'narrow_straight');
    const owner = project.routes[0].pieces[1];
    // The far ends sit where the narrow sector plate's CAD puts its stubs (24 mm pivot stub + 256 mm reach, ±5.625°).
    const out = piecePorts(owner, project).find(port => port.id === 'out')!, out1 = piecePorts(owner, project).find(port => port.id === 'out1')!;
    expect([out.x - owner.x, out.y - owner.y, out1.y - owner.y]).toEqual([expect.closeTo(278.7673, 3), expect.closeTo(25.0924, 3), expect.closeTo(-25.0924, 3)]);
    let fit = fitProject(project);
    expect(fit.issues.filter(issue => issue.severity === 'error')).toEqual([]);
    const through = routePath(fit.sections, 'stall-out1', 'narrow');
    expect(ids(through)).toEqual([project.routes[0].pieces[0].id, `${switchId}:track-1`, 'stall-out1']);
    expect(trainProblem(narrowTrain, through.sections)).toBeNull();
    expect(trainProblem(standardTrain, through.sections)).toMatch(/^Narrow-gauge track: this train is standard gauge\./);
    expect(routePath(fit.sections, 'stall-out', 'narrow').startHalt).toBe('The stub switch is set to track 1.');
    project = setPieceState(project, switchId, 'track2');
    fit = fitProject(project);
    expect(ids(routePath(fit.sections, 'stall-out', 'narrow'))).toEqual([project.routes[0].pieces[0].id, `${switchId}:track-2`, 'stall-out']);
    expect(fit.partInstances.find(part => part.id === switchId)!.parameters).toMatchObject({ deck: 192, switch_state: 1 });
  });

  it('the gauge adapter preset leads standard track on to narrow track through 64 mm of dual track', () => {
    const adapter = TRACK_KINDS.find(kind => kind.id === 'gauge_adapter')!;
    const shape = adapter.shape(adapter.initial, 'printed')!;
    const joined = fitProject(chain(['track_straight', [shape.family, { params: shape.params }], 'narrow_straight']));
    expect(joined.issues.filter(issue => issue.severity === 'error')).toEqual([]);
    expect(joined.sections.map(section => section.gauge ?? 'standard')).toEqual(['standard', 'dual', 'narrow']);
    expect(joined.sections[1].run).toBeCloseTo(64, 9);
    expect(adapter.shape(adapter.initial, 'owned')).toBeNull();
  });
});

describe('car gauge and cog drive in saved projects', () => {
  it('round-trips gauge and cog and rejects unknown values', () => {
    const project = createProject('Cars');
    project.cars = [car('loco', 'narrow'), { ...car('rack'), cog: true }, car('plain')];
    const saved = serializeProject(project);
    expect(parseProject(saved)).toEqual(project);
    const withCar = (patch: Record<string, unknown>) => JSON.stringify({ ...project, cars: [{ ...car('x'), ...patch }] });
    expect(() => parseProject(withCar({ gauge: 'dual' }))).toThrow('Invalid project car');
    expect(() => parseProject(withCar({ gauge: 'meter' }))).toThrow('Invalid project car');
    expect(() => parseProject(withCar({ cog: false }))).toThrow('Invalid project car');
    expect(parseProject(withCar({ gauge: 'monorail' })).cars[0].gauge).toBe('monorail');
  });
});
