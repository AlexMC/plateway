import * as THREE from 'three';

/**
 * Monorail beam drawing for the 2D plan, the 3D builder and Test drive (cad/models/monorail.py): a grey 32 mm wide,
 * 12.8 mm tall beam with its dark centre groove (default 17.5 mm wide, 6.4 mm deep) and the rack rod standing in it.
 * Points run along the beam's underside centre line, as monorail paths do.
 */
type BeamPose = { x: number; y: number; z?: number; heading: number; pitch?: number };
const HALF = 16, HEIGHT = 12.8, GROOVE = 17.5 / 2, FLOOR = HEIGHT - 6.4, ROD = 1.4, ROD_TOP = HEIGHT - .8;
export const MONORAIL_BEAM_COLOR = 0x9a9ea3;
/** Monorail cars ride the beam top, this far above the route path. */
export const MONORAIL_BEAM_TOP = HEIGHT;
const SLOT_COLOR = 0x2f3236;

/** Left/right offset of a pose in plan. */
function offset(point: BeamPose, lateral: number): { x: number; y: number } {
  return { x: point.x - Math.sin(point.heading) * lateral, y: point.y + Math.cos(point.heading) * lateral };
}
function band(points: readonly BeamPose[], low: number, high: number): string {
  const loop = [...points.map(point => offset(point, low)), ...points.map(point => offset(point, high)).reverse()];
  return `${loop.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')} Z`;
}

/** 2D plan beam: grey beam, dark groove, the rack rod's teeth as a dashed centre line. */
export function MonorailBeam({ points, selected = false, preview = false, unresolved = false, printed = true, lite = false, rise }: {
  points: readonly BeamPose[]; selected?: boolean; preview?: boolean; unresolved?: boolean; printed?: boolean; lite?: boolean; rise?: number;
}) {
  const centre = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
  const middle = points[Math.floor(points.length / 2)];
  return <g className={`builder-piece is-monorail ${printed ? 'is-printed' : 'is-owned'} ${lite ? 'is-fast' : ''} ${selected ? 'is-selected' : ''} ${preview ? 'is-preview' : ''} ${unresolved ? 'is-unresolved' : ''}`}>
    <title>{`Monorail beam${lite ? ' · fast print' : ''}`}</title>
    <path d={band(points, -HALF, HALF)} fill={unresolved ? '#c07772' : '#9a9ea3'} stroke="#6d7075" strokeWidth={.6}/>
    <path d={band(points, -GROOVE, GROOVE)} fill="#2f3236"/>
    <path d={centre} fill="none" stroke="#c9ccd0" strokeWidth={ROD * 2} strokeDasharray="0.8 0.77"><title>Rack rod</title></path>
    {selected && <path d={centre} className="builder-piece-selection" strokeWidth={2 * HALF + 15}/>}
    {rise !== undefined && <text x={middle.x} y={middle.y - HALF - 15} className="builder-piece-rise" textAnchor="middle">{rise > 0 ? '+' : ''}{rise} mm</text>}
  </g>;
}

/** A closed (y, z) profile swept along the poses (normal to the pitched path), with end caps. */
function sweep(points: readonly BeamPose[], profile: readonly (readonly [number, number])[]): THREE.BufferGeometry {
  const rings = points.map(point => {
    const pitch = point.pitch ?? 0, c = Math.cos(point.heading), s = Math.sin(point.heading);
    const up = [-Math.sin(pitch) * c, -Math.sin(pitch) * s, Math.cos(pitch)];
    return profile.map(([y, z]) => [point.x - s * y + up[0] * z, point.y + c * y + up[1] * z, (point.z ?? 0) + up[2] * z]);
  });
  const vertices: number[] = [], n = profile.length;
  const push = (...corners: number[][]) => corners.forEach(corner => vertices.push(...corner));
  for (let i = 1; i < rings.length; i++) for (let j = 0; j < n; j++) {
    const a = rings[i - 1][j], b = rings[i - 1][(j + 1) % n], c = rings[i][j], d = rings[i][(j + 1) % n];
    push(a, b, d, a, d, c);
  }
  const triangles = THREE.ShapeUtils.triangulateShape(profile.map(([y, z]) => new THREE.Vector2(y, z)), []);
  for (const [ring, flip] of [[rings[0], true], [rings.at(-1)!, false]] as const)
    for (const [a, b, c] of triangles) push(...(flip ? [ring[a], ring[c], ring[b]] : [ring[a], ring[b], ring[c]]));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
}

const BEAM: readonly (readonly [number, number])[] = [[-HALF, 0], [HALF, 0], [HALF, HEIGHT], [GROOVE, HEIGHT], [GROOVE, FLOOR],
  [-GROOVE, FLOOR], [-GROOVE, HEIGHT], [-HALF, HEIGHT]];
const ROD_PROFILE: readonly (readonly [number, number])[] = [[-ROD, FLOOR - .05], [ROD, FLOOR - .05], [ROD, ROD_TOP], [-ROD, ROD_TOP]];
const FLOOR_PROFILE: readonly (readonly [number, number])[] = [[-GROOVE, FLOOR - .05], [GROOVE, FLOOR - .05], [GROOVE, FLOOR + .05], [-GROOVE, FLOOR + .05]];
let slotMaterial: THREE.Material | undefined;

/**
 * 3D beam along `points`: `add` places a geometry with the caller's piece material (selection, ghosting, picking);
 * the groove floor and rack rod are recoloured dark. `beam` replaces the piece material on the beam (Test drive).
 */
export function addMonorailBeam(points: readonly BeamPose[], add: (geometry: THREE.BufferGeometry) => THREE.Mesh, beam?: THREE.Material): void {
  if (points.length < 2) return;
  const body = add(sweep(points, BEAM));
  if (beam) body.material = beam;
  slotMaterial ??= new THREE.MeshStandardMaterial({ color: SLOT_COLOR, roughness: .7, metalness: .05 });
  for (const profile of [FLOOR_PROFILE, ROD_PROFILE]) add(sweep(points, profile)).material = slotMaterial;
}
