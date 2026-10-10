import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { carCurveSweep, frontReach, rearReach } from '../src/domain/car-geometry';
import { createProject, validateProject, type Car, type WorkshopProject } from '../src/domain/project';
import { catalogueCar, searchTrainSets, type TrainCatalogue } from '../src/domain/trains';
import { fitProject } from '../src/fitting/fit';
import { placeConsist, startingLeadDistance, type PlacedCar } from '../src/drive/train';
import { routePath } from '../src/drive/traversal';
import { placePiece, unoccupiedPiecePorts, type TileFamily } from '../src/editor/operations';

import fixtureIndex from './fixtures/trains/index.json';
import fixtureGlb from './fixtures/trains/fixture-1/loco.glb?inline';
import { createStandardProject } from '../src/editor/setup-defaults';

const fixture = fixtureIndex as TrainCatalogue;
// The real catalogue (scripts/trains → public/trains); a glob keeps its 260 kB out of the type checker.
const catalogue = Object.values(import.meta.glob<TrainCatalogue>('../public/trains/index.json', { eager: true, import: 'default' }))[0];

// Long nose ahead of the pivots, short tail behind: a measured locomotive.
const loco: Car = { id: 'loco', name: 'Loco', length: 150, width: 48, height: 90, wheelbase: 100, couplerGap: 0,
  bogies: [50, -50], couplers: { front: 90, rear: -60 } };
const wagon: Car = { id: 'wagon', name: 'Wagon', length: 140, width: 48, height: 70, wheelbase: 96, couplerGap: 0,
  bogies: [48, -48], couplers: { front: 70, rear: -70 } };

function chain(pieces: readonly TileFamily[]): WorkshopProject {
  let project = createProject('Measured cars');
  for (const family of pieces) {
    const end = unoccupiedPiecePorts(project).find(candidate => candidate.port.id === 'out')?.port ?? { x: 0, y: 0 };
    [project] = placePiece(project, family, { x: end.x, y: end.y });
  }
  return project;
}

/** A point `along` the placed car's body axis from its origin, in plan. */
function face(placed: PlacedCar, along: number): [number, number] {
  return [placed.pose.x + Math.cos(placed.pose.heading) * along, placed.pose.y + Math.sin(placed.pose.heading) * along];
}

describe('measured official cars', () => {
  const project = chain(['brick_straight_nominal', 'brick_straight_nominal', 'printed_curve_r40', 'printed_curve_r40',
    'printed_curve_r40', 'printed_curve_r40', 'brick_straight_nominal']);
  const path = routePath(fitProject(project).sections, project.routes[0].id);

  it('couples coupling face to coupling face on straight track and across the chord on a curve', () => {
    const straight = placeConsist(path, [loco, wagon], startingLeadDistance([loco, wagon]));
    expect(straight.warning).toBeNull();
    // On the straight, origins sit tail reach + nose reach apart and the faces touch.
    expect(straight.cars[0].distance - straight.cars[1].distance).toBeCloseTo(60 + 70, 6);
    const [rear, front] = [face(straight.cars[0], -rearReach(loco)), face(straight.cars[1], frontReach(wagon))];
    expect(Math.hypot(rear[0] - front[0], rear[1] - front[1])).toBeLessThan(1e-3);

    // Mid-curve the faces still meet along the wagon's axis, only offset sideways.
    const curveStart = path.sections.slice(0, 2).reduce((sum, section) => sum + section.run, 0);
    const curved = placeConsist(path, [loco, wagon], curveStart + 200);
    expect(curved.warning).toBeNull();
    const [a, b] = [face(curved.cars[0], -rearReach(loco)), face(curved.cars[1], frontReach(wagon))];
    const heading = curved.cars[1].pose.heading;
    expect(Math.abs((a[0] - b[0]) * Math.cos(heading) + (a[1] - b[1]) * Math.sin(heading))).toBeLessThan(1e-2);
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(3);
  });

  it('keeps the old along-track spacing for cars without measured couplers', () => {
    const plain = [{ ...loco, couplers: undefined, bogies: undefined, couplerGap: 8 }, { ...wagon, couplers: undefined, bogies: undefined }];
    const curveStart = path.sections.slice(0, 2).reduce((sum, section) => sum + section.run, 0);
    const frame = placeConsist(path, plain, curveStart + 200);
    expect(frame.cars[0].distance - frame.cars[1].distance).toBeCloseTo((150 + 140) / 2 + 8, 6);
  });

  it('swings by the pivot chord inside a curve and by the corner overhang outside it', () => {
    const radius = 320, half = loco.width / 2;
    // Pivots on the centreline circle; the body axis is their chord, from tail face to nose face.
    const lean = Math.asin(loco.wheelbase / 2 / radius), chord = radius * Math.cos(lean);
    let outer = 0, inner = Infinity;
    for (let x = -60; x <= 90; x += .25) for (const y of [-half, half]) {
      const r = Math.hypot(chord + y, x);
      outer = Math.max(outer, r); inner = Math.min(inner, r);
    }
    const brute = Math.max(outer - (radius + half), radius - half - inner);
    expect(carCurveSweep(loco, radius)).toBeCloseTo(brute, 6);
    // A car known only by its length still sweeps as one rigid body spanning it.
    expect(carCurveSweep({ ...loco, bogies: undefined, couplers: undefined }, radius)).toBeCloseTo(radius - Math.sqrt(radius ** 2 - 75 ** 2), 9);
  });

  it('opens only the app\'s own train models from a saved project', () => {
    const save = (car: Partial<Car>) => ({ ...createProject('Saved'), cars: [{ ...wagon, ...car }] });
    expect(() => validateProject(save({ model: { set: '60052-1', car: '60052-1/loco', asset: 'trains/60052-1/loco.glb' } }))).not.toThrow();
    for (const asset of ['trains/../../secret.glb', 'https://example.com/trains/a/b.glb', '/trains/a/b.glb', 'trains/a/b.stl']) {
      expect(() => validateProject(save({ model: { set: 'a', car: 'b', asset } }))).toThrow('Invalid project car');
    }
    expect(() => validateProject(save({ couplers: { front: -1, rear: -70 } }))).toThrow('Invalid project car');
    expect(() => validateProject(save({ outline: Array.from({ length: 41 }, (_, i): [number, number] => [i, i]) }))).toThrow('Invalid project car');
  });

  it('turns a catalogue car into a project car that couples without a gap', () => {
    const [set] = searchTrainSets(fixture, 'infrared shunter');
    expect(set?.id).toBe('fixture-1');
    expect(searchTrainSets(fixture, 'monorail')).toEqual([]);
    const car = catalogueCar(set, set.cars[0], 'id');
    expect(car).toMatchObject({ length: 144, wheelbase: 100, couplerGap: 0, couplers: { front: 72, rear: -72 },
      model: { set: 'fixture-1', car: 'fixture-1/loco', asset: 'trains/fixture-1/loco.glb' } });
    expect(car.gauge).toBeUndefined();
    expect(catalogueCar({ ...set, gauge: 'monorail' }, set.cars[0]).gauge).toBe('monorail');
  });

  it('loads a car model in the car frame: z up from the railhead, no glTF axis turn', async () => {
    const bytes = Uint8Array.from(atob(fixtureGlb.split(',')[1]), char => char.charCodeAt(0));
    const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '');
    const box = new THREE.Box3().setFromObject(gltf.scene);
    expect(box.min.z).toBeCloseTo(4, 6);
    expect(box.max.z).toBeCloseTo(fixture.sets[0].cars[0].height, 6);
    expect(box.max.x).toBeCloseTo(fixture.sets[0].cars[0].couplers.front, 6);
  });

  it('starts new projects with the 60052 Cargo Train exactly as the catalogue measures it', () => {
    const set = catalogue.sets.find(item => item.id === '60052-1')!;
    const cars = createStandardProject('Example').cars;
    expect(cars.every(car => car.example)).toBe(true);
    expect(cars.map(({ id, example, ...car }) => car)).toEqual(set.cars.map(car => { const { id, ...rest } = catalogueCar(set, car); return rest; }));
  });
});
