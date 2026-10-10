import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { furnitureType } from '../domain/furniture';
import type { Furniture, RoutePiece, WorkshopProject } from '../domain/project';
import { pieceIsFast } from '../domain/printer';
import { BRICK_TRACK, railDimension } from '../domain/track';
import { gaugeLayout } from '../domain/gauges';
import { physicalPaths, pieceDefinition, piecePaths, placePoint, type Gauge, type ShapePath } from '../domain/pieces';
import { mechanismFootprints } from '../domain/track-footprints';
import type { FitResult } from '../fitting/fit';
import { unoccupiedPiecePorts, type BuilderPort } from './operations';
import type { CheckBounds, CheckTargets } from './checks';
import { FAST_PRINT_COLOR, braceGeometry, connectorCentre, connectorGeometry, connectorPorts, curveTieLayout, partStations, partUndersides, sectionGeometry, splitPath, stringerSection, tieGeometry, wedgeGeometry, type PreviewPose, type TieLayout } from './track-preview';
import { ownSupportGeometries } from './own-support-preview';
import { scenicDecor } from './scenic-preview';
import { MONORAIL_BEAM_TOP, addMonorailBeam } from './monorail-visual';
import { CommunityMeshHint, communityMesh, communityMeshMatrix, useCommunityMeshes } from './community-mesh';
import { trainGauge } from '../drive/compat';
import { placeConsist, startingLeadDistance } from '../drive/train';
import { createTrainView } from '../drive/train-models';
import { routePath } from '../drive/traversal';
import { VIEW_MOTION_MS, easeInOut } from './view-motion';
import './builder-scene.css';

type Point = { x: number; y: number };
type Pose = PreviewPose;
export interface BuilderSceneHandle {
  projectPointer(clientX: number, clientY: number): Point | null;
  /** Where a world point (mm) appears on screen, in client pixels; null behind the camera. */
  projectToScreen(point: { x: number; y: number; z: number }): Point | null;
  frame(mode: 'track' | 'room'): void;
  /** Look at a box (a selected check's targets), no closer than a few pieces' span. */
  frameBounds(bounds: CheckBounds): void;
  zoom(factor: number): void;
}
export interface BuilderSceneProps {
  project: WorkshopProject;
  fit: FitResult;
  selectedId: string | null;
  selectedFurnitureId: string | null;
  /** The selected check's pieces, supports and points, drawn as a glow through everything else. */
  highlight: CheckTargets | null;
  armedFurniture: boolean;
  previewFurniture: Furniture | null;
  /** Ghost pieces: the armed piece, or the dragged route where it would land. */
  preview: readonly RoutePiece[];
  /** Open port the preview snaps onto. */
  snapTarget: BuilderPort | null;
  armed: boolean;
  /** Heights to show over points (open ends while a climb kit is armed): small labels that always face the camera. */
  heightLabels?: readonly { x: number; y: number; z: number; text: string }[];
  onHover: (point: Point | null) => void;
  /** Where the dragged piece or shelf origin would land; null when the drag ends. */
  onDrag: (drag: { kind: 'track' | 'furniture'; id: string; origin: Point } | null) => void;
  onDeselect: () => void;
  onPlace: (point: Point) => void;
  onSelect: (id: string) => void;
  onMove: (id: string, point: Point) => void;
  onFurniturePlace: (point: Point) => void;
  onFurnitureSelect: (id: string) => void;
  onFurnitureMove: (id: string, point: Point) => void;
}

interface SceneState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  raycaster: THREE.Raycaster;
  plane: THREE.Plane;
  canvas: HTMLCanvasElement;
  model: THREE.Group | null;
  previewModel: THREE.Group | null;
  highlightModel: THREE.Group | null;
  pickables: THREE.Object3D[];
  focusedOnTrack: boolean;
  focusedOnFurniture: boolean;
  /** A programmatic camera move in progress (fit, framing, zoom buttons); the user's own orbit or wheel stops it. */
  tween: { fromPosition: THREE.Vector3; fromTarget: THREE.Vector3; toPosition: THREE.Vector3; toTarget: THREE.Vector3; start: number } | null;
  invalidate: () => void;
  projectPointer: (x: number, y: number) => Point | null;
  dispose: () => void;
}

// When dimensions have not been entered, these are illustrative brick-scale planning values.
const dimension = (value: number | null | undefined, fallback: number) => value != null && value > 0 ? value : fallback;
const pointOnPiece = (project: WorkshopProject, piece: RoutePiece, t: number): Pose => {
  const definition = pieceDefinition(piece.family);
  if (piece.sweep !== undefined) {
    const radius = definition.radius!, side = Math.sign(piece.sweep);
    const heading = piece.heading + piece.sweep * t;
    return { x: piece.x + side * radius * (Math.sin(heading) - Math.sin(piece.heading)),
      y: piece.y + side * radius * (Math.cos(piece.heading) - Math.cos(heading)), z: piece.z, heading };
  }
  const run = definition.run(piece, project);
  return { x: piece.x + run * t * Math.cos(piece.heading), y: piece.y + run * t * Math.sin(piece.heading),
    z: piece.z + (piece.rise ?? 0) * (3 * t * t - 2 * t * t * t), heading: piece.heading,
    pitch: Math.atan((piece.rise ?? 0) * 6 * t * (1-t) / run) };
};
/** Fit the track, not the room, so a single nominal piece stays inspectable. */
function trackFrame(project: WorkshopProject): { center: THREE.Vector3; span: number } | null {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const include = (at: Pose) => {
    minX = Math.min(minX, at.x); maxX = Math.max(maxX, at.x);
    minY = Math.min(minY, at.y); maxY = Math.max(maxY, at.y);
    minZ = Math.min(minZ, at.z); maxZ = Math.max(maxZ, at.z);
  };
  for (const route of project.routes) for (const piece of route.pieces) {
    const definition = pieceDefinition(piece.family);
    if (definition.body !== 'rail') {
      for (const path of piecePaths(piece, project)) for (const point of path.points) include(point);
      continue;
    }
    const run = definition.run(piece, project);
    const count = piece.sweep === undefined ? 2 : Math.max(8, Math.ceil(run / 24));
    for (let i = 0; i <= count; i++) include(pointOnPiece(project, piece, i / count));
  }
  if (minX === Infinity) return null;
  return { center: new THREE.Vector3((minX + maxX)/2, (minY + maxY)/2, (minZ + maxZ)/2),
    span: Math.max(500, (maxX - minX) * 1.2, (maxY - minY) * 1.2, (maxZ - minZ) * 4) };
}

/** The tallest piece of furniture in the room (mm), 0 with none. */
const tallest = (furniture: readonly Furniture[]) => Math.max(0, ...furniture.map(item => furnitureType(item.family).height));

/** When no track exists, frame the full height of the placed furniture rather than the empty floor. */
function furnitureFrame(furniture: Furniture[]): { center: THREE.Vector3; span: number; elevation: number; side: number; forward: number } | null {
  if (!furniture.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const item of furniture) {
    const { width, depth } = furnitureType(item.family);
    const halfX = (item.quarterTurns % 2 ? depth : width) / 2;
    const halfY = (item.quarterTurns % 2 ? width : depth) / 2;
    minX = Math.min(minX, item.x - halfX); maxX = Math.max(maxX, item.x + halfX);
    minY = Math.min(minY, item.y - halfY); maxY = Math.max(maxY, item.y + halfY);
  }
  const height = tallest(furniture);
  return { center: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, height / 2),
    span: Math.max(500, (maxX - minX) * 1.2, (maxY - minY) * 1.2, height * 1.9),
    elevation: 0.3, side: furniture[0].quarterTurns % 2 ? 0.95 : 0.22,
    forward: furniture[0].quarterTurns % 2 ? 0.22 : 0.95 };
}

/** Eases the camera to `position`, looking at `target`, over `VIEW_MOTION_MS` (at once when the user prefers reduced motion). */
function moveCamera(live: SceneState, position: THREE.Vector3, target: THREE.Vector3) {
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) {
    live.tween = null;
    live.camera.position.copy(position);
    live.controls.target.copy(target);
    live.controls.update();
  } else live.tween = { fromPosition: live.camera.position.clone(), fromTarget: live.controls.target.clone(), toPosition: position, toTarget: target, start: performance.now() };
  live.invalidate();
}

function focusScene(live: SceneState, frame: { center: THREE.Vector3; span: number; elevation?: number; side?: number; forward?: number }) {
  moveCamera(live, new THREE.Vector3(frame.center.x + frame.span * (frame.side ?? 0.68),
    frame.center.y - frame.span * (frame.forward ?? 0.95), frame.center.z + frame.span * (frame.elevation ?? 0.82)), frame.center.clone());
}

/** Disposes what the group drew; a community piece's mesh is shared by every view and stays. */
function disposeGroup(group: THREE.Group) {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  group.traverse(object => {
    if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Line)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  geometries.forEach(geometry => { if (!geometry.userData.libraryMesh) geometry.dispose(); });
  materials.forEach(material => material.dispose());
  group.clear();
}

function box(group: THREE.Group, size: [number, number, number], center: [number, number, number], color: number,
  opacity = 1): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshStandardMaterial({
    color, metalness: 0.12, roughness: 0.72, transparent: opacity < 1, opacity, depthWrite: opacity === 1
  }));
  mesh.position.set(...center);
  mesh.receiveShadow = true;
  mesh.castShadow = size[2] > 2;
  group.add(mesh);
  return mesh;
}

/**
 * A piece of furniture as its type's panels (a KALLAX: outer shell, four shelves and twenty dividers forming 25
 * open-through bays), in its colour; a placeholder for an unknown family is a see-through box of its outline.
 */
function addFurniture(group: THREE.Group, furniture: Furniture, pickables: THREE.Object3D[] | null,
  options: { ghost?: boolean; selected?: boolean } = {}) {
  const type = furnitureType(furniture.family);
  const boxes = type.panels.length ? type.panels : [{ x: 0, y: 0, z: type.height / 2, width: type.width, depth: type.depth, height: type.height }];
  const seeThrough = !!options.ghost || !type.panels.length;
  const panels = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({
      color: options.selected ? 0xb8efaf : options.ghost ? 0xb6e6d9 : type.colour,
      emissive: options.selected ? 0x355729 : 0x000000,
      roughness: 0.72, transparent: seeThrough,
      opacity: seeThrough ? 0.5 : 1, depthWrite: !seeThrough
    }), boxes.length);
  const transform = new THREE.Object3D();
  boxes.forEach(({ x, y, z, width, depth, height }, index) => {
    transform.position.set(x, y, z);
    transform.scale.set(width, depth, height);
    transform.updateMatrix();
    panels.setMatrixAt(index, transform.matrix);
  });
  panels.instanceMatrix.needsUpdate = true;
  panels.castShadow = !options.ghost;
  panels.receiveShadow = !options.ghost;
  if (!options.ghost && pickables) {
    panels.userData.furnitureId = furniture.id;
    pickables.push(panels);
  }
  const placement = new THREE.Group();
  placement.position.set(furniture.x, furniture.y, 0);
  placement.rotation.z = furniture.quarterTurns * Math.PI / 2;
  placement.add(panels);
  group.add(placement);
}

// Keep eight side triangles per span and just two end caps; interiors have no visible caps.
const stripFaces = [2,3,7, 2,7,6, 0,2,6, 0,6,4, 1,5,7, 1,7,3, 0,4,5, 0,5,1];
function strip(points: Pose[], offset: number, width: number, bottom: number, top: number): THREE.BufferGeometry {
  const vertices = new Float32Array(points.length * 12);
  const indices = new Uint32Array((points.length - 1) * 24 + 12);
  for (let i = 0; i < points.length; i++) {
    const { x, y, z, heading } = points[i];
    const sine = Math.sin(heading), cosine = Math.cos(heading);
    const leftX = x - sine * (offset - width/2), leftY = y + cosine * (offset - width/2);
    const rightX = x - sine * (offset + width/2), rightY = y + cosine * (offset + width/2);
    const base = i * 12;
    vertices[base] = leftX; vertices[base+1] = leftY; vertices[base+2] = z+bottom;
    vertices[base+3] = rightX; vertices[base+4] = rightY; vertices[base+5] = z+bottom;
    vertices[base+6] = leftX; vertices[base+7] = leftY; vertices[base+8] = z+top;
    vertices[base+9] = rightX; vertices[base+10] = rightY; vertices[base+11] = z+top;
    if (i) for (let face = 0; face < stripFaces.length; face++)
      indices[(i-1)*stripFaces.length+face] = (i-1)*4 + stripFaces[face];
  }
  const cap = (points.length - 1) * 24, end = (points.length - 1) * 4;
  indices[cap] = 2; indices[cap+1] = 3; indices[cap+2] = 1;
  indices[cap+3] = 2; indices[cap+4] = 1; indices[cap+5] = 0;
  indices[cap+6] = end; indices[cap+7] = end+1; indices[cap+8] = end+3;
  indices[cap+9] = end; indices[cap+10] = end+3; indices[cap+11] = end+2;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

// One A/B buffer pair per scene group and end variant; each preserves its accepted contact geometry.
type ConnectorPair = [THREE.BufferGeometry, THREE.BufferGeometry];
const groupConnectors = new WeakMap<THREE.Group, Partial<Record<'standard' | 'flex' | 'narrow', ConnectorPair>>>();

/** `gauge`: the path's track gauge (absent = standard); its layout sets rails, stringers, ties, braces and ends. `base`: the printed
 * part's flat underside, where a graded part's wedge reaches down to. */
type StandardTrackOptions = { ghost?: boolean; selected?: boolean; unresolved?: boolean; owned?: boolean; tieLayout?: TieLayout; flex?: boolean; lite?: boolean; ramp?: boolean; gauge?: Gauge; base?: number };
/** A piece body's material: its colour, or the selection or unresolved colour; a ghost is translucent. */
function bodyMaterial(color: number, options: StandardTrackOptions): THREE.MeshStandardMaterial {
  const opacity = options.ghost ? 0.55 : 1;
  return new THREE.MeshStandardMaterial({
    color: options.unresolved ? 0xc07772 : options.selected ? 0xc3ee8d : color,
    roughness: options.owned ? 0.85 : 0.64, metalness: 0.08, side: THREE.DoubleSide,
    transparent: opacity < 1, opacity, depthWrite: opacity === 1
  });
}
/** `lite`: fast print draws gauge braces instead of full ties; rails, rail supports and end ties are unchanged. */
function createStandardTrack(group: THREE.Group, samples: Pose[], length: number, color: number, id: string | null,
  pickables: THREE.Object3D[], options: StandardTrackOptions) {
  const points = connectorCentre(samples, length), across = gaugeLayout(options.gauge);
  const material = bodyMaterial(color, options);
  const add = (geometry: THREE.BufferGeometry) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.castShadow = !options.ghost;
    group.add(mesh);
    if (id) { mesh.userData.pieceId = id; pickables.push(mesh); }
    return mesh;
  };
  if (options.gauge === 'monorail') return addMonorailBeam(samples, add);
  const ties = options.lite ? braceGeometry(points, length, options.tieLayout, options.ramp, across) : tieGeometry(points, length, options.tieLayout, across);
  if (ties) add(ties);
  for (const stringer of across.stringers) add(sectionGeometry(points, stringerSection(stringer)));
  for (const rail of across.rails) add(sectionGeometry(points, BRICK_TRACK.railSection, rail));
  if (options.base !== undefined && samples.some(sample => sample.z - options.base! > 0.05)) add(wedgeGeometry(samples, options.base, across.bodyWidth / 2));
  const variant = across.narrowEnds ? 'narrow' : options.flex ? 'flex' : 'standard', cache = groupConnectors.get(group) ?? {};
  groupConnectors.set(group, cache);
  const geometries = cache[variant] ??= [connectorGeometry(0, options.flex, across.narrowEnds), connectorGeometry(1, options.flex, across.narrowEnds)];
  for (const [index, port] of connectorPorts(samples).entries()) {
    const mesh = add(geometries[index]);
    mesh.position.set(port.x, port.y, port.z);
    mesh.rotation.set(0, -(port.pitch ?? 0), port.heading, 'ZYX');
  }
}

function createTrack(group: THREE.Group, samples: Pose[], length: number, profile: {
  gauge: number; railWidth: number; bedWidth: number; bedDepth: number; railHeight: number;
}, color: number, id: string | null, pickables: THREE.Object3D[], options: StandardTrackOptions & { bridge?: boolean; standard?: boolean } = {}) {
  if (samples.length < 2) return;
  if (options.standard) {
    createStandardTrack(group, samples, length, color, id, pickables, options);
    return;
  }
  const { gauge, railWidth, bedWidth, bedDepth, railHeight } = profile;
  const opacity = options.ghost ? 0.55 : 1;
  const bedColor = options.unresolved ? 0x914f52 : options.selected ? 0x80ac78 : 0x263333;
  const bed = new THREE.Mesh(strip(samples, 0, bedWidth, -bedDepth, -1),
    new THREE.MeshStandardMaterial({ color: bedColor, roughness: 0.82, side: THREE.DoubleSide, transparent: opacity < 1, opacity, depthWrite: opacity === 1 }));
  bed.receiveShadow = true;
  bed.castShadow = !options.ghost;
  group.add(bed);
  if (id) { bed.userData.pieceId = id; pickables.push(bed); }
  const sleepers = Math.max(1, Math.floor(length / 24));
  const sleeperGeometry = new THREE.BoxGeometry(10, bedWidth + 5, Math.max(2, bedDepth * 0.45));
  const sleeperMaterial = new THREE.MeshStandardMaterial({ color: options.unresolved ? 0xc07772 : 0x6e7771, roughness: 0.88,
    transparent: opacity < 1, opacity, depthWrite: opacity === 1 });
  const ties = new THREE.InstancedMesh(sleeperGeometry, sleeperMaterial, sleepers);
  const transform = new THREE.Object3D();
  for (let i = 0; i < sleepers; i++) {
    const t = (i + 0.5) / sleepers;
    const at = samples[Math.min(samples.length - 1, Math.round(t * (samples.length - 1)))];
    transform.position.set(at.x, at.y, at.z - bedDepth * 0.34);
    transform.rotation.set(0, 0, at.heading);
    transform.updateMatrix();
    ties.setMatrixAt(i, transform.matrix);
  }
  ties.instanceMatrix.needsUpdate = true;
  group.add(ties);
  if (id) { ties.userData.pieceId = id; pickables.push(ties); }
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(strip(samples, side * gauge / 2, railWidth, 0, railHeight),
      new THREE.MeshStandardMaterial({ color: options.unresolved ? 0xf07a72 : options.ghost ? 0xbcefa2 : 0xc4ccc2,
        metalness: 0.56, roughness: 0.32, side: THREE.DoubleSide, transparent: opacity < 1, opacity, depthWrite: opacity === 1 }));
    rail.castShadow = !options.ghost;
    rail.receiveShadow = true;
    group.add(rail);
    if (id) { rail.userData.pieceId = id; pickables.push(rail); }
  }
  // Family-coloured edge bands make the section boundaries and ramp/bridge identity legible at room scale.
  for (const side of [-1, 1]) group.add(new THREE.Mesh(
    strip(samples, side * (bedWidth / 2 - 2.5), 4, -1.3, 0),
    new THREE.MeshStandardMaterial({ color: options.unresolved ? 0xec7470 : options.selected ? 0xc3ee8d : color,
      side: THREE.DoubleSide, emissive: options.selected || options.ghost ? 0x314421 : 0x000000,
      transparent: opacity < 1, opacity, depthWrite: opacity === 1 })));
  if (options.bridge) {
    const underside = new THREE.Mesh(strip(samples, 0, bedWidth + 8, -bedDepth - 5, -bedDepth),
      new THREE.MeshStandardMaterial({ color: 0x9c7859, side: THREE.DoubleSide, metalness: 0.18 }));
    underside.castShadow = true;
    group.add(underside);
  }
}

/**
 * Every physical path of the piece; open-port rings are drawn separately. `cuts`: a composite piece's bed-part stations;
 * `bases`: each part's flat underside (a graded part prints as a wedge down to it).
 */
function createPieceTrack(group: THREE.Group, project: WorkshopProject, piece: RoutePiece,
  profile: Parameters<typeof createTrack>[3], pickables: THREE.Object3D[],
  { cuts = [], bases = [], ...options }: { ghost?: boolean; selected?: boolean; unresolved?: boolean; cuts?: readonly number[]; bases?: readonly number[] } = {}) {
  const id = options.ghost ? null : piece.id, lite = pieceIsFast(project, piece), definition = pieceDefinition(piece.family);
  const color = lite ? FAST_PRINT_COLOR : definition.color;
  const pointsLength = (points: readonly Pose[]) => points.slice(1).reduce((sum, point, index) =>
    sum + Math.hypot(point.x-points[index].x, point.y-points[index].y), 0);
  const pathLength = (path: ShapePath) => pointsLength(path.points);
  // A placed community piece draws its uploaded mesh once downloaded; a ghost, and the piece until then, generic track.
  const uploaded = options.ghost ? null : communityMesh(definition);
  if (uploaded?.state === 'loaded') {
    const mesh = new THREE.Mesh(uploaded.geometry, bodyMaterial(color, options));
    mesh.applyMatrix4(communityMeshMatrix(piece, definition));
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.pieceId = piece.id;
    pickables.push(mesh);
    group.add(mesh);
  } else if (definition.body === 'path') {
    for (const path of piecePaths(piece, project)) splitPath(path.points, cuts).forEach((points, part) =>
      createTrack(group, points, pointsLength(points), profile, color, id, pickables,
        { ...options, standard: true, owned: definition.source === 'owned', lite, gauge: path.gauge, base: bases[part] }));
  } else if (definition.body === 'assembly') {
    if(options.selected) for(const footprint of mechanismFootprints(piece, project)) {
      const points=footprint.polygon.map(point=>new THREE.Vector3(point.x,point.y,piece.z+1));
      const line=new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineDashedMaterial({color:0xffc18a,dashSize:7,gapSize:6,depthTest:false}));
      line.computeLineDistances();line.renderOrder=3;group.add(line);
    }
    // Fixed body (turntable pit, transfer-table well): a slab under the moving deck's ties.
    for (const outline of definition.outline?.(piece, project) ?? []) {
      const shape = new THREE.Shape(outline.map(point => new THREE.Vector2(point.x, point.y)));
      const slab = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: BRICK_TRACK.baseThickness, bevelEnabled: false }),
        new THREE.MeshStandardMaterial({ color: options.unresolved ? 0xc07772 : options.selected ? 0x9fcf86 : 0x4d5d58,
          roughness: 0.9, transparent: options.ghost, opacity: options.ghost ? 0.55 : 1 }));
      slab.position.set(piece.x, piece.y, piece.z - BRICK_TRACK.baseThickness);
      slab.rotation.z = piece.heading;
      slab.receiveShadow = true;
      group.add(slab);
      if (id) { slab.userData.pieceId = id; pickables.push(slab); }
    }
    for (const points of definition.fixedTrack?.(piece, project) ?? []) {
      const placed = points.map(point => placePoint(piece, point));
      createTrack(group, placed, pointsLength(placed), profile, color, id, pickables, { ...options, standard: true, owned: false, lite });
    }
    const paths = piecePaths(piece, project);
    for (const path of physicalPaths(paths)) createTrack(group, path.points, pathLength(path), profile, color, id, pickables,
      { ...options, standard: true, owned: definition.source === 'owned', flex: definition.flexEnds, lite, gauge: path.gauge });
    // A moving deck's other positions show only on the selected piece.
    for (const path of paths.filter(item => !item.moving || item.enabled || options.selected)) {
      const geometry = new THREE.BufferGeometry().setFromPoints(path.points.map(point =>
        new THREE.Vector3(point.x, point.y, point.z + BRICK_TRACK.railTop + 2)));
      const material = path.enabled ? new THREE.LineBasicMaterial({ color: 0x73e3e8, depthTest: false }) :
        new THREE.LineDashedMaterial({ color: 0xffc18a, dashSize: 7, gapSize: 6, depthTest: false });
      const line = new THREE.Line(geometry, material);
      line.computeLineDistances();
      line.renderOrder = 3;
      group.add(line);
    }
  } else {
    const length = definition.run(piece, project);
    const count = Math.max(2, Math.ceil(length / 12));
    createTrack(group, Array.from({ length: count + 1 }, (_, i) => pointOnPiece(project, piece, i / count)),
      length, profile, color, id, pickables,
      { ...options, bridge: definition.deck, standard: project.trackSystem === 'brick-v1',
        owned: definition.source === 'owned', lite, ramp: definition.legacy?.rise !== undefined,
        tieLayout: piece.sweep === undefined ? 'modular' : curveTieLayout(definition.radius!, piece.sweep) });
  }
  const opacity = options.ghost ? 0.55 : 1;
  for (const { geometry, color: decorColor } of scenicDecor(piece, project)) {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: options.unresolved ? 0xc07772 : options.selected ? 0xc3ee8d : decorColor, roughness: 0.8,
      side: THREE.DoubleSide, transparent: opacity < 1, opacity, depthWrite: opacity === 1 }));
    mesh.castShadow = !options.ghost;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (id) { mesh.userData.pieceId = id; pickables.push(mesh); }
  }
}

function portMarker(group: THREE.Group, at: Pose, color: number, radius = 12) {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 2.5, 6, 16),
    new THREE.MeshBasicMaterial({ color, depthTest: false }));
  ring.position.set(at.x, at.y, at.z + 3);
  ring.renderOrder = 2;
  group.add(ring);
}

function populateModel(group: THREE.Group, project: WorkshopProject, fit: FitResult,
  selectedId: string | null, selectedFurnitureId: string | null, pickables: THREE.Object3D[]) {
  const width = dimension(project.measurements.roomWidth.value, 2400);
  const depth = dimension(project.measurements.roomDepth.value, 2100);
  const gauge = dimension(railDimension(project, 'railGauge'), 37.5);
  const railWidth = dimension(railDimension(project, 'railInterfaceWidth'), 5);
  const bedWidth = Math.max(gauge + railWidth * 2 + 8, dimension(railDimension(project, 'railBodyWidth'), 60));
  const bedDepth = dimension(railDimension(project, 'railBaseThickness'), 5);
  const railHeight = dimension(railDimension(project, 'railHeight'), 8);
  const profile = { gauge, railWidth, bedWidth, bedDepth, railHeight };
  const floor = new THREE.Group();
  group.add(floor);
  group.userData.floor = floor;
  box(floor, [width, depth, 12], [width/2, depth/2, -12], 0x26393a);
  const rim = box(floor, [width+12, depth+12, 7], [width/2, depth/2, -21], 0x577370);
  rim.receiveShadow = false;
  for (const furniture of project.furniture) {
    addFurniture(group, furniture, pickables, { selected: furniture.id === selectedFurnitureId });
  }
  const unresolvedPieces = new Set(fit.sections.filter(section => section.kind === 'unresolved').map(section => section.pieceId ?? section.id));
  for (const route of project.routes) for (const piece of route.pieces) {
    const current = fit.layoutRevision === project.layoutRevision;
    createPieceTrack(group, project, piece, profile, pickables,
      { selected: selectedId === piece.id, unresolved: unresolvedPieces.has(piece.id),
        cuts: current ? partStations(fit.partInstances, piece.id) : [], bases: current ? partUndersides(fit.partInstances, piece.id) : [] });
  }
  // A support's seat is under the track at its pose: standard brick track's datum is its underside, custom-joiner track's
  // bed hangs `bedDepth` below its datum. Columns carry their seat plate, turned and tilted with the track's underside there.
  const seatDrop = project.trackSystem === 'brick-v1' ? 0 : bedDepth;
  const design = (key: string, fallback: number) => Number.isFinite(project.partDesign[key]) && project.partDesign[key] > 0 ? project.partDesign[key] : fallback;
  const seatThickness = design('seat_thickness', 4);
  for (const support of fit.supports) {
    const ground = support.ground ?? 0, top = support.pose.z - seatDrop, height = top - ground;
    if (height <= 0.05) continue;
    if (support.family === 'layout_riser') {
      // Riser blocks: 4 × 8 studs under a full tie, turned with the track.
      box(group, [32, 64, height], [support.pose.x, support.pose.y, ground + height/2], 0x9db6b0).rotation.z = support.pose.heading;
      continue;
    }
    // Lower than its seat plate, a column is a flat packer: only the seat-sized block.
    const plate = Math.min(seatThickness, height), stem = height - plate;
    if (stem > 0) {
      box(group, [13, 13, stem], [support.pose.x, support.pose.y, ground + stem/2], 0x7e9da3);
      box(group, [30, 30, 5], [support.pose.x, support.pose.y, ground - 2.5], 0x5f7775);
    }
    box(group, [design('seat_depth', 24), design('seat_width', 45), plate], [support.pose.x, support.pose.y, top - plate/2], 0x7e9da3)
      .rotation.set(0, support.family === 'reversible_column' ? -support.pose.pitch : 0, support.pose.heading, 'ZYX');
  }
  // Helix column tubes and wall/shelf brackets: the parts that hold self-supported track.
  const ownSupportMaterial = new THREE.MeshStandardMaterial({ color: 0x7e9da3, roughness: 0.72, metalness: 0.12 });
  for (const geometry of ownSupportGeometries(fit.layoutRevision === project.layoutRevision ? fit.partInstances : [])) {
    const mesh = new THREE.Mesh(geometry, ownSupportMaterial);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  // Rings mark only open ends: where the next piece can attach.
  for (const { port } of unoccupiedPiecePorts(project)) portMarker(group, port, 0xc3ee8d);
}

function populatePreview(group: THREE.Group, project: WorkshopProject, preview: readonly RoutePiece[], target: BuilderPort | null) {
  const gauge = dimension(railDimension(project, 'railGauge'), 37.5);
  const railWidth = dimension(railDimension(project, 'railInterfaceWidth'), 5);
  const profile = { gauge, railWidth,
    bedWidth: Math.max(gauge + railWidth * 2 + 8, dimension(railDimension(project, 'railBodyWidth'), 60)),
    bedDepth: dimension(railDimension(project, 'railBaseThickness'), 5),
    railHeight: dimension(railDimension(project, 'railHeight'), 8) };
  for (const piece of preview) createPieceTrack(group, project, piece, profile, [], { ghost: true });
  if (target) portMarker(group, target, 0xffffff, 18);
}

/** A label sprite per point: the text drawn on a canvas, about 22 cm wide in the room, seen through the track. */
function heightLabelSprites(labels: readonly { x: number; y: number; z: number; text: string }[]): THREE.Group {
  const group = new THREE.Group();
  for (const { x, y, z, text } of labels) {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 80;
    const context = canvas.getContext('2d');
    if (!context) continue;
    context.font = '700 44px "Space Grotesk", sans-serif';
    context.textAlign = 'center'; context.textBaseline = 'middle';
    context.lineWidth = 10; context.lineJoin = 'round'; context.strokeStyle = '#102322'; context.strokeText(text, 128, 40);
    context.fillStyle = '#ffd79a'; context.fillText(text, 128, 40);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    sprite.scale.set(224, 70, 1);
    sprite.position.set(x, y, z + 70);
    sprite.renderOrder = 4;
    group.add(sprite);
  }
  return group;
}

/** A selected check's targets: amber tubes along its pieces, posts at its supports and rings at its points, seen through the track. */
function populateHighlight(group: THREE.Group, project: WorkshopProject, fit: FitResult, targets: CheckTargets) {
  // Untoned, so the exposure that lights the track does not wash the amber out towards the printed track's tan.
  const material = new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, toneMapped: false });
  const add = (geometry: THREE.BufferGeometry, at?: { x: number; y: number; z: number }) => {
    const mesh = new THREE.Mesh(geometry, material);
    if (at) mesh.position.set(at.x, at.y, at.z);
    mesh.renderOrder = 3;
    group.add(mesh);
    return mesh;
  };
  const ids = new Set(targets.pieceIds);
  for (const piece of project.routes.flatMap(route => route.pieces).filter(item => ids.has(item.id)))
    for (const path of physicalPaths(piecePaths(piece, project))) {
      const points = path.points.map(point => new THREE.Vector3(point.x, point.y, point.z + 4));
      if (points.length < 2) continue;
      add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), Math.max(4, points.length * 2), 14, 8, false));
    }
  const supports = new Set(targets.supportIds ?? []);
  for (const support of fit.supports.filter(item => supports.has(item.id))) {
    const ground = support.ground ?? 0, height = Math.max(8, support.pose.z - ground);
    add(new THREE.CylinderGeometry(26, 26, height, 16), { x: support.pose.x, y: support.pose.y, z: ground + height / 2 }).rotation.x = Math.PI / 2;
  }
  for (const point of targets.points ?? []) add(new THREE.TorusGeometry(30, 5, 8, 28), { x: point.x, y: point.y, z: point.z + 6 });
}

export const BuilderScene = forwardRef<BuilderSceneHandle, BuilderSceneProps>(function BuilderScene(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const state = useRef<SceneState | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const [error, setError] = useState(false);
  // A community piece's mesh that finishes loading redraws the layout with it.
  const meshes = useCommunityMeshes();
  useImperativeHandle(ref, () => ({
    projectPointer: (x, y) => state.current?.projectPointer(x, y) ?? null,
    projectToScreen: point => {
      const live = state.current;
      if (!live) return null;
      const projected = new THREE.Vector3(point.x, point.y, point.z).project(live.camera);
      if (projected.z > 1) return null;
      const bounds = live.canvas.getBoundingClientRect();
      return { x: bounds.left + (projected.x + 1) / 2 * bounds.width, y: bounds.top + (1 - projected.y) / 2 * bounds.height };
    },
    frame: mode => {
      const live = state.current;
      if (!live) return;
      const project = callbacks.current.project;
      const frame = mode === 'track' ? trackFrame(project) : {
        center: new THREE.Vector3(dimension(project.measurements.roomWidth.value, 2400)/2,
          dimension(project.measurements.roomDepth.value, 2100)/2,
          tallest(project.furniture) / 2),
        span: Math.max(500, dimension(project.measurements.roomWidth.value, 2400),
          dimension(project.measurements.roomDepth.value, 2100),
          tallest(project.furniture) * 1.9),
        elevation: project.furniture.length ? 0.3 : 0.82,
        side: project.furniture.length && project.furniture[0].quarterTurns % 2 ? 0.95 : project.furniture.length ? 0.22 : 0.68,
        forward: project.furniture.length && project.furniture[0].quarterTurns % 2 ? 0.22 : 0.95
      };
      if (frame) focusScene(live, frame);
    },
    frameBounds: ({ min, max }) => {
      const live = state.current;
      if (!live) return;
      const center = new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
      const span = Math.max(450, (max.x - min.x) * 1.3, (max.y - min.y) * 1.3, (max.z - min.z) * 2);
      // Keep the user's viewing direction; only the distance and target change.
      const offset = live.camera.position.clone().sub(live.controls.target).setLength(span * 1.43);
      moveCamera(live, center.clone().add(offset), center);
    },
    zoom: factor => {
      const live = state.current;
      if (!live) return;
      const target = live.tween?.toTarget ?? live.controls.target, position = live.tween?.toPosition ?? live.camera.position;
      const distance = Math.max(live.controls.minDistance,
        Math.min(live.controls.maxDistance, position.distanceTo(target)*factor));
      moveCamera(live, position.clone().sub(target).setLength(distance).add(target), target.clone());
    }
  }), []);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
    catch { setError(true); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.65;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.tabIndex = 0;
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x142123);
    scene.fog = new THREE.FogExp2(0x142123, 0.00024);
    const camera = new THREE.PerspectiveCamera(48, 1, 1, 100000);
    camera.up.set(0, 0, 1);
    const width = dimension(callbacks.current.project.measurements.roomWidth.value, 2400);
    const depth = dimension(callbacks.current.project.measurements.roomDepth.value, 2100);
    const center = new THREE.Vector3(width/2, depth/2, 0);
    const span = Math.max(width, depth, 500);
    camera.position.set(center.x + span * 0.68, center.y - span * 0.95, span * 0.82);
    camera.lookAt(center);
    scene.add(new THREE.HemisphereLight(0xd7eced, 0x445250, 2.3));
    const sun = new THREE.DirectionalLight(0xffeed7, 2.3);
    sun.position.set(center.x - span * 0.3, center.y - span * 0.35, span * 0.95);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -span * 0.9;
    sun.shadow.camera.right = span * 0.9;
    sun.shadow.camera.top = span * 0.9;
    sun.shadow.camera.bottom = -span * 0.9;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = span * 2;
    sun.shadow.bias = -0.0002;
    scene.add(sun);
    const gridSize = Math.ceil(span / 100) * 100;
    const grid = new THREE.GridHelper(gridSize, gridSize / 100, 0x7a9d8b, 0x4a6b60);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(Math.round(center.x / 100) * 100, Math.round(center.y / 100) * 100, -4);
    scene.add(grid);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.minDistance = 70;
    controls.maxDistance = Math.max(span * 4, 1800);
    controls.maxPolarAngle = Math.PI * 0.95;
    controls.update();
    const raycaster = new THREE.Raycaster();
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const canvas = renderer.domElement;
    const ndc = new THREE.Vector2();
    const hit = new THREE.Vector3();
    const cursorRay = (x: number, y: number) => {
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height || x < bounds.left || y < bounds.top || x > bounds.right || y > bounds.bottom) return false;
      ndc.set((x - bounds.left) / bounds.width * 2 - 1, -(y - bounds.top) / bounds.height * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      return true;
    };
    const pointerOnFloor = (x: number, y: number): Point | null => {
      if (!cursorRay(x, y) || !raycaster.ray.intersectPlane(plane, hit)) return null;
      return { x: hit.x, y: hit.y };
    };
    const pointerOnHeight = (x: number, y: number, height: number): Point | null => {
      dragPlane.constant = -height;
      if (!cursorRay(x, y) || !raycaster.ray.intersectPlane(dragPlane, hit)) return null;
      return { x: hit.x, y: hit.y };
    };
    const projectPointer = (x: number, y: number): Point | null => {
      const point = pointerOnFloor(x, y);
      return point && point.x >= 0 && point.x <= dimension(callbacks.current.project.measurements.roomWidth.value, 2400) &&
        point.y >= 0 && point.y <= dimension(callbacks.current.project.measurements.roomDepth.value, 2100) ? point : null;
    };
    let animation = 0, disposed = false;
    const render = () => {
      animation = 0;
      const tween = live.tween;
      if (tween) {
        const t = Math.min(1, (performance.now() - tween.start) / VIEW_MOTION_MS);
        camera.position.lerpVectors(tween.fromPosition, tween.toPosition, easeInOut(t));
        controls.target.lerpVectors(tween.fromTarget, tween.toTarget, easeInOut(t));
        if (t < 1) invalidate(); else live.tween = null;
      }
      if (controls.update()) invalidate();
      const floor = live.model?.userData.floor as THREE.Group | undefined;
      if (floor) floor.visible = camera.position.z >= 0;
      // Depth cues follow view scale; a large fitted layout must not disappear into fixed-distance fog.
      (scene.fog as THREE.FogExp2).density = .5 / Math.max(camera.position.distanceTo(controls.target), 500);
      renderer.render(scene, camera);
    };
    const invalidate = () => { if (!disposed && !animation) animation = requestAnimationFrame(render); };
    const live: SceneState = { renderer, scene, camera, controls, raycaster, plane, canvas,
      model: null, previewModel: null, highlightModel: null, pickables: [], focusedOnTrack: false, focusedOnFurniture: false, tween: null,
      invalidate, projectPointer, dispose: () => {} };
    state.current = live;
    const pick = (x: number, y: number): THREE.Intersection | null =>
      cursorRay(x, y) ? raycaster.intersectObjects(live.pickables, false)[0] ?? null : null;
    let drag: { kind: 'track' | 'furniture'; id: string; startX: number; startY: number;
      origin: Point; grab: Point; height: number; moved: boolean } | null = null;
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const point = projectPointer(event.clientX, event.clientY);
      const picked = !callbacks.current.armed && !callbacks.current.armedFurniture ?
        pick(event.clientX, event.clientY) : null;
      const data = picked?.object.userData;
      const chosen = data?.furnitureId ? { kind: 'furniture' as const, id: data.furnitureId as string } :
        data?.pieceId ? { kind: 'track' as const, id: data.pieceId as string } : null;
      let origin: Point | null = null;
      let grab = point;
      if (chosen?.kind === 'furniture') {
        const furniture = callbacks.current.project.furniture.find(item => item.id === chosen.id);
        if (furniture) {
          origin = { x: furniture.x, y: furniture.y };
          grab = { x: picked!.point.x, y: picked!.point.y };
        }
      } else if (chosen?.kind === 'track' && point) {
        for (const route of callbacks.current.project.routes) {
          const piece = route.pieces?.find(item => item.id === chosen.id);
          if (piece) { origin = { x: piece.x, y: piece.y }; break; }
        }
      }
      if (chosen && origin && grab) {
        controls.enabled = false;
        drag = { kind: chosen.kind, id: chosen.id, startX: event.clientX, startY: event.clientY,
          origin, grab, height: chosen.kind === 'furniture' ? picked!.point.z : 0, moved: false };
        canvas.setPointerCapture(event.pointerId);
        event.stopPropagation();
      } else if ((callbacks.current.armed || callbacks.current.armedFurniture) && point) {
        controls.enabled = false;
        canvas.setPointerCapture(event.pointerId);
        event.stopPropagation();
      }
    };
    let press: { x: number; y: number } | null = null;
    const captureDown = (event: PointerEvent) => {
      canvas.focus({ preventScroll: true });
      if (event.button !== 0) return;
      press = { x: event.clientX, y: event.clientY };
      down(event);
    };
    const dragOrigin = (active: NonNullable<typeof drag>, x: number, y: number): Point | null => {
      const destination = active.kind === 'furniture' ? pointerOnHeight(x, y, active.height) : projectPointer(x, y);
      return destination && { x: active.origin.x + destination.x - active.grab.x, y: active.origin.y + destination.y - active.grab.y };
    };
    const move = (event: PointerEvent) => {
      const point = projectPointer(event.clientX, event.clientY);
      if (drag) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) drag.moved = true;
        canvas.style.cursor = 'grabbing';
        const origin = drag.moved ? dragOrigin(drag, event.clientX, event.clientY) : null;
        if (origin) callbacks.current.onDrag({ kind: drag.kind, id: drag.id, origin });
      } else canvas.style.cursor = callbacks.current.armed || callbacks.current.armedFurniture ?
        'crosshair' : pick(event.clientX, event.clientY) ? 'grab' : 'move';
      callbacks.current.onHover(point);
    };
    const end = (event: PointerEvent) => {
      const point = event.type === 'pointercancel' ? null : projectPointer(event.clientX, event.clientY);
      if (event.type !== 'pointercancel') {
        if (drag) {
          const next = drag.moved ? dragOrigin(drag, event.clientX, event.clientY) : null;
          if (next) {
            if (drag.kind === 'furniture') callbacks.current.onFurnitureMove(drag.id, next);
            else callbacks.current.onMove(drag.id, next);
          } else if (!drag.moved) {
            if (drag.kind === 'furniture') callbacks.current.onFurnitureSelect(drag.id);
            else callbacks.current.onSelect(drag.id);
          }
        } else if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 5) {
          if (callbacks.current.armedFurniture) { if (point) callbacks.current.onFurniturePlace(point); }
          else if (callbacks.current.armed) { if (point) callbacks.current.onPlace(point); }
          else callbacks.current.onDeselect();
        }
      }
      if (drag) callbacks.current.onDrag(null);
      drag = null;
      press = null;
      controls.enabled = true;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      invalidate();
    };
    const leave = () => { if (!drag) callbacks.current.onHover(null); };
    const resize = new ResizeObserver(() => {
      const w = element.clientWidth, h = element.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      invalidate();
    });
    canvas.addEventListener('pointerdown', captureDown, true);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', leave);
    controls.addEventListener('change', invalidate);
    const stopTween = () => { live.tween = null; };
    controls.addEventListener('start', stopTween);
    resize.observe(element);
    invalidate();
    live.dispose = () => {
      disposed = true;
      cancelAnimationFrame(animation);
      resize.disconnect();
      canvas.removeEventListener('pointerdown', captureDown, true);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', end);
      canvas.removeEventListener('pointercancel', end);
      canvas.removeEventListener('pointerleave', leave);
      controls.removeEventListener('change', invalidate);
      controls.removeEventListener('start', stopTween);
      controls.dispose();
      if (live.model) { scene.remove(live.model); disposeGroup(live.model); }
      if (live.previewModel) { scene.remove(live.previewModel); disposeGroup(live.previewModel); }
      if (live.highlightModel) { scene.remove(live.highlightModel); disposeGroup(live.highlightModel); }
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      canvas.remove();
    };
    return () => { live.dispose(); state.current = null; };
  }, []);

  useEffect(() => {
    const live = state.current;
    if (!live) return;
    if (live.model) { live.scene.remove(live.model); disposeGroup(live.model); }
    const group = new THREE.Group();
    live.model = group;
    live.pickables = [];
    populateModel(group, props.project, props.fit, props.selectedId, props.selectedFurnitureId, live.pickables);
    live.scene.add(group);
    if (!live.focusedOnTrack) {
      const frame = trackFrame(props.project);
      if (frame) {
        focusScene(live, frame);
        live.focusedOnTrack = true;
      } else if (!live.focusedOnFurniture) {
        const furniture = furnitureFrame(props.project.furniture);
        if (furniture) {
          focusScene(live, furniture);
          live.focusedOnFurniture = true;
        }
      }
    }
    if (!props.project.furniture.length) live.focusedOnFurniture = false;
    live.invalidate();
  }, [props.project, props.fit, props.selectedId, props.selectedFurnitureId, meshes]);

  useEffect(() => {
    const live = state.current;
    if (!live) return;
    if (live.previewModel) { live.scene.remove(live.previewModel); disposeGroup(live.previewModel); }
    live.previewModel = null;
    if (props.preview.length || props.snapTarget || props.previewFurniture) {
      const group = new THREE.Group();
      populatePreview(group, props.project, props.preview, props.snapTarget);
      if (props.previewFurniture) addFurniture(group, props.previewFurniture, null, { ghost: true });
      live.previewModel = group;
      live.scene.add(group);
    }
    live.invalidate();
  }, [props.project, props.preview, props.snapTarget, props.previewFurniture]);

  useEffect(() => {
    const live = state.current;
    if (!live) return;
    if (live.highlightModel) { live.scene.remove(live.highlightModel); disposeGroup(live.highlightModel); }
    live.highlightModel = null;
    if (props.highlight) {
      const group = new THREE.Group();
      populateHighlight(group, props.project, props.fit, props.highlight);
      live.highlightModel = group;
      live.scene.add(group);
    }
    live.invalidate();
  }, [props.project, props.fit, props.highlight]);

  useEffect(() => {
    const live = state.current, labels = props.heightLabels;
    if (!live || !labels?.length) return;
    const group = heightLabelSprites(labels);
    live.scene.add(group);
    live.invalidate();
    return () => {
      live.scene.remove(group);
      group.traverse(object => { if (object instanceof THREE.Sprite) { object.material.map?.dispose(); object.material.dispose(); } });
      state.current?.invalidate();
    };
  }, [props.heightLabels]);

  // The train waits at the start of the first route it fits on whole.
  useEffect(() => {
    const live = state.current, { project, fit } = props;
    if (!live || !project.cars.length || fit.layoutRevision !== project.layoutRevision) return;
    const gauge = trainGauge(project.cars);
    const frame = project.routes.map(route => placeConsist(routePath(fit.sections, route.id, gauge), project.cars,
      startingLeadDistance(project.cars))).find(candidate => candidate.cars.length === project.cars.length);
    if (!frame) return;
    const standard = project.trackSystem === 'brick-v1';
    const view = createTrainView(project.cars, car => !standard ? 0 : car.gauge === 'monorail' ? MONORAIL_BEAM_TOP : BRICK_TRACK.railTop,
      () => state.current?.invalidate(), { shadows: true });
    view.place(frame);
    live.scene.add(view.group);
    live.invalidate();
    return () => { view.dispose(); state.current?.invalidate(); };
  }, [props.project.cars, props.project.routes, props.project.trackSystem, props.project.layoutRevision, props.fit]);

  return <div className="builder-3d" ref={host} role="img" aria-label="3D view of room, furniture and track">
    {error && <div className="builder-3d-error" role="status">WebGL is unavailable. Use the top view to edit this layout.</div>}
    <CommunityMeshHint project={props.project}/>
  </div>;
});
