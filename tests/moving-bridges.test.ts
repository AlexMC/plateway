import { describe, expect, it } from 'vitest';
import { createProject, type RoutePiece, type WorkshopProject } from '../src/domain/project';
import type { PartInstance } from '../src/domain/route';
import { piecePaths, piecePorts, pieceState, pieceStates } from '../src/domain/pieces';
import { rebuildPiecePoints, setPieceParam, setPieceState } from '../src/editor/operations';
import { fitProject } from '../src/fitting/fit';
import { routePath } from '../src/drive/traversal';

const X = 1000, Y = 1000;
function route(id: string, piece: RoutePiece) {
  return { id, name: id, pieces: [piece], points: [] };
}
/** A bridge at (X, Y) with a 256 mm straight running up to its `in` port and another leaving its `out` port. */
function crossing(family: string, params: Record<string, number> = {}, state?: string): WorkshopProject {
  const project = createProject('Bridges');
  const bridge = route('bridge', { id: 'bridge', family, x: X, y: Y, z: 0, heading: 0, params, ...(state ? { state } : {}) });
  rebuildPiecePoints(project, bridge);
  project.routes = [bridge];
  const out = piecePorts(bridge.pieces[0], project).find(port => port.id === 'out')!;
  const west = route('west', { id: 'west', family: 'track_straight', x: X - 256, y: Y, z: 0, heading: 0, params: { length: 256 } });
  const east = route('east', { id: 'east', family: 'track_straight', x: out.x, y: out.y, z: 0, heading: 0, params: { length: 256 } });
  for (const item of [west, east]) rebuildPiecePoints(project, item);
  project.routes = [bridge, west, east];
  return project;
}
type Assembly = Extract<PartInstance, { interfaceKind: 'track-assembly' }>;
/** The fitted printed assembly of piece `id`. */
const assembly = (project: WorkshopProject, id: string) => fitProject(project).partInstances.find(part => part.id === id) as Assembly;
const ids = (project: WorkshopProject, routeId: string) => routePath(fitProject(project).sections, routeId).sections.map(section => section.id);

describe('moving spans (C4)', () => {
  it.each([
    ['bridge_lift_out', 'out', 'The lift-out section is removed.'],
    ['bridge_drop_leaf', 'up', 'The hinged section is raised.'],
    ['bridge_bascule', 'up', 'The bascule bridge is raised.'],
    ['bridge_swing', 'open', 'The swing bridge is open.'],
    ['bridge_lift', 'up', 'The lift bridge is raised.']
  ])('%s carries trains only while in place; otherwise the route stops at the landing and says why', (family, away, message) => {
    const project = crossing(family);
    expect(ids(project, 'west')).toEqual(['west', 'bridge:main', 'east']);
    const opened = setPieceState(project, 'bridge', away);
    const west = routePath(fitProject(opened).sections, 'west');
    expect(west.gap).toBeNull();
    expect(west.sections.map(section => section.id)).toEqual(['west']);
    expect(west.endHalt).toBe(message);
    expect(routePath(fitProject(opened).sections, 'east').startHalt).toBe(message);
    // The deck's position is not physical track while it is away, but both ports stay snap targets.
    const paths = piecePaths(opened.routes[0].pieces[0], opened);
    expect(paths.every(path => path.moving && !path.enabled)).toBe(true);
    expect(piecePorts(opened.routes[0].pieces[0], opened).map(port => port.id).sort()).toEqual(['in', 'out']);
    // The printed parts are the same in every state; only the open route changes.
    expect(assembly(opened, 'bridge').paths.map(path => path.enabled)).toEqual([false]);
    expect(assembly(opened, 'bridge').parameters).toEqual({ ...assembly(project, 'bridge').parameters, state: 1 });
    expect(ids(setPieceState(opened, 'bridge', pieceStates(opened.routes[0].pieces[0])![0].id), 'west')).toEqual(['west', 'bridge:main', 'east']);
  });

  it('chains between straights in one route without a break, on the stud grid', () => {
    const project = createProject('Chain');
    const pieces: RoutePiece[] = [];
    let x = X;
    for (const [family, params] of [['track_straight', { length: 256 }], ['bridge_swing', { span: 160 }], ['track_straight', { length: 256 }]] as const) {
      const piece: RoutePiece = { id: `p${pieces.length}`, family, x, y: Y, z: 0, heading: 0, params: { ...params } };
      pieces.push(piece);
      x = piecePorts(piece, project).find(port => port.id === 'out')!.x;
    }
    const chained = route('chain', pieces[0]);
    chained.pieces = pieces;
    rebuildPiecePoints(project, chained);
    project.routes = [chained];
    expect(fitProject(project).issues.filter(issue => issue.severity === 'error')).toEqual([]);
    expect(ids(project, 'chain')).toEqual(['p0', 'p1:main', 'p2']);
  });

  it('keeps every span on the stud grid: landings 6 studs, the span in whole studs', () => {
    for (const [family, span] of [['bridge_lift_out', 64], ['bridge_drop_leaf', 160], ['bridge_bascule', 96], ['bridge_swing', 144], ['bridge_lift', 128]] as const) {
      const project = crossing(family, { span });
      const out = piecePorts(project.routes[0].pieces[0], project).find(port => port.id === 'out')!;
      expect(out.x - X).toBeCloseTo(96 + span, 9);
      expect(((out.x - X) / 8) % 1).toBe(0);
    }
  });
});

describe('train elevator (C4)', () => {
  function elevator(levels: number, state?: string) {
    const project = createProject('Elevator');
    const car = route('car', { id: 'car', family: 'train_elevator', x: X, y: Y, z: 0, heading: 0, params: { levels, level_height: 128 }, ...(state ? { state } : {}) });
    rebuildPiecePoints(project, car);
    project.routes = [car];
    const ports = piecePorts(car.pieces[0], project);
    const leaving = (level: number) => {
      const port = ports.find(item => item.id === (level ? `out-${level + 1}` : 'out'))!;
      return route(`level-${level + 1}`, { id: `level-${level + 1}`, family: 'track_straight', x: port.x, y: port.y, z: port.z, heading: 0, params: { length: 256 } });
    };
    const extra = Array.from({ length: levels }, (_, level) => leaving(level));
    for (const item of extra) rebuildPiecePoints(project, item);
    project.routes = [car, ...extra];
    return project;
  }

  it('offers one state per level and a port pair at each level height', () => {
    const project = elevator(3);
    const car = project.routes[0].pieces[0];
    expect(pieceStates(car)!.map(state => state.id)).toEqual(['level-1', 'level-2', 'level-3']);
    const ports = piecePorts(car, project);
    expect(ports.map(port => [port.id, port.z]).sort()).toEqual([['in', 0], ['in-2', 128], ['in-3', 256], ['out', 0], ['out-2', 128], ['out-3', 256]]);
    // Fewer levels: a car left at a level that no longer exists falls back to the ground.
    const lowered = setPieceParam(setPieceState(project, 'car', 'level-3'), 'car', 'levels', 2);
    expect(pieceState(lowered.routes[0].pieces[0])).toBe('level-1');
  });

  it('runs a train only through the level the car is at', () => {
    let project = elevator(2, 'level-2');
    expect(ids(project, 'level-2')).toEqual(['car:level-2', 'level-2']);
    const ground = routePath(fitProject(project).sections, 'level-1');
    expect(ground.sections.map(section => section.id)).toEqual(['level-1']);
    expect(ground.startHalt).toBe('The elevator car is at level 2.');
    project = setPieceState(project, 'car', 'level-1');
    expect(ids(project, 'level-1')).toEqual(['car:main', 'level-1']);
    const fitted = assembly(project, 'car');
    expect(fitted.ports.find(port => port.id === 'out-2')!.pose.z).toBeCloseTo(128, 9);
    expect(fitted.paths.map(path => [path.id, path.enabled])).toEqual([['main', true], ['level-2', false]]);
  });
});
