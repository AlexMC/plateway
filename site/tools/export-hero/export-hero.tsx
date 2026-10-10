/**
 * Exports the landing page's live hero (site/js/hero3d.js) from the app's own Test drive scene.
 *
 * Regenerate when the app's 3D look or the showcase layout changes:
 *   1. The layout is site/tools/hero-project.json, a project saved by the app (open it there to edit; it must show
 *      "No problems found"). Which trains run and which stand still is site/tools/hero-scene.json.
 *   2. From the repo root: `npx vite --port 8891`, open http://127.0.0.1:8891/site/tools/export-hero/ and pick both
 *      files (or call `exportHero(projectJson, scene)`). The page mounts the real DriveScene, waits for the train car
 *      models and offers hero-raw.glb and hero.json.
 *   3. `node site/tools/build-hero.mjs <hero-raw.glb> <hero.json>` optimises the model into site/hero/ and rebuilds
 *      the vendored three.js bundle; `node site/tools/build-poster.mjs` redraws the poster and OG image.
 *
 * The scene: owned track grey, printed track orange (as the stills chose; the app's own 3D draws owned track
 * lime), turntable pit and transfer-table well slabs as Build's 3D view draws them, parked cars baked into the layout,
 * and one node per moving car with its route path so the page can run it. Lights and grid are left to hero3d.js.
 */
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { DriveScene } from '../../../src/drive/scene';
import { fitProject } from '../../../src/fitting/fit';
import { routePath, samplePath, type RoutePath } from '../../../src/drive/traversal';
import { consistLength, finalLeadDistance, placeConsist, startingLeadDistance } from '../../../src/drive/train';
import { createTrainView } from '../../../src/drive/train-models';
import { changeProject, parseProject, type Car, type WorkshopProject } from '../../../src/domain/project';
import { catalogueCar, type TrainSet } from '../../../src/domain/trains';
import { pieceDefinition } from '../../../src/domain/pieces';
import { FAMILIES } from '../../../src/fitting/catalog';
import { BRICK_TRACK } from '../../../src/domain/track';

/** A train: `route` is 1-based; `switches` set junction states (piece index in route order → state) for its path. */
export interface HeroTrain { route: number; cars: string[]; switches?: { route: number; piece: number; state: string }[] }
export interface HeroScene {
  /** Trains that run: each gets its own path; `speed` mm/s, `phase` mm of path at t = 0. */
  moving: (HeroTrain & { speed: number; phase: number })[];
  /** Trains standing still: the lead car's origin `lead` mm along the route, else the front coupling face `back` mm
   * short of the route's far end (8 mm: against the buffer stop). */
  parked: (HeroTrain & { back?: number; lead?: number })[];
}

let captured: THREE.Scene | null = null;
const add = THREE.Object3D.prototype.add;
THREE.Object3D.prototype.add = function (...objects) {
  if (this instanceof THREE.Scene) captured = this;
  return add.apply(this, objects);
};

const PATH_STEP = 20, OWNED = 0xa3abae, PRINTED = 0xe7a871, SLAB = 0x4d5d58;
const pause = (ms: number) => { const tick = Promise.withResolvers<void>(); setTimeout(tick.resolve, ms); return tick.promise; };
const base64 = (bytes: Uint8Array) => { let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(text); };

function withSwitches(project: WorkshopProject, train: HeroTrain) {
  return changeProject(project, draft => {
    for (const change of train.switches ?? []) draft.routes[change.route - 1].pieces[change.piece].state = change.state;
  });
}
function carsOf(index: { sets: TrainSet[] }, refs: string[]): Car[] {
  return refs.map(ref => {
    const [id, which] = ref.split('#'), set = index.sets.find(item => item.id === id);
    if (!set) throw new Error(`No set ${id}`);
    return catalogueCar(set, set.cars[Number(which ?? 0)]);
  });
}
function bakedGroup(name: string, sources: THREE.Object3D[], frame: THREE.Matrix4) {
  const group = new THREE.Group();
  group.name = name;
  const inverse = frame.clone().invert();
  for (const source of sources) source.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !object.visible) return;
    object.updateWorldMatrix(true, false);
    group.add(new THREE.Mesh(object.geometry.clone().applyMatrix4(inverse.clone().multiply(object.matrixWorld)), object.material));
  });
  return group;
}
async function modelsLoaded(views: { group: THREE.Group }[]) {
  for (let tries = 0; tries < 150; tries++) {
    await pause(100);
    if (views.every(view => view.group.children.every(holder => !holder.visible || holder.children.some(child => {
      let model = false; child.traverse(o => { if (o instanceof THREE.Mesh && o.geometry.type === 'BufferGeometry') model = true; }); return model;
    })))) return;
  }
  throw new Error('Car models did not load');
}
function encodePath(path: RoutePath) {
  const count = Math.floor(path.length / PATH_STEP) + 1, points = new Int16Array(count * 3);
  for (let i = 0; i < count; i++) {
    const pose = samplePath(path, Math.min(i * PATH_STEP, path.length))!;
    points.set([Math.round(pose.x * 2), Math.round(pose.y * 2), Math.round(pose.z * 2)], i * 3);
  }
  return base64(new Uint8Array(points.buffer));
}

export async function exportHero(text: string, sceneSpec: HeroScene) {
  const project = parseProject(text), fit = fitProject(project);
  const index = await (await fetch('/trains/index.json')).json() as { sets: TrainSet[] };
  captured = null;
  const stage = document.getElementById('stage')!, root = createRoot(stage);
  root.render(<DriveScene fit={fit} frame={{ routeId: '__none__', leadDistance: 0, cars: [], stopped: true, warning: null }} project={project} />);
  for (let tries = 0; tries < 50 && !captured; tries++) await pause(100);
  if (!captured) throw new Error('DriveScene did not render');
  const scene = captured as THREE.Scene;
  await pause(300);

  // DriveScene adds one group per drawn section, in fit order, before anything else.
  const drawn = fit.sections.filter(section => !(section.kind === 'unresolved' || section.moving && section.enabled === false));
  const groups = scene.children.filter(child => child instanceof THREE.Group).slice(0, drawn.length);
  if (groups.length !== drawn.length) throw new Error(`Expected ${drawn.length} section groups, found ${groups.length}`);
  const material = (color: number) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.08, side: THREE.DoubleSide });
  const owned = material(OWNED), printed = material(PRINTED);
  drawn.forEach((section, i) => {
    const mat = FAMILIES.find(family => family.id === section.family)?.source === 'owned' ? owned : printed;
    groups[i].traverse(object => { if (object instanceof THREE.Mesh) object.material = mat; });
  });
  // Turntable pit and transfer-table well: the slab Build's 3D view draws under the moving deck.
  const slab = new THREE.MeshStandardMaterial({ color: SLAB, roughness: 0.9 });
  for (const piece of project.routes.flatMap(route => route.pieces)) {
    for (const outline of pieceDefinition(piece.family).outline?.(piece, project) ?? []) {
      const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(new THREE.Shape(outline.map(point => new THREE.Vector2(point.x, point.y))),
        { depth: BRICK_TRACK.baseThickness, bevelEnabled: false }), slab);
      mesh.position.set(piece.x, piece.y, piece.z - BRICK_TRACK.baseThickness);
      mesh.rotation.z = piece.heading;
      scene.add(mesh);
    }
  }

  const warnings: string[] = [];
  const parkedViews = sceneSpec.parked.map(train => {
    const cars = carsOf(index, train.cars), variant = withSwitches(project, train), variantFit = variant === project ? fit : fitProject(variant);
    const path = routePath(variantFit.sections, variant.routes[train.route - 1].id);
    const lead = train.lead ?? Math.max(startingLeadDistance(cars), finalLeadDistance(cars, path.length) - (train.back ?? 8));
    const frame = placeConsist(path, cars, lead);
    if (frame.cars.length !== cars.length) warnings.push(`Parked on route ${train.route}: ${frame.warning}`);
    const view = createTrainView(cars, () => BRICK_TRACK.railTop, () => {});
    view.place(frame);
    scene.add(view.group);
    return view;
  });
  const moving = sceneSpec.moving.map(train => {
    const cars = carsOf(index, train.cars), variant = withSwitches(project, train), variantFit = variant === project ? fit : fitProject(variant);
    const path = routePath(variantFit.sections, variant.routes[train.route - 1].id);
    if (path.gap) throw new Error(`Route ${train.route}: ${path.gap}`);
    const lead = startingLeadDistance(cars) + 1, frame = placeConsist(path, cars, lead);
    if (frame.cars.length !== cars.length) throw new Error(`Route ${train.route}: ${frame.warning}`);
    const view = createTrainView(cars, () => BRICK_TRACK.railTop, () => {});
    view.place(frame);
    scene.add(view.group);
    const first = samplePath(path, 0)!, last = samplePath(path, path.length)!;
    return { train, cars, path, frame, lead, view, closed: Math.hypot(first.x - last.x, first.y - last.y, first.z - last.z) < 1 };
  });
  await modelsLoaded([...parkedViews, ...moving.map(item => item.view)]);

  const out = new THREE.Scene();
  // Track and supports, then the parked cars (simplified less by build-hero.mjs), then each moving car.
  const trainGroups = new Set<THREE.Object3D>([...parkedViews, ...moving.map(item => item.view)].map(view => view.group));
  out.add(bakedGroup('layout', scene.children.filter(child => !trainGroups.has(child) && !(child instanceof THREE.Light) &&
    !(child instanceof THREE.LineSegments)), new THREE.Matrix4()));
  out.add(bakedGroup('parked', parkedViews.map(view => view.group), new THREE.Matrix4()));
  moving.forEach((item, t) => item.view.group.children.forEach((holder, c) => {
    holder.updateWorldMatrix(true, false);
    out.add(bakedGroup(`train-${t}-car-${c}`, holder.children, holder.matrixWorld));
  }));
  const glb = await new GLTFExporter().parseAsync(out, { binary: true }) as ArrayBuffer;

  const ends = fit.sections.flatMap(section => [section.start.pose, section.end.pose]);
  const lo = { x: Math.min(...ends.map(p => p.x)), y: Math.min(...ends.map(p => p.y)), z: Math.min(...ends.map(p => p.z)) };
  const hi = { x: Math.max(...ends.map(p => p.x)), y: Math.max(...ends.map(p => p.y)), z: Math.max(...ends.map(p => p.z)) };
  const meta = {
    name: project.name, step: PATH_STEP, railTop: BRICK_TRACK.railTop,
    trains: moving.map((item, t) => ({
      route: item.train.route, length: item.path.length, closed: item.closed, points: encodePath(item.path),
      speed: item.train.speed, phase: item.train.phase, lead: item.lead, consist: consistLength(item.cars),
      cars: item.frame.cars.map((placed, c) => ({ node: `train-${t}-car-${c}`, name: placed.car.name, offset: item.lead - placed.distance, wheelbase: placed.car.wheelbase }))
    })),
    center: [(lo.x + hi.x) / 2, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2],
    span: Math.max(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z, 300), gridZ: Math.min(0, lo.z) - 3, warnings
  };
  root.unmount();
  return { glb: base64(new Uint8Array(glb)), meta };
}

declare global { interface Window { exportHero: typeof exportHero } }
window.exportHero = exportHero;

const status = document.getElementById('status')!, links = document.getElementById('links')!;
document.getElementById('files')!.addEventListener('change', async event => {
  const files = [...((event.target as HTMLInputElement).files ?? [])];
  const project = files.find(file => !/scene/i.test(file.name)), spec = files.find(file => /scene/i.test(file.name));
  if (!project || !spec) { status.textContent = 'Pick the project JSON and hero-scene.json together.'; return; }
  status.textContent = 'Building the scene…';
  links.textContent = '';
  try {
    const { glb, meta } = await exportHero(await project.text(), JSON.parse(await spec.text()));
    const link = (name: string, blob: Blob) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.textContent = name; links.append(a); };
    link('hero-raw.glb', new Blob([Uint8Array.from(atob(glb), c => c.charCodeAt(0))], { type: 'model/gltf-binary' }));
    link('hero.json', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    status.textContent = `Exported ${meta.name}: ${meta.trains.length} moving trains.${meta.warnings.length ? ' Warnings: ' + meta.warnings.join('; ') : ''}`;
  } catch (error) { status.textContent = `Export failed: ${error instanceof Error ? error.message : error}`; }
});
