import type { LibraryOrigin, RoutePiece } from '../../project';
import { arc, origin } from '../geometry';
import type { ParamSpec, PieceDefinition, ShapePoint } from '../types';

/**
 * A marked end of a community piece's mesh, in the mesh frame of its STL (mm, +z up, the mesh's flat underside at z = 0):
 * the track centreline where it crosses the end face, at rail-top height, and `heading`, the direction (radians,
 * anticlockwise from +x) pointing out of the piece through that end.
 */
export interface MeshEnd { x: number; y: number; z: number; heading: number }

/** The two ends' heights may differ by this much (mm): contributed pieces are level track. */
const LEVEL = 0.5;
/** Shortest centreline between the ends (mm). */
const SHORTEST = 16;
/** Ends this close to one circular arc (radians) are joined by that arc; others by a smooth cubic. */
const ARC_TOLERANCE = 0.01;
const SAMPLE = 4;
const normalize = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

/**
 * The piece-frame centreline between two ends: `start` becomes the piece's `in` end at the origin facing +x, and the
 * path runs to `end` (its `out`). The mesh maps into this frame by moving `start` to the origin in plan (z unchanged)
 * and turning by -(start.heading + π) about z.
 */
export function meshCentreline(start: MeshEnd, end: MeshEnd): ShapePoint[] {
  const turn = -(start.heading + Math.PI), c = Math.cos(turn), s = Math.sin(turn);
  const dx = end.x - start.x, dy = end.y - start.y;
  const x = c * dx - s * dy, y = s * dx + c * dy, heading = normalize(end.heading + turn);
  const chord = Math.hypot(x, y), bearing = Math.atan2(y, x);
  const points: ShapePoint[] = [origin()];
  if (Math.abs(heading) < 1e-4 && Math.abs(y) < 0.05) {
    points.push({ x, y: 0, z: 0, heading: 0 });
    return points;
  }
  if (Math.abs(normalize(heading - 2 * bearing)) < ARC_TOLERANCE) {
    arc(points, Math.abs(chord / (2 * Math.sin(heading / 2))), heading);
    // The arc's last sample lands on the marked end to within float error; the end is exactly the marked one.
    points[points.length - 1] = { x, y, z: 0, heading };
    return points;
  }
  // Ends that no single arc joins (an S-bend): a cubic whose handles make it a near-exact arc when the ends nearly are one.
  const handle = chord / (3 * Math.cos(heading / 4) ** 2), p1 = { x: handle, y: 0 };
  const p2 = { x: x - handle * Math.cos(heading), y: y - handle * Math.sin(heading) };
  const count = Math.max(2, Math.ceil(chord * 1.5 / SAMPLE));
  for (let i = 1; i <= count; i++) {
    const t = i / count, u = 1 - t;
    const px = 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * x;
    const py = 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * y;
    const tx = 3 * u * u * p1.x + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (x - p2.x);
    const ty = 3 * u * u * p1.y + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (y - p2.y);
    points.push({ x: px, y: py, z: 0, heading: i === count ? heading : Math.atan2(ty, tx) });
  }
  return points;
}

/** Why two marked ends can't make a piece, or null: level, apart, and each end ahead of the other, turning at most 90°. */
export function meshEndsProblem([start, end]: readonly [MeshEnd, MeshEnd]): string | null {
  if (![start, end].every(point => [point.x, point.y, point.z, point.heading].every(Number.isFinite))) return 'An end is not a number.';
  if (Math.abs(start.z - end.z) > LEVEL) return 'The ends are not at the same rail height.';
  for (const [from, to] of [[start, end], [end, start]]) {
    const far = meshCentreline(from, to).at(-1)!;
    if (Math.hypot(far.x, far.y) < SHORTEST) return 'The ends are too close together.';
    if (far.x <= 0 || Math.abs(far.heading) > Math.PI / 2 + 1e-6) return 'The ends do not face away from each other.';
  }
  return null;
}

/**
 * Hidden: 1 when the piece was laid from its `out` end (`reverseParams`), so its `in` is the mesh's second marked end.
 * The same physical piece either way; only the authoring direction changes.
 */
const REVERSED: ParamSpec = { key: 'reversed', label: 'Laid from its far end', unit: '', min: 0, max: 1, step: 1, default: 0, hidden: true };
export const PRINTS_AS_UPLOADED = 'Prints as uploaded: print style and fit adjustment don’t apply.';

/**
 * A community piece from the library (KTD9): two-ended plain track printed from its uploaded mesh exactly as uploaded
 * (R20). Its one path runs between the mesh's two marked ends; it has no print styles and no settings. `file`: its STL's
 * URL, drawn in Build and Test drive once downloaded.
 */
export function meshPiece({ name, ends, origin: community, file }: { name: string; ends: readonly [MeshEnd, MeshEnd]; origin: LibraryOrigin; file: string }): PieceDefinition {
  const forward = meshCentreline(ends[0], ends[1]), backward = meshCentreline(ends[1], ends[0]);
  const run = forward.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - forward[index].x, point.y - forward[index].y), 0);
  const degrees = Math.round(Math.abs(forward.at(-1)!.heading) * 180 / Math.PI);
  const shape = degrees === 0 ? 'straight' : `${degrees}° curve`;
  return {
    family: community.id, label: name, group: 'community', source: 'printed', styles: [], params: [REVERSED], gauge: 'standard',
    body: 'path', customJoiner: false, color: 0x6aa6c9, community, libraryMesh: { file, ends }, ...(community.retired ? { hidden: true } : {}),
    description: () => `${shape} · ${Math.round(run)} mm`,
    notes: [PRINTS_AS_UPLOADED],
    paths: (piece: RoutePiece) => [{ id: 'main', from: 'in', to: 'out', points: piece.params?.reversed === 1 ? backward : forward }],
    run: () => run,
    reverseParams: params => ({ ...params, reversed: params.reversed === 1 ? 0 : 1 }),
    cad: () => []
  };
}
