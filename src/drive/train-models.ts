import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { frontReach, rearReach } from '../domain/car-geometry';
import { BRICK_TRACK } from '../domain/track';
import { NARROW_TRACK } from '../domain/gauges';
import type { Car } from '../domain/project';
import { librarySettled } from '../domain/library';
import { libraryModel } from '../domain/trains';
import type { TrainFrame } from './train';

/**
 * Cars drawn in Test drive and Build: each car's catalogue model (public/trains, glTF in the car frame: x forward, y left,
 * z up, mm, origin midway between the outer bogie pivots at railhead top) or, while it loads and for custom cars, a
 * procedural car built from its sizes in the same frame.
 */
interface CachedModel { scene: Promise<THREE.Object3D>; users: number; release?: ReturnType<typeof setTimeout> }
const models = new Map<string, CachedModel>();
/** An unused model stays cached this long, so re-entering a view or re-fitting the layout doesn't download it again. */
const RELEASE_DELAY = 30_000;
let loader: GLTFLoader | null = null;

function disposeObject(root: THREE.Object3D) {
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
  });
}

/**
 * Shared, reference-counted scene of one car model; every use gets a clone sharing its geometry and materials. A
 * community train's model is the copy checked against the library index's digest at start-up, never fetched again; a
 * view drawn before that check finished shows the procedural car until it has.
 */
function acquireModel(asset: string): Promise<THREE.Object3D> {
  let entry = models.get(asset);
  if (!entry) {
    const gltf = loader ??= new GLTFLoader();
    const loaded = !asset.startsWith('library:') ? gltf.loadAsync(`${import.meta.env.BASE_URL}${asset}`) : librarySettled().then(() => {
      const checked = libraryModel(asset);
      return checked ? gltf.parseAsync(checked.slice(0), '') : Promise.reject(new Error('not in the library index'));
    });
    const created: CachedModel = { users: 0, scene: loaded.then(result => result.scene) };
    // A failed load is forgotten so the next view retries it.
    created.scene.catch(() => { if (models.get(asset) === created) models.delete(asset); });
    models.set(asset, created);
    entry = created;
  }
  clearTimeout(entry.release);
  entry.users++;
  return entry.scene;
}

function releaseModel(asset: string) {
  const entry = models.get(asset);
  if (!entry || --entry.users > 0) return;
  entry.release = setTimeout(() => {
    if (entry.users > 0 || models.get(asset) !== entry) return;
    models.delete(asset);
    entry.scene.then(disposeObject, () => {});
  }, RELEASE_DELAY);
}

const COLOURS = { lead: 0xc4ee89, wagon: 0xd7aa73, chassis: 0x353d3f, wheel: 0xa3abae, glass: 0x1c2a2e, roof: 0x8a9294 };
const WHEEL_RADIUS = 6, AXLE_SPACING = 20, DECK = 5;

/** A car from its sizes alone: chassis, bogies with wheels, couplers and a body; the lead car gets a raised cab. */
export function proceduralCar(car: Car, lead: boolean): THREE.Group {
  const group = new THREE.Group();
  const material = (color: number) => new THREE.MeshStandardMaterial({ color, roughness: .7, metalness: .08 });
  const body = material(lead ? COLOURS.lead : COLOURS.wagon), chassis = material(COLOURS.chassis);
  const wheel = material(COLOURS.wheel), glass = material(COLOURS.glass), roof = material(COLOURS.roof);
  const box = (x0: number, x1: number, width: number, z0: number, z1: number, mat: THREE.Material) => {
    if (x1 - x0 <= 0 || z1 - z0 <= 0 || width <= 0) return;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, width, z1 - z0), mat);
    mesh.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
    group.add(mesh);
  };
  const front = frontReach(car), rear = -rearReach(car), width = car.width, height = car.height;
  const monorail = car.gauge === 'monorail';
  const gauge = car.gauge === 'narrow' ? NARROW_TRACK.railGauge : BRICK_TRACK.railGauge;
  const deck = Math.min(2 * WHEEL_RADIUS + 3, height * .3);
  for (const pivot of car.bogies ?? [car.wheelbase / 2, -car.wheelbase / 2]) {
    const span = Math.min(AXLE_SPACING + 2 * WHEEL_RADIUS + 4, car.wheelbase);
    box(pivot - span / 2, pivot + span / 2, Math.min(width, gauge + 6), monorail ? 0 : WHEEL_RADIUS - 2, deck, chassis);
    if (monorail) continue;
    for (const axle of [-AXLE_SPACING / 2, AXLE_SPACING / 2]) for (const side of [-1, 1]) {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 3, 18), wheel);
      mesh.position.set(pivot + axle, side * (gauge / 2 + 1.5), WHEEL_RADIUS);
      group.add(mesh);
    }
  }
  box(rear, front, width, deck, deck + DECK, chassis);
  for (const [from, to] of [[front - 1, front], [rear, rear + 1]]) box(from, to, 8, deck - 6, deck, chassis);
  const top = Math.max(deck + DECK + 1, height);
  if (lead) {
    // Locomotive: a lower hood, a cab one third of the length from the front with a dark window band, a roof cap.
    const length = front - rear, cab = front - length * .3;
    box(rear + 3, front - 3, width - 6, deck + DECK, deck + DECK + (top - deck - DECK) * .62, body);
    box(cab - length * .18, cab + length * .1, width, deck + DECK, top - 3, body);
    box(cab - length * .18 - .5, cab + length * .1 + .5, width - 2, top - 3 - (top - deck) * .22, top - 6, glass);
    box(cab - length * .2, cab + length * .12, width - 4, top - 3, top, roof);
  } else {
    box(rear + 3, front - 3, width, deck + DECK, top - 4, body);
    box(rear + 5, front - 5, width - 6, top - 4, top, roof);
  }
  return group;
}

export interface TrainView {
  /** One child per car, in the car frame; `place` moves them onto the track. */
  group: THREE.Group;
  place(frame: TrainFrame): void;
  dispose(): void;
}

/**
 * The consist's cars, each its catalogue model once loaded (a procedural car until then, or for custom cars).
 * `railTop`: height of a car's running surface above the route path. `onChange` asks the view to redraw.
 */
export function createTrainView(cars: readonly Car[], railTop: (car: Car) => number, onChange: () => void,
  options: { shadows?: boolean } = {}): TrainView {
  const group = new THREE.Group(), holders = new Map<string, THREE.Group>(), fallbacks = new Map<string, THREE.Group>();
  const acquired: string[] = [];
  let disposed = false;
  const shade = (object: THREE.Object3D) => {
    if (options.shadows) object.traverse(child => { child.castShadow = true; child.receiveShadow = true; });
  };
  cars.forEach((car, index) => {
    const holder = new THREE.Group(), fallback = proceduralCar(car, index === 0);
    shade(fallback);
    holder.add(fallback);
    holder.visible = false;
    holders.set(car.id, holder);
    fallbacks.set(car.id, fallback);
    group.add(holder);
    const asset = car.model?.asset;
    if (!asset) return;
    acquired.push(asset);
    acquireModel(asset).then(scene => {
      if (disposed) return;
      const model = scene.clone(true);
      shade(model);
      holder.remove(fallback);
      disposeObject(fallback);
      fallbacks.delete(car.id);
      holder.add(model);
      onChange();
    }, error => console.warn(`Train model ${asset} not shown:`, error));
  });
  return {
    group,
    place(frame) {
      for (const holder of holders.values()) holder.visible = false;
      for (const placed of frame.cars) {
        const holder = holders.get(placed.car.id);
        if (!holder) continue;
        holder.visible = true;
        holder.position.set(placed.pose.x, placed.pose.y, placed.pose.z + railTop(placed.car));
        // + roll raises the right rail: a negative turn about the car's forward axis.
        holder.rotation.set(-(placed.pose.roll ?? 0), -placed.pose.pitch, placed.pose.heading, 'ZYX');
      }
    },
    dispose() {
      disposed = true;
      group.removeFromParent();
      for (const fallback of fallbacks.values()) disposeObject(fallback);
      for (const asset of acquired) releaseModel(asset);
      group.clear();
    }
  };
}
