import { describe, expect, it } from 'vitest';
import { piecePorts } from '../src/domain/pieces';
import { KALLAX_5X5, parseProject, serializeProject } from '../src/domain/project';
import { solveGap } from '../src/domain/solver/gap';
import { createStandardProject } from '../src/editor/setup-defaults';
import { buildPlan, describeReport, type BuiltPlan } from '../src/plan/build';

const EXAMPLES = import.meta.glob<unknown>('../docs/plans/examples/*.json', { eager: true, import: 'default' });
/** A fresh copy of a documented example plan. */
const example = (name: string): unknown => structuredClone(EXAMPLES[`../docs/plans/examples/${name}.json`]);
const pieces = (project: BuiltPlan['project']) => project.routes.flatMap(route => route.pieces);

describe('track plan builder', () => {
  it('builds every documented example cleanly into a project the app can open', () => {
    const names = Object.keys(EXAMPLES).map(file => file.slice('../docs/plans/examples/'.length, -'.json'.length));
    expect(names.length).toBeGreaterThanOrEqual(4);
    for (const name of names) {
      const { project, report } = buildPlan(example(name));
      expect({ name, ok: report.ok, errors: report.errors, trains: report.trains.filter(train => !train.ok) }).toEqual({ name, ok: true, errors: [], trains: [] });
      expect(parseProject(serializeProject(project)).routes).toEqual(project.routes);
    }
  }, 30_000);

  it('closes an oval of owned R40 curves and straights that the example train runs round', () => {
    const { project, report } = buildPlan(example('oval'));
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.fit.openEnds).toEqual([]);
    expect(pieces(project).map(piece => piece.family).sort()).toEqual([...Array(16).fill('brick_curve_r40'), ...Array(8).fill('brick_straight_nominal')]);
    expect(report.trains).toEqual([expect.objectContaining({ track: 'main', ok: true, closed: true, switches: [] })]);
  });

  it('gives a passing loop two routes the train can take, one per turnout setting', () => {
    const { report } = buildPlan(example('passing-loop'));
    expect(report.ok).toBe(true);
    const main = report.trains.find(train => train.track === 'main')!, loop = report.trains.find(train => train.track === 'loop')!;
    expect(main).toMatchObject({ ok: true, closed: true, switches: [] });
    expect(loop).toMatchObject({ ok: true, closed: true, switches: [{ piece: 'A', state: 'diverging' }, { piece: 'B', state: 'diverging' }] });
    // Through the loop is a different, longer way round than along the main line.
    expect(loop.length).toBeGreaterThan(main.length);
  });

  it('ends a siding from a turnout branch on a buffer stop, with nothing left open', () => {
    const { project, report } = buildPlan(example('passing-loop'));
    const siding = report.steps.filter(step => step.path.startsWith('tracks[2]'));
    expect(siding.at(-1)!.pieces.map(piece => piece.family)).toEqual(['buffer_stop']);
    expect(report.fit.openEnds).toEqual([]);
    expect(report.trains.find(train => train.track === 'siding')).toMatchObject({ ok: true, closed: false, switches: [{ piece: 'C', state: 'diverging' }] });
    // The buffer's far end joins nothing, so the siding offers no end to build on.
    const buffer = pieces(project).find(piece => piece.family === 'buffer_stop')!;
    expect(piecePorts(buffer, project).find(port => port.id === 'out')!.stop).toBe(true);
    const extended = buildPlan({ ...(example('passing-loop') as object), tracks: [...(example('passing-loop') as { tracks: unknown[] }).tracks,
      { id: 'more', start: { from: 'siding.end' }, steps: [{ straight: 128 }] }] }).report;
    expect(extended.errors).toEqual([expect.objectContaining({ path: 'tracks[3].start' })]);
  });

  it('reports why a close cannot join two ends, with the solver reason and the step path', () => {
    const plan = { version: 1, name: 'Bad close', tracks: [
      { id: 'a', start: { x: 300, y: 300, heading: 0 }, steps: [{ straight: 128 }] },
      { id: 'b', start: { x: 900, y: 600, heading: 90 }, steps: [{ straight: 128 }, { close: 'a.end' }] }
    ] };
    const { report } = buildPlan(plan);
    const reason = solveGap({ x: 900, y: 728, z: 0, heading: Math.PI / 2 }, { x: 428, y: 300, z: 0, heading: 0 });
    expect(reason.ok).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].path).toBe('tracks[1].steps[1]');
    expect(report.errors[0].message).toContain(reason.ok ? '' : reason.reason);
    expect(report.errors[0].hint).toBeTruthy();
    // Both ends stay open for the next attempt.
    expect(report.fit.openEnds.map(end => end.label)).toEqual(expect.arrayContaining(['a.end', 'b.end']));
  });

  it('falls back to printed pieces once the owned stock runs out, and the bill shows it', () => {
    const base = createStandardProject('Short stock');
    base.inventory.brick_straight_nominal = 3;
    const plan = { version: 1, name: 'Long straight', tracks: [{ id: 'run', start: { x: 300, y: 300 }, steps: [{ straight: 128, count: 5 }] }] };
    const { project, report } = buildPlan(plan, base);
    expect(report.steps[0].pieces.map(piece => [piece.source, piece.fallback ?? false])).toEqual([
      ['owned', false], ['owned', false], ['owned', false], ['printed', true], ['printed', true]]);
    expect(report.bill.owned).toContainEqual({ family: 'brick_straight_nominal', used: 3, stock: 3 });
    expect(report.bill.printed).toEqual([{ family: 'printed_brick_straight', count: 2 }]);
    expect(report.bill.fallbacks).toEqual([{ family: 'brick_straight_nominal', count: 2 }]);
    // Never more owned pieces than the inventory holds, so fit has no shortfall.
    expect(report.fit.issues.map(issue => issue.code)).not.toContain('owned-piece-unavailable');
    // Stock already used by the base project counts too.
    const again = buildPlan({ ...plan, tracks: [{ id: 'more', start: { x: 300, y: 800 }, steps: [{ straight: 128, count: 2 }] }] }, project).report;
    expect(again.steps[0].pieces.every(piece => piece.source === 'printed' && piece.fallback)).toBe(true);
  });

  it('reports a bad reference and an unknown family with their paths, and builds the rest', () => {
    const plan = { version: 1, name: 'Mistakes', tracks: [
      { id: 'main', start: { x: 300, y: 300 }, steps: [{ straight: 128 }, { piece: 'warp_drive' }, { straight: 128 }] },
      { id: 'spur', start: { from: 'Z.branch' }, steps: [{ straight: 128 }] },
      { id: 'other', start: { x: 300, y: 800 }, steps: [{ curve: 'R40', turn: 'left', angel: 45 }] },
      { id: 'fine', start: { x: 300, y: 1300 }, steps: [{ straight: 64 }] }
    ] };
    let result!: BuiltPlan;
    expect(() => { result = buildPlan(plan); }).not.toThrow();
    const { report } = result;
    expect(report.ok).toBe(false);
    expect(report.errors.map(error => error.path)).toEqual(['tracks[0].steps[1].piece', 'tracks[2].steps[0].angel', 'tracks[1].start']);
    expect(report.errors.every(error => error.hint)).toBe(true);
    expect(report.steps.map(step => step.path)).toEqual(['tracks[0].steps[0]', 'tracks[3].steps[0]']);
  });

  it('starts a track at a KALLAX cubby opening, heading into the cubby', () => {
    const plan = { version: 1, name: 'Cubby', furniture: [{ id: 'K1', kallax: { x: 1000, y: 1000, quarterTurns: 1 } }],
      tracks: [{ id: 'in', start: { kallax: 'K1', cubby: [2, 4], side: 'front' }, steps: [{ straight: 128 }] }] };
    const { project, report } = buildPlan(plan);
    expect(report.errors).toEqual([]);
    expect(project.furniture).toEqual([expect.objectContaining({ x: 1000, y: 1000, quarterTurns: 1 })]);
    // Shelf frame: columns along +x from the left seen from the front (the −y face), rows up from the bottom panel.
    const { width, depth, outer, inner, opening } = KALLAX_5X5;
    const local = { x: -width / 2 + outer + 3 * (opening + inner) + opening / 2, y: -depth / 2 };
    const first = pieces(project)[0];
    // A quarter turn maps the shelf's (x, y) to the room's (−y, x); into the cubby (+y) becomes −x.
    expect(first.x).toBeCloseTo(1000 - local.y, 6);
    expect(first.y).toBeCloseTo(1000 + local.x, 6);
    expect(first.z).toBeCloseTo(outer + opening + inner, 6);
    expect(Math.cos(first.heading)).toBeCloseTo(-1, 9);
  });
  it('reports track that leaves the room or runs into a shelf body, by step and distance', () => {
    const shelf = { id: 'K1', kallax: { x: 1200, y: 1800, quarterTurns: 0 } };
    const plan = { version: 1, name: 'Off the plan', furniture: [shelf], tracks: [
      { id: 'west', start: { x: 100, y: 500, heading: 180 }, steps: [{ straight: 64 }, { straight: 128, count: 2 }] },
      // Floor level, straight at the bottom panel of the middle cubby (its floor is 38 mm up).
      { id: 'low', start: { x: 1200, y: 1400, heading: 90 }, steps: [{ straight: 128 }, { straight: 128 }] },
      // On the cubby floor it enters cleanly.
      { id: 'cubby', start: { kallax: 'K1', cubby: [1, 3] }, steps: [{ straight: 128, count: 2 }] }
    ] };
    const { report } = buildPlan(plan);
    expect(report.ok).toBe(false);
    expect(report.errors.map(error => [error.path, error.space])).toEqual([['tracks[0].steps[1]', 'room'], ['tracks[1].steps[1]', 'shelf']]);
    // 100 mm of room behind the start, then 64 + 256 mm of track and its 6 mm connector: 226 mm past the x = 0 wall.
    expect(report.errors[0].message).toContain('226 mm past x = 0');
    expect(report.errors[1].message).toContain('K1');
    expect(report.errors.every(error => error.hint)).toBe(true);
    // Said once, by step: fit's own room issues stay out of the report.
    expect(report.fit.issues.filter(issue => ['track-outside-room', 'track-into-shelf'].includes(issue.code))).toEqual([]);
  });

  it('merges identical per-piece fit issues of one step into one line', () => {
    // One R56 helix turn climbing 127 mm (4.5 %): every graded section of it is steep.
    const plan = { version: 1, name: 'Steep', tracks: [{ id: 'up', start: { x: 1200, y: 1000 }, steps: [{ helix: { turns: 1, radius: 'R56', dir: 'left', climb: 'up', rise: 127 } }] }] };
    const { report } = buildPlan(plan);
    const steep = report.fit.issues.filter(issue => issue.code === 'grade-steep');
    expect(steep).toEqual([expect.objectContaining({ steps: ['tracks[0].steps[0]'] })]);
    expect(steep[0].count).toBeGreaterThan(1);
    expect(steep[0].count).toBeLessThanOrEqual(report.steps[0].pieces.length);
    expect(describeReport(report).split('\n').filter(line => line.includes('grade-steep'))).toHaveLength(1);
  });
  it('runs a branch that joins a loop through a plain turnout, on the route Test drive drives it by', () => {
    // From its own end the portal laps the oval back into C's straight side (set diverging): Route 1 runs it the other way.
    const plan = { version: 1, name: 'Portal branch', furniture: [{ id: 'K1', kallax: { x: 1200, y: 1850, quarterTurns: 0 } }], tracks: [
      { id: 'oval', start: { x: 500, y: 250, heading: 0 }, steps: [{ turnout: 'right', as: 'C', set: 'straight' }, { straight: 128, count: 3 },
        { curve: 'R40', turn: 'left', angle: 180 }, { straight: 128, count: 5 }, { curve: 'R40', turn: 'left', angle: 180 }, { close: 'oval.start' }] },
      { id: 'portal', start: { kallax: 'K1', cubby: [1, 5], side: 'back' }, steps: [{ straight: 128, count: 3 }, { raise: { to: 0, grade: 4.5 } },
        { curve: 'R40', turn: 'right', angle: 90 }, { close: 'C.branch' }] }
    ] };
    const { project, report } = buildPlan(plan);
    expect(report.errors).toEqual([]);
    const portal = report.trains.find(train => train.track === 'portal')!;
    expect(portal).toMatchObject({ ok: true, closed: false, switches: [{ piece: 'C', state: 'diverging' }] });
    const portalRoute = project.routes.find(route => route.pieces.some(piece => piece.id === report.steps.find(step => step.path === 'tracks[1].steps[0]')!.pieces[0].id))!;
    expect(portal.route).not.toBe(portalRoute.name);
  });

  it('starts a climb right after a turnout with the 128 mm of level the points need', () => {
    const plan = { version: 1, name: 'Climb off the points', tracks: [{ id: 'up', start: { x: 400, y: 800, heading: 0 },
      steps: [{ turnout: 'left', as: 'A', set: 'straight' }, { raise: { to: 40, grade: 5 } }, { straight: 128 }] }] };
    const { project, report } = buildPlan(plan);
    expect(report.errors).toEqual([]);
    const climb = pieces(project).find(piece => piece.family === 'track_climb')!;
    expect(climb.params?.lead).toBe(128);
    expect(report.fit.issues.filter(issue => issue.code.startsWith('junction'))).toEqual([]);
    // Further along level track, a climb needs no lead of its own.
    const later = buildPlan({ ...plan, tracks: [{ ...plan.tracks[0], steps: [plan.tracks[0].steps[0], { straight: 128 }, ...plan.tracks[0].steps.slice(1)] }] });
    expect(pieces(later.project).find(piece => piece.family === 'track_climb')!.params?.lead).toBeUndefined();
  });
});
