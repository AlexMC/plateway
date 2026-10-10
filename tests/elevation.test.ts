import { describe, expect, it } from 'vitest';
import { ELEVATION, planRamp } from '../src/domain/elevation';
import { partUnderside, pieceDefinition, piecePaths, piecePorts, primaryEnd } from '../src/domain/pieces';
import { createProject, type WorkshopProject } from '../src/domain/project';
import { buildChecks } from '../src/editor/checks';
import { layFlyover, layClimb, placeKitPieces } from '../src/editor/elevation-kits';
import { liftPieceRoute, placePiece, setRouteBase } from '../src/editor/operations';
import { setSetupMeasurement } from '../src/editor/setup-defaults';
import { fitProject } from '../src/fitting/fit';

/** Long ramps need room: an 8 × 4 m room holds every layout here. */
const brick = (): WorkshopProject => setSetupMeasurement(setSetupMeasurement({ ...createProject('Elevation'), trackSystem: 'brick-v1' }, 'roomWidth', 8000), 'roomDepth', 4000);
const codes = (project: WorkshopProject, severity: 'error' | 'warning') =>
  fitProject(project).issues.filter(issue => issue.severity === severity).map(issue => issue.code);
/** Lay `family` on the end of the last route. */
function extend(project: WorkshopProject, family: string, params?: Record<string, number>): WorkshopProject {
  const end = primaryEnd(project.routes.at(-1)!.pieces.at(-1)!, project);
  return placePiece(project, family, { x: end.x, y: end.y, z: end.z, heading: end.heading, ...(params ? { params } : {}) }, 1)[0];
}
function straight(length = 256, z = 0): WorkshopProject {
  return placePiece(brick(), 'track_straight', { x: 300, y: 500, z, params: { length } })[0];
}

describe('ramp planning', () => {
  it('lands exactly on the height in whole studs, never steeper than asked, with eased ends of at least 5.1 m', () => {
    for (const [rise, grade] of [[118, 0.04], [64, 0.05], [-90, 0.03], [6, 0.04], [1000, 0.02]]) {
      const plan = planRamp(rise, grade)!;
      const pieces = plan.pieces.map(part => ({ ...part, rise: part.grade / 100 * part.length * (part.part === 1 ? 1 : 0.5) }));
      expect(pieces.reduce((sum, part) => sum + part.rise, 0)).toBeCloseTo(rise, 9);
      expect(plan.run % 8).toBe(0);
      expect(plan.grade).toBeLessThanOrEqual(grade + 1e-12);
      expect(plan.transition / plan.grade).toBeGreaterThanOrEqual(ELEVATION.verticalRadius - 1e-6);
      expect(pieces.every(part => part.length <= 2000)).toBe(true);
    }
    expect(planRamp(6, 0.04)!.pieces.map(part => part.part)).toEqual([0, 2]);
  });

  it('lays a Go up or down ramp from an open end that fits, joins level track at both ends and reaches the target', () => {
    let project = straight();
    const start = piecePorts(project.routes[0].pieces[0], project).find(port => port.id === 'out')!;
    const raise = layClimb(start, { target: 118, grade: 4 });
    [project] = placeKitPieces(project, raise.pieces);
    project = extend(project, 'track_straight', { length: 128 });
    expect(project.routes).toHaveLength(1);
    expect(primaryEnd(project.routes[0].pieces.at(-1)!, project).z).toBeCloseTo(118, 6);
    expect(codes(project, 'error')).toEqual([]);
    expect(codes(project, 'warning').filter(code => code.startsWith('grade') || code.startsWith('vertical'))).toEqual([]);
  });

  it('describes the same physical ramp when authored from its far end', () => {
    const project = brick(), definition = pieceDefinition('track_ramp');
    for (const params of [{ part: 0, grade: 4, length: 0, radius: 448, sweep: 22.5 }, { part: 1, grade: -3, length: 300, radius: 320, sweep: 0 }]) {
      const piece = { id: 'a', family: 'track_ramp', x: 0, y: 0, z: 10, heading: 0.3, params };
      const end = primaryEnd(piece, project);
      const back = { ...piece, id: 'b', x: end.x, y: end.y, z: end.z, heading: end.heading + Math.PI, params: definition.reverseParams!(params) };
      const forward = piecePaths(piece, project)[0].points, reversed = piecePaths(back, project)[0].points.slice().reverse();
      expect(Math.hypot(reversed[0].x - piece.x, reversed[0].y - piece.y, reversed[0].z - piece.z)).toBeLessThan(1e-6);
      for (const [index, point] of forward.entries()) {
        const other = reversed[Math.round(index * (reversed.length - 1) / (forward.length - 1))];
        expect(Math.hypot(point.x - other.x, point.y - other.y)).toBeLessThan(0.5);
        expect(point.z).toBeCloseTo(other.z, 1);
      }
    }
  });
});

describe('elevation rules', () => {
  it('rejects grades over 5 % and warns over 4 %', () => {
    expect(codes(extend(straight(), 'track_ramp', { part: 1, grade: 5.5, length: 256 }), 'error')).toContain('grade-too-steep');
    const steep = extend(straight(), 'track_ramp', { part: 1, grade: 4.5, length: 256 });
    expect(codes(steep, 'warning')).toContain('grade-steep');
    expect(codes(steep, 'error')).not.toContain('grade-too-steep');
  });

  it('rejects a grade that changes abruptly: a level piece straight onto a slope, or a too-short easement', () => {
    expect(codes(extend(straight(), 'track_ramp', { part: 1, grade: 3, length: 128 }), 'error')).toContain('grade-break');
    expect(codes(extend(straight(), 'track_ramp', { part: 0, grade: 5, length: 64 }), 'error')).toContain('vertical-curve-tight');
    expect(codes(extend(straight(), 'track_ramp', { part: 0, grade: 4, length: 160 }), 'warning')).toContain('vertical-curve');
    expect(codes(extend(straight(), 'track_ramp', { part: 0, grade: 4, length: 0 }), 'warning')).not.toContain('vertical-curve');
  });

  it('keeps junctions level with a full track of level before any slope', () => {
    const withGap = (gap: number) => {
      let project = placePiece(brick(), 'printed_switch_left', { x: 300, y: 500 })[0];
      if (gap) project = extend(project, 'track_straight', { length: gap });
      return codes(extend(project, 'track_ramp', { part: 0, grade: 4 }), 'error');
    };
    expect(withGap(0)).toContain('junction-on-slope');
    expect(withGap(64)).toContain('junction-near-slope');
    expect(withGap(128).filter(code => code.startsWith('junction'))).toEqual([]);
  });

  it('starts a climb laid on points with the level they still need, and counts that level towards the junction', () => {
    const climbAfter = (gap: number, params: Record<string, number> = {}) => {
      let project = placePiece(brick(), 'printed_switch_left', { x: 300, y: 500 })[0];
      if (gap) project = extend(project, 'track_straight', { length: gap });
      return extend(project, 'track_climb', { rise: 40, grade: 4, ...params });
    };
    const climb = (project: WorkshopProject) => project.routes.flatMap(route => route.pieces).find(piece => piece.family === 'track_climb')!;
    for (const [gap, lead] of [[0, 128], [64, 64], [104, 24], [128, undefined]] as const) {
      const project = climbAfter(gap);
      expect(climb(project).params?.lead).toBe(lead);
      expect(codes(project, 'error').filter(code => code.startsWith('junction'))).toEqual([]);
      // The level lead-in is part of the climb: it still reaches its height, level at both ends.
      expect(primaryEnd(climb(project), project).z).toBeCloseTo(40, 6);
    }
    // Laid with no lead on purpose, it is the user's choice: the check says why.
    expect(codes(climbAfter(0, { lead: 0 }), 'error')).toContain('junction-on-slope');
  });

  it('names the junction and the slope, and its one fix clears the check', () => {
    const junctionRows = (project: WorkshopProject) => buildChecks(project, fitProject(project)).filter(check => /level track/.test(check.title));
    const turnout = placePiece(brick(), 'printed_switch_left', { x: 300, y: 500 })[0];
    const switchId = turnout.routes[0].pieces[0].id;
    // A climb laid right on the points: the fix gives it the 128 mm lead-in, its start stays on the turnout.
    const climbing = extend(turnout, 'track_climb', { rise: 40, grade: 4, lead: 0 });
    const climbId = climbing.routes[0].pieces[1].id;
    const [row] = junctionRows(climbing);
    expect(row.title).toBe('The climb starts right at the left turnout; points need 128 mm of level track before a slope.');
    expect(row.targets.pieceIds.sort()).toEqual([switchId, climbId].sort());
    const levelled = row.fix!.apply(climbing);
    expect(junctionRows(levelled)).toEqual([]);
    expect(codes(levelled, 'error')).toEqual([]);
    expect(levelled.routes[0].pieces[1]).toMatchObject({ id: climbId, x: climbing.routes[0].pieces[1].x, y: climbing.routes[0].pieces[1].y, params: { lead: 128 } });
    // Any other slope 64 mm from the points: a 64 mm level straight goes in before it and the ramp moves along.
    const ramp = extend(extend(turnout, 'track_straight', { length: 64 }), 'track_ramp', { part: 0, grade: 4 });
    const [near] = junctionRows(ramp);
    expect(near.title).toBe('Only 64 mm of level track between the left turnout and the climb; points need 128 mm before a slope.');
    const fixed = near.fix!.apply(ramp), pieces = fixed.routes[0].pieces;
    expect(pieces.map(piece => piece.family)).toEqual(['printed_switch_left', 'track_straight', 'track_straight', 'track_ramp']);
    expect(pieces[2].params).toEqual({ length: 64 });
    expect(pieces[3].x - ramp.routes[0].pieces[2].x).toBeCloseTo(64, 6);
    expect(codes(fixed, 'error')).toEqual([]);
  });

  it('asks for 118 mm under a flyover, rail top to deck underside, and certifies it with the user\'s cars', () => {
    const flyover = (clearance: number) => {
      let project = placePiece(brick(), 'track_straight', { x: 3600, y: 100, heading: Math.PI / 2, params: { length: 1000 } })[0];
      const laid = layFlyover(project, { x: 0, y: 600, z: 0, heading: 0 }, { clearance, grade: 4, decks: 2, under: 0 });
      const decks = laid.pieces.filter(piece => piece.family === 'bridge_deck'), dx = 3600 - (decks[0].x + primaryEnd(decks[1], project).x) / 2;
      [project] = placeKitPieces(project, laid.pieces.map(piece => ({ ...piece, x: piece.x + dx })));
      return project;
    };
    const low = fitProject(flyover(100));
    expect(low.issues).toContainEqual(expect.objectContaining({ code: 'crossing-standard-clearance', message: expect.stringContaining('Raise the upper track 18 mm') }));
    const clear = flyover(ELEVATION.clearance);
    clear.cars = [{ id: 'loco', name: 'Loco', length: 230, width: 62, height: 100, wheelbase: 140, couplerGap: 8 }];
    const fit = fitProject(clear);
    expect(fit.crossings.map(crossing => crossing.status)).toEqual(['digitally-clear']);
    expect(fit.issues.filter(issue => issue.severity === 'error' || issue.code.startsWith('crossing'))).toEqual([]);
  });
});

describe('supports for raised and graded track', () => {
  it('seats every column under a 5 % climb on the flat underside of the printed wedge above it, at its exact height', () => {
    const project = placePiece(brick(), 'track_climb', { x: 300, y: 500, heading: 0.4, params: { rise: 40, grade: 5 } })[0];
    const climb = project.routes[0].pieces[0], fit = fitProject(project);
    const parts = fit.partInstances.filter(part => part.family === 'composite_track');
    let station = 0;
    const spans = parts.map(part => {
      const length = part.parameters.s0_len, span = { from: station, to: station + length, underside: partUnderside(part.parameters, part.pose.z) };
      station += length;
      return span;
    });
    const columns = fit.supports.filter(support => support.family === 'reversible_column');
    // Every part printed above the table stands on columns; the first starts on the table.
    expect(spans.filter(span => span.underside > 0.5).length * 2).toBeLessThanOrEqual(columns.length);
    for (const column of columns) {
      const along = (column.pose.x - climb.x) * Math.cos(climb.heading) + (column.pose.y - climb.y) * Math.sin(climb.heading);
      const above = spans.find(span => along >= span.from - 1e-6 && along <= span.to + 1e-6)!;
      expect(Math.abs(column.pose.z - above.underside)).toBeLessThanOrEqual(0.2);
      // The wedge's underside is flat: so is the seat, and the printed column is exactly as tall as the seat is high.
      expect(column.pose.pitch).toBe(0);
      const printed = fit.partInstances.find(part => part.id === column.id)!;
      expect(printed.parameters).toMatchObject({ height: column.pose.z });
      expect(printed.parameters.seat_pitch).toBeUndefined();
    }
  });

  it('tilts a column\'s seat to the track\'s grade under a sloped underside (the legacy ramp piece)', () => {
    let [project] = placePiece({ ...createProject('Ramp'), trackSystem: 'custom-joiner-v1' }, 'printed_straight', { x: 300, y: 300, z: 8 });
    const end = primaryEnd(project.routes[0].pieces[0], project);
    [project] = placePiece(project, 'vertical_transition', { x: end.x, y: end.y, z: end.z, heading: end.heading, rise: 24 }, 1);
    const ramp = project.routes[0].pieces[1], run = pieceDefinition(ramp.family).run(ramp, project), fit = fitProject(project);
    const columns = fit.supports.filter(support => support.pose.x > ramp.x + 1 && support.pose.x < ramp.x + run - 1);
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      // The ramp's height is rise·(3t² − 2t³) along its run: the seat pitches as the track does above it.
      const t = (column.pose.x - ramp.x) / run, grade = 24 * (6 * t - 6 * t * t) / run;
      expect(column.pose.z).toBeCloseTo(8 + 24 * (3 * t * t - 2 * t ** 3), 6);
      expect(fit.partInstances.find(part => part.id === column.id)!.parameters.seat_pitch).toBeCloseTo(Math.atan(grade), 6);
    }
  });

  it('stands level track at whole plates on riser stacks, columns elsewhere, all on the route\'s ground', () => {
    const project = straight(512);
    const raised = liftPieceRoute(project, project.routes[0].pieces[0].id, 70.4);
    const fit = fitProject(raised);
    expect(fit.supports.length).toBeGreaterThan(0);
    expect(fit.supports.every(support => support.family === 'layout_riser' && JSON.stringify(support.blocks) === JSON.stringify([32, 32, 6.4]))).toBe(true);
    const blocks = fit.partInstances.filter(part => part.family === 'layout_riser');
    expect(blocks).toHaveLength(fit.supports.length * 3);
    expect(blocks.map(part => part.pose.z).slice(0, 3)).toEqual([0, 32, 64]);
    expect(fitProject(liftPieceRoute(project, project.routes[0].pieces[0].id, 70)).supports.every(support => support.family === 'reversible_column')).toBe(true);
    const lowered = setRouteBase(raised, raised.routes[0].id, -25.6);
    expect(fitProject(lowered).supports.every(support => support.family === 'layout_riser' && support.ground === -25.6 && Math.abs(support.height - 96) < 1e-9)).toBe(true);
  });

  it('lets a line dip below the table only down to its route\'s ground', () => {
    let project = straight(256);
    const id = project.routes[0].pieces[0].id;
    project = liftPieceRoute(project, id, -40);
    expect(codes(project, 'error')).toContain('below-table');
    project = setRouteBase(project, project.routes[0].id, -48);
    expect(codes(project, 'error')).toEqual([]);
    expect(fitProject(project).supports.every(support => support.ground === -48 && Math.abs(support.height - 8) < 1e-9)).toBe(true);
    expect(codes(setRouteBase(project, project.routes[0].id, -32), 'error')).toContain('below-ground');
  });
});
