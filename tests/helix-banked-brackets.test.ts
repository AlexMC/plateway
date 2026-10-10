import { describe, expect, it } from 'vitest';
import { createProject, type WorkshopProject } from '../src/domain/project';
import { ELEVATION } from '../src/domain/elevation';
import { compositeLength, piecePorts, splitComposite, tieStations, type CompositeTrack } from '../src/domain/pieces';
import { sliceTrackOptions } from '../src/domain/pieces/families/track-options';
import { fitProject } from '../src/fitting/fit';
import { HELIX_COLUMN } from '../src/fitting/own-supports';
import { routePath, samplePath } from '../src/drive/traversal';
import { placePiece } from '../src/editor/operations';
import { placeKitPieces } from '../src/editor/elevation-kits';
import { HELIX_SECTOR, layHelix, minimumRise, planHelix, type HelixOptions } from '../src/editor/helix';
import { layWallRun, type WallRunOptions } from '../src/editor/wall-run';

const DEG = Math.PI / 180;
const brick = (cars = true): WorkshopProject => ({ ...createProject('Elevation'), trackSystem: 'brick-v1',
  cars: cars ? [{ id: 'car', name: 'Car', length: 230, width: 62, height: 96, wheelbase: 140, couplerGap: 8 }] : [] });
const HELIX: HelixOptions = { radius: 576, turns: 2, rise: minimumRise(576), hand: 1, direction: 1, columns: 8, side: 1, offset: 56 };
function helixProject(options: Partial<HelixOptions> = {}, cars = true): WorkshopProject {
  const project = brick(cars);
  return placeKitPieces(project, layHelix(project, { x: 1200, y: 400, z: 0, heading: 0 }, { ...HELIX, ...options }))[0];
}

describe('helix kit', () => {
  it('climbs from level to level in quarter turns, easing within the vertical-curve limit, with room for trains between turns', () => {
    for (const radius of [576, 704, 832]) {
      const options = { ...HELIX, radius, rise: minimumRise(radius), turns: 2.25 }, plan = planHelix(options);
      expect(plan.problem).toBeNull();
      expect(plan.sections).toHaveLength(2.25 * 360 / HELIX_SECTOR);
      expect(plan.sections[0].grade0).toBe(0);
      expect(plan.sections.at(-1)!.grade1).toBeCloseTo(0, 12);
      expect(plan.grade).toBeLessThanOrEqual(ELEVATION.maxGrade);
      expect(plan.clearance).toBeGreaterThanOrEqual(ELEVATION.clearance);
      const length = radius * HELIX_SECTOR * DEG;
      for (const section of plan.sections) {
        const change = Math.abs(section.grade1 - section.grade0) / 100;
        if (change) expect(length / change).toBeGreaterThanOrEqual(ELEVATION.verticalRadius - 1e-6);
      }
      // A quarter-turn helix leaves square to where it entered, on the 22.5° grid.
      const project = brick(), pieces = layHelix(project, { x: 0, y: 0, z: 0, heading: 0 }, options);
      const out = piecePorts(pieces.at(-1)!, project).find(port => port.id === 'out')!;
      expect(Math.sin(out.heading - Math.PI / 2)).toBeCloseTo(0, 9);
      expect(out.pitch ?? 0).toBeCloseTo(0, 9);
    }
  });

  it('refuses grades over 5 % and warns below the 118 mm clearance', () => {
    expect(planHelix({ ...HELIX, radius: 448, rise: 160 }).problem).toMatch(/Too steep/);
    expect(planHelix({ ...HELIX, rise: 125 }).caution).toMatch(/between turns/);
    expect(planHelix({ ...HELIX, turns: 1.1 }).problem).toMatch(/quarter turns/);
  });

  it('fits as one drivable route whose lugs stack into printable columns, with no generic supports under it', { timeout: 20000 }, () => {
    const project = helixProject(), fit = fitProject(project), route = project.routes[0];
    expect(project.routes).toHaveLength(1);
    expect(fit.issues.filter(issue => issue.severity === 'error')).toEqual([]);
    expect(fit.supports).toEqual([]);
    expect(fit.crossings.map(crossing => crossing.status)).toEqual(['digitally-clear']);
    const path = routePath(fit.sections, route.id);
    expect(path.gap).toBeNull();
    const middle = samplePath(path, path.length / 2)!;
    expect(Math.tan(middle.pitch)).toBeCloseTo(HELIX.rise / (2 * Math.PI * HELIX.radius), 3);
    const tubes = fit.partInstances.filter(part => part.family === 'helix_column');
    const stacks = new Map<string, typeof tubes>();
    for (const tube of tubes) stacks.set(`${tube.pose.x.toFixed(1)},${tube.pose.y.toFixed(1)}`, [...stacks.get(`${tube.pose.x.toFixed(1)},${tube.pose.y.toFixed(1)}`) ?? [], tube]);
    expect(stacks.size).toBe(8);
    for (const stack of stacks.values()) {
      stack.sort((a, b) => a.pose.z - b.pose.z);
      expect(stack[0].parameters.foot).toBe(1);
      expect(stack[0].pose.z).toBe(0);
      for (const [index, tube] of stack.entries()) {
        expect(tube.parameters.spigot).toBe(HELIX_COLUMN.engage + HELIX_COLUMN.lug);
        // Each tube reaches the next lug's underside; the one above starts on that lug's top.
        if (index) expect(tube.pose.z).toBeCloseTo(stack[index - 1].pose.z + stack[index - 1].parameters.height + HELIX_COLUMN.lug, 6);
        if (index) expect(tube.parameters.height).toBeCloseTo(HELIX.rise - HELIX_COLUMN.lug, 2);
      }
    }
    // The lugs sit inside the curve, clear of the track and of the car.
    const centre = { x: 1200, y: 400 + HELIX.radius };
    for (const tube of tubes) expect(Math.hypot(tube.pose.x - centre.x, tube.pose.y - centre.y)).toBeCloseTo(HELIX.radius - HELIX.offset, 0);
  });

  it('measures the clearance between turns on the printed wedges and against the tallest car', { timeout: 20000 }, () => {
    const low = fitProject(helixProject({ rise: 128 }));
    expect(low.issues.find(issue => issue.code === 'helix-clearance')).toMatchObject({ severity: 'warning' });
    const tall = helixProject({ rise: 128 });
    tall.cars = [{ id: 'tall', name: 'Double-decker', length: 230, width: 62, height: 120, wheelbase: 140, couplerGap: 8 }];
    expect(fitProject(tall).issues.find(issue => issue.code === 'helix-clearance')).toMatchObject({ severity: 'error' });
    expect(fitProject(helixProject({ columns: 0 })).issues.map(issue => issue.code)).toContain('helix-unsupported');
  });

  it('flags a column standing in other track', () => {
    let project = helixProject({ turns: 1 });
    const column = fitProject(project).partInstances.find(part => part.family === 'helix_column')!;
    [project] = placePiece(project, 'track_straight', { x: column.pose.x - 64, y: column.pose.y, z: 0, heading: 0, params: { length: 128 } }, -1);
    expect(fitProject(project).issues.map(issue => issue.code)).toContain('helix-column-collision');
  });
});

describe('banked curve', () => {
  const bank = (params: Record<string, number>, printer: WorkshopProject['printer'] = 'X1 Carbon') => {
    const project = { ...brick(), printer };
    return placePiece(project, 'track_banked', { x: 1000, y: 1000, params }, -1)[0];
  };
  it('prints as level-ended entry and exit parts around a canted body joined at plain cut ends', () => {
    for (const printer of ['X1 Carbon', 'A1 mini'] as const) {
      const fit = fitProject(bank({ radius: 448, sweep: 45, cant: 2.9, transition: 96 }, printer));
      expect(fit.issues.filter(issue => issue.severity === 'error')).toEqual([]);
      const parts = fit.partInstances.filter(part => part.family === 'composite_track');
      expect(parts.length).toBeGreaterThanOrEqual(3);
      expect(parts[0].parameters).toMatchObject({ ends: 1, cant0: 0, cant1: 2.9 });
      expect(parts.at(-1)!.parameters).toMatchObject({ ends: 2, cant0: 2.9, cant1: 0 });
      for (const part of parts.slice(1, -1)) expect(part.parameters).toMatchObject({ ends: 0, cant0: 2.9, cant1: 2.9 });
      expect(parts[0].parameters.s0_len).toBe(96);
    }
  });
  it('rolls the train with the cant, outer rail up, either way round', () => {
    const project = bank({ radius: 448, sweep: -45, cant: 2.3, transition: 96 }), fit = fitProject(project);
    const path = routePath(fit.sections, project.routes[0].id);
    expect(samplePath(path, 0)!.roll ?? 0).toBeCloseTo(0, 9);
    // A right-hand curve raises the left rail: negative roll.
    expect(samplePath(path, path.length / 2)!.roll! / DEG).toBeCloseTo(-2.3, 6);
    const reversed = routePath(fit.sections.map(section => ({ ...section, start: section.end, end: section.start,
      pathPoints: [...section.pathPoints!].reverse().map(pose => ({ ...pose, heading: pose.heading + Math.PI, pitch: -pose.pitch, roll: -(pose.roll ?? 0) })) })), project.routes[0].id);
    expect(samplePath(reversed, reversed.length / 2)!.roll! / DEG).toBeCloseTo(2.3, 6);
  });
  it('cuts a cant profile at its knees and only at tie stations', () => {
    const track: CompositeTrack = { segments: [{ len: 704, k0: 1 / 448, k1: 1 / 448 }], z0: 0, z1: 0, grade0: 0, grade1: 0, cant0: 0, cant1: 0, vcurve: 0,
      cants: [{ s: 0, cant: 0 }, { s: 96, cant: 2 }, { s: 608, cant: 2 }, { s: 704, cant: 0 }] };
    const cuts = splitComposite(track, part => compositeLength(part) <= 200)!;
    expect(cuts).toEqual(expect.arrayContaining([0, 96, 608, 704]));
    for (const cut of cuts.slice(1, -1)) expect(tieStations(704)).toContain(cut);
  });
});

describe('wall and shelf brackets', () => {
  const run = (options: Partial<WallRunOptions>, z = 300) => {
    const project = brick();
    return placeKitPieces(project, layWallRun(project, { x: 500, y: 500, z, heading: 0 },
      { length: 1024, height: z, mount: 1, side: 1, reach: 72, spacing: 256, shelf: 16, ...options }))[0];
  };
  it('puts a bracket under a full sleeper about every spacing, on the wall side, and no generic supports', () => {
    const fit = fitProject(run({})), brackets = fit.partInstances.filter(part => part.family === 'track_bracket');
    expect(fit.issues.filter(issue => issue.severity === 'error')).toEqual([]);
    expect(fit.supports).toEqual([]);
    expect(brackets).toHaveLength(4);
    const parts = fit.partInstances.filter(part => part.family === 'composite_track');
    const ties = parts.flatMap(part => tieStations(part.parameters.s0_len).map(station => part.pose.x + station));
    for (const bracket of brackets) {
      expect(ties.some(tie => Math.abs(tie - bracket.pose.x) < 1e-6)).toBe(true);
      expect(bracket.pose).toMatchObject({ y: 500, z: 300, heading: 0 });
      expect(bracket.parameters).toEqual({ mount: 1, reach: 72, height: 0 });
    }
    const right = fitProject(run({ side: -1, mount: 2, shelf: 30 })).partInstances.filter(part => part.family === 'track_bracket');
    expect(right[0].pose.heading).toBeCloseTo(Math.PI, 12);
    expect(right[0].parameters).toEqual({ mount: 2, reach: 72, height: 30 });
  });
  it('flags brackets reaching below the table and walls a car would scrape', () => {
    expect(fitProject(run({}, 60)).issues.map(issue => issue.code)).toContain('bracket-below-ground');
    const wide = run({ reach: 48 });
    expect(fitProject(wide).issues.map(issue => issue.code)).not.toContain('bracket-wall-collision');
    wide.cars = [{ id: 'crane', name: 'Crane wagon', length: 230, width: 96, height: 96, wheelbase: 140, couplerGap: 8 }];
    expect(fitProject(wide).issues.map(issue => issue.code)).toContain('bracket-wall-collision');
  });
});

describe('column lug slicing', () => {
  it('moves a lug off a cut sleeper onto the slice-local full tie the CAD builds it on', () => {
    const { slices, socket } = sliceTrackOptions({ socket: 1, socket_s: 64, socket_side: 1, socket_offset: 56 }, 128, [0, 64, 128]);
    expect(socket).toEqual({ slice: 1, station: 96 });
    expect(slices[1]).toMatchObject({ socket: 1, socket_s: 32, socket_side: 1, socket_offset: 56 });
    expect(slices[0].socket).toBeUndefined();
  });
});
