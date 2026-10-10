import { describe, expect, it } from 'vitest';
import { primaryEnd } from '../src/domain/pieces';
import { createProject, type Car, type WorkshopProject } from '../src/domain/project';
import { placeConsist } from '../src/drive/train';
import { routePath, samplePath } from '../src/drive/traversal';
import { placePiece } from '../src/editor/operations';
import { fitProject } from '../src/fitting/fit';

const brick = (): WorkshopProject => ({ ...createProject('Slope'), trackSystem: 'brick-v1' });
const car = (id: string): Car => ({ id, name: id, length: 160, width: 60, height: 90, wheelbase: 100, couplerGap: 10, cog: true });
function extend(project: WorkshopProject, family: string, params: Record<string, number>): WorkshopProject {
  const end = primaryEnd(project.routes.at(-1)!.pieces.at(-1)!, project);
  return placePiece(project, family, { x: end.x, y: end.y, z: end.z, heading: end.heading, params }, 1)[0];
}
const gap3d = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('train spacing on slopes', () => {
  it('keeps wheelbases and car spacing along a 20% rack slope, and reaches the true end of steep path points', () => {
    let project = placePiece(brick(), 'track_rack', { x: 300, y: 500, z: 0, params: { part: 1, grade: 20, length: 1200 } })[0];
    project = extend(project, 'track_rack', { part: 2, grade: 20 });
    const path = routePath(fitProject(project).sections, project.routes[0].id);
    const cars = [car('a'), car('b'), car('c')];
    const frame = placeConsist(path, cars, 700);
    expect(frame.cars).toHaveLength(3);
    for (const placed of frame.cars) expect(gap3d(placed.frontWheel, placed.rearWheel)).toBeCloseTo(100, 1);
    // Centre to centre: half of each car plus the coupler gap, along the slope.
    for (let i = 1; i < 3; i++) expect(gap3d(frame.cars[i - 1].pose, frame.cars[i].pose)).toBeCloseTo(170, 0);
    const first = path.sections[0], end = samplePath({ ...path, sections: [first], length: first.run }, first.run)!;
    expect(gap3d(end, first.end.pose)).toBeLessThan(1e-6);
  });

  it('places a consist on level track exactly as plan distances say', () => {
    const project = placePiece(brick(), 'track_straight', { x: 300, y: 500, z: 0, params: { length: 1024 } })[0];
    const path = routePath(fitProject(project).sections, project.routes[0].id);
    const frame = placeConsist(path, [car('a'), car('b')], 600);
    expect(frame.cars.map(placed => placed.distance)).toEqual([600, 600 - 170]);
    expect(frame.cars[1].frontWheel.x - frame.cars[1].rearWheel.x).toBeCloseTo(100, 9);
  });
});
