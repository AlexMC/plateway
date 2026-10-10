import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerFurnitureType, unregisterFurnitureType, type FurnitureType } from '../src/domain/furniture';
import { createProject, type WorkshopProject } from '../src/domain/project';
import { fitProject } from '../src/fitting/fit';
import { placePiece } from '../src/editor/operations';
import { buildPlan } from '../src/plan/build';
import kallaxStation from '../docs/plans/examples/kallax-station.json';
import { overpass, WAGON } from './overpass';

describe('bridge supports', () => {
  it('rejects a column that cannot leave the underpassing train corridor, but not a wall bracket', () => {
    const project = overpass({ cars: [{ ...WAGON, width: 500 }] });
    const result = fitProject(project);
    expect(result.issues.some(issue => issue.code === 'support-track-collision')).toBe(true);
    expect(result.geometryFeasible).toBe(false);
    project.mounting = 'anchored';
    expect(fitProject(project).issues.some(issue => issue.code === 'support-track-collision')).toBe(false);
  });
  it('shifts a column out of the underpassing train corridor', () => {
    const project = overpass({ underX: 150 });
    const lowerX = project.routes[1].pieces[0].x;
    const result = fitProject(project);
    expect(result.issues.some(issue => issue.code === 'support-track-collision')).toBe(false);
    expect(result.supports.every(support => Math.abs(support.pose.x - lowerX) > WAGON.width / 2)).toBe(true);
    expect(result.geometryFeasible).toBe(true);
  });
  it('checks the corridor only against real cars', () => {
    const result = fitProject(overpass({ cars: [{ ...WAGON, width: 500, example: true }] }));
    expect(result.issues.some(issue => issue.code === 'support-track-collision')).toBe(false);
  });
  it('stands nothing under track a float hair above its ground, as a closed loop re-laid round a helix leaves it', () => {
    for (const trackSystem of ['custom-joiner-v1', 'brick-v1'] as const) {
      const [project] = placePiece({ ...createProject('Drift'), trackSystem }, 'printed_straight', { x: 500, y: 500, z: 1e-9 });
      expect(fitProject(project).supports).toEqual([]);
    }
  });
});

/** A 2000 × 800 coffee table, its top at 450 mm, centred at (1100, 1000): x 100–2100, y 600–1400. */
const TABLE: FurnitureType = {
  family: 'test_coffee_table', label: 'Coffee table', width: 2000, depth: 800, height: 450,
  surfaces: [{ id: 'top', name: 'top', height: 450, footprint: [{ x: -1000, y: -400 }, { x: 1000, y: -400 }, { x: 1000, y: 400 }, { x: -1000, y: 400 }], entries: [] }],
  panels: [{ x: 0, y: 0, z: 440, width: 2000, depth: 800, height: 20 }], orientations: [0, 1, 2, 3], colour: 0xffffff,
  plan: { lines: [], caption: 'Coffee table' }, terms: '', description: 'coffee table' };
const lay = (start: { x: number; y: number; z: number }, steps: unknown[]): WorkshopProject => {
  const base = { ...createProject('Table'), furniture: [{ id: 'T1', family: TABLE.family, x: 1100, y: 1000, quarterTurns: 0 as const }] };
  const { project, report } = buildPlan({ version: 1, name: 'On the table', tracks: [{ id: 't', start: { ...start, heading: 0 }, steps }] }, base);
  expect(report.errors).toEqual([]);
  return project;
};

describe('supports on furniture', () => {
  beforeAll(() => registerFurnitureType(TABLE));
  afterAll(() => unregisterFurnitureType(TABLE.family));

  it('stands nothing under an oval resting on a table top, so prints no columns', () => {
    const oval = lay({ x: 700, y: 700, z: 450 }, [{ straight: 128, count: 4 }, { curve: 'R40', turn: 'left', angle: 180 },
      { straight: 128, count: 4 }, { curve: 'R40', turn: 'left', angle: 180 }, { close: 't.start' }]);
    const fit = fitProject(oval);
    expect(fit.supports).toEqual([]);
    expect(fit.partInstances.filter(part => part.interfaceKind === 'mounting')).toEqual([]);
  });

  it('stands track raised above the top on supports from the top, not the floor', () => {
    const { supports } = fitProject(lay({ x: 250, y: 1000, z: 450 }, [{ straight: 128 }, { ramp: { rise: 40 } }, { straight: 128 }]));
    expect(supports.length).toBeGreaterThan(0);
    for (const support of supports) {
      expect(support.ground).toBe(450);
      expect(support.height).toBeLessThanOrEqual(40 + 1e-6);
    }
    expect(Math.max(...supports.map(support => support.height))).toBeCloseTo(40, 3);
  });

  it('stands track running off the top on the floor, and nothing under it while it still rests on the top', () => {
    const { supports } = fitProject(lay({ x: 1800, y: 1000, z: 450 }, [{ straight: 128, count: 4 }]));
    expect(supports.length).toBeGreaterThan(0);
    for (const support of supports) {
      expect(support.pose.x).toBeGreaterThan(2100);
      expect(support.ground).toBeUndefined();
      expect(support.height).toBeCloseTo(450, 6);
    }
  });

  it('stands nothing under the KALLAX station inside its cubby, but still stands the climb in front of the shelf on the table', () => {
    const { project } = buildPlan(kallaxStation);
    const shelf = project.furniture[0], { supports } = fitProject(project);
    expect(supports.length).toBeGreaterThan(0);
    for (const support of supports) {
      expect(support.pose.y).toBeLessThan(shelf.y - 390 / 2);
      expect(support.ground).toBeUndefined();
    }
  });
});
