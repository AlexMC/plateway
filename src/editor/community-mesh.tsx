import { useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { findPieceDefinition, type PieceDefinition } from '../domain/pieces';
import type { RoutePiece, WorkshopProject } from '../domain/project';

/**
 * Community pieces' uploaded meshes (KTD9) in Build and Test drive. A piece registers from its index entry alone; its STL
 * downloads the first time a placed piece is drawn, once per digest for the page's life, and must match the index digest.
 * Until it is in, and for good when it is refused (a failed download or a different digest), the piece draws as generic
 * track and `CommunityMeshHint` says so. The geometry is shared by every view: views must not dispose it
 * (`geometry.userData.libraryMesh`).
 */
export type CommunityMesh =
  | { state: 'loading' }
  | { state: 'loaded'; geometry: THREE.BufferGeometry; footprint: readonly Rect[] }
  | { state: 'failed'; reason: string };
/** A plan rectangle in the mesh frame (mm): x0 ≤ x1, y0 ≤ y1. */
type Rect = readonly [x0: number, y0: number, x1: number, y1: number];

const meshes = new Map<string, CommunityMesh>();
let version = 0;
const listeners = new Set<() => void>();
const changed = () => { version++; for (const listener of listeners) listener(); };
/** Calls `listener` whenever a mesh finishes loading or is refused; returns the unsubscribe. */
export function onCommunityMeshChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Redraws a view when a community mesh loads or is refused. */
export function useCommunityMeshes(): number {
  return useSyncExternalStore(onCommunityMeshChange, () => version, () => version);
}

async function download(file: string, digest: string): Promise<CommunityMesh> {
  try {
    const response = await fetch(file);
    if (!response.ok) return { state: 'failed', reason: `Its file did not download (${response.status}).` };
    const bytes = await response.arrayBuffer();
    const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== digest) return { state: 'failed', reason: 'Its file does not match the index digest.' };
    const geometry = new STLLoader().parse(bytes);
    if (!geometry.getAttribute('position')?.count) return { state: 'failed', reason: 'Its file has no triangles.' };
    geometry.computeBoundingBox();
    geometry.userData.libraryMesh = true;
    return { state: 'loaded', geometry, footprint: planFootprint(geometry) };
  } catch (error) {
    return { state: 'failed', reason: `Its file did not load (${error instanceof Error ? error.message : 'unknown error'}).` };
  }
}

/**
 * A placed community piece's mesh: loaded, still loading (its download starts on the first call) or refused; null for any
 * other piece. Call it only for placed pieces: a palette tile or a ghost must not download a mesh.
 */
export function communityMesh(definition: PieceDefinition): CommunityMesh | null {
  const { libraryMesh: mesh, community } = definition;
  if (!mesh || !community) return null;
  let entry = meshes.get(community.digest);
  if (!entry) {
    entry = { state: 'loading' };
    meshes.set(community.digest, entry);
    void download(mesh.file, community.digest).then(result => {
      if (result.state === 'failed') console.warn(`Community piece ${definition.label} shows as plain track:`, result.reason);
      meshes.set(community.digest, result);
      changed();
    });
  }
  return entry;
}

/**
 * Mesh frame → world for a placed piece: its `in` end (the mesh's first marked end, or its second when laid from its far
 * end) goes to the piece's pose, turned so that end faces back along the piece (`meshCentreline`); heights are unchanged,
 * the mesh's underside on the piece's datum.
 */
export function communityMeshMatrix(piece: RoutePiece, definition: PieceDefinition): THREE.Matrix4 {
  const ends = definition.libraryMesh!.ends, start = ends[piece.params?.reversed === 1 ? 1 : 0];
  return new THREE.Matrix4().makeTranslation(piece.x, piece.y, piece.z)
    .multiply(new THREE.Matrix4().makeRotationZ(piece.heading - start.heading - Math.PI))
    .multiply(new THREE.Matrix4().makeTranslation(-start.x, -start.y, 0));
}

/** Plan cells of the footprint (mm); a piece fits a printer bed, so a few thousand cells at most. */
const CELL = 2;
/**
 * The mesh's plan silhouette in its own frame: every triangle seen from above, rasterised on a 2 mm grid and merged into
 * rectangles (runs along x, stacked along y where they line up).
 */
function planFootprint(geometry: THREE.BufferGeometry): Rect[] {
  const box = geometry.boundingBox!, positions = geometry.getAttribute('position');
  const x0 = box.min.x, y0 = box.min.y, columns = Math.max(1, Math.ceil((box.max.x - x0) / CELL)), rows = Math.max(1, Math.ceil((box.max.y - y0) / CELL));
  const filled = new Uint8Array(columns * rows);
  for (let i = 0; i + 2 < positions.count; i += 3) {
    const ax = positions.getX(i), ay = positions.getY(i), bx = positions.getX(i + 1), by = positions.getY(i + 1);
    const cx = positions.getX(i + 2), cy = positions.getY(i + 2);
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-9) continue;
    const first = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / CELL)), last = Math.min(columns - 1, Math.floor((Math.max(ax, bx, cx) - x0) / CELL));
    const low = Math.max(0, Math.floor((Math.min(ay, by, cy) - y0) / CELL)), high = Math.min(rows - 1, Math.floor((Math.max(ay, by, cy) - y0) / CELL));
    for (let row = low; row <= high; row++) for (let column = first; column <= last; column++) {
      const px = x0 + (column + 0.5) * CELL, py = y0 + (row + 0.5) * CELL;
      // Barycentric signs, scaled by the triangle's own orientation: inside (or on an edge) when none is negative.
      const u = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area, v = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
      if (u >= -1e-9 && v >= -1e-9 && 1 - u - v >= -1e-9) filled[row * columns + column] = 1;
    }
  }
  const rects: [number, number, number, number][] = [];
  let open = new Map<string, [number, number, number, number]>();
  for (let row = 0; row < rows; row++) {
    const next = new Map<string, [number, number, number, number]>();
    for (let column = 0; column < columns; column++) {
      if (!filled[row * columns + column]) continue;
      const start = column;
      while (column + 1 < columns && filled[row * columns + column + 1]) column++;
      const key = `${start}:${column}`, above = open.get(key);
      if (above) { above[3] = y0 + (row + 1) * CELL; next.set(key, above); continue; }
      const rect: [number, number, number, number] = [x0 + start * CELL, y0 + row * CELL, x0 + (column + 1) * CELL, y0 + (row + 1) * CELL];
      rects.push(rect);
      next.set(key, rect);
    }
    open = next;
  }
  return rects;
}

/** Placed community pieces whose mesh was refused: they show as generic track. Never starts a download. */
function refusedPieces(project: WorkshopProject): string[] {
  const labels = new Set<string>();
  for (const route of project.routes) for (const piece of route.pieces) {
    const definition = findPieceDefinition(piece.family);
    if (definition?.community && meshes.get(definition.community.digest)?.state === 'failed') labels.add(definition.label);
  }
  return [...labels];
}

/** A quiet line naming the placed community pieces drawn as plain track because their mesh was refused; nothing otherwise. */
export function CommunityMeshHint({ project, className = 'community-mesh-hint' }: { project: WorkshopProject; className?: string }) {
  useCommunityMeshes();
  const labels = refusedPieces(project);
  if (!labels.length) return null;
  const one = labels.length === 1;
  return <p className={className} role="status">{`${labels.join(', ')} ${one ? 'shows' : 'show'} as plain track: ${one ? 'its model' : 'their models'} didn’t load.`}</p>;
}

/** The plan silhouette of a placed community piece whose mesh is in, drawn under its track in the top view. */
export function CommunityFootprint({ piece }: { piece: RoutePiece }) {
  useCommunityMeshes();
  const definition = findPieceDefinition(piece.family), mesh = definition && communityMesh(definition);
  if (mesh?.state !== 'loaded') return null;
  const matrix = communityMeshMatrix(piece, definition!), point = new THREE.Vector3();
  const corner = (x: number, y: number) => { point.set(x, y, 0).applyMatrix4(matrix); return `${point.x.toFixed(2)},${point.y.toFixed(2)}`; };
  const d = mesh.footprint.map(([x0, y0, x1, y1]) => `M${corner(x0, y0)}L${corner(x1, y0)}L${corner(x1, y1)}L${corner(x0, y1)}Z`).join('');
  return <path className="builder-community-footprint" d={d}><title>{`${definition!.label} · uploaded model`}</title></path>;
}
