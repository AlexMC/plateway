import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** Disposes every geometry and material under `root`. */
export function disposeObject(root: THREE.Object3D) {
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Line)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
  });
}

interface Live { scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; invalidate: () => void }

/**
 * An uploaded model in 3D (mm, +z up) in the Build scene's light and colours: orbit to look around; a click that doesn't
 * drag reports the hit on `object` to `onPick`. `overlay` (marks, arrows, lines) is drawn over it and never picked. The
 * viewer owns both objects: it disposes each when it is replaced or unmounted.
 */
export function ModelViewer({ object, overlay = null, onPick, label }: {
  object: THREE.Object3D | null; overlay?: THREE.Object3D | null; onPick?: (hit: THREE.Intersection) => void; label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef<Live | null>(null);
  const shown = useRef(object);
  shown.current = object;
  const pick = useRef(onPick);
  pick.current = onPick;
  const [error, setError] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
    catch { setError(true); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x142123);
    // Stronger key light than Build's scene, so each face of an uploaded mesh reads apart from its neighbours.
    scene.add(new THREE.HemisphereLight(0xd7eced, 0x2c3836, 1.2));
    const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 20000);
    camera.up.set(0, 0, 1);
    // The key light rides with the camera: whichever way the model is turned, the faces towards the viewer are lit.
    const sun = new THREE.DirectionalLight(0xffeed7, 2.4);
    sun.position.set(-0.5, 0.3, 1);
    camera.add(sun);
    scene.add(camera);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    let frame = 0, disposed = false;
    const render = () => {
      frame = 0;
      if (controls.update()) invalidate();
      renderer.render(scene, camera);
    };
    const invalidate = () => { if (!disposed && !frame) frame = requestAnimationFrame(render); };
    controls.addEventListener('change', invalidate);
    const canvas = renderer.domElement, raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
    let press: { x: number; y: number } | null = null;
    const down = (event: PointerEvent) => { press = event.button === 0 ? { x: event.clientX, y: event.clientY } : null; };
    const up = (event: PointerEvent) => {
      const target = shown.current;
      if (!press || !target || !pick.current || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) return;
      press = null;
      const bounds = canvas.getBoundingClientRect();
      pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(target, true)[0];
      if (hit) pick.current(hit);
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointerup', up);
    const resize = new ResizeObserver(() => {
      const w = element.clientWidth, h = element.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      invalidate();
    });
    resize.observe(element);
    live.current = { scene, camera, controls, invalidate };
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointerup', up);
      controls.dispose();
      renderer.dispose();
      canvas.remove();
      live.current = null;
    };
  }, []);

  useEffect(() => {
    const view = live.current;
    if (!view || !object) return () => { if (object) disposeObject(object); };
    view.scene.add(object);
    const box = new THREE.Box3().setFromObject(object), centre = box.getCenter(new THREE.Vector3());
    const span = Math.max(40, box.getSize(new THREE.Vector3()).length());
    view.camera.position.set(centre.x + span * 0.55, centre.y - span * 0.85, centre.z + span * 0.45);
    view.controls.target.copy(centre);
    view.controls.minDistance = span * 0.2;
    view.controls.maxDistance = span * 6;
    view.controls.update();
    view.invalidate();
    return () => { view.scene.remove(object); disposeObject(object); view.invalidate(); };
  }, [object]);

  useEffect(() => {
    const view = live.current;
    if (!view || !overlay) return () => { if (overlay) disposeObject(overlay); };
    view.scene.add(overlay);
    view.invalidate();
    return () => { view.scene.remove(overlay); disposeObject(overlay); view.invalidate(); };
  }, [overlay]);

  return <div className="contribute-viewer" ref={host} role="img" aria-label={label}>
    {error && <div className="builder-3d-error" role="status">WebGL is unavailable, so the 3D view can’t show here.</div>}
  </div>;
}
