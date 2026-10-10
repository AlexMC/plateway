import { compositeCentreline } from '../pieces/composite';
import type { CompositeTrack, TrackSegment } from '../pieces/types';

/** An open end as `piecePorts` gives it: position and the heading pointing out of its piece. */
export interface GapEnd { x: number; y: number; z: number; heading: number }
/** The far end in the start end's frame: where the path must arrive and its heading of travel there. */
export interface GapTarget { x: number; y: number; heading: number }
/** Candidate paths from the origin (heading 0) to `target`; each is checked for exactness before use. */
export type GapStrategy = (target: GapTarget) => TrackSegment[][];

export const DEFAULT_MIN_RADIUS = 320;
export const LOWEST_MIN_RADIUS = 192;
/** Composite printed track limits (cad/models/composite.py). */
export const GAP_MIN_LENGTH = 24, GAP_MAX_LENGTH = 2000;
/** The finished path must end this close to the far port, so the two ports mate. */
export const GAP_POSITION_TOLERANCE = 0.05, GAP_HEADING_TOLERANCE = 0.01 * Math.PI / 180;
const MAX_TURN = Math.PI, LEVEL_TOLERANCE = 0.05;

export type GapSolution =
  | { ok: true; segments: TrackSegment[]; length: number; minRadius: number }
  | { ok: false; reason: string; minRadius?: number };

const normalize = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
const straight = (len: number): TrackSegment => ({ len, k0: 0, k1: 0 });
/** Segments shorter than this are dropped; they move the end by less than the tolerance. */
const TINY = 1e-4;

/** Circular arc (or straight) from the origin heading `heading` to (dx, dy); null if it would double back. */
function arcTo(heading: number, dx: number, dy: number): { segment: TrackSegment; heading: number } | null {
  const chord = Math.hypot(dx, dy);
  if (chord < TINY) return null;
  const half = normalize(Math.atan2(dy, dx) - heading);
  if (Math.abs(half) >= Math.PI / 2) return null;
  if (Math.abs(half) < 1e-12) return { segment: straight(chord), heading };
  const k = 2 * Math.sin(half) / chord;
  return { segment: { len: half * chord / Math.sin(half), k0: k, k1: k }, heading: heading + 2 * half };
}

/** One straight when the far end lies dead ahead, facing back. */
const straightStrategy: GapStrategy = ({ x, y, heading }) =>
  Math.abs(heading) < 1e-6 && Math.abs(y) < 1e-3 && x > 0 ? [[straight(x)]] : [];

/** One arc tangent to both end lines, with the leftover run on the longer side as straight (or none). */
const arcStrategy: GapStrategy = ({ x, y, heading }) => {
  const turn = Math.abs(heading);
  if (turn < 1e-9 || Math.abs(Math.PI - turn) < 1e-9) return [];
  // The end lines cross `before` mm ahead of the start and `after` mm behind the end.
  const after = y / Math.sin(heading), before = x - after * Math.cos(heading);
  if (before < -TINY || after < -TINY) return [];
  const tangent = Math.max(0, Math.min(before, after)), radius = tangent / Math.tan(turn / 2);
  if (radius < TINY) return [];
  const k = Math.sign(heading) / radius;
  return [[straight(before - tangent), { len: radius * turn, k0: k, k1: k }, straight(after - tangent)].filter(segment => segment.len > TINY)];
};

/**
 * Two tangent arcs (either may be straight): for each ratio of the tangent lengths there is exactly one biarc,
 * so the ratio is swept on a log scale and the best one refined by golden-section search.
 */
const biarcStrategy: GapStrategy = target => {
  const biarc = (ratio: number): TrackSegment[] | null => {
    const { x, y, heading } = target, t1 = { x: Math.cos(heading), y: Math.sin(heading) };
    const w = { x: ratio + t1.x, y: t1.y }, vw = x * w.x + y * w.y, vv = x * x + y * y;
    const a = 2 * ratio * (Math.cos(heading) - 1);
    let d2: number;
    if (Math.abs(a) < 1e-12) { if (vw <= 0) return null; d2 = vv / (2 * vw); }
    else {
      const disc = 4 * vw * vw - 4 * a * vv;
      d2 = Math.max((2 * vw + Math.sqrt(disc)) / (2 * a), (2 * vw - Math.sqrt(disc)) / (2 * a));
    }
    if (!(d2 > 0)) return null;
    const d1 = ratio * d2, q1 = { x: d1, y: 0 }, q2 = { x: x - d2 * t1.x, y: y - d2 * t1.y };
    const joint = { x: (d2 * q1.x + d1 * q2.x) / (d1 + d2), y: (d2 * q1.y + d1 * q2.y) / (d1 + d2) };
    const first = arcTo(0, joint.x, joint.y);
    if (!first) return null;
    const second = arcTo(first.heading, x - joint.x, y - joint.y);
    return second ? [first.segment, second.segment] : null;
  };
  const score = (segments: TrackSegment[] | null) => segments ? minRadius(segments) : -1;
  const ratios = Array.from({ length: 241 }, (_, index) => 10 ** (-3 + index / 40));
  let best = -1, bestIndex = -1;
  ratios.forEach((ratio, index) => { const value = score(biarc(ratio)); if (value > best) { best = value; bestIndex = index; } });
  if (bestIndex < 0) return [];
  let low = Math.log10(ratios[Math.max(0, bestIndex - 1)]), high = Math.log10(ratios[Math.min(ratios.length - 1, bestIndex + 1)]);
  const golden = (Math.sqrt(5) - 1) / 2;
  for (let step = 0; step < 60; step++) {
    const left = high - golden * (high - low), right = low + golden * (high - low);
    if (score(biarc(10 ** left)) >= score(biarc(10 ** right))) high = right; else low = left;
  }
  return [biarc(10 ** ((low + high) / 2)), biarc(ratios[bestIndex])].filter((path): path is TrackSegment[] => path !== null);
};

/** Plain paths only (straights and arcs). A clothoid-smoothed variant is one more strategy in this list. */
export const PLAIN_STRATEGIES: readonly GapStrategy[] = [straightStrategy, arcStrategy, biarcStrategy];

export function minRadius(segments: readonly TrackSegment[]): number {
  return Math.min(...segments.map(segment => 1 / Math.max(Math.abs(segment.k0), Math.abs(segment.k1))));
}
export function totalTurn(segments: readonly TrackSegment[]): number {
  return segments.reduce((sum, { len, k0, k1 }) => sum + (k0 * k1 >= 0 ? (Math.abs(k0) + Math.abs(k1)) / 2 * len :
    len * (k0 * k0 + k1 * k1) / (2 * (Math.abs(k0) + Math.abs(k1)))), 0);
}
export const levelTrack = (segments: TrackSegment[]): CompositeTrack =>
  ({ segments, z0: 0, z1: 0, grade0: 0, grade1: 0, cant0: 0, cant1: 0, vcurve: 0 });

/** `to` in the frame of `from`, as the pose the path must arrive at (facing into `to`'s piece). */
export function gapTarget(from: GapEnd, to: GapEnd): GapTarget {
  const c = Math.cos(from.heading), s = Math.sin(from.heading), dx = to.x - from.x, dy = to.y - from.y;
  return { x: c * dx + s * dy, y: -s * dx + c * dy, heading: normalize(to.heading + Math.PI - from.heading) };
}

/** Joins neighbouring segments of equal curvature (a biarc of two equal arcs is one arc). */
function merged(segments: readonly TrackSegment[]): TrackSegment[] {
  const result: TrackSegment[] = [];
  for (const segment of segments) {
    const last = result.at(-1);
    if (last && last.k0 === last.k1 && segment.k0 === segment.k1 && Math.abs(last.k1 - segment.k0) <= 1e-9 * Math.abs(segment.k0))
      result[result.length - 1] = { ...last, len: last.len + segment.len };
    else result.push({ ...segment });
  }
  return result;
}
/** How often the path changes from turning one way to the other. */
function reversals(segments: readonly TrackSegment[]): number {
  const signs = segments.flatMap(({ k0, k1 }) => [Math.sign(k0), Math.sign(k1)]).filter(sign => sign !== 0);
  return signs.filter((sign, index) => index > 0 && sign !== signs[index - 1]).length;
}

/**
 * The plain path from open end `from` to open end `to`; a piece laid on it with its `in` at `from` (heading
 * `from.heading`) mates both ends. Among paths no tighter than `minRadius`: the fewest reverse curves (straight,
 * then one arc with straight, then S-bends), then the largest smallest radius. Rejections explain themselves in one line.
 */
export function solveGap(from: GapEnd, to: GapEnd, { minRadius: limit = DEFAULT_MIN_RADIUS, strategies = PLAIN_STRATEGIES }:
  { minRadius?: number; strategies?: readonly GapStrategy[] } = {}): GapSolution {
  const rise = to.z - from.z;
  if (Math.abs(rise) > LEVEL_TOLERANCE) return { ok: false, reason: `The ends are at different heights (${Math.abs(rise).toFixed(1)} mm apart); a gap closer joins level ends.` };
  const target = gapTarget(from, to), gap = Math.hypot(target.x, target.y);
  if (gap < GAP_MIN_LENGTH) return { ok: false, reason: `The ends are only ${gap.toFixed(1)} mm apart; a printed piece needs at least ${GAP_MIN_LENGTH} mm.` };
  const exact = strategies.flatMap(strategy => strategy(target)).flatMap(path => [merged(path), path]).filter(segments => {
    if (!segments.length || totalTurn(segments) > MAX_TURN + 1e-9) return false;
    // The far end as the piece's path (and so its `out` port) will place it.
    const end = compositeCentreline(levelTrack(segments)).at(-1)!;
    return Math.hypot(end.x - target.x, end.y - target.y) <= GAP_POSITION_TOLERANCE &&
      Math.abs(normalize(end.heading - target.heading)) <= GAP_HEADING_TOLERANCE;
  });
  if (!exact.length) return { ok: false, reason: 'The ends face away from each other; turn one of them first.' };
  const length = (segments: readonly TrackSegment[]) => segments.reduce((sum, segment) => sum + segment.len, 0);
  // Radii equal to the limit up to rounding count as meeting it.
  const wideEnough = exact.filter(segments => minRadius(segments) >= limit * (1 - 1e-9));
  const usable = wideEnough.filter(segments => length(segments) <= GAP_MAX_LENGTH);
  if (!usable.length) {
    const widest = Math.max(...exact.map(minRadius));
    if (wideEnough.length) return { ok: false, minRadius: widest,
      reason: `The path would be ${Math.round(Math.min(...wideEnough.map(length)))} mm; a gap closer is at most ${GAP_MAX_LENGTH} mm.` };
    return { ok: false, minRadius: widest, reason: `Needs a ${Math.round(widest)} mm radius; the minimum is ${limit} mm` +
      `${limit > LOWEST_MIN_RADIUS && widest >= LOWEST_MIN_RADIUS ? ' (lower it to allow this)' : ''}.` };
  }
  const best = usable.reduce((a, b) => {
    if (reversals(a) !== reversals(b)) return reversals(b) < reversals(a) ? b : a;
    const ra = minRadius(a), rb = minRadius(b);
    if (Math.abs(ra - rb) > 1e-6 * Math.min(ra, rb)) return rb > ra ? b : a;
    return b.length < a.length || b.length === a.length && length(b) < length(a) ? b : a;
  });
  return { ok: true, segments: best, length: length(best), minRadius: minRadius(best) };
}
