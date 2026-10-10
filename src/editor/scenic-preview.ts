import * as THREE from 'three';
import type { RoutePiece, WorkshopProject } from '../domain/project';
import { COMPOSITE_FAMILY, MARKER_COLOURS, compositeCentreline, pieceDefinition, piecePaths, type CadPart } from '../domain/pieces';
import { LED_STRIPS, METAL_RAIL } from '../domain/pieces/families/track-options';
import { BRICK_TRACK } from '../domain/track';
import { funicularDecor } from './funicular-preview';
import { rackDecor } from './rack-preview';
import { sectionGeometry, type PreviewPose } from './track-preview';

/** One extra solid drawn with a piece: the printed options and scenic parts, in world coordinates. */
export interface Decor { geometry: THREE.BufferGeometry; color: number }

const HALF = BRICK_TRACK.bodyWidth / 2, BASE = BRICK_TRACK.baseThickness, TOP = BRICK_TRACK.railTop;
// Rail head faces, from the centreline.
const INNER = BRICK_TRACK.railGauge / 2 - BRICK_TRACK.railInterfaceWidth / 2, OUTER = INNER + BRICK_TRACK.railInterfaceWidth;
// composite.py: 64022 guard ridges, flangeway floor, ballast shoulder toe; buffer.py and road.py dimensions.
const GUARD = [13.4, 14.8], FLANGE_FLOOR = TOP - 3.2, BALLAST = HALF + 8;
const BUFFER = { block: 20, beam: [19.2, 32], lip: 2, top: 6 };
const RERAIL = { ramp: 40, plateau: TOP - .2 };
const ROAD = { width: 128, edge: 32, apron: 32, filler: 32 };
const ASPHALT = 0x5f6166, BALLAST_COLOR = 0x8f8576, GUARD_COLOR = 0x9aa19a, BUFFER_COLOR = 0xb8433a, GUIDE_COLOR = 0xd9b44a;
// track_power.py: nickel-silver rail, copper tape, LED strip (drawn lit) in its channel under the deck.
const NICKEL_SILVER = 0xc9ccd1, COPPER = 0xc87533, LED_GLOW = 0xbff3ff, LED_CEILING = BASE - .9;

const rect = (y0: number, y1: number, z0: number, z1: number) => [[y0, z0], [y1, z0], [y1, z1], [y0, z1]];
const mirror = (section: number[][]) => section.map(([y, z]) => [-y, z]).reverse();

/** A side profile [(x, z)] across the lateral band y0..y1, placed with the piece's pose. */
function sideProfile(piece: RoutePiece, profile: readonly [number, number][], y0: number, y1: number): THREE.BufferGeometry {
  const geometry = new THREE.ExtrudeGeometry(new THREE.Shape(profile.map(([x, z]) => new THREE.Vector2(x, z))),
    { depth: y1 - y0, bevelEnabled: false, steps: 1 });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, y1, 0);
  return placed(piece, geometry);
}
function placed(piece: RoutePiece, geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  geometry.rotateZ(piece.heading);
  geometry.translate(piece.x, piece.y, piece.z);
  return geometry;
}

/** Street surface, ballast shoulders, guard ridges and the marker pad of a plain printed track part. */
function trackOptions(piece: RoutePiece, project: WorkshopProject, parameters: Record<string, number>): Decor[] {
  const points: PreviewPose[] = piecePaths(piece, project)[0].points;
  const decor: Decor[] = [];
  const swept = (section: number[][], color: number) => decor.push({ geometry: sectionGeometry(points, section), color });
  if (parameters.street) {
    for (const band of [rect(OUTER, HALF, BASE, TOP), rect(GUARD[1], INNER, BASE, FLANGE_FLOOR)]) {
      swept(band, ASPHALT); swept(mirror(band), ASPHALT);
    }
    swept(rect(-GUARD[1], GUARD[1], BASE, TOP), ASPHALT);
  }
  if (parameters.ballast) {
    const shoulder = [[HALF - .3, 0], [BALLAST, 0], [BALLAST, 1.8], [HALF + 1.4, BASE - .2], [HALF - .3, BASE]];
    swept(shoulder, BALLAST_COLOR); swept(mirror(shoulder), BALLAST_COLOR);
  }
  if (parameters.guard_rail) {
    const ridge = rect(GUARD[0], GUARD[1], 2, TOP);
    swept(ridge, GUARD_COLOR); swept(mirror(ridge), GUARD_COLOR);
  }
  if (parameters.metal) {
    // Code 250 rail stands on the deck (drawn just over the printed rail it replaces); copper tape lies over the printed head.
    const metal = parameters.metal === METAL_RAIL;
    const rail = metal ? rect(INNER - .25, OUTER + .25, BASE, TOP + .08) : rect(INNER - .05, OUTER + .05, TOP - .1, TOP + .04);
    swept(rail, metal ? NICKEL_SILVER : COPPER); swept(mirror(rail), metal ? NICKEL_SILVER : COPPER);
  }
  if (parameters.rack) decor.push(...rackDecor(points, parameters));
  if (parameters.led) {
    const half = LED_STRIPS[parameters.led] / 2;
    swept(rect(-half, half, LED_CEILING - 1.6, LED_CEILING), LED_GLOW);
  }
  if (parameters.marker) {
    const track = pieceDefinition(piece.family).composite!(piece, project);
    const at = compositeCentreline(track, 1).reduce((best, point) =>
      Math.abs(point.station - parameters.marker_s) < Math.abs(best.station - parameters.marker_s) ? point : best);
    const pad = new THREE.BoxGeometry(12, 12, 1.6);
    pad.rotateZ(at.heading);
    pad.translate(at.x, at.y, at.z + BASE + .8);
    decor.push({ geometry: placed(piece, pad), color: Number.parseInt((MARKER_COLOURS.find(colour => colour.value === parameters.marker)?.hex ?? '#808080').slice(1), 16) });
  }
  return decor;
}

/** Convex polygon clipped to the half plane a·p <= b (Sutherland–Hodgman). */
function clip(polygon: [number, number][], a: [number, number], b: number): [number, number][] {
  const out: [number, number][] = [], side = (p: [number, number]) => a[0] * p[0] + a[1] * p[1] - b;
  polygon.forEach((p, i) => {
    const q = polygon[(i + 1) % polygon.length], sp = side(p), sq = side(q);
    if (sp <= 0) out.push(p);
    if (sp * sq < 0) { const t = sp / (sp - sq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  });
  return out;
}

/** A level-crossing road tile as drawn: its plan (road.py's region) extruded to the rail tops. */
function roadTile(piece: RoutePiece, { run, angle, side, kind, half }: Record<string, number>): THREE.BufferGeometry | null {
  const theta = angle * Math.PI / 180, cx = run / 2, [c, s] = [Math.cos(theta), Math.sin(theta)];
  let region: [number, number][] = [[-2000, ROAD.edge], [2000, ROAD.edge], [2000, ROAD.edge + (kind ? ROAD.filler : 2000)], [-2000, ROAD.edge + (kind ? ROAD.filler : 2000)]];
  const high = half >= 0 ? ROAD.width / 2 : 0, low = half <= 0 ? -ROAD.width / 2 : 0;
  // Road frame: u = (x - cx)c + ys along the road, v = -(x - cx)s + yc across it.
  region = clip(region, [-s, c], high - s * cx);
  region = clip(region, [s, -c], s * cx - low);
  if (!kind) region = clip(region, [c, s], ROAD.edge / s + ROAD.width / 2 / Math.abs(Math.tan(theta)) + ROAD.apron + cx * c);
  if (region.length < 3) return null;
  // Built for the left side; the right side is the same region half a turn about the crossing centre.
  const plan = region.map(([x, y]) => side > 0 ? new THREE.Vector2(x, y) : new THREE.Vector2(2 * cx - x, -y));
  const geometry = new THREE.ExtrudeGeometry(new THREE.Shape(plan), { depth: TOP, bevelEnabled: false, steps: 1 });
  return placed(piece, geometry);
}

/** The extra solids of a scenic piece or a plain track piece with options. */
export function scenicDecor(piece: RoutePiece, project: WorkshopProject): Decor[] {
  const definition = pieceDefinition(piece.family);
  if (piece.family === 'funicular') return funicularDecor(piece);
  if (piece.family === 'buffer_stop') {
    const run = definition.run(piece, project), face = run - BUFFER.block, [low, high] = BUFFER.beam;
    const profile: [number, number][] = [[face, BASE], [run, BASE], [run, TOP], [face - BUFFER.lip + BUFFER.top, high],
      [face - BUFFER.lip, high], [face - BUFFER.lip, low], [face, low - BUFFER.lip]];
    return [{ geometry: sideProfile(piece, profile, -HALF, HALF), color: BUFFER_COLOR }];
  }
  if (piece.family === 'rerailer') {
    const run = definition.run(piece, project), foot = BRICK_TRACK.endTieWidth;
    const top = foot + Math.min(RERAIL.ramp, (run - 2 * foot - 8) / 2), far = run - top;
    const ramp = (height: number): [number, number][] => [[foot, BASE], [run - foot, BASE], [far, height], [top, height]];
    const decor: Decor[] = [];
    for (const sign of [1, -1]) {
      const band = (a: number, b: number) => a * sign < b * sign ? [a * sign, b * sign] : [b * sign, a * sign];
      const [y0, y1] = band(OUTER, HALF);
      decor.push({ geometry: sideProfile(piece, ramp(RERAIL.plateau), y0, y1), color: GUIDE_COLOR });
      const [g0, g1] = band(GUARD[0], GUARD[1]);
      decor.push({ geometry: sideProfile(piece, [[top, BASE], [far, BASE], [far, TOP], [top, TOP]], g0, g1), color: GUIDE_COLOR });
    }
    return decor;
  }
  const parts: CadPart[] = definition.composite ? definition.cad(piece, project) : [];
  const track = parts.find(part => part.family === COMPOSITE_FAMILY);
  return [
    ...(track ? trackOptions(piece, project, track.parameters) : []),
    ...parts.filter(part => part.family === 'road_tile').flatMap(part => {
      const geometry = roadTile(piece, part.parameters);
      return geometry ? [{ geometry, color: ASPHALT }] : [];
    })
  ];
}
