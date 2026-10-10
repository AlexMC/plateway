import { meshCentreline, type MeshEnd } from '../domain/pieces/families/community';

/**
 * Marking a contributed piece's two track ends on its mesh (R17, R20). A click on an end face snaps to the connector
 * grid as cad/library/check.py checks it: the middle of that face (a connector's stud columns are symmetric about the
 * centreline), at rail height (the highest point within a connector's half-width), heading straight out of the face.
 */
export interface StlMesh {
  /** Merged vertex positions, x, y, z per vertex (mm). */
  positions: Float32Array;
  /** Three vertex indices per triangle. */
  faces: Uint32Array;
  /** Each triangle's unit normal from its winding (outwards on a closed, consistently wound mesh). */
  normals: Float32Array;
  size: [number, number, number];
  /** The lowest corner: the mesh sits on its underside at `min[2]`. */
  min: [number, number, number];
}
/** The two ends as marked so far: either may be empty. */
export type MarkedEnds = readonly [MeshEnd | null, MeshEnd | null];

/** check.py `END_FACE_COSINE`, `END_FACE_OFFSET`, `END_FACE_WIDTH`, `RAIL_REACH`. */
const FACE_COSINE = Math.cos(2 * Math.PI / 180), FACE_OFFSET = 0.3, FACE_WIDTH = 16, RAIL_REACH = 32;

/** A binary STL (checked by `stlProblem` first) as an indexed mesh: identical corners merged, as check.py's trimesh does. */
export function meshFromStl(bytes: ArrayBuffer): StlMesh {
  const view = new DataView(bytes), count = view.getUint32(80, true);
  const index = new Map<string, number>(), positions: number[] = [], faces = new Uint32Array(count * 3), normals = new Float32Array(count * 3);
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < count; t++) {
    const corners: number[][] = [];
    for (let c = 0; c < 3; c++) {
      const at = 84 + t * 50 + 12 + c * 12;
      const point = [view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true)];
      corners.push(point);
      const key = point.join(',');
      let vertex = index.get(key);
      if (vertex === undefined) {
        vertex = positions.length / 3;
        index.set(key, vertex);
        positions.push(...point);
        for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]); }
      }
      faces[t * 3 + c] = vertex;
    }
    const [a, b, c] = corners, u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], length = Math.hypot(...n) || 1;
    normals.set(n.map(value => value / length), t * 3);
  }
  return { positions: Float32Array.from(positions), faces, normals, min, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/** check.py `rail_top`: the highest vertex within `RAIL_REACH` of (x, y) in plan, or the nearest when none is. */
function railTop({ positions }: StlMesh, x: number, y: number): number {
  let nearest = Infinity;
  for (let i = 0; i < positions.length; i += 3) nearest = Math.min(nearest, Math.hypot(positions[i] - x, positions[i + 1] - y));
  const reach = Math.max(RAIL_REACH, nearest);
  let top = -Infinity;
  for (let i = 0; i < positions.length; i += 3) if (Math.hypot(positions[i] - x, positions[i + 1] - y) <= reach) top = Math.max(top, positions[i + 2]);
  return top;
}

// `+ 0` turns -0 into 0, so a snapped end reads as it is written.
const round = (value: number, places: number) => Number(value.toFixed(places)) + 0;

/**
 * The end a click on triangle `face` marks, snapped to the connector grid; or why that face can't hold one. Everything in
 * the face's plane facing the same way, taken together, is the end face (check.py `end_face`): a connector's tongue and
 * socket cut it into separate pieces, and its width is their combined span across the track.
 */
export function snapEnd(mesh: StlMesh, face: number): MeshEnd | string {
  const { positions, faces, normals } = mesh, nx = normals[face * 3], ny = normals[face * 3 + 1];
  if (Math.hypot(nx, ny) < FACE_COSINE) return 'That isn’t an end face: click the side of the piece where track leaves it.';
  const heading = Math.atan2(ny, nx), dx = Math.cos(heading), dy = Math.sin(heading);
  const along = (vertex: number) => positions[vertex * 3] * dx + positions[vertex * 3 + 1] * dy;
  const offset = (along(faces[face * 3]) + along(faces[face * 3 + 1]) + along(faces[face * 3 + 2])) / 3;
  let low = Infinity, high = -Infinity;
  for (let t = 0; t < faces.length / 3; t++) {
    if (normals[t * 3] * dx + normals[t * 3 + 1] * dy < FACE_COSINE) continue;
    const corners = [faces[t * 3], faces[t * 3 + 1], faces[t * 3 + 2]];
    if (corners.some(vertex => Math.abs(along(vertex) - offset) > FACE_OFFSET)) continue;
    for (const vertex of corners) {
      const side = -positions[vertex * 3] * dy + positions[vertex * 3 + 1] * dx;
      low = Math.min(low, side); high = Math.max(high, side);
    }
  }
  if (high - low < FACE_WIDTH) return `That face is only ${Math.round((high - low) * 10) / 10} mm wide: click the end face where track leaves the piece, not a side.`;
  const middle = (low + high) / 2, x = offset * dx - middle * dy, y = offset * dy + middle * dx;
  return { x: round(x, 2), y: round(y, 2), z: round(railTop(mesh, x, y), 2), heading: round(heading, 6) };
}

/** Marks `end` in the first empty slot; both ends marked already: unchanged (clear one first). */
export function placeEnd(ends: MarkedEnds, end: MeshEnd): MarkedEnds {
  if (!ends[0]) return [end, ends[1]];
  if (!ends[1]) return [ends[0], end];
  return ends;
}

/** The end turned to face the other way: its arrow flipped. */
export function flipEnd(ends: MarkedEnds, index: 0 | 1): MarkedEnds {
  const end = ends[index];
  if (!end) return ends;
  const flipped = { ...end, heading: round(Math.atan2(-Math.sin(end.heading), -Math.cos(end.heading)), 6) };
  return index === 0 ? [flipped, ends[1]] : [ends[0], flipped];
}

/** Only that end removed. */
export function clearEnd(ends: MarkedEnds, index: 0 | 1): MarkedEnds {
  return index === 0 ? [null, ends[1]] : [ends[0], null];
}

/** The track between the ends in the mesh's frame (`meshCentreline` maps the mesh into the piece frame; this undoes it). */
export function centrelineInMesh(start: MeshEnd, end: MeshEnd): { x: number; y: number; z: number }[] {
  const turn = start.heading + Math.PI, c = Math.cos(turn), s = Math.sin(turn);
  return meshCentreline(start, end).map(point => ({ x: start.x + c * point.x - s * point.y, y: start.y + s * point.x + c * point.y, z: start.z }));
}

/** Whether a marked end still lies on an end face facing its way (a flipped arrow points into the piece). */
export function endFacesOut(mesh: StlMesh, end: MeshEnd): boolean {
  const { positions, faces, normals } = mesh, dx = Math.cos(end.heading), dy = Math.sin(end.heading);
  const offset = end.x * dx + end.y * dy;
  for (let t = 0; t < faces.length / 3; t++) {
    if (normals[t * 3] * dx + normals[t * 3 + 1] * dy < FACE_COSINE) continue;
    if ([0, 1, 2].every(c => Math.abs(positions[faces[t * 3 + c] * 3] * dx + positions[faces[t * 3 + c] * 3 + 1] * dy - offset) <= FACE_OFFSET)) return true;
  }
  return false;
}
