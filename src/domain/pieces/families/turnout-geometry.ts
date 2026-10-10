import type { RoutePiece } from '../../project';
import { paramValue } from '../composite';
import { arc, origin } from '../geometry';
import type { ParamSpec, PieceDefinition, PiecePath, ShapePoint, StateSpec } from '../types';
import { PRINTED_COLOR } from './composite-piece';

/**
 * Point-blade junctions (cad/models/turnout.py): each switch is two routes sharing a port; the CAD derives flexure
 * blades where they part. Manual points are held by a spacer; sprung points spring back to the set route after a
 * train trails through from the other one, so their diverging paths are `trailable`. Manual points may instead be
 * driven by an SG90 servo beside the track (cad/models/turnout_servo.py), which holds either position.
 */

type XY = { x: number; y: number };
const HALF = 31.9;
/** CAD defaults: blade flex length and the envelope's reach past it (turnout.FLEX, ENVELOPE_REACH). */
export const POINTS_FLEX = 48;
const ENVELOPE_REACH = 32;
export const R40 = 320, R56 = 448;

export const SPRUNG_PARAM: ParamSpec = { key: 'sprung', label: 'Points', unit: '', min: 0, max: 1, step: 1, default: 0,
  options: [{ value: 0, label: 'Manual' }, { value: 1, label: 'Sprung' }] };
export const HAND_PARAM: ParamSpec = { key: 'hand', label: 'Hand', unit: '', min: -1, max: 1, step: 2, default: 1,
  options: [{ value: 1, label: 'Left' }, { value: -1, label: 'Right' }] };
/** Manual points only: an SG90 servo beside the track throws and holds them (a controllable automation device). */
export const SERVO_PARAM: ParamSpec = { key: 'servo', label: 'Drive', unit: '', min: 0, max: 1, step: 1, default: 0,
  options: [{ value: 0, label: 'By hand' }, { value: 1, label: 'SG90 servo' }], when: { key: 'sprung', values: [0] } };
/**
 * Plan zone (piece frame) the servo, its housing, clamp and throw rod stay inside on side `side` (1 left, -1 right of
 * the toe): along the position-0 route from 32 mm before to 44 mm past the station where the routes first part by 1 mm,
 * out to 82 mm from that route, never past the toe. turnout_servo.editor_zone mirrors it and the CAD checks containment.
 */
export function servoZone(a: PiecePath, b: PiecePath, port: string, side: number): XY[] {
  const ra = resample(oriented(a, port)), rb = resample(oriented(b, port));
  const n = Math.min(ra.length, rb.length);
  let at = ra[n-1];
  for (let i = 0; i < n; i++) if (Math.hypot(ra[i].x - rb[i].x, ra[i].y - rb[i].y) >= 1) { at = ra[i]; break; }
  const tx = Math.cos(at.heading), ty = Math.sin(at.heading), nx = -ty*side, ny = tx*side;
  const corner = (along: number, lateral: number) => ({ x: at.x + tx*along + nx*lateral, y: at.y + ty*along + ny*lateral });
  const rect = side > 0 ? [corner(-32, 0), corner(44, 0), corner(44, 82), corner(-32, 82)]
    : [corner(-32, 82), corner(44, 82), corner(44, 0), corner(-32, 0)];
  // Clip to the inside of the toe: (p - toe) · inward >= 0.
  const toe = ra[0], ix = Math.cos(toe.heading), iy = Math.sin(toe.heading);
  const inside = (p: XY) => (p.x - toe.x)*ix + (p.y - toe.y)*iy;
  const out: XY[] = [];
  rect.forEach((p, i) => {
    const q = rect[(i + 1) % rect.length], dp = inside(p), dq = inside(q);
    if (dp >= 0) out.push(p);
    if ((dp >= 0) !== (dq >= 0)) out.push({ x: p.x + (q.x - p.x)*dp/(dp - dq), y: p.y + (q.y - p.y)*dp/(dp - dq) });
  });
  return out;
}

export function straightPoints(length: number, y = 0): ShapePoint[] {
  return [origin(y), { x: length, y, z: 0, heading: 0 }];
}
export function extend(points: ShapePoint[], length: number): void {
  const last = points.at(-1)!;
  points.push({ x: last.x + length*Math.cos(last.heading), y: last.y + length*Math.sin(last.heading), z: 0, heading: last.heading });
}

/** Resample from the first point every `step` mm (heading interpolated), like turnout._dense. */
function resample(points: readonly ShapePoint[], step = 1): { x: number; y: number; heading: number; s: number }[] {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i-1] + Math.hypot(points[i].x - points[i-1].x, points[i].y - points[i-1].y));
  const total = lengths.at(-1)!, out = [];
  let j = 0;
  for (let s = 0; ; s += step) {
    const station = Math.min(s, total);
    while (j < lengths.length - 2 && lengths[j+1] < station) j++;
    const span = lengths[j+1] - lengths[j], t = span > 0 ? (station - lengths[j]) / span : 0;
    const a = points[j], b = points[j+1];
    out.push({ x: a.x + t*(b.x - a.x), y: a.y + t*(b.y - a.y), heading: a.heading + t*(b.heading - a.heading), s: station });
    if (station >= total) break;
  }
  return out;
}
function oriented(path: PiecePath, port: string): ShapePoint[] {
  if (path.from === port) return path.points;
  if (path.to === port) return [...path.points].reverse().map(point => ({ ...point, heading: point.heading + Math.PI }));
  throw new Error(`Port ${port} is not an end of path ${path.id}.`);
}
/** Counterclockwise convex hull (Andrew's monotone chain). */
function hull(points: XY[]): XY[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: XY, a: XY, b: XY) => (a.x - o.x)*(b.y - o.y) - (a.y - o.y)*(b.x - o.x);
  const half = (list: XY[]) => {
    const out: XY[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length-2], out[out.length-1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/**
 * Conservative operating envelope of one set of points (piece frame, counterclockwise), the same rule as
 * turnout.Points.envelope: both routes from the shared port up to (first station 1 mm apart) + flex + 32 mm, ±31.9 mm.
 */
export function switchEnvelope(a: PiecePath, b: PiecePath, port: string, flex = POINTS_FLEX): XY[] {
  const ra = resample(oriented(a, port)), rb = resample(oriented(b, port));
  const n = Math.min(ra.length, rb.length);
  let parted = ra[n-1].s;
  for (let i = 0; i < n; i++) if (Math.hypot(ra[i].x - rb[i].x, ra[i].y - rb[i].y) >= 1) { parted = ra[i].s; break; }
  const reach = parted + flex + ENVELOPE_REACH, points: XY[] = [];
  for (const route of [ra, rb]) for (const p of route) {
    if (p.s > reach) break;
    const nx = -Math.sin(p.heading), ny = Math.cos(p.heading);
    points.push({ x: p.x + nx*HALF, y: p.y + ny*HALF }, { x: p.x - nx*HALF, y: p.y - ny*HALF });
  }
  return hull(points);
}

/** One switch: the two path ids and their shared port. */
export interface SwitchSpec { a: string; b: string; port: string }

/** A printed point-blade junction; `trailable` marks the paths a sprung switch lets trains trail through. */
export function turnoutDefinition(spec: {
  family: string; label: string; params: readonly ParamSpec[]; states: readonly StateSpec[];
  paths(piece: RoutePiece): PiecePath[]; switches: readonly SwitchSpec[];
  description(piece: RoutePiece): string; run(piece: RoutePiece): number; end?(piece: RoutePiece): ShapePoint;
  cad(piece: RoutePiece, state: number): Record<string, number>; flip?: PieceDefinition['flip']; notes?: readonly string[];
  /** Side its servos sit on (1 left, -1 right of the toe); mirrors turnout.servo_side. */
  servoSide(piece: RoutePiece): number;
}): PieceDefinition {
  const params: readonly ParamSpec[] = [...spec.params, SPRUNG_PARAM, SERVO_PARAM];
  const sprung = (piece: RoutePiece) => paramValue({ params }, piece, 'sprung') === 1;
  const servo = (piece: RoutePiece) => !sprung(piece) && paramValue({ params }, piece, 'servo') === 1;
  const stateIndex = (piece: RoutePiece) => Math.max(0, spec.states.findIndex(state => state.id === (piece.state ?? spec.states[0].id)));
  const definition: PieceDefinition = {
    family: spec.family, label: spec.label, group: 'junction', source: 'printed', styles: ['detailed', 'fast'],
    params, states: spec.states, gauge: 'standard', body: 'assembly', handed: true, customJoiner: false, color: PRINTED_COLOR,
    description: piece => `${spec.description(piece)}${sprung(piece) ? ' · sprung' : servo(piece) ? ' · servo' : ''}`,
    paths: piece => {
      const paths = spec.paths(piece);
      return sprung(piece) ? paths.map(path => (path.states ? { ...path, trailable: true } : path)) : paths;
    },
    run: spec.run, ...(spec.end ? { end: spec.end } : {}), ...(spec.flip ? { flip: spec.flip } : {}),
    notes: [...(spec.notes ?? []), 'Points: flexure blades on a tie bar, held by two screwed keepers; manual points lock with a printed spacer, sprung points spring back.',
      'SG90 servo drive: a throw rod under the stock rail to a servo housing clamped beside the track, away from the branch; the servo holds either position.'],
    envelopes: piece => {
      const paths = spec.paths(piece);
      const byId = (id: string) => paths.find(path => path.id === id)!;
      return [...spec.switches.map(sw => switchEnvelope(byId(sw.a), byId(sw.b), sw.port)),
        ...(servo(piece) ? spec.switches.map(sw => servoZone(byId(sw.a), byId(sw.b), sw.port, spec.servoSide(piece))) : [])];
    },
    cad: piece => [{ family: spec.family, parameters: { ...spec.cad(piece, stateIndex(piece)), sprung: sprung(piece) ? 1 : 0,
      switch_state: stateIndex(piece), ...(servo(piece) ? { servo: 1 } : {}) } }]
  };
  SWITCH_COUNT.set(definition, spec.switches.length);
  return definition;
}

const SWITCH_COUNT = new WeakMap<PieceDefinition, number>();
/** SG90 servos driving a piece's points: one per switch of a servo-driven point-blade junction, else 0. */
export function servoCount(definition: PieceDefinition, piece: RoutePiece): number {
  const switches = SWITCH_COUNT.get(definition);
  return switches && paramValue(definition, piece, 'sprung') !== 1 && paramValue(definition, piece, 'servo') === 1 ? switches : 0;
}

export const paramOf = (params: readonly ParamSpec[], piece: RoutePiece, key: string) => paramValue({ params }, piece, key);
export const handOf = (params: readonly ParamSpec[], piece: RoutePiece) => paramOf(params, piece, 'hand') < 0 ? -1 : 1;

/**
 * Diverging centreline from the toe for each radius family (studs), and the main line's length;
 * mirrors turnout._branch. R40 is the official 53404 shape; R56 oblique lands 16 studs over after one R56 curve;
 * R104 and R148 are Pythagorean S-bends returning parallel 16 studs over at 80 and 96 studs.
 */
export function branchPoints(radius: number, hand: number): { points: ShapePoint[]; main: number } {
  const points = [origin()];
  if (radius === 40) {
    const turn = Math.atan2(3, 4);
    arc(points, R40, hand*turn);
    arc(points, R40, -hand*(turn - Math.PI/8));
    return { points, main: 256 };
  }
  if (radius === 56) {
    arc(points, R56, hand*Math.PI/8);
    extend(points, (128 - 2*R56*(1 - Math.cos(Math.PI/8))) / Math.sin(Math.PI/8));
    return { points, main: 320 };
  }
  const [r, turn, main] = radius === 104 ? [832, Math.asin(5/13), 640] : [1184, Math.asin(12/37), 768];
  arc(points, r, hand*turn);
  arc(points, r, -hand*turn);
  points[points.length - 1] = { x: main, y: hand*128, z: 0, heading: 0 };
  return { points, main };
}

