import { describe, expect, it } from 'vitest';
import { createProject, type Car, type WorkshopProject } from '../src/domain/project';
import { fitProject } from '../src/fitting/fit';
import { advanceConsist, placeConsist, startingLeadDistance } from '../src/drive/train';
import { currentInspectionMesh, type InspectionMesh } from '../src/drive/scene';
import { routePath, samplePath } from '../src/drive/traversal';
import { placePiece, unoccupiedPiecePorts, type TileFamily } from '../src/editor/operations';

const cars: Car[] = [
  { id: 'loco', name: 'Locomotive', length: 100, width: 60, height: 70, wheelbase: 72, couplerGap: 8 },
  { id: 'w1', name: 'First wagon', length: 120, width: 65, height: 80, wheelbase: 88, couplerGap: 8 },
  { id: 'w2', name: 'Last wagon', length: 140, width: 65, height: 90, wheelbase: 92, couplerGap: 0 }
];

/** Each piece snaps onto the previous piece's open end. */
function chain(pieces: readonly (TileFamily | [TileFamily, number])[]): WorkshopProject {
  let project = createProject('Synthetic chain');
  for (const entry of pieces) {
    const [family, rise] = typeof entry === 'string' ? [entry, undefined] : entry;
    const end = unoccupiedPiecePorts(project).find(candidate => candidate.port.id === 'out')?.port ?? { x: 0, y: 0 };
    [project] = placePiece(project, family, { x: end.x, y: end.y, rise });
  }
  return project;
}

describe('fitted-route train traversal', () => {
  it('samples the exact end of an R40 curve even when the station overshoots by float drift', () => {
    const fit = fitProject(chain(['printed_curve_r40']));
    const section = fit.sections[0];
    const path = { routeId: section.routeId, sections: [section], length: section.run, gap: null };
    // 125.66… · 11 / 11 lands one ulp past the run; Test drive samples pieces exactly like this.
    expect(section.run * 11 / 11).toBeGreaterThan(section.run);
    const end = samplePath(path, section.run * 11 / 11);
    expect(end).not.toBeNull();
    expect(end!.x).toBeCloseTo(section.end.pose.x, 6);
    expect(end!.y).toBeCloseTo(section.end.pose.y, 6);
    expect(samplePath(path, section.run + 1)).toBeNull();
  });

  it('places locomotive and both wagons at different heights through the climb, including reverse travel', () => {
    const project = chain(['brick_straight_nominal', 'brick_straight_nominal', ...Array.from({ length: 4 }, (): [TileFamily, number] => ['vertical_transition', 8]),
      'brick_straight_nominal', 'brick_straight_nominal']);
    const fit = fitProject(project);
    const path = routePath(fit.sections, project.routes[0].id);
    expect(path.gap).toBeNull();
    const climb = path.sections.filter(section => section.kind === 'transition');
    const start = path.sections.indexOf(climb[0]);
    const climbStart = path.sections.slice(0, start).reduce((sum, section) => sum + section.run, 0);
    const climbRun = climb.reduce((sum, section) => sum + section.run, 0);
    const lead = climbStart + climbRun / 2 + 188;
    const frame = placeConsist(path, cars, lead);
    expect(frame.warning).toBeNull();
    expect(frame.cars.map(car => car.car.id)).toEqual(['loco', 'w1', 'w2']);
    expect(frame.cars[0].pose.z).toBeGreaterThan(frame.cars[1].pose.z);
    expect(frame.cars[1].pose.z).toBeGreaterThan(frame.cars[2].pose.z);
    const reverse = advanceConsist(path, cars, frame.leadDistance, -120, 2);
    expect(reverse.cars).toHaveLength(3);
    for (let index = 0; index < 3; index++) expect(reverse.cars[index].distance).toBeLessThan(frame.cars[index].distance);
    expect(samplePath(path, path.length)!.z).toBeGreaterThan(samplePath(path, 0)!.z);
  });

  it('stops before an open endpoint and rejects a route with an unfitted span', () => {
    const project = chain(['brick_straight_nominal', 'brick_straight_nominal', 'brick_straight_nominal']);
    const fit = fitProject(project);
    const path = routePath(fit.sections, project.routes[0].id);
    const initial = placeConsist(path, cars, startingLeadDistance(cars));
    expect(initial.cars).toHaveLength(3);
    const end = advanceConsist(path, cars, initial.leadDistance, 300, 5);
    expect(end.stopped).toBe(true);
    expect(end.warning).not.toBeNull();
    expect(end.cars).toHaveLength(3);
    expect(end.cars[0].distance + cars[0].length/2).toBeCloseTo(path.length);
    const broken = fit.sections.map((section, index) => index === 1 ? { ...section, kind: 'unresolved' as const } : section);
    const gap = routePath(broken, project.routes[0].id);
    expect(gap.gap).not.toBeNull();
    const rejected = placeConsist(gap, cars, 360);
    expect(rejected.cars).toHaveLength(0);
    expect(rejected.warning).toBe(gap.gap);
  });

  it('rejects an older or dimensionally mismatched CAD mesh after a route edit', () => {
    const project = chain(['printed_brick_straight']);
    const fit = fitProject(project);
    const part = fit.partInstances.find(instance => instance.source === 'printed')!;
    const mesh: InspectionMesh = { sectionId: part.sectionId, interfaceKind: part.interfaceKind,
      layoutRevision: fit.layoutRevision,
      parameters: { ...part.parameters }, assemblyParameters: { ...part.parameters }, pose: { ...part.pose }, digest: 'a'.repeat(64),
      requestDigest: 'b'.repeat(64), url: '/api/packages/example/mesh' };
    expect(currentInspectionMesh(fit, part, mesh)).toBe(true);
    expect(currentInspectionMesh({ ...fit, layoutRevision: crypto.randomUUID() }, part, mesh)).toBe(false);
    const [key] = Object.keys(part.parameters);
    const changed = { ...part.parameters, [key]: part.parameters[key] + 1 };
    expect(currentInspectionMesh(fit, part, { ...mesh, parameters: changed, assemblyParameters: changed })).toBe(false);
  });
});
