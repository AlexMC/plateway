import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import type { PartInstance, Pose3, Section } from '../domain/route';
import { BRICK_TRACK } from '../domain/track';
import { gaugeLayout } from '../domain/gauges';
import { findPieceDefinition } from '../domain/pieces';
import { FAMILIES } from '../fitting/catalog';
import type { FitResult } from '../fitting/fit';
import { FAST_PRINT_COLOR, braceGeometry, connectorCentre, connectorGeometry, connectorPorts, curveTieLayout, partStations, sectionGeometry, stringerSection, tieGeometry, type PreviewPose } from '../editor/track-preview';
import type { TrainFrame } from './train';
import { createTrainView, type TrainView } from './train-models';
import { samplePath } from './traversal';
import { ownSupportGeometries } from '../editor/own-support-preview';
import { scenicDecor } from '../editor/scenic-preview';
import type { WorkshopProject } from '../domain/project';
import { apiFetch } from '../net/api';
import { MONORAIL_BEAM_COLOR, MONORAIL_BEAM_TOP, addMonorailBeam } from '../editor/monorail-visual';
import { CommunityMeshHint, communityMesh, communityMeshMatrix, onCommunityMeshChange } from '../editor/community-mesh';
import './drive.css';

export interface InspectionMesh {
  sectionId: string;
  interfaceKind: PartInstance['interfaceKind'];
  layoutRevision: string;
  parameters: Record<string, number>;
  assemblyParameters?: Record<string, number>;
  componentRole?: string;
  pose: Pose3;
  digest: string;
  requestDigest: string;
  url: string;
}

/** Generation identity, fitted parameters and assembly transform must all still match. */
export function currentInspectionMesh(fit: FitResult, instance: PartInstance, mesh: InspectionMesh): boolean {
  if (mesh.layoutRevision !== fit.layoutRevision || mesh.sectionId !== instance.sectionId ||
    mesh.interfaceKind !== instance.interfaceKind ||
    !/^[a-f0-9]{64}$/.test(mesh.digest) || !/^[a-f0-9]{64}$/.test(mesh.requestDigest)) return false;
  const keys = Object.keys(instance.parameters);
  const parameters=instance.interfaceKind==='track-assembly'?mesh.assemblyParameters:mesh.parameters;
  if (!parameters || keys.length !== Object.keys(parameters).length || keys.some(key => parameters[key] !== instance.parameters[key])) return false;
  return (['x', 'y', 'z', 'heading', 'pitch'] as const).every(key => instance.pose[key] === mesh.pose[key]);
}

function sectionSamples(section: Section, spacing: number, from = 0, to = section.run): Pose3[] {
  const path = {routeId:section.routeId,sections:[section],length:section.run,gap:null};
  const steps = Math.max(2, Math.ceil((to - from) / spacing));
  const points: Pose3[] = [];
  for (let step = 0; step <= steps; step++) {
    const pose = samplePath(path, from + (to - from) * step / steps);
    if (pose) points.push(pose);
  }
  return points;
}

type ConnectorPair = readonly [THREE.BufferGeometry, THREE.BufferGeometry];
type Connectors = Record<'standard' | 'flex' | 'narrow', ConnectorPair>;

/**
 * The Build step's piece geometry, so Test drive shows the same track; `lite` draws fast-print braces instead of ties.
 * `cuts` split a composite piece into its bed-sized parts, each with its own ties and end connectors.
 * `section.gauge` (absent = standard) sets the cross-section: rails, stringers, ties, braces and ends.
 */
function addStandardTrack(group: THREE.Group, section: Section, material: THREE.Material,
  connectors: Connectors, lite: boolean, cuts: readonly number[] = []) {
  const stations = [0, ...cuts, section.run];
  for (let index = 1; index < stations.length; index++)
    addStandardPart(group, section, material, connectors, lite, stations[index - 1], stations[index]);
}
function addStandardPart(group: THREE.Group, section: Section, material: THREE.Material,
  connectors: Connectors, lite: boolean, from: number, to: number) {
  const samples: PreviewPose[] = sectionSamples(section, 12, from, to), run = to - from;
  if (samples.length < 2) return;
  const points = connectorCentre(samples, run);
  const add = (geometry: THREE.BufferGeometry) => {
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);
    return mesh;
  };
  if (section.gauge === 'monorail') return addMonorailBeam(samples, add, new THREE.MeshStandardMaterial({ color: MONORAIL_BEAM_COLOR, roughness: .64 }));
  const layout = section.arc ? curveTieLayout(section.arc.radius, section.arc.sweep) : 'modular', across = gaugeLayout(section.gauge);
  const ties = lite ? braceGeometry(points, run, layout, section.family === 'vertical_transition', across) : tieGeometry(points, run, layout, across);
  if (ties) add(ties);
  for (const stringer of across.stringers) add(sectionGeometry(points, stringerSection(stringer)));
  for (const rail of across.rails) add(sectionGeometry(points, BRICK_TRACK.railSection, rail));
  const ends = across.narrowEnds ? connectors.narrow : findPieceDefinition(section.family ?? '')?.flexEnds ? connectors.flex : connectors.standard;
  for (const [index, port] of connectorPorts(samples).entries()) {
    const mesh = add(ends[index]);
    mesh.position.set(port.x, port.y, port.z);
    mesh.rotation.set(0, -(port.pitch ?? 0), port.heading, 'ZYX');
  }
}

/** `project`: its pieces' printed options and scenery (ballast, rack teeth, road tiles, a funicular's plank and winch) are drawn as in Build. */
export function DriveScene({ fit, frame, meshes = [], standardTrack = true, project }: {
  fit: FitResult; frame: TrainFrame; meshes?: readonly InspectionMesh[]; standardTrack?: boolean; project?: WorkshopProject;
}) {
  const host = useRef<HTMLDivElement>(null);
  const train = useRef<TrainView | null>(null);
  const invalidateRef = useRef<() => void>(() => {});
  const [sceneError, setSceneError] = useState('');
  const railTop = standardTrack ? BRICK_TRACK.railTop : 0;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch { setSceneError('3D view unavailable in this browser. Use Top view.'); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x132022, 1);
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#132022');
    const camera = new THREE.PerspectiveCamera(48, 1, 1, 100000);
    camera.up.set(0, 0, 1);
    const positions = fit.sections.flatMap(section => [section.start.pose, section.end.pose]);
    const minimum = positions.length ? positions.reduce((acc, pose) => ({ x: Math.min(acc.x, pose.x), y: Math.min(acc.y, pose.y), z: Math.min(acc.z, pose.z) }), { x: Infinity, y: Infinity, z: Infinity }) : { x: -250, y: -250, z: 0 };
    const maximum = positions.length ? positions.reduce((acc, pose) => ({ x: Math.max(acc.x, pose.x), y: Math.max(acc.y, pose.y), z: Math.max(acc.z, pose.z) }), { x: -Infinity, y: -Infinity, z: -Infinity }) : { x: 250, y: 250, z: 100 };
    const center = new THREE.Vector3((minimum.x + maximum.x)/2, (minimum.y + maximum.y)/2, (minimum.z + maximum.z)/2);
    const span = Math.max(maximum.x-minimum.x, maximum.y-minimum.y, maximum.z-minimum.z, 300);
    camera.position.set(center.x + span*0.75, center.y - span, center.z + span*0.85);
    camera.lookAt(center);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x44646b, 2.3));
    const sun = new THREE.DirectionalLight(0xffffff, 2.1);
    sun.position.set(center.x+span/2,center.y-span/3,center.z+span);
    scene.add(sun);
    const grid = new THREE.GridHelper(span*1.5, 20, 0x436266, 0x29454a);
    grid.rotation.x = Math.PI/2;
    grid.position.set(center.x, center.y, Math.min(0,minimum.z)-3);
    scene.add(grid);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.enableDamping = true;
    controls.update();
    // Owned and printed pieces keep the Build step's colours; other routes are dimmed.
    const trackMaterial = (color: number) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.08, side: THREE.DoubleSide });
    const materials = { owned: trackMaterial(0xa9d788), printed: trackMaterial(0xe7a871), fast: trackMaterial(FAST_PRINT_COLOR), other: trackMaterial(0x7d918c) };
    // Fast-print pieces are the ones whose printed instance carries `lite`.
    const fastSections = new Set(fit.sections.filter(section => fit.partInstances.some(instance => instance.parameters.lite === 1 &&
      (instance.sectionId === section.id || instance.id === section.pieceId))).map(section => section.id));
    const connectors = standardTrack ? {
      standard: [connectorGeometry(0), connectorGeometry(1)] as const,
      flex: [connectorGeometry(0, true), connectorGeometry(1, true)] as const,
      narrow: [connectorGeometry(0, false, true), connectorGeometry(1, false, true)] as const
    } : null;
    const sectionGroups = new Map<string, THREE.Group>();
    const sectionMaterial = (section: Section) => section.routeId !== frame.routeId ? materials.other :
      FAMILIES.find(family => family.id === section.family)?.source === 'owned' ? materials.owned : fastSections.has(section.id) ? materials.fast : materials.printed;
    for (const section of fit.sections) {
      // A moving deck is drawn only where it is lined up now.
      if (section.kind === 'unresolved' || section.moving && section.enabled === false) continue;
      const lite = fastSections.has(section.id);
      const material = sectionMaterial(section);
      const group = new THREE.Group();
      if (connectors) addStandardTrack(group, section, material, connectors, lite, partStations(fit.partInstances, section.id));
      else {
        const curve = new THREE.CatmullRomCurve3(sectionSamples(section, 20).map(pose => new THREE.Vector3(pose.x, pose.y, pose.z)));
        group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(8, Math.ceil(section.run/12)), 1.3, 6, false), material));
      }
      sectionGroups.set(section.id, group);
      scene.add(group);
    }
    if (project && standardTrack) for (const route of project.routes) for (const piece of route.pieces)
      for (const { geometry, color } of scenicDecor(piece, project))
        scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.75, side: THREE.DoubleSide })));
    const supportMaterial = new THREE.MeshStandardMaterial({ color: 0x7e9da3, roughness: 0.72, metalness: 0.12 });
    for (const support of fit.supports) {
      if (support.height <= 0) continue;
      const ground = support.ground ?? 0;
      if (support.family === 'layout_riser') {
        const riser = new THREE.Mesh(new THREE.BoxGeometry(32, 64, support.height), supportMaterial);
        riser.position.set(support.pose.x, support.pose.y, ground + support.height/2);
        riser.rotation.z = support.pose.heading;
        scene.add(riser);
        continue;
      }
      const column = new THREE.Mesh(new THREE.BoxGeometry(13, 13, support.height), supportMaterial);
      column.position.set(support.pose.x, support.pose.y, ground + support.height/2);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(30, 30, 5), supportMaterial);
      foot.position.set(support.pose.x, support.pose.y, ground - 2.5);
      scene.add(column, foot);
    }
    for (const geometry of ownSupportGeometries(fit.partInstances)) scene.add(new THREE.Mesh(geometry, supportMaterial));
    // Cars ride the rail tops (a monorail car the beam top); custom-joiner routes are drawn at their path height.
    const trainView = createTrainView(frame.cars.map(placed => placed.car),
      car => car.gauge === 'monorail' && standardTrack ? MONORAIL_BEAM_TOP : railTop, () => invalidateRef.current());
    trainView.place(frame);
    scene.add(trainView.group);
    train.current = trainView;

    let cancelled = false;
    let animation = 0;
    const render = () => { animation = 0; controls.update(); renderer.render(scene, camera); };
    const invalidate = () => { if (!cancelled && !animation) animation = requestAnimationFrame(render); };
    invalidateRef.current = invalidate;
    controls.addEventListener('change', invalidate);
    const current = fit.partInstances.filter(instance => instance.source === 'printed');
    // A community piece (its section is the piece) draws its uploaded mesh in place of its track once downloaded, as in Build.
    const communityShown = new Set<string>();
    const showCommunityMeshes = () => {
      for (const piece of project?.routes.flatMap(route => route.pieces) ?? []) {
        const definition = findPieceDefinition(piece.family), mesh = definition && communityMesh(definition);
        const section = fit.sections.find(item => item.id === piece.id), preview = sectionGroups.get(piece.id);
        if (mesh?.state !== 'loaded' || !section || !preview?.visible || communityShown.has(piece.id)) continue;
        const object = new THREE.Mesh(mesh.geometry, sectionMaterial(section));
        object.applyMatrix4(communityMeshMatrix(piece, definition!));
        object.userData.pieceId = piece.id;
        scene.add(object);
        preview.visible = false;
        communityShown.add(piece.id);
      }
      invalidate();
    };
    showCommunityMeshes();
    const stopCommunityMeshes = onCommunityMeshChange(showCommunityMeshes);
    const verified = meshes.filter(mesh=>current.some(instance=>currentInspectionMesh(fit,instance,mesh)));
    const stlLoader = new STLLoader();
    const loaded = new Map<string, Promise<THREE.BufferGeometry>>();
    // A printed part whose mesh loads replaces its preview geometry; a failed load keeps the preview.
    for (const receipt of verified) {
      void (async () => {
        try {
          const key = `${receipt.url}:${receipt.digest}`;
          let geometry = loaded.get(key);
          if (!geometry) {
            geometry = (async () => {
              const bytes = await (await apiFetch(receipt.url, { fallback: 'Mesh fetch failed' })).arrayBuffer();
              const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2,'0')).join('');
              if (digest !== receipt.digest) throw new Error('Mesh digest does not match the current receipt');
              return stlLoader.parse(bytes);
            })();
            loaded.set(key, geometry);
          }
          const shape = await geometry;
          if (cancelled) { shape.dispose(); return; }
          const section = fit.sections.find(item => item.id === receipt.sectionId);
          const object = new THREE.Mesh(shape, section?.routeId === frame.routeId ? materials.printed : materials.other);
          object.position.set(receipt.pose.x, receipt.pose.y, receipt.pose.z);
          object.rotation.set(0, receipt.interfaceKind === 'connector' ? -receipt.pose.pitch : 0,
            receipt.pose.heading, 'ZYX');
          scene.add(object);
          const preview = sectionGroups.get(receipt.sectionId);
          if (preview) preview.visible = false;
          invalidate();
        } catch (error) { console.warn('Printed-part mesh not shown:', error); }
      })();
    }
    const resize = new ResizeObserver(() => {
      const width = element.clientWidth, height = element.clientHeight;
      if (!width || !height) return;
      camera.aspect = width/height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      invalidate();
    });
    resize.observe(element);
    invalidate();
    return () => {
      cancelled = true;
      cancelAnimationFrame(animation);
      invalidateRef.current = () => {};
      stopCommunityMeshes();
      controls.removeEventListener('change', invalidate);
      resize.disconnect();
      controls.dispose();
      // Car models are shared between views: the train view releases its own.
      trainView.dispose();
      train.current = null;
      const geometries = new Set<THREE.BufferGeometry>(connectors ? Object.values(connectors).flat() : []);
      scene.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
      });
      for (const material of Object.values(materials)) material.dispose();
      // A community piece's mesh is shared by every view and stays.
      for (const geometry of geometries) if (!geometry.userData.libraryMesh) geometry.dispose();
      renderer.dispose();
      element.removeChild(renderer.domElement);
    };
  }, [fit, meshes, standardTrack, project, frame.routeId, frame.cars.map(car => car.car.id).join('|'), railTop]);

  useEffect(() => {
    train.current?.place(frame);
    invalidateRef.current();
  }, [frame]);

  return <div className="drive-view"><div ref={host} className="drive-canvas" role="img" aria-label="Orbitable 3D preview of fitted routes, supports and complete train" />
    {sceneError ? <div className="drive-mesh-status" role="status">{sceneError}</div> : project && <CommunityMeshHint project={project} className="drive-mesh-status"/>}</div>;
}
