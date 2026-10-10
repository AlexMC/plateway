import type { RoutePiece } from '../../project';
import { BRICK_LAYOUT, BRICK_TRACK } from '../../track';
import { paramValue } from '../composite';
import { arc, origin } from '../geometry';
import type { ParamSpec, PieceDefinition, PiecePath } from '../types';
import { DEG, studs, type Values } from './composite-piece';
import type { TrackKind } from './kinds';

/**
 * Diamond crossings: route A ('main', in→out) runs straight along +x; route B ('crossing', cross-in→cross-out)
 * crosses A's midpoint at `angle` (signed degrees, + heads left), straight over `cross` mm or, on the curve
 * crossing, an arc of signed `radius` (+ bends left) over `sweep` degrees. Both routes are always open: no states.
 * Printed by cad/models/crossing_any.py; below 22.5° the frog gaps get long, so those angles are experimental.
 */
export const DIAMOND_FAMILY = 'track_diamond';
export const CURVE_CROSSING_FAMILY = 'track_diamond_curve';
export const CROSSING_MIN_ANGLE = 15;
/** Below this the frog gaps are long enough to call the crossing experimental. */
export const CROSSING_WARN_ANGLE = 22.5;
const HALF = BRICK_TRACK.bodyWidth / 2;
const R40 = BRICK_LAYOUT.curveRadius, R56 = BRICK_LAYOUT.wideCurveRadius;
const COLOR = 0xd98f5c;

export interface DiamondShape { angle: number; length: number; cross: number }
export interface CurveCrossingShape { angle: number; length: number; radius: number; sweep: number }

/** Diamond crossing paths in the piece frame. */
export function diamondPaths({ angle, length, cross }: DiamondShape): PiecePath[] {
  const t = angle * DEG, middle = length / 2, half = cross / 2;
  return [
    { id: 'main', from: 'in', to: 'out', points: [origin(), { x: length, y: 0, z: 0, heading: 0 }] },
    { id: 'crossing', from: 'cross-in', to: 'cross-out', points: [
      { x: middle - half * Math.cos(t), y: -half * Math.sin(t), z: 0, heading: t },
      { x: middle + half * Math.cos(t), y: half * Math.sin(t), z: 0, heading: t }] }
  ];
}
/** Straight × curve crossing paths: the arc's midpoint sits on A's midpoint, heading `angle`. */
export function curveCrossingPaths({ angle, length, radius, sweep }: CurveCrossingShape): PiecePath[] {
  const t = angle * DEG, k = Math.sign(radius) / Math.abs(radius), span = Math.abs(radius) * sweep * DEG, h0 = t - k * span / 2;
  const points = [{ x: length / 2 - (Math.sin(t) - Math.sin(h0)) / k, y: (Math.cos(t) - Math.cos(h0)) / k, z: 0, heading: h0 }];
  arc(points, Math.abs(radius), k * span);
  return [{ id: 'main', from: 'in', to: 'out', points: [origin(), { x: length, y: 0, z: 0, heading: 0 }] },
    { id: 'crossing', from: 'cross-in', to: 'cross-out', points }];
}
/** Shortest straight-diamond leg whose ports clear the other route's 63.8 mm body (the joined track runs on straight). */
export function diamondMinLeg(angle: number): number {
  return 2 * HALF / Math.tan(Math.abs(angle) * DEG / 2);
}

/**
 * Why another route's body would reach into the track joined at a port (taken to continue straight out of it,
 * 63.8 mm wide), or null. Mirrors crossing_any.corridor_problem, with its 0.5 mm tolerance.
 */
export function corridorProblem(paths: readonly PiecePath[]): string | null {
  for (const path of paths) {
    const ends = [{ id: path.from, p: path.points[0], heading: path.points[0].heading + Math.PI },
      { id: path.to, p: path.points.at(-1)!, heading: path.points.at(-1)!.heading }];
    for (const end of ends) {
      const c = Math.cos(end.heading), s = Math.sin(end.heading);
      for (const other of paths) {
        if (other === path) continue;
        for (let i = 1; i < other.points.length; i++) {
          const a = other.points[i - 1], b = other.points[i], steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
          for (let n = 0; n <= steps; n++) {
            const f = n / steps, x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f, h = a.heading + (b.heading - a.heading) * f;
            for (let side = -4; side <= 4; side++) {
              const lateral = HALF * side / 4, qx = x - Math.sin(h) * lateral - end.p.x, qy = y + Math.cos(h) * lateral - end.p.y;
              if (qx * c + qy * s > .5 && Math.abs(-qx * s + qy * c) < HALF - .5) return end.id;
            }
          }
        }
      }
    }
  }
  return null;
}

const angleSpec: ParamSpec = { key: 'angle', label: 'Angle', unit: 'deg', min: -90, max: 90, step: 0.5, default: 45 };
const lengthSpec: ParamSpec = { key: 'length', label: 'Main leg', unit: 'mm', min: 64, max: 1024, step: 8, default: 160 };
const DIAMOND_PARAMS: readonly ParamSpec[] = [angleSpec, lengthSpec,
  { key: 'cross', label: 'Crossing leg', unit: 'mm', min: 64, max: 1024, step: 8, default: 160 }];
const CURVE_PARAMS: readonly ParamSpec[] = [angleSpec, { ...lengthSpec, default: 208 },
  { key: 'radius', label: 'Radius', unit: 'mm', min: -1472, max: 1472, step: 8, default: R40 },
  { key: 'sweep', label: 'Curve', unit: 'deg', min: 5, max: 90, step: 0.5, default: 45 }];

/** Shown with any crossing whose rails meet below CROSSING_WARN_ANGLE. */
export const SHALLOW_CROSSING = 'Experimental: below 22.5° the frog gaps are long; check rails guide the wheels across them. Test-run slowly.';
const angleText = (angle: number) => `${Math.abs(angle)}°${Math.abs(angle) < CROSSING_WARN_ANGLE - 1e-9 ? ' · experimental' : ''}`;

function crossing({ family, label, params, paths, description, notes, flip, reverseParams }: {
  family: string; label: string; params: readonly ParamSpec[]; paths(values: Values): PiecePath[];
  description(values: Values): string; notes: readonly string[];
  flip(values: Values): Values; reverseParams(values: Values): Values;
}): PieceDefinition {
  const shape = (piece: Pick<RoutePiece, 'params'>): Values =>
    Object.fromEntries(params.map(spec => [spec.key, paramValue({ params }, piece as RoutePiece, spec.key)]));
  const defaults = (given: Values) => ({ ...shape({ params: given }), ...given });
  return {
    family, label, group: 'junction', source: 'printed', styles: ['detailed', 'fast'], params, gauge: 'standard',
    body: 'assembly', customJoiner: false, color: COLOR, notes,
    description: piece => description(shape(piece)),
    run: piece => shape(piece).length,
    end: piece => ({ x: shape(piece).length, y: 0, z: 0, heading: 0 }),
    paths: piece => paths(shape(piece)),
    cad: piece => [{ family, parameters: shape(piece) }],
    flip: given => ({ ...given, ...flip(defaults(given)) }),
    reverseParams: given => ({ ...given, ...reverseParams(defaults(given)) })
  };
}

const NOTES = ['Both routes are always open; only one train may use the crossing at a time.',
  'Check rails are added where a frog gap is longer than 4 mm.'];

export const TRACK_DIAMOND = crossing({
  family: DIAMOND_FAMILY, label: 'Diamond crossing', params: DIAMOND_PARAMS, notes: NOTES,
  paths: ({ angle, length, cross }) => diamondPaths({ angle, length, cross }),
  description: ({ angle, length, cross }) => `${angleText(angle)} · ${studs(length)} × ${studs(cross)} studs`,
  flip: ({ angle }) => ({ angle: -angle }),
  // Turned end for end, a diamond is the same piece.
  reverseParams: given => given
});

export const TRACK_CURVE_CROSSING = crossing({
  family: CURVE_CROSSING_FAMILY, label: 'Curve crossing', params: CURVE_PARAMS, notes: NOTES,
  paths: ({ angle, length, radius, sweep }) => curveCrossingPaths({ angle, length, radius, sweep }),
  description: ({ angle, length, radius, sweep }) => `R${studs(Math.abs(radius))} ${sweep}° across ${studs(length)} studs · ${angleText(angle)}`,
  flip: ({ angle, radius }) => ({ angle: -angle, radius: -radius }),
  // Turned end for end the arc crosses the same line but bends the other way.
  reverseParams: ({ radius }) => ({ radius: -radius })
});

/** The shortest whole-stud leg (both legs equal) that clears at this angle. */
function shortestLeg(angle: number): number {
  return Math.ceil((diamondMinLeg(angle) - 1) / 8) * 8;
}
function crossingProblem(paths: PiecePath[], angle: number): string | null {
  if (!(Math.abs(angle) >= CROSSING_MIN_ANGLE && Math.abs(angle) <= 90)) return `Angle must be ${CROSSING_MIN_ANGLE}° to 90°.`;
  const port = corridorProblem(paths);
  return port ? `The other track reaches the piece joined at ${port}; make the legs longer.` : null;
}
const pickValues = (definition: PieceDefinition, piece: RoutePiece, keys: readonly string[]): Values =>
  Object.fromEntries(keys.map(key => [key, paramValue(definition, piece, key)]));

/** Palette tile and card: 45° and the 22.5° R104 star crossing, or any angle from 15°. */
export const DIAMOND_KIND: TrackKind = {
  id: 'diamond', label: 'Diamond crossing', group: 'junction', hand: 'angle', families: [DIAMOND_FAMILY],
  rows: [{ label: 'Angle', match: ['angle', 'length', 'cross'],
    choices: [
      { label: '45°', values: { angle: 45, length: 160, cross: 160 }, title: '45° · 20 × 20 studs, two printed parts' },
      { label: '22.5° star', values: { angle: 22.5, length: 336, cross: 336 }, title: 'R104 star crossing: 22.5° · 42 × 42 studs' }
    ],
    customValues: { angle: 30, length: shortestLeg(30), cross: shortestLeg(30) },
    custom: [
      { key: 'angle', label: 'Angle', unit: 'deg', min: CROSSING_MIN_ANGLE, max: 90, step: 0.5, signed: true },
      { key: 'length', label: 'Main leg', unit: 'mm', min: 64, max: 1024, step: 8 },
      { key: 'cross', label: 'Crossing leg', unit: 'mm', min: 64, max: 1024, step: 8 }
    ] }],
  initial: { angle: 45, length: 160, cross: 160 },
  values: piece => pickValues(TRACK_DIAMOND, piece, ['angle', 'length', 'cross']),
  shape: (given, source, customJoiner = false) => source === 'owned' || customJoiner ? null :
    { family: DIAMOND_FAMILY, params: { angle: given.angle, length: given.length, cross: given.cross } },
  problem: ({ angle, length, cross }) => {
    if (!(length >= 64 && length <= 1024 && cross >= 64 && cross <= 1024)) return 'Legs must be 64 to 1024 mm.';
    const problem = crossingProblem(diamondPaths({ angle, length, cross }), angle);
    return problem && Math.abs(angle) >= CROSSING_MIN_ANGLE ? `${problem} At ${Math.abs(angle)}° both legs need ${shortestLeg(angle)} mm.` : problem;
  },
  caution: ({ angle }) => Math.abs(angle) < CROSSING_WARN_ANGLE - 1e-9 ? SHALLOW_CROSSING : null,
  describe: ({ angle, length, cross }) => `${angleText(angle)} · ${studs(length)} × ${studs(cross)}`
};

/** A straight crossed by an R40 or R56 arc (or any radius): loops crossing a straight at any angle. */
export const CURVE_CROSSING_KIND: TrackKind = {
  id: 'curve-crossing', label: 'Curve crossing', group: 'junction', hand: 'angle', families: [CURVE_CROSSING_FAMILY],
  rows: [
    { label: 'Radius', match: ['radius'],
      choices: [R40, R56].map(radius => ({ label: `R${studs(radius)}`, values: { radius }, title: `${radius} mm radius` })),
      custom: [{ key: 'radius', label: 'Radius', unit: 'mm', min: 192, max: 1472, step: 8 }] },
    { label: 'Angle', match: ['angle', 'sweep', 'length'],
      choices: [{ label: '45° · 45°', values: { angle: 45, sweep: 45, length: 208 }, title: 'Crosses at 45°; its ends sit on the 22.5° curve grid' },
        { label: '90° · 22.5°', values: { angle: 90, sweep: 22.5, length: 128 }, title: 'One 22.5° curve crossing square' }],
      custom: [
        { key: 'angle', label: 'Angle', unit: 'deg', min: CROSSING_MIN_ANGLE, max: 90, step: 0.5, signed: true },
        { key: 'sweep', label: 'Curve', unit: 'deg', min: 5, max: 90, step: 0.5 },
        { key: 'length', label: 'Main leg', unit: 'mm', min: 64, max: 1024, step: 8 }
      ] }
  ],
  initial: { radius: R40, bend: 1, angle: 45, sweep: 45, length: 208 },
  // Which way the arc bends is not a choice: the other way is the same piece turned end for end. `bend` keeps a placed piece's way.
  values: piece => {
    const { angle, length, radius, sweep } = pickValues(TRACK_CURVE_CROSSING, piece, ['angle', 'length', 'radius', 'sweep']);
    return { angle, length, sweep, radius: Math.abs(radius), bend: Math.sign(radius) * Math.sign(angle || 1) };
  },
  shape: ({ angle, length, radius, sweep, bend }, source, customJoiner = false) => source === 'owned' || customJoiner ? null :
    { family: CURVE_CROSSING_FAMILY, params: { angle, length, sweep, radius: bend * Math.sign(angle || 1) * radius } },
  problem: ({ angle, length, radius, sweep, bend }) => {
    if (!(radius >= 192 && radius <= 1472)) return 'Radius must be 192 to 1472 mm (R24 to R184).';
    if (!(sweep >= 5 && sweep <= 90) || !(length >= 64 && length <= 1024)) return 'Curve must turn 5° to 90° over a 64 to 1024 mm leg.';
    return crossingProblem(curveCrossingPaths({ angle, length, sweep, radius: bend * Math.sign(angle || 1) * radius }), angle);
  },
  caution: ({ angle }) => Math.abs(angle) < CROSSING_WARN_ANGLE - 1e-9 ? SHALLOW_CROSSING : null,
  describe: ({ angle, radius, sweep }) => `R${studs(radius)} ${sweep}° · ${angleText(angle)}`
};
