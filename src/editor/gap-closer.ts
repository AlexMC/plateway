import type { RoutePiece, WorkshopProject } from '../domain/project';
import { pieceIsFast } from '../domain/printer';
import { gaugesMate, primaryEnd, type ShapePort, type TrackSegment } from '../domain/pieces';
import { GAP_CLOSER, GAP_CLOSER_FAMILY, gapCloserParams } from '../domain/pieces/families/gap-closer';
import { DEFAULT_MIN_RADIUS, GAP_HEADING_TOLERANCE, GAP_MIN_LENGTH, GAP_POSITION_TOLERANCE, gapTarget, solveGap, type GapSolution } from '../domain/solver/gap';
import { BRICK_LAYOUT } from '../domain/track';
import { placePiece, previewPiece, unoccupiedPiecePorts, type Placement } from './operations';

/** Two open ends at most this far apart get a "Close this gap" offer in Checks. */
export const GAP_OFFER_DISTANCE = 400;
/** An open end: a port not mated with any other piece. */
export interface OpenEnd { pieceId: string; portId: string; port: ShapePort }
export interface GapPlan {
  /** The closer's `in` sits on `from`, its `out` on `to`. */
  from: OpenEnd; to: OpenEnd;
  solution: GapSolution;
  /** The piece that would be placed, when the solution is ok. */
  piece: RoutePiece | null;
}

export function openEnds(project: WorkshopProject): OpenEnd[] {
  return unoccupiedPiecePorts(project).map(({ part, port }) => ({ pieceId: part.id, portId: port.id, port }));
}

/**
 * The closest pair of open ends (among `ends`) within `within` mm that some plain path can join (at any radius, so a
 * too-tight gap is still offered and explains itself), or null. Ends facing apart are never paired.
 */
export function nearestGap(project: WorkshopProject, within = GAP_OFFER_DISTANCE, ends = openEnds(project)): [OpenEnd, OpenEnd] | null {
  const pairs: { pair: [OpenEnd, OpenEnd]; distance: number }[] = [];
  for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
    const a = ends[i].port, b = ends[j].port, distance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    if (distance <= within) pairs.push({ pair: [ends[i], ends[j]], distance });
  }
  pairs.sort((a, b) => a.distance - b.distance);
  return pairs.find(({ pair: [a, b] }) => solveGap(a.port, b.port, { minRadius: 0 }).ok)?.pair ?? null;
}

/**
 * Solve the closer between two open ends. The closer continues a route from its last piece when it can
 * (its `in` on a route's end), so merging keeps the existing route's direction.
 */
export function planGap(project: WorkshopProject, a: OpenEnd, b: OpenEnd, minRadius = DEFAULT_MIN_RADIUS): GapPlan {
  const reject = (reason: string): GapPlan => ({ from: a, to: b, solution: { ok: false, reason }, piece: null });
  if (a.pieceId === b.pieceId && a.portId === b.portId) return reject('Pick two different open ends.');
  if (project.trackSystem !== 'brick-v1') return reject('Gap closers need standard brick track.');
  if (![a, b].every(end => gaugesMate(end.port.gauge, GAP_CLOSER.gauge))) return reject('Gap closers join standard-gauge ends only.');
  const routeStart = (end: OpenEnd) => project.routes.some(route => route.pieces[0]?.id === end.pieceId && end.portId === 'in');
  const [from, to] = routeStart(a) && !routeStart(b) ? [b, a] : [a, b];
  const solution = solveGap(from.port, to.port, { minRadius });
  if (!solution.ok) return { from, to, solution, piece: null };
  return { from, to, solution, piece: previewPiece(project, GAP_CLOSER_FAMILY, closerPlacement(project, from, solution.segments), -1).piece };
}

function closerPlacement(project: WorkshopProject, from: OpenEnd, segments: readonly TrackSegment[]): Placement {
  const neighbour = project.routes.flatMap(route => route.pieces).find(piece => piece.id === from.pieceId);
  const fast = neighbour !== undefined && pieceIsFast(project, neighbour);
  return { x: from.port.x, y: from.port.y, z: from.port.z, heading: from.port.heading, params: gapCloserParams(segments), ...(fast ? { style: 'fast' as const } : {}) };
}

/** Place a solved closer; it merges the routes it touches, and closes the loop when both ends were one route's. */
export function closeGap(project: WorkshopProject, plan: GapPlan): [WorkshopProject, string] {
  if (!plan.solution.ok) throw new Error(plan.solution.reason);
  // Never snap: the pose is exact, and mergeTouchingRoutes joins both mated ends.
  return placePiece(project, GAP_CLOSER_FAMILY, closerPlacement(project, plan.from, plan.solution.segments), -1);
}

const STRAIGHT = BRICK_LAYOUT.straightLength, SECTOR = BRICK_LAYOUT.curveSweep;
const OWNED_STRAIGHT = 'brick_straight_nominal', OWNED_CURVE = 'brick_curve_r40';
/** One way to close a gap, laid on a copy of the layout and checked to join both ends exactly. */
export interface GapOption {
  /** "2 owned straights (256 mm) + 80 mm printed". */
  label: string;
  owned: number;
  printed: number;
  /** Millimetres of track to print. */
  printedLength: number;
  /** The made-to-measure piece bends, so the tightest bend allowed shaped it. */
  bent: boolean;
  /** The layout with the pieces in (commit it as one undoable change) and the laid pieces, last one last. */
  next: WorkshopProject;
  pieces: RoutePiece[];
}

/** Owned pieces of `family` the layout doesn't use yet. */
export function spareOwned(project: WorkshopProject, family: string): number {
  const used = project.routes.reduce((sum, route) => sum + route.pieces.filter(piece => piece.family === family).length, 0);
  return Math.max(0, (project.inventory[family] ?? 0) - used);
}

/**
 * The ways to join open ends `a` and `b`, at most three, the one to preselect first (fewest printed millimetres, then fewest
 * pieces): spare owned R40 curves for a turn of whole 22.5° steps, then spare owned 128 mm straights along what is dead
 * ahead, with a made-to-measure printed piece (no tighter than `minRadius`) for the rest; and the made-to-measure piece alone.
 * Each is laid on a copy and offered only when both ends then meet exactly.
 */
export function gapOptions(project: WorkshopProject, a: OpenEnd, b: OpenEnd, minRadius = DEFAULT_MIN_RADIUS): GapOption[] {
  if (project.trackSystem !== 'brick-v1' || `${a.pieceId}:${a.portId}` === `${b.pieceId}:${b.portId}`) return [];
  const { from, to } = planGap(project, a, b, minRadius), openBefore = unoccupiedPiecePorts(project).length;
  /** `curves` owned curves turning `sweep` each, then `straights` owned straights from `from`, then the printed rest. */
  const lay = (curves: number, sweep: number, straights: number): GapOption | null => {
    let next = project, end = from, closer: { length: number; minRadius: number } | null = null;
    const ids: string[] = [];
    try {
      for (const step of [...Array(curves).fill(sweep), ...Array(straights).fill(undefined)] as (number | undefined)[]) {
        const [laid, id] = placePiece(next, step === undefined ? OWNED_STRAIGHT : OWNED_CURVE,
          { x: end.port.x, y: end.port.y, z: end.port.z, heading: end.port.heading, ...(step === undefined ? {} : { sweep: step }) }, -1);
        const out = unoccupiedPiecePorts(laid).find(({ part }) => part.id === id);
        if (!out) return null;
        next = laid; ids.push(id); end = { pieceId: id, portId: out.port.id, port: out.port };
      }
      const left = gapTarget(end.port, to.port);
      if (Math.hypot(left.x, left.y) > GAP_POSITION_TOLERANCE || Math.abs(left.heading) > GAP_HEADING_TOLERANCE) {
        const plan = planGap(next, end, to, minRadius);
        if (!plan.solution.ok) return null;
        const [closed, id] = closeGap(next, plan);
        next = closed; ids.push(id); closer = plan.solution;
      }
    } catch { return null; }
    // Every laid piece is joined at both ends, and exactly the two ends it closed are gone.
    const open = unoccupiedPiecePorts(next);
    if (open.length !== openBefore - 2 || open.some(({ part }) => ids.includes(part.id))) return null;
    const placed = next.routes.flatMap(route => route.pieces), bent = closer !== null && Number.isFinite(closer.minRadius);
    const length = Math.round(closer?.length ?? 0), radius = bent ? ` · R${Math.round(closer!.minRadius)} min` : '';
    const parts = [
      ...(curves ? [`${curves} owned curve${curves === 1 ? '' : 's'} (${Number((curves * SECTOR * 180 / Math.PI).toFixed(1))}°)`] : []),
      ...(straights ? [`${straights} owned straight${straights === 1 ? '' : 's'} (${straights * STRAIGHT} mm)`] : []),
      ...(closer ? [curves || straights ? `${length} mm printed${bent ? ' bend' : ''}${radius}` : `1 printed ${bent ? 'bend' : 'straight'} ${length} mm${radius}`] : [])];
    return { label: parts.join(' + '), owned: curves + straights, printed: closer ? 1 : 0, printedLength: closer?.length ?? 0, bent, next,
      pieces: ids.map(id => placed.find(piece => piece.id === id)!) };
  };

  // Owned curves for whole 22.5° steps of the turn, then owned straights along the line those leave dead ahead.
  const turn = gapTarget(from.port, to.port).heading, steps = Math.round(turn / SECTOR), sweep = Math.sign(steps) * SECTOR;
  const whole = steps !== 0 && Math.abs(turn - steps * SECTOR) <= GAP_HEADING_TOLERANCE;
  const curves = whole ? Math.min(Math.abs(steps), spareOwned(project, OWNED_CURVE)) : 0;
  // Where those curves end, heading on: the straights' line.
  let start: ShapePort | Pick<ShapePort, 'x' | 'y' | 'z' | 'heading'> = from.port;
  for (let k = 0; k < curves; k++) start = primaryEnd({ id: 'probe', family: OWNED_CURVE, x: start.x, y: start.y, z: start.z, heading: start.heading, sweep }, project);
  const ahead = gapTarget(start, to.port);
  let straights = 0;
  if (Math.abs(ahead.heading) <= GAP_HEADING_TOLERANCE && Math.abs(ahead.y) <= GAP_POSITION_TOLERANCE && ahead.x > 0) {
    straights = Math.min(Math.floor((ahead.x + GAP_POSITION_TOLERANCE) / STRAIGHT), spareOwned(project, OWNED_STRAIGHT));
    const rest = ahead.x - straights * STRAIGHT;
    if (straights && rest > GAP_POSITION_TOLERANCE && rest < GAP_MIN_LENGTH) straights--;
  }
  const candidates = [[curves, straights], [curves, 0], [0, 0]].filter(([c, s], index, all) => all.findIndex(([oc, os]) => oc === c && os === s) === index);
  return candidates.map(([c, s]) => lay(c, sweep, s))
    .filter((option): option is GapOption => option !== null)
    .sort((x, y) => x.printedLength - y.printedLength || x.owned + x.printed - (y.owned + y.printed)).slice(0, 3);
}
