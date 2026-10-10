import { describe, expect, it } from 'vitest';
import { createProject, type Car } from '../src/domain/project';
import { primaryEnd } from '../src/domain/pieces';
import { inspectDrive } from '../src/drive/collision';
import { placeConsist } from '../src/drive/train';
import { routePath } from '../src/drive/traversal';
import { placePiece } from '../src/editor/operations';
import { fitProject } from '../src/fitting/fit';
import type { Support } from '../src/fitting/mounting';

const CARS: Car[] = [
  { id: 'loco', name: 'Locomotive', length: 100, width: 60, height: 70, wheelbase: 70, couplerGap: 8 },
  { id: 'wagon', name: 'Loaded wagon', length: 120, width: 70, height: 90, wheelbase: 85, couplerGap: 0 }
];

function inspect(cars: Car[]) {
  let project = placePiece(createProject('Underpass'), 'printed_brick_straight', { x: 100, y: 0, heading: Math.PI / 2 })[0];
  for (let i = 0; i < 3; i++) {
    const end = primaryEnd(project.routes[0].pieces.at(-1)!, project);
    project = placePiece(project, 'printed_brick_straight', { x: end.x, y: end.y, heading: end.heading })[0];
  }
  project.cars = cars;
  const fit = fitProject(project);
  const frame = placeConsist(routePath(fit.sections, project.routes[0].id), project.cars, 330);
  expect(frame.cars).toHaveLength(2);
  const obstacle: Support = { id: 'column', routeId: 'upper', family: 'reversible_column', pose: { x: 100, y: 212, z: 100, heading: 0, pitch: 0 }, height: 100 };
  return inspectDrive(project, { ...fit, supports: [obstacle] }, frame);
}

describe('train collision check', () => {
  it('reports the wagon striking a support that the locomotive clears', () => {
    const { collisions } = inspect(CARS);
    expect(collisions).toEqual(['Loaded wagon hits a bridge support.']);
  });
  it('does not check example cars against supports', () => {
    expect(inspect(CARS.map(car => ({ ...car, example: true as const }))).collisions).toEqual([]);
  });
});
