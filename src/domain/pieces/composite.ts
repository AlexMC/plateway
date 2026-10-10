import type { RoutePiece } from '../project';
import { BRICK_TRACK } from '../track';
import { origin } from './geometry';
import type { CompositeTrack, ParamSpec, PieceDefinition, ShapePoint, TrackSegment } from './types';

export const COMPOSITE_FAMILY = 'composite_track';
/** Both ends carry brick connectors. */
export const BOTH_ENDS = 3;

export function compositeLength(track: CompositeTrack): number {
  return track.segments.reduce((sum, segment) => sum + segment.len, 0);
}

/** Numbers-only `composite_track` parameters (C2); options stay at their CAD defaults. */
export function compositeParameters(track: CompositeTrack, ends = BOTH_ENDS): Record<string, number> {
  return {
    segments: track.segments.length,
    ...Object.fromEntries(track.segments.flatMap((segment, i) =>
      [[`s${i}_len`, segment.len], [`s${i}_k0`, segment.k0], [`s${i}_k1`, segment.k1]])),
    z0: track.z0, z1: track.z1, grade0: track.grade0, grade1: track.grade1, vcurve: track.vcurve,
    cant0: track.cant0, cant1: track.cant1, ends
  };
}

/** Cant (degrees) at `station`: the piecewise profile when the track has one, else linear from cant0 to cant1. */
export function cantAt(track: CompositeTrack, station: number): number {
  const total = compositeLength(track);
  if (!track.cants) return track.cant0 + (track.cant1 - track.cant0) * (total ? station / total : 1);
  const knots = track.cants, index = knots.findIndex(knot => knot.s >= station - 1e-9);
  if (index <= 0) return index < 0 ? knots.at(-1)!.cant : knots[0].cant;
  const a = knots[index - 1], b = knots[index];
  return b.s - a.s < 1e-9 ? b.cant : a.cant + (b.cant - a.cant) * (station - a.s) / (b.s - a.s);
}
/** `ends` bits for the part of `track` between two stations: a brick connector wherever the cant there is zero (C2). */
export function sliceEnds(track: CompositeTrack, from: number, to: number): number {
  return (Math.abs(cantAt(track, from)) < 1e-9 ? 1 : 0) | (Math.abs(cantAt(track, to)) < 1e-9 ? 2 : 0);
}
/**
 * The flat underside of a printed part, relative to its start datum (composite.py Spec.base): the lowest point of the
 * height profile and of the pitched contacts of its brick connector ends.
 */
export function compositeUnderside(track: CompositeTrack, ends = BOTH_ENDS): number {
  const total = compositeLength(track);
  let low = Math.min(0, track.z1 - track.z0);
  for (let i = 0; i <= 400; i++) low = Math.min(low, profileAt(track, total * i / 400).z - track.z0);
  const contact = (z: number, grade: number) => {
    const pitch = Math.atan(grade);
    low = Math.min(low, z - 3.7 * Math.sin(pitch), z + (BRICK_TRACK.endLength + .05) * Math.sin(pitch));
  };
  if (ends & 1) contact(0, track.grade0);
  if (ends & 2) contact(track.z1 - track.z0, -track.grade1);
  return low;
}

/** World height of a printed `composite_track` part's flat underside, from its parameters (as fit emits them) posed at height `z`. */
export function partUnderside(parameters: Readonly<Record<string, number>>, z: number): number {
  const p = parameters, segments = Array.from({ length: p.segments }, (_, i) => ({ len: p[`s${i}_len`], k0: p[`s${i}_k0`], k1: p[`s${i}_k1`] }));
  return z + compositeUnderside({ segments, z0: p.z0, z1: p.z1, grade0: p.grade0, grade1: p.grade1, cant0: p.cant0, cant1: p.cant1, vcurve: p.vcurve }, p.ends);
}

/** Centreline in the track's start frame, sampled every ~`spacing` mm of arc length, with `station` = distance from the start. */
export function compositeCentreline(track: CompositeTrack, spacing = 4): (ShapePoint & { station: number })[] {
  const total = compositeLength(track);
  const points: (ShapePoint & { station: number })[] = [{ ...origin(), station: 0, pitch: Math.atan(track.grade0), roll: cantAt(track, 0) * Math.PI / 180 }];
  let x = 0, y = 0, heading = 0, station = 0;
  for (const segment of track.segments) {
    const steps = Math.max(1, Math.ceil(segment.len / spacing)), ds = segment.len / steps;
    for (let i = 1; i <= steps; i++) {
      // Midpoint rule on curvature keeps clothoids accurate at this spacing; arcs and straights are exact in heading.
      const k = segment.k0 + (segment.k1 - segment.k0) * (i - 0.5) / steps, turn = k * ds;
      const chord = Math.abs(turn) < 1e-12 ? ds : 2 * Math.sin(turn / 2) / k;
      x += chord * Math.cos(heading + turn / 2); y += chord * Math.sin(heading + turn / 2);
      heading += turn; station += ds;
      const { z, grade } = profileAt(track, station);
      points.push({ x, y, z, heading, station,
        pitch: Math.atan(grade), roll: (track.cants ? cantAt(track, station) : track.cant0 + (track.cant1 - track.cant0) * (total ? station / total : 1)) * Math.PI / 180 });
    }
  }
  return points;
}
/**
 * Height and grade at `station`: cubic Hermite between the profile knots (`heights`), else between the end heights and
 * grades (the CAD applies its own vertical-curve limit).
 */
function profileAt(track: CompositeTrack, station: number): { z: number; grade: number } {
  const knots = track.heights ?? [{ s: 0, z: track.z0, grade: track.grade0 }, { s: compositeLength(track), z: track.z1, grade: track.grade1 }];
  const index = Math.min(knots.length - 1, Math.max(1, knots.findIndex(knot => knot.s >= station - 1e-9)));
  const a = knots[index - 1], b = knots[index], length = b.s - a.s;
  if (!(length > 1e-9)) return { z: b.z, grade: b.grade };
  const u = Math.min(1, Math.max(0, (station - a.s) / length));
  return { z: (2*u**3 - 3*u**2 + 1) * a.z + (u**3 - 2*u**2 + u) * a.grade * length + (-2*u**3 + 3*u**2) * b.z + (u**3 - u**2) * b.grade * length,
    grade: ((6*u**2 - 6*u) * a.z + (3*u**2 - 4*u + 1) * a.grade * length + (-6*u**2 + 6*u) * b.z + (3*u**2 - 2*u) * b.grade * length) / length };
}
/**
 * Full-tie centres of the piece's own modular layout: 32 mm pitch inward from both ends, residual in the middle.
 * Cutting only here gives every sub-part the same end half-ties and the parent's tie pattern exactly.
 */
export function tieStations(length: number): number[] {
  const { tiePitch } = BRICK_TRACK;
  const count = Math.max(0, Math.floor((length - tiePitch + 1e-9) / tiePitch));
  const stations: number[] = [];
  for (let index = 1; index <= Math.floor(count / 2); index++) stations.push(tiePitch * index, length - tiePitch * index);
  if (count % 2) stations.push(length / 2);
  return stations.sort((a, b) => a - b);
}

/** The part of `track` between two stations; curvature, height, grade and cant are those of the parent there. */
export function compositeSlice(track: CompositeTrack, from: number, to: number): CompositeTrack {
  const total = compositeLength(track), segments: TrackSegment[] = [];
  let start = 0;
  for (const segment of track.segments) {
    const end = start + segment.len, a = Math.max(from, start), b = Math.min(to, end);
    if (b - a > 1e-9) {
      const k = (s: number) => segment.len ? segment.k0 + (segment.k1 - segment.k0) * (s - start) / segment.len : segment.k0;
      segments.push({ len: b - a, k0: k(a), k1: k(b) });
    }
    start = end;
  }
  const at = (station: number) => total ? station / total : 0;
  const cant = (station: number) => track.cants ? cantAt(track, station) : track.cant0 + (track.cant1 - track.cant0) * at(station);
  const cants = track.cants && [{ s: 0, cant: cant(from) },
    ...track.cants.filter(knot => knot.s > from + 1e-9 && knot.s < to - 1e-9).map(knot => ({ s: knot.s - from, cant: knot.cant })),
    { s: to - from, cant: cant(to) }];
  const low = profileAt(track, from), high = profileAt(track, to);
  const inner = (track.heights ?? []).filter(knot => knot.s > from + 1e-9 && knot.s < to - 1e-9);
  const heights = inner.length ? [{ s: 0, z: 0, grade: low.grade },
    ...inner.map(knot => ({ s: knot.s - from, z: knot.z - low.z, grade: knot.grade })), { s: to - from, z: high.z - low.z, grade: high.grade }] : null;
  return { segments, z0: 0, z1: high.z - low.z, grade0: low.grade, grade1: high.grade, cant0: cant(from), cant1: cant(to), vcurve: track.vcurve,
    ...(cants ? { cants } : {}), ...(heights ? { heights } : {}) };
}

/** Printed track of any length (sweep 0) or any radius and sweep: one `composite_track` part, split to the bed by fit. */
const PARAMS: readonly ParamSpec[] = [
  { key: 'length', label: 'Length', unit: 'mm', min: 24, max: 2000, step: 8, default: 128 },
  { key: 'radius', label: 'Radius', unit: 'mm', min: 192, max: 1472, step: 8, default: 320 },
  { key: 'sweep', label: 'Sweep', unit: 'deg', min: -90, max: 90, step: 0.5, default: 0 }
];
export function paramValue(definition: Pick<PieceDefinition, 'params'>, piece: RoutePiece, key: string): number {
  return piece.params?.[key] ?? definition.params.find(spec => spec.key === key)!.default;
}
function printedTrack(piece: RoutePiece): CompositeTrack {
  const value = (key: string) => paramValue({ params: PARAMS }, piece, key);
  const sweep = value('sweep') * Math.PI / 180, curvature = Math.sign(sweep) / value('radius');
  const segment = sweep ? { len: value('radius') * Math.abs(sweep), k0: curvature, k1: curvature } : { len: value('length'), k0: 0, k1: 0 };
  return { segments: [segment], z0: 0, z1: 0, grade0: 0, grade1: 0, cant0: 0, cant1: 0, vcurve: 0 };
}
export const PRINTED_TRACK: PieceDefinition = {
  family: 'printed_track', label: 'Printed track', group: 'track', source: 'printed',
  description: piece => {
    const value = (key: string) => paramValue({ params: PARAMS }, piece, key);
    return value('sweep') ? `${value('radius')} mm radius · ${Math.abs(value('sweep'))}°` : `${value('length')} mm`;
  },
  styles: ['detailed', 'fast'], params: PARAMS, gauge: 'standard', body: 'path', customJoiner: false, hidden: true, color: 0xe7a871,
  composite: printedTrack,
  reverseParams: params => params.sweep === undefined ? { ...params } : { ...params, sweep: -params.sweep },
  run: piece => compositeLength(printedTrack(piece)),
  paths: piece => [{ id: 'main', from: 'in', to: 'out', points: compositeCentreline(printedTrack(piece)).map(({ station: _, ...point }) => point) }],
  cad: piece => [{ family: COMPOSITE_FAMILY, parameters: compositeParameters(printedTrack(piece)) }]
};

/**
 * Stations (from 0 to the full length) that cut `track` into parts that each pass `fits`, cutting only at tie stations.
 * Uses the fewest parts, as even in length as the tie stations allow; null when some stretch cannot fit between stations.
 * A cant or height profile's interior knots are always cut; canted stations may be cut too (plain ends, see `sliceEnds`).
 */
export function splitComposite(track: CompositeTrack, fits: (part: CompositeTrack) => boolean): number[] | null {
  const length = compositeLength(track);
  const knots = [...new Set([...(track.cants ?? []), ...(track.heights ?? [])].map(knot => knot.s))]
    .filter(s => s > 1e-9 && s < length - 1e-9).sort((a, b) => a - b);
  if (!knots.length && fits(track)) return [0, length];
  // A connector end must be uncanted, so a canted stretch is cut only where the track allows plain ends.
  const stations = track.cants ? tieStations(length) :
    tieStations(length).filter(station => track.cant0 + (track.cant1 - track.cant0) * station / length === 0);
  const range = (low: number, high: number): number[] | null => {
    if (fits(compositeSlice(track, low, high))) return [low, high];
    const inside = stations.filter(station => station > low + 1e-9 && station < high - 1e-9), cuts = [low];
    while (!fits(compositeSlice(track, cuts.at(-1)!, high))) {
      const from = cuts.at(-1)!, next = inside.filter(station => station > from && fits(compositeSlice(track, from, station))).at(-1);
      if (next === undefined) return null;
      cuts.push(next);
    }
    cuts.push(high);
    const parts = cuts.length - 1, span = high - low;
    const even = [low, ...Array.from({ length: parts - 1 }, (_, index) => inside.reduce((best, station) =>
      Math.abs(station - low - span * (index + 1) / parts) < Math.abs(best - low - span * (index + 1) / parts) ? station : best)), high];
    const evenFits = even.every((station, index) => !index || station > even[index - 1] && fits(compositeSlice(track, even[index - 1], station)));
    return evenFits ? even : cuts;
  };
  const bounds = [0, ...knots, length], cuts = [0];
  for (let index = 1; index < bounds.length; index++) {
    const part = range(bounds[index - 1], bounds[index]);
    if (!part) return null;
    cuts.push(...part.slice(1));
  }
  return cuts;
}
