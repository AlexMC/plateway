/**
 * Still previews of community library items for library.html and the landing strip. One offscreen WebGLRenderer
 * draws every item once, from the same three-quarter view, and the frame becomes an image (WebP where the browser
 * encodes it, else PNG), so a page of cards holds no WebGL context per card. Pieces are their STL in the app's
 * printed-piece colour; furniture is its FurnitureType's panels (src/domain/furniture.ts) as boxes in its own colour;
 * trains are their car's glTF binary. Everything is in the library's frame: millimetres, z up, front towards -y.
 *
 * Finished previews are kept in the Cache API under the item's digest, so a return visit (or library.html after the
 * landing page) draws nothing and downloads no model. `spin` turns a model in a 2D canvas over its card, drawing with
 * the same renderer, one item at a time.
 */
import {
  Box3, BoxGeometry, DirectionalLight, GLTFLoader, Group, HemisphereLight, Mesh, MeshStandardMaterial, PCFSoftShadowMap,
  PerspectiveCamera, PlaneGeometry, STLLoader, Scene, ShadowMaterial, Vector3, WebGLRenderer
} from './vendor/three-site.js';

export const WIDTH = 640, HEIGHT = 480;
/** Bump when the look changes: older cached previews are dropped. */
const LOOK = 1;
const CACHE = `plateway-library-previews-${LOOK}`;
/** The app's printed-piece colour (src/domain/pieces/catalogue.ts). */
const PRINTED = 0xe7a871;
const AZIMUTH = -55 * Math.PI / 180, ELEVATION = 26 * Math.PI / 180, FOV = 24;
/** Models kept for spinning, most recently drawn last. */
const KEEP = 12;
/** Models downloading at once. */
const DOWNLOADS = 3;

let stage = null;
function getStage() {
  if (stage) return stage;
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT, false);
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  // The app's 3D view lights (hero3d.js, src/drive/scene.tsx).
  const scene = new Scene();
  scene.add(new HemisphereLight(0xffffff, 0x44646b, 2.3));
  const sun = new DirectionalLight(0xffffff, 2.1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);
  const ground = new Mesh(new PlaneGeometry(1, 1), new ShadowMaterial({ opacity: 0.32 }));
  ground.receiveShadow = true;
  scene.add(ground);
  const camera = new PerspectiveCamera(FOV, WIDTH / HEIGHT, 1, 1e6);
  camera.up.set(0, 0, 1);
  stage = { renderer, scene, sun, ground, camera, subject: null };
  return stage;
}

const direction = (azimuth, elevation) =>
  new Vector3(Math.cos(azimuth) * Math.cos(elevation), Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation));

/** Puts `model` alone on the stage, its shadow on the floor under it. */
function stageModel(model) {
  const { scene, sun, ground } = stage;
  if (stage.subject === model.object) return;
  if (stage.subject) scene.remove(stage.subject);
  scene.add(model.object);
  stage.subject = model.object;
  const { box, centre, span } = model;
  ground.position.set(centre.x, centre.y, box.min.z - span * 0.001);
  ground.scale.set(span * 6, span * 6, 1);
  sun.position.copy(centre).add(new Vector3(-0.45, -0.7, 1.25).multiplyScalar(span * 2));
  sun.target.position.copy(centre);
  Object.assign(sun.shadow.camera, { left: -span * 1.6, right: span * 1.6, top: span * 1.6, bottom: -span * 1.6, near: span * 0.1, far: span * 6 });
  sun.shadow.camera.updateProjectionMatrix();
}

/** The camera basis looking from `azimuth`: `back` points from the model to the camera. */
function basis(azimuth) {
  const back = direction(azimuth, ELEVATION), right = new Vector3(0, 0, 1).cross(back).normalize();
  return { back, right, up: back.clone().cross(right) };
}
const TAN_V = Math.tan(FOV / 2 * Math.PI / 180) / 1.22, TAN_H = TAN_V * WIDTH / HEIGHT;

/** The tightest view from `azimuth` that keeps every corner of the model's box in frame, its image centred. */
function fit(model, azimuth) {
  const { back, right, up } = basis(azimuth), corners = model.corners;
  let distance = 0;
  for (const p of corners) distance = Math.max(distance, Math.abs(p.dot(right)) / TAN_H + p.dot(back), Math.abs(p.dot(up)) / TAN_V + p.dot(back));
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of corners) {
    const depth = distance - p.dot(back), sx = p.dot(right) / depth, sy = p.dot(up) / depth;
    x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
  }
  const target = model.centre.clone().addScaledVector(right, (x0 + x1) / 2 * distance).addScaledVector(up, (y0 + y1) / 2 * distance);
  return { target, distance };
}

/** One view for a whole turn: on the box's centre, far enough for every azimuth. */
function turnFit(model) {
  let distance = 0;
  for (let step = 0; step < 24; step++) {
    const { back, right, up } = basis(step * Math.PI / 12);
    for (const p of model.corners)
      distance = Math.max(distance, Math.abs(p.dot(right)) / TAN_H + p.dot(back), Math.abs(p.dot(up)) / TAN_V + p.dot(back));
  }
  return { target: model.centre.clone(), distance };
}

function draw(model, azimuth, view) {
  stageModel(model);
  const { camera, renderer, scene } = stage, { back } = basis(azimuth);
  camera.position.copy(view.target).addScaledVector(back, view.distance);
  camera.near = Math.max(0.1, view.distance - model.span * 2);
  camera.far = view.distance + model.span * 4;
  camera.updateProjectionMatrix();
  camera.lookAt(view.target);
  renderer.render(scene, camera);
  return renderer.domElement;
}

/** A model's object, its box, centre, span and corners (for framing) and its size for the card, in mm. */
async function buildModel(item, url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${item.file}: ${response.status}`);
  let object, size;
  if (item.kind === 'furniture') {
    const type = await response.json();
    object = furnitureObject(type);
    size = [type.width, type.depth, type.height];
  } else if (item.kind === 'piece') {
    const geometry = new STLLoader().parse(await response.arrayBuffer());
    geometry.deleteAttribute('normal');
    geometry.computeVertexNormals();
    object = new Mesh(geometry, new MeshStandardMaterial({ color: PRINTED, roughness: 0.64, metalness: 0.08 }));
  } else {
    const gltf = await new GLTFLoader().parseAsync(await response.arrayBuffer(), '');
    object = gltf.scene;
  }
  object.traverse(child => { if (child.isMesh) child.castShadow = child.receiveShadow = true; });
  object.updateMatrixWorld(true);
  const box = new Box3().setFromObject(object);
  if (box.isEmpty()) throw new Error(`${item.file}: nothing to draw`);
  const centre = box.getCenter(new Vector3()), extent = box.getSize(new Vector3());
  if (!size) size = [extent.x, extent.y, extent.z];
  if (item.kind === 'train' && item.train?.car) size = [item.train.car.length, item.train.car.width, item.train.car.height];
  const corners = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z])
    corners.push(new Vector3(x, y, z).sub(centre));
  return { object, box, centre, corners, span: Math.max(extent.x, extent.y, extent.z), size };
}

/** A furniture type's panels as boxes; one with no panels shows its surfaces as boards instead. */
function furnitureObject(type) {
  const material = new MeshStandardMaterial({ color: type.colour, roughness: 0.72, metalness: 0.12 });
  const boards = type.panels?.length ? type.panels : (type.surfaces ?? []).map(surface => {
    const xs = surface.footprint.map(point => point.x), ys = surface.footprint.map(point => point.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: surface.height - 9, width: x1 - x0, depth: y1 - y0, height: 18 };
  });
  const group = new Group();
  for (const panel of boards) {
    const board = new Mesh(new BoxGeometry(panel.width, panel.depth, panel.height), material);
    board.position.set(panel.x, panel.y, panel.z);
    group.add(board);
  }
  return group;
}

function dispose(object) {
  object.traverse(child => {
    child.geometry?.dispose();
    for (const material of [child.material].flat()) material?.dispose();
  });
}

const models = new Map();
function keep(id, model) {
  models.delete(id);
  models.set(id, model);
  for (const [oldest, old] of models) {
    if (models.size <= KEEP) break;
    if (stage?.subject === old.object) continue;
    models.delete(oldest);
    dispose(old.object);
  }
}

let active = 0;
const waiting = [];
async function downloadSlot(task) {
  if (active >= DOWNLOADS) await new Promise(resolve => waiting.push(resolve));
  active++;
  try { return await task(); } finally { active--; waiting.shift()?.(); }
}

const loading = new Map();
function loadModel(item, url) {
  if (models.has(item.id)) return Promise.resolve(models.get(item.id));
  if (!loading.has(item.id)) {
    const promise = downloadSlot(() => buildModel(item, url, AbortSignal.timeout(60_000)))
      .then(model => { keep(item.id, model); return model; })
      .finally(() => loading.delete(item.id));
    loading.set(item.id, promise);
  }
  return loading.get(item.id);
}

const cacheKey = item => new URL(`/library-preview/${encodeURIComponent(item.id)}/${item.version}/${item.digest}`, location.origin).href;
let cacheReady = null;
/** The previews cache, older looks deleted; null where the Cache API is missing (plain http, some private modes). */
function openCache() {
  cacheReady ??= (async () => {
    if (!globalThis.caches) return null;
    try {
      for (const name of await caches.keys()) if (name.startsWith('plateway-library-previews-') && name !== CACHE) await caches.delete(name);
      return await caches.open(CACHE);
    } catch { return null; }
  })();
  return cacheReady;
}

/** Whether this browser can draw previews at all (WebGL 2, the same bar as the landing hero). */
export function canPreview() {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}

const toBlob = canvas => new Promise((resolve, reject) =>
  canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The preview could not be encoded')), 'image/webp', 0.9));

/**
 * The item's preview: `{ blob, size }`, from the cache or drawn now. `url` is the item's file (itemFileUrl). Drawing
 * runs one item at a time on the shared renderer; downloads overlap up to DOWNLOADS.
 */
export async function preview(item, url) {
  const cache = await openCache(), key = cacheKey(item);
  const hit = await cache?.match(key).catch(() => null);
  if (hit) {
    try { return { blob: await hit.blob(), size: JSON.parse(hit.headers.get('x-preview-size')) }; } catch { /* draw it again */ }
  }
  const model = await loadModel(item, url);
  getStage();
  const blob = await toBlob(draw(model, AZIMUTH, fit(model, AZIMUTH)));
  await cache?.put(key, new Response(blob, { headers: { 'content-type': blob.type, 'x-preview-size': JSON.stringify(model.size) } }))
    .catch(() => {});
  return { blob, size: model.size };
}

let spinning = null;
/**
 * Turns the item's model in `canvas` (a 2D canvas WIDTH × HEIGHT) until the returned stop is called. It starts from the
 * still preview's view and eases out to one that fits every side. Only one model spins at a time; starting another
 * stops this one. `onFrame` runs once the first frame is drawn (the caller shows the canvas then).
 */
export function spin(item, url, canvas, onFrame) {
  spinning?.();
  let stopped = false, frame = 0;
  const stop = () => { stopped = true; cancelAnimationFrame(frame); if (spinning === stop) spinning = null; };
  spinning = stop;
  loadModel(item, url).then(model => {
    if (stopped) return;
    getStage();
    const context = canvas.getContext('2d'), still = fit(model, AZIMUTH), turn = turnFit(model);
    const view = { target: new Vector3(), distance: 0 };
    let start = null;
    const tick = now => {
      if (stopped) return;
      start ??= now;
      const seconds = (now - start) / 1000, t = Math.min(1, seconds / 0.6), eased = t * t * (3 - 2 * t);
      view.target.lerpVectors(still.target, turn.target, eased);
      view.distance = still.distance + (turn.distance - still.distance) * eased;
      const source = draw(model, AZIMUTH + seconds * 0.9, view);
      context.clearRect(0, 0, WIDTH, HEIGHT);
      context.drawImage(source, 0, 0);
      if (onFrame) { onFrame(); onFrame = null; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }).catch(() => stop());
  return stop;
}
