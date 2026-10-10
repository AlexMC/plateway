/**
 * The hero's live model: the "Engine shed and viaduct" layout exported from the app's Test drive scene
 * (site/tools/export-hero, build-hero.mjs), lit like the app's 3D view. The Horizon Express runs the main loop and the
 * Emerald Night the viaduct's figure eight, each on its real route path; parked locos and wagons are part of the
 * model. Loaded after first paint by index.html; the poster image stays until the first frame is drawn, and stays for
 * good if anything fails.
 *
 * The camera follows a short cinematic: a low, close opening shot on the engine shed while the Emerald Night crosses
 * the viaduct in front, an eased pull-back to the whole layout, a gentle sway, and now and then a slow push-in that
 * rides along with the Emerald Night over the viaduct. Its keyframes are `camera` in hero.json (from
 * site/tools/hero-scene.json); a drag or pinch hands the view to the visitor, and the cinematic blends back in after
 * they leave it alone. With prefers-reduced-motion the view is the still whole layout.
 */
import {
  Box3, DirectionalLight, GLTFLoader, GridHelper, Group, HemisphereLight, Mesh, MeshoptDecoder, OrbitControls,
  PCFSoftShadowMap, PerspectiveCamera, PlaneGeometry, Scene, ShadowMaterial, Vector3, WebGLRenderer
} from './vendor/three-site.js';

const DEG = Math.PI / 180;
const ease = t => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));

/** Path samples (half millimetres, Int16) → Float32 xyz in mm. */
function decodePath(train) {
  const bytes = Uint8Array.from(atob(train.points), c => c.charCodeAt(0));
  const raw = new Int16Array(bytes.buffer), points = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) points[i] = raw[i] / 2;
  return points;
}

/** A camera pose: what it looks at, from which direction (azimuth from +x, elevation, radians) and how far (mm). */
const pose = () => ({ target: new Vector3(), azimuth: 0, elevation: 0, distance: 1 });
function copyPose(out, from) {
  out.target.copy(from.target); out.azimuth = from.azimuth; out.elevation = from.elevation; out.distance = from.distance;
  return out;
}
/** Eased blend `t` from a to b; distance in log space so zooms feel even, azimuth the short way round. */
function mixPose(out, a, b, t) {
  out.target.lerpVectors(a.target, b.target, t);
  out.azimuth = a.azimuth + wrap(b.azimuth - a.azimuth) * t;
  out.elevation = a.elevation + (b.elevation - a.elevation) * t;
  out.distance = a.distance * Math.pow(b.distance / a.distance, t);
  return out;
}
function direction(azimuth, elevation, out = new Vector3()) {
  return out.set(Math.cos(azimuth) * Math.cos(elevation), Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation));
}

/**
 * Mounts the live hero in `figure`. `still` draws one frame and stops: 'full' (the whole layout, used for reduced
 * motion) or 'opening' (the cinematic's first frame; build-poster.mjs draws the poster from it).
 */
export async function mountHero(figure, { reduceMotion = false, still = reduceMotion ? 'full' : null } = {}) {
  const base = new URL('../hero/', import.meta.url);
  const [meta, gltf] = await Promise.all([
    fetch(new URL('hero.json', base)).then(response => { if (!response.ok) throw new Error(`hero.json ${response.status}`); return response.json(); }),
    new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(new URL('hero.glb', base).href)
  ]);
  const shot = meta.camera;

  const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.className = 'hero-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Interactive 3D model of a train layout: a main loop of grey brick track around an engine ' +
    'shed and freight yard, with a turntable whose stalls each hold a locomotive, a transfer table, an uncoupler and wagons ' +
    'in the sidings. A printed viaduct line climbs on columns and bridges over the main loop twice. The Horizon ' +
    'Express runs the main loop while the Emerald Night steam train crosses the viaduct. Drag to look around.');

  // The app's Test drive scene: Z up, millimetres, the same lights and grid colours.
  const scene = new Scene();
  const [cx, cy, cz] = meta.center, span = meta.span;
  scene.add(new HemisphereLight(0xffffff, 0x44646b, 2.3));
  const sun = new DirectionalLight(0xffffff, 2.1);
  sun.position.set(cx + span / 2, cy - span / 3, cz + span);
  sun.target.position.set(cx, cy, cz);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -span * 0.75, right: span * 0.75, top: span * 0.75, bottom: -span * 0.75, near: 1, far: span * 4 });
  sun.shadow.bias = -0.0005;
  sun.shadow.radius = 4;
  scene.add(sun, sun.target);
  const grid = new GridHelper(span * 1.5, 20, 0x436266, 0x29454a);
  grid.rotation.x = Math.PI / 2;
  grid.position.set(cx, cy, meta.gridZ);
  scene.add(grid);
  const ground = new Mesh(new PlaneGeometry(span * 1.5, span * 1.5), new ShadowMaterial({ color: 0x050b0c, opacity: 0.32 }));
  ground.position.set(cx, cy, meta.gridZ + 0.5);
  ground.receiveShadow = true;
  scene.add(ground);

  const model = gltf.scene;
  model.traverse(object => { if (object.isMesh) { object.castShadow = true; object.receiveShadow = true; } });
  // Each moving car node carries its dequantisation transform; a holder moves it along its train's path.
  const trains = meta.trains.map(train => ({
    ...train, points: decodePath(train),
    cars: train.cars.map(car => {
      const holder = new Group();
      holder.add(model.getObjectByName(car.node));
      scene.add(holder);
      return { ...car, holder };
    })
  }));
  scene.add(model);

  const front = [0, 0, 0], rear = [0, 0, 0];
  const wrapDistance = (train, distance) => train.closed ? ((distance % train.length) + train.length) % train.length :
    Math.min(Math.max(distance, 0), train.length);
  const at = (train, distance, out) => {
    const { points } = train, count = points.length / 3;
    const f = wrapDistance(train, distance) / meta.step, i = Math.min(Math.floor(f), count - 2), t = f - i;
    for (let k = 0; k < 3; k++) out[k] = points[i * 3 + k] + (points[(i + 1) * 3 + k] - points[i * 3 + k]) * t;
    return out;
  };
  // The trains' timetable: speeds and starting points were chosen (hero-scene.json) so they never meet where the
  // viaduct line shares the main loop. `clock` is the cinematic's time; the timetable starts at camera.startClock so
  // the Emerald Night reaches the viaduct during the opening shot. As the app places a car, its body rests on its
  // bogie pivots.
  let clock = 0;
  const leadAt = (train, time) => train.phase + train.speed * (shot.startClock + time);
  const placeTrains = () => {
    for (const train of trains) {
      const lead = leadAt(train, clock);
      for (const car of train.cars) {
        const distance = lead - car.offset;
        at(train, distance + car.wheelbase / 2, front);
        at(train, distance - car.wheelbase / 2, rear);
        const dx = front[0] - rear[0], dy = front[1] - rear[1], dz = front[2] - rear[2];
        car.holder.position.set((front[0] + rear[0]) / 2, (front[1] + rear[1]) / 2, (front[2] + rear[2]) / 2 + meta.railTop);
        car.holder.rotation.set(0, -Math.atan2(dz, Math.hypot(dx, dy)), Math.atan2(dy, dx), 'ZYX');
      }
    }
  };
  placeTrains();

  const camera = new PerspectiveCamera(40, 1, 10, span * 10);
  camera.up.set(0, 0, 1);
  // Frame the track itself: a sample of the layout's vertices, not its bounding box (whose corners are empty table).
  model.updateMatrixWorld(true);
  const corners = [], vertex = new Vector3();
  model.traverse(object => {
    if (!object.isMesh) return;
    const position = object.geometry.attributes.position, stride = Math.max(1, Math.floor(position.count / 400));
    for (let i = 0; i < position.count; i += stride) corners.push(vertex.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld).clone());
  });

  // Keyframe poses. The whole-layout view keeps every sampled vertex inside `full.margin` of the frame from every
  // angle of the sway, so the viaduct never crops.
  const opening = pose();
  opening.target.fromArray(shot.opening.target);
  Object.assign(opening, { azimuth: shot.opening.azimuth * DEG, elevation: shot.opening.elevation * DEG, distance: shot.opening.distance });
  const full = pose();
  full.target.copy(new Box3().setFromPoints(corners).getCenter(new Vector3()));
  Object.assign(full, { azimuth: shot.full.azimuth * DEG, elevation: shot.full.elevation * DEG });
  const sway = shot.sway.degrees * DEG;
  const fitDistance = () => {
    let needed = 0;
    const probe = camera.clone(), projected = new Vector3(), [mx, my] = shot.full.margin;
    for (const offset of [-1, -0.5, 0, 0.5, 1]) {
      let near = span * 0.2, far = span * 6;
      for (let step = 0; step < 24; step++) {
        const mid = (near + far) / 2;
        probe.position.copy(direction(full.azimuth + offset * sway, full.elevation)).multiplyScalar(mid).add(full.target);
        probe.lookAt(full.target);
        probe.updateMatrixWorld();
        const inside = corners.every(corner => { projected.copy(corner).project(probe); return Math.abs(projected.x) < mx && Math.abs(projected.y) < my; });
        if (inside) far = mid; else near = mid;
      }
      needed = Math.max(needed, far);
    }
    return needed;
  };

  // Follow: ride along with one train while all of it stays on the high viaduct for the whole push-in.
  const follow = shot.follow, followed = trains[follow.train];
  const followLength = follow.in + follow.hold + follow.out;
  const onViaduct = lead => {
    for (let d = lead - followed.consist; d <= lead + followed.speed * followLength; d += meta.step) {
      if (at(followed, d, front)[2] < follow.minHeight) return false;
    }
    return true;
  };
  let followStart = null, lastFollowEnd = shot.opening.hold + shot.pullBack;
  const followPose = (base, out) => {
    // The middle of the train, a little ahead of where it is now so it sits in the frame's centre.
    at(followed, leadAt(followed, clock) - followed.consist / 2 + followed.speed, front);
    out.target.set(front[0], front[1], front[2] + 40);
    return Object.assign(out, { azimuth: base.azimuth, elevation: follow.elevation * DEG, distance: follow.distance });
  };

  /** The cinematic's pose at the current clock. */
  const wanted = pose(), swayPose = pose(), followView = pose();
  const introEnd = shot.opening.hold + shot.pullBack;
  const cinematic = out => {
    copyPose(swayPose, full).azimuth = full.azimuth + sway * Math.sin(Math.max(0, clock - introEnd) / shot.sway.period * 2 * Math.PI);
    if (clock < shot.opening.hold) return copyPose(out, opening);
    if (clock < introEnd) return mixPose(out, opening, swayPose, ease((clock - shot.opening.hold) / shot.pullBack));
    if (followStart === null && clock - lastFollowEnd >= follow.every && onViaduct(leadAt(followed, clock))) followStart = clock;
    if (followStart !== null) {
      const t = clock - followStart;
      if (t >= followLength) { followStart = null; lastFollowEnd = clock; }
      else return mixPose(out, swayPose, followPose(swayPose, followView), ease(t / follow.in) * (1 - ease((t - follow.in - follow.hold) / follow.out)));
    }
    return copyPose(out, swayPose);
  };
  const place = p => {
    camera.position.copy(direction(p.azimuth, p.elevation)).multiplyScalar(p.distance).add(p.target);
    camera.lookAt(p.target);
    controls.target.copy(p.target);
  };

  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.6;
  controls.maxPolarAngle = Math.PI / 2 - 0.08;
  controls.minPolarAngle = 0.15;
  // Scrolling scrolls the page; only ctrl/cmd + scroll (and trackpad pinch, which arrives as ctrl + wheel) zooms.
  canvas.addEventListener('wheel', event => { controls.enableZoom = event.ctrlKey || event.metaKey; }, { capture: true, passive: true });
  // Touch: a vertical swipe scrolls the page, a sideways drag turns the model, two fingers pinch to zoom.
  canvas.style.touchAction = 'pan-y';
  canvas.addEventListener('pointerdown', event => { if (event.pointerType === 'touch') controls.enableZoom = true; }, { capture: true });

  // Who drives the camera: the cinematic, or the visitor from their first drag or pinch until they leave it alone for
  // camera.resume.after seconds; then the cinematic blends back in from wherever they left the view.
  let driving = still ? 'visitor' : 'cinematic', dragging = false, touched = false, idleSince = 0, resumeAt = null, resumeFor = 0;
  const resumeFrom = pose(), current = pose();
  const hint = document.createElement('p');
  hint.className = 'hero-hint';
  hint.textContent = 'Drag to look around';
  hint.setAttribute('aria-hidden', 'true');
  controls.addEventListener('start', () => {
    driving = 'visitor'; dragging = touched = true; resumeAt = null; followStart = null;
    hint.classList.add('is-hidden');
    invalidate();
  });
  controls.addEventListener('end', () => { dragging = false; idleSince = clock; });
  controls.addEventListener('change', () => invalidate());

  const resize = () => {
    const width = figure.clientWidth, height = figure.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    full.distance = fitDistance();
    controls.minDistance = Math.min(opening.distance, follow.distance) * 0.9;
    controls.maxDistance = full.distance * 1.4;
    if (still && !touched) place(still === 'full' ? full : opening);
    invalidate();
  };

  // Render only while the hero is on screen and the tab is visible; the clock (trains and cinematic) stops with it,
  // so a visitor coming back finds the sequence where they left it.
  let visible = true, frame = 0, last = 0;
  const running = () => !still && visible && !document.hidden;
  const animate = now => {
    // Claim the next frame before controls.update(), whose 'change' event would otherwise start a second loop.
    frame = running() ? requestAnimationFrame(animate) : 0;
    const seconds = last ? Math.min((now - last) / 1000, 0.1) : 0;
    last = now;
    if (!still) {
      clock += seconds;
      placeTrains();
      if (driving === 'visitor' && !dragging && clock - idleSince >= shot.resume.after) {
        driving = 'cinematic';
        const offset = camera.position.clone().sub(controls.target);
        Object.assign(resumeFrom, { azimuth: Math.atan2(offset.y, offset.x), elevation: Math.asin(offset.z / offset.length()), distance: offset.length() });
        resumeFrom.target.copy(controls.target);
        resumeAt = clock;
        // Long enough that the view never turns faster than resume.maxTurn (smoothstep peaks at 1.5× its average).
        cinematic(wanted);
        const turn = Math.max(Math.abs(wrap(wanted.azimuth - resumeFrom.azimuth)), Math.abs(wanted.elevation - resumeFrom.elevation)) / DEG;
        resumeFor = Math.max(shot.resume.blend, 1.5 * turn / shot.resume.maxTurn);
      }
      if (driving === 'cinematic') {
        cinematic(wanted);
        place(resumeAt === null ? wanted : mixPose(current, resumeFrom, wanted, ease((clock - resumeAt) / resumeFor)));
        if (resumeAt !== null && clock - resumeAt >= resumeFor) resumeAt = null;
      }
    }
    // The visitor's view: damping keeps turning it for a few frames after a drag.
    if (driving === 'visitor' && controls.update() && !frame) frame = requestAnimationFrame(animate);
    renderer.render(scene, camera);
  };
  function invalidate() {
    if (!frame && visible && !document.hidden) { last = 0; frame = requestAnimationFrame(animate); }
  }
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) invalidate(); else { cancelAnimationFrame(frame); frame = 0; }
  }).observe(figure);
  document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelAnimationFrame(frame); frame = 0; } else invalidate(); });
  new ResizeObserver(resize).observe(figure);

  figure.append(canvas, hint);
  resize();
  // The first frame is the opening shot at clock 0 (the poster is drawn from it), or the still whole layout.
  place(still === 'full' ? full : opening);
  controls.update();
  renderer.render(scene, camera);
  // Crossfade from the poster once the first frame is on the canvas.
  requestAnimationFrame(() => {
    figure.classList.add('is-live');
    figure.querySelector('picture img')?.setAttribute('aria-hidden', 'true');
  });
  return { renderer, scene, camera };
}
