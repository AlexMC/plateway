import { describe, expect, it } from 'vitest';
import saved from '../cad/tests/fixtures/climb-parts.json';
import { planRamp } from '../src/domain/elevation';
import { CLIMB_FAMILY, pieceDefinition, piecePaths, piecePorts, primaryEnd } from '../src/domain/pieces';
import { createProject, parseProject, serializeProject, type WorkshopProject } from '../src/domain/project';
import { findJoint, jointVariants } from '../src/editor/joint-lock';
import { flipPiece, placePiece, placePreview, removePiece, setPieceParam } from '../src/editor/operations';
import { setSetupMeasurement } from '../src/editor/setup-defaults';
import { sectionVerticalRadius } from '../src/fitting/elevation';
import { fitProject } from '../src/fitting/fit';
import { buildPlan } from '../src/plan/build';
import { climbFixture } from './climb-fixture';

/** A 4 × 3 m room: long climbs need it. */
const brick = (): WorkshopProject => setSetupMeasurement(setSetupMeasurement({ ...createProject('Climb'), trackSystem: 'brick-v1' }, 'roomWidth', 4000), 'roomDepth', 3000);
/** Lay `family` on the end of the last route. */
function extend(project: WorkshopProject, family: string, params?: Record<string, number>): WorkshopProject {
  const end = primaryEnd(project.routes.at(-1)!.pieces.at(-1)!, project);
  return placePiece(project, family, { x: end.x, y: end.y, z: end.z, heading: end.heading, ...(params ? { params } : {}) }, 1)[0];
}
/** A level straight at height `z`, a climb of `rise` mm at 4 %, and a level straight after it: one route. */
function climbLine(rise: number, z = 0): WorkshopProject {
  const project = placePiece(brick(), 'track_straight', { x: 300, y: 600, z, params: { length: 256 } })[0];
  return extend(extend(project, CLIMB_FAMILY, { rise, grade: 4 }), 'track_straight', { length: 128 });
}
const climbOf = (project: WorkshopProject) => project.routes[0].pieces.find(piece => piece.family === CLIMB_FAMILY)!;

describe('Go up or down as one piece', () => {
  it('runs level, eases onto the grade, holds it and eases back to level, landing exactly on the height', () => {
    const project = climbLine(38), climb = climbOf(project), plan = planRamp(38, 0.04)!;
    const points = piecePaths(climb, project)[0].points, grade = (point: { pitch?: number }) => Math.tan(point.pitch ?? 0);
    expect(project.routes[0].pieces.map(piece => piece.family)).toEqual(['track_straight', CLIMB_FAMILY, 'track_straight']);
    expect(points[0]).toMatchObject({ z: 0, pitch: 0 });
    expect(points.at(-1)!.z).toBeCloseTo(38, 9);
    expect(grade(points.at(-1)!)).toBeCloseTo(0, 12);
    expect(points.at(-1)!.x - points[0].x).toBeCloseTo(plan.run, 6);
    // Halfway along each easement the grade is half the slope's; along the slope it is the slope's, never steeper than 4 %.
    const at = (distance: number) => points.reduce((best, point) => Math.abs(point.x - points[0].x - distance) < Math.abs(best.x - points[0].x - distance) ? point : best);
    expect(grade(at(plan.transition / 2))).toBeCloseTo(plan.grade / 2, 6);
    expect(grade(at(plan.run - plan.transition / 2))).toBeCloseTo(plan.grade / 2, 6);
    expect(grade(at(plan.run / 2))).toBeCloseTo(plan.grade, 9);
    expect(Math.max(...points.map(grade))).toBeLessThanOrEqual(0.04 + 1e-12);
    const fit = fitProject(project);
    expect(sectionVerticalRadius(fit.sections.find(section => section.id === climb.id)!)).toBeGreaterThanOrEqual(5120 - 1e-6);
    expect(fit.issues.filter(issue => issue.severity === 'error')).toEqual([]);
    expect(fit.issues.map(issue => issue.code).filter(code => /^(grade|vertical|junction)/.test(code))).toEqual([]);
  });

  it('describes itself as a climb or a descent', () => {
    const definition = pieceDefinition(CLIMB_FAMILY), piece = (rise: number) => ({ id: 'c', family: CLIMB_FAMILY, x: 0, y: 0, z: 0, heading: 0, params: { rise, grade: 4 } });
    expect(definition.description(piece(38))).toBe('Climb · +38 mm · 1.2 m');
    expect(definition.description(piece(-38))).toBe('Descent · −38 mm · 1.2 m');
    expect(definition.problem!(piece(0))).toMatch(/^No height change/);
  });

  it('laid at either open end of a track, continues from that end to the height and joins it as one route', () => {
    const line = placePiece(brick(), 'track_straight', { x: 1500, y: 600, params: { length: 128 } })[0];
    for (const end of piecePorts(line.routes[0].pieces[0], line)) {
      const lock = findJoint(line, CLIMB_FAMILY, { x: end.x + 10 * Math.cos(end.heading), y: end.y + 10 * Math.sin(end.heading) }, 60, 36)!;
      expect(lock.point).toMatchObject({ x: end.x, y: end.y });
      // Up to 64 mm, or the other way (F): never laid by its far end, which would go the wrong way from the joint.
      const variants = jointVariants(line, CLIMB_FAMILY, { x: 0, y: 0, heading: 0, params: { rise: 64, grade: 4 } }, lock);
      expect(variants.map(variant => [variant.facing, variant.piece.params?.rise])).toEqual([['with', 64], ['with', -64]]);
      for (const variant of variants) {
        const [next, id] = placePreview(line, variant.snap!);
        expect(next.routes).toHaveLength(1);
        const climb = next.routes[0].pieces.find(piece => piece.id === id)!, ports = piecePorts(climb, next);
        // Its start is on the open end, level and at its height; its far end is the height change away, out along the end.
        const near = ports.find(port => Math.hypot(port.x - end.x, port.y - end.y) < 1e-6)!, far = ports.find(port => port !== near)!;
        expect(near.z).toBeCloseTo(end.z, 9);
        expect(far.z - end.z).toBeCloseTo(variant.piece.params!.rise, 9);
        expect((far.x - end.x) * Math.cos(end.heading) + (far.y - end.y) * Math.sin(end.heading)).toBeGreaterThan(1000);
      }
    }
  });

  it('flips from climbing to descending and deletes as one piece', () => {
    const project = climbLine(38, 64), climb = climbOf(project);
    const flipped = flipPiece(project, climb.id);
    expect(flipped.routes[0].pieces).toHaveLength(3);
    expect(climbOf(flipped).params?.rise).toBe(-38);
    expect(primaryEnd(climbOf(flipped), flipped).z).toBeCloseTo(26, 9);
    expect(flipped.routes[0].pieces[2].z).toBeCloseTo(26, 9);
    const removed = removePiece(project, climb.id);
    expect(removed.routes.flatMap(route => route.pieces).map(piece => piece.family)).toEqual(['track_straight', 'track_straight']);
  });

  it('rebuilds when its height or grade changes, and the track after it follows its new end', () => {
    const project = climbLine(38), climb = climbOf(project);
    const higher = setPieceParam(project, climb.id, 'rise', 64), after = higher.routes[0].pieces[2];
    expect(after.z).toBeCloseTo(64, 9);
    expect(after.x).toBeCloseTo(climb.x + planRamp(64, 0.04)!.run, 6);
    const gentler = setPieceParam(higher, climb.id, 'grade', 3);
    expect(gentler.routes[0].pieces[2].x).toBeCloseTo(climb.x + planRamp(64, 0.03)!.run, 6);
    expect(fitProject(gentler).issues.filter(issue => issue.severity === 'error')).toEqual([]);
  });

  it('prints as parts cut at its easements and to the bed, each joining the next at the same height and grade', () => {
    const project = climbLine(64), climb = climbOf(project), plan = planRamp(64, 0.04)!;
    const parts = fitProject(project).partInstances.flatMap(part => part.sectionId === climb.id && part.interfaceKind === 'rail' ? [part] : []);
    expect(parts.length).toBeGreaterThan(3);
    const stations = parts.map(part => part.parameters.s0_len).reduce((cuts, length) => [...cuts, cuts.at(-1)! + length], [0]);
    expect(stations.at(-1)).toBeCloseTo(plan.run, 6);
    expect(stations.some(station => Math.abs(station - plan.transition) < 1e-6)).toBe(true);
    expect(stations.some(station => Math.abs(station - (plan.run - plan.transition)) < 1e-6)).toBe(true);
    for (let n = 1; n < parts.length; n++) {
      const end = parts[n - 1].endPort.pose, start = parts[n].startPort.pose;
      expect(start.z).toBeCloseTo(end.z, 9);
      expect(start.pitch).toBeCloseTo(end.pitch, 9);
    }
  });

  it('keeps the CAD fixture of its printed parts current (regenerate: npx vite-node scripts/climb-fixture.ts)', () => {
    expect(saved).toEqual(climbFixture());
  });

  it('is what a plan\'s raise step lays: one piece to the height', () => {
    const plan = { version: 1, name: 'Up', tracks: [{ id: 'up', start: { x: 200, y: 600 }, steps: [{ straight: 128 }, { raise: { to: 38 } }, { straight: 128 }] }] };
    const { project, report } = buildPlan(plan);
    expect(report.steps[1].pieces).toEqual([expect.objectContaining({ family: CLIMB_FAMILY })]);
    const climb = project.routes.flatMap(route => route.pieces).find(piece => piece.id === report.steps[1].pieces[0].id)!;
    expect(primaryEnd(climb, project).z).toBeCloseTo(38, 9);
  });

  it('leaves projects laid with Ramp set pieces as they were', () => {
    let project = placePiece(brick(), 'track_straight', { x: 300, y: 600, params: { length: 256 } })[0];
    for (const params of [{ part: 0, grade: 4 }, { part: 1, grade: 4, length: 256 }, { part: 2, grade: 4 }] as Record<string, number>[]) project = extend(project, 'track_ramp', params);
    project = extend(project, 'vertical_transition');
    const reopened = parseProject(serializeProject(project));
    expect(reopened.routes).toEqual(project.routes);
    expect(reopened.routes[0].pieces.map(piece => piece.family)).toEqual(['track_straight', 'track_ramp', 'track_ramp', 'track_ramp', 'vertical_transition']);
    expect(fitProject(reopened).issues.filter(issue => issue.severity === 'error')).toEqual(fitProject(project).issues.filter(issue => issue.severity === 'error'));
  });
});
