import { describe, expect, it } from 'vitest';
import { CARS_NEEDED_MESSAGE, createProject } from '../src/domain/project';
import { port, type Section } from '../src/domain/route';
import { checkCrossings } from '../src/fitting/crossing';
import { fitProject } from '../src/fitting/fit';
import { overpass, WAGON } from './overpass';

describe('three-dimensional crossing', () => {
  it('clears a bridge tile over the lower track for the tallest real car', () => {
    const fit = fitProject(overpass());
    expect(fit.crossings[0].status).toBe('digitally-clear');
    expect(fit.crossings[0].upperPoint.z).toBeCloseTo(90);
    expect(fit.geometryFeasible).toBe(true);
  });
  it('blocks a car taller than the space under the bridge', () => {
    const fit = fitProject(overpass({ cars: [WAGON, { ...WAGON, id: 'tall', height: 90 }] }));
    expect(fit.crossings[0].status).toBe('blocked');
    expect(fit.issues).toContainEqual(expect.objectContaining({ code: 'crossing-clearance', severity: 'error' }));
  });
  it('ignores example cars and asks for the real train', () => {
    const fit = fitProject(overpass({ cars: [{ ...WAGON, height: 200, example: true }] }));
    expect(fit.crossings[0].status).toBe('unknown');
    expect(fit.issues).toContainEqual(expect.objectContaining({ code: 'crossing-envelope-unknown', message: CARS_NEEDED_MESSAGE }));
    expect(fit.geometryFeasible).toBe(true);
  });
  it('cannot clear a crossing without a bridge tile over it', () => {
    const fit = fitProject(overpass({ deck: 'printed_straight' }));
    expect(fit.crossings[0].status).toBe('unknown');
    expect(fit.issues.some(issue => issue.code === 'deck-clearance-unknown')).toBe(true);
  });
  it('finds a route crossing itself, skipping pieces that only touch, with the higher side as the bridge', () => {
    const project = createProject('Figure eight');
    project.cars = [WAGON];
    project.crossings = [{ id: 'self', upperRouteId: 'loop', lowerRouteId: 'loop' }];
    const straight = (id: string, a: [number, number, number], b: [number, number, number]): Section => ({
      id, routeId: 'loop', fromPointId: `${id}:start`, toPointId: `${id}:end`, family: 'printed_straight', kind: 'straight',
      start: port({ x: a[0], y: a[1], z: a[2], heading: 0, pitch: 0 }, 40, 2.4),
      end: port({ x: b[0], y: b[1], z: b[2], heading: 0, pitch: 0 }, 40, 2.4), run: Math.hypot(b[0]-a[0], b[1]-a[1]), parameters: {}
    });
    const { crossings, issues } = checkCrossings(project, [
      straight('under', [100, -200, 0], [100, 200, 0]),
      straight('join', [100, 200, 0], [300, 200, 100]),
      straight('over', [0, 0, 100], [200, 0, 100])
    ]);
    expect(crossings).toHaveLength(1);
    expect(crossings[0].upperPoint).toMatchObject({ x: 100, y: 0, z: 100 });
    expect(crossings[0].lowerPoint).toMatchObject({ x: 100, y: 0, z: 0 });
    expect(issues.some(issue => issue.code === 'crossing-no-intersection' || issue.code === 'crossing-clearance')).toBe(false);
  });
  // A line that leaves a loop at a turnout and bridges back over it touches the loop at the branch joint (gap 0):
  // that joint must not stand in for the bridge.
  const branchOverLoop = (bridge: number) => {
    const project = createProject('Branch over its loop');
    project.cars = [WAGON];
    project.crossings = [{ id: 'over-loop', upperRouteId: 'branch', lowerRouteId: 'loop' }];
    const straight = (id: string, routeId: string, a: [number, number, number], b: [number, number, number], pieceId?: string): Section => ({
      id, routeId, ...(pieceId ? { pieceId } : {}), fromPointId: `${id}:start`, toPointId: `${id}:end`, family: 'printed_straight', kind: 'straight',
      start: port({ x: a[0], y: a[1], z: a[2], heading: 0, pitch: 0 }, 40, 2.4),
      end: port({ x: b[0], y: b[1], z: b[2], heading: 0, pitch: 0 }, 40, 2.4), run: Math.hypot(b[0]-a[0], b[1]-a[1]), parameters: {}
    });
    return checkCrossings(project, [
      straight('points-main', 'loop', [0, 0, 0], [256, 0, 0], 'turnout'),
      straight('points-branch', 'loop', [0, 0, 0], [256, -100, 0], 'turnout'),
      straight('loop-far-side', 'loop', [600, -300, 0], [600, 300, 0]),
      straight('leave', 'branch', [256, -100, 0], [400, -100, 0]),
      straight('climb', 'branch', [400, -100, 0], [500, 0, bridge]),
      straight('bridge', 'branch', [500, 0, bridge], [700, 0, bridge])
    ]);
  };
  it('measures a branch bridging back over its own loop at the bridge, not at the turnout joint', () => {
    const { crossings, issues } = branchOverLoop(140);
    expect(crossings).toHaveLength(1);
    expect(crossings[0].upperPoint).toMatchObject({ x: 600, y: 0, z: 140 });
    expect(crossings[0].lowerPoint).toMatchObject({ x: 600, y: 0, z: 0 });
    expect(issues.some(issue => issue.code === 'crossing-clearance' || issue.code === 'crossing-no-intersection')).toBe(false);
  });
  it('still blocks a branch bridge too low for the train over its own loop', () => {
    const { crossings, issues } = branchOverLoop(40);
    expect(crossings[0].status).toBe('blocked');
    expect(crossings[0].upperPoint).toMatchObject({ x: 600, y: 0, z: 40 });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'crossing-clearance', severity: 'error',
      message: expect.stringContaining('Only 40 mm under the bridge') }));
  });
});
