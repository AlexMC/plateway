import type { Route, RoutePiece, WorkshopProject } from '../domain/project';
import { counterpartFamily, pieceDefinition, piecePorts, primaryEnd } from '../domain/pieces';
import { GAP_HEADING_TOLERANCE, GAP_POSITION_TOLERANCE } from '../domain/solver/gap';
import { BRICK_LAYOUT } from '../domain/track';
import { spareOwned, type OpenEnd } from './gap-closer';
import { insertAtJoint, placePiece, tileFits, unoccupiedPiecePorts, type TileFamily } from './operations';

/** The plain 128 mm straight a short side is made up with. */
const STRAIGHT = BRICK_LAYOUT.straightLength, STRAIGHT_FAMILY = 'brick_straight_nominal';
/** A chain turning this much (a loop up to four 22.5° curves short or long), on one level, is a loop that doesn't close. */
const LOOP_TURN_MIN = 1.5 * Math.PI - 1e-3, LOOP_TURN_MAX = 2.5 * Math.PI + 1e-3, LOOP_LEVEL = 1;
/** "Whole" curve pieces and straights; the joined loop itself is held to the gap solver's exactness. */
const WHOLE_ANGLE = 1e-3, WHOLE_LENGTH = 0.05, SIDEWAYS = 0.5, PARALLEL = 1e-3;
const DEG = 180 / Math.PI;

type Pose = { x: number; y: number; z: number; heading: number };
export type Side = 'top' | 'bottom' | 'left' | 'right';
/** One reason the ends miss, in plain words by `explainGap`'s text. */
export type GapCause =
  /** `count` curve pieces of `sector` radians short of a full turn; `bend` is the short bend, `others` the pieces in each bend. */
  | { kind: 'curves-short'; count: number; sector: number; bend: Side | null; pieces: number; others: { side: Side | null; pieces: number }[] }
  | { kind: 'curves-over'; count: number; sector: number }
  /** The ends point `degrees` apart, not a whole number of curve pieces. */
  | { kind: 'turn'; degrees: number }
  /** `side` is `straights` × 128 mm shorter than `than` (null when no opposite side matches). */
  | { kind: 'short-side'; side: Side | null; straights: number; than: Side | null }
  /** `distance` mm sideways, and `along` mm ahead (negative: behind) along the line. */
  | { kind: 'offset'; distance: number; along: number }
  /** In line but `distance` mm apart (negative: overlapping), not whole straights. */
  | { kind: 'in-line'; distance: number };
export interface GapFix {
  label: string;
  /** Where the pieces come from: owned stock first, then printed. */
  note: string;
  apply(project: WorkshopProject): WorkshopProject;
}
export interface GapExplanation {
  /** Turn still missing for `a` to arrive facing into `b` (radians, + = left). */
  turn: number;
  /** `b` in `a`'s frame once the missing curves are in (as is when the turn isn't whole curves): mm ahead and mm to the left. */
  along: number;
  lateral: number;
  /** The loop's curve family and how many of its pieces are missing (negative: too many). */
  curve: { family: string; sector: number; missing: number } | null;
  /** 128 mm straights missing on the short side. */
  straights: number;
  causes: GapCause[];
  text: string;
  /** Where the missing pieces belong: the short side's pieces and the pieces either side of the short bend's joint. */
  pieceIds: string[];
  /** Adds the missing pieces there as one change and the loop closes exactly; null when whole pieces can't close it. */
  fix: GapFix | null;
}

const normalize = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
const compose = (p: Pose, m: Pose): Pose => {
  const c = Math.cos(p.heading), s = Math.sin(p.heading);
  return { x: p.x + c * m.x - s * m.y, y: p.y + s * m.x + c * m.y, z: p.z + m.z, heading: p.heading + m.heading };
};
const relative = (p: Pose, q: Pose): Pose => {
  const c = Math.cos(p.heading), s = Math.sin(p.heading), dx = q.x - p.x, dy = q.y - p.y;
  return { x: c * dx + s * dy, y: -s * dx + c * dy, z: q.z - p.z, heading: normalize(q.heading - p.heading) };
};
const pose = ({ x, y, z, heading }: Pose): Pose => ({ x, y, z, heading });
const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const degrees = (radians: number) => `${Number((Math.abs(radians) * DEG).toFixed(1))}°`;
const mm = (value: number) => `${Math.round(Math.abs(value))} mm`;

/** A route read from its first piece's `in` (the loop's start, `b`) to its last piece's `out` (`a`). */
interface Chain { joints: Pose[]; bends: number[]; kinds: ('straight' | 'curve' | 'other')[] }
/** Consecutive pieces `from`..`to` (inclusive) of one kind: a straight run or a bend turning one way. */
interface Stretch { from: number; to: number }
interface Step { family: TileFamily; sweep?: number; at: number | 'end' }

function chainOf(project: WorkshopProject, route: Route): Chain {
  const joints = [...route.pieces.map(pose), pose(primaryEnd(route.pieces.at(-1)!, project))];
  const bends = route.pieces.map((_, index) => normalize(joints[index + 1].heading - joints[index].heading));
  const kinds = route.pieces.map((_, index) => {
    const local = relative(joints[index], joints[index + 1]);
    return Math.abs(bends[index]) > 1e-6 ? 'curve' as const : Math.abs(local.y) < 1e-3 && local.x > 0 ? 'straight' as const : 'other' as const;
  });
  return { joints, bends, kinds };
}
/** Maximal stretches of pieces that `same` groups together. */
function stretches(count: number, member: (index: number) => boolean, same: (a: number, b: number) => boolean): Stretch[] {
  const result: Stretch[] = [];
  for (let index = 0; index < count; index++) {
    if (!member(index)) continue;
    const last = result.at(-1);
    if (last && last.to === index - 1 && same(last.to, index)) last.to = index; else result.push({ from: index, to: index });
  }
  return result;
}
/** Joints after putting a piece ending at `local` in at joint `at`: the pieces from there move along rigidly. */
function insertPose(joints: readonly Pose[], at: number, local: Pose): Pose[] {
  const start = joints[at], end = compose(start, local);
  return [...joints.slice(0, at + 1), end, ...joints.slice(at + 1).map(joint => compose(end, relative(start, joint)))];
}
/** Which side of the layout (as the top view shows it, y up the screen) the pieces `from`..`to` lie on. */
function sideOf(joints: readonly Pose[], stretch: Stretch, centre: { x: number; y: number }): Side | null {
  const points = joints.slice(stretch.from, stretch.to + 2);
  const x = points.reduce((sum, point) => sum + point.x, 0) / points.length - centre.x, y = points.reduce((sum, point) => sum + point.y, 0) / points.length - centre.y;
  if (Math.hypot(x, y) < 1) return null;
  return Math.abs(x) > Math.abs(y) ? x < 0 ? 'left' : 'right' : y > 0 ? 'top' : 'bottom';
}
/** The route running from one end (its first piece's `in`) round to the other (its last piece's `out`). */
function routeBetween(project: WorkshopProject, a: OpenEnd, b: OpenEnd): Route | null {
  const ends = (route: Route) => [`${route.pieces[0].id}:in`, `${route.pieces.at(-1)!.id}:out`];
  const wanted = [`${a.pieceId}:${a.portId}`, `${b.pieceId}:${b.portId}`].sort().join();
  return project.routes.find(route => route.pieces.length > 1 && ends(route).sort().join() === wanted) ?? null;
}

/** Pieces of one shape to lay: their families in laying order (owned first), and the owned stock behind them. */
interface Stock { families: string[]; owned: number; spare: number; total: number }
/** `count` pieces of a shape: owned while stock lasts, then printed; null when they can't be had on this track system. */
function stock(project: WorkshopProject, family: string, count: number): Stock | null {
  const definition = pieceDefinition(family), ownedFamily = definition.owned?.family;
  const printed = definition.source === 'printed' ? family : counterpartFamily(family, 'printed');
  const free = ownedFamily ? spareOwned(project, ownedFamily) : 0, owned = Math.min(free, count);
  if (owned < count && (!printed || !tileFits(project, printed))) return null;
  const total = ownedFamily ? project.inventory[ownedFamily] ?? 0 : 0;
  return { families: [...Array(owned).fill(ownedFamily), ...Array(count - owned).fill(printed)], owned, spare: free, total };
}
function stockNote(name: string, many: string, count: number, from: Stock): string {
  const inUse = from.total - from.spare;
  if (from.owned === count) return `${count === 1 ? capital(name) : `${count} ${many}`} from your stock (${inUse} of ${from.total} in use)`;
  if (!from.owned) return `${count === 1 ? capital(name) : `${count} ${many}`} printed (${from.total ? `all ${from.total} owned in use` : 'none owned'})`;
  return `${from.owned} ${from.owned === 1 ? name : many} from your stock, ${count - from.owned} printed (all ${from.total} owned in use)`;
}
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Lays `steps` in order on the route that starts with `firstId`: at a joint by the insert logic, at `end` on its last piece's end. */
function layPieces(project: WorkshopProject, firstId: string, steps: readonly Step[]): WorkshopProject {
  for (const step of steps) {
    const route = project.routes.find(item => item.pieces[0]?.id === firstId);
    if (!route) throw new Error('The loop changed; check it again.');
    const placement = { x: 0, y: 0, ...(step.sweep === undefined ? {} : { sweep: step.sweep }) };
    if (step.at === 'end') {
      const end = primaryEnd(route.pieces.at(-1)!, project);
      // Exactly on the end, never snapped: the route merges it as its new last piece.
      [project] = placePiece(project, step.family, { ...placement, x: end.x, y: end.y, z: end.z, heading: end.heading }, -1);
    } else project = insertAtJoint(project, step.family, placement, route.id, step.at, false).next;
  }
  return project;
}
/** The route starting with `firstId` is a closed loop, its two ends meeting within the gap solver's tolerance. */
function closesExactly(project: WorkshopProject, firstId: string): boolean {
  const route = project.routes.find(item => item.pieces.some(piece => piece.id === firstId));
  if (!route || route.pieces.length < 2) return false;
  const start = piecePorts(route.pieces[0], project).find(port => port.id === 'in');
  const end = piecePorts(route.pieces.at(-1)!, project).find(port => port.id === 'out');
  return !!start && !!end && Math.hypot(start.x - end.x, start.y - end.y, start.z - end.z) <= GAP_POSITION_TOLERANCE &&
    Math.abs(normalize(start.heading - end.heading - Math.PI)) <= GAP_HEADING_TOLERANCE;
}

/**
 * Why open end `a` misses open end `b`, in plain words. `b` is put in `a`'s frame: the turn still missing (as whole curve pieces of
 * the loop's curve family), then what is left once those curves are in, along the line and sideways. On a route running from one end
 * round to the other, the missing curves go at the end of the bend that turns least, and missing 128 mm straights on the straight side
 * whose direction closes what is left — "the bottom side is one straight shorter than the top side". `fix` lays exactly those pieces
 * (owned first) with the insert logic, offered only when the loop then closes exactly.
 */
export function explainGap(project: WorkshopProject, a: OpenEnd, b: OpenEnd): GapExplanation {
  const route = routeBetween(project, a, b);
  const raw = relative(pose(a.port), { ...pose(b.port), heading: b.port.heading + Math.PI });
  if (!route) {
    const causes = looseCauses(raw);
    return { turn: raw.heading, along: raw.x, lateral: raw.y, curve: null, straights: 0, causes, text: describe(causes), pieceIds: [a.pieceId, b.pieceId], fix: null };
  }
  const { joints, bends, kinds } = chainOf(project, route), n = bends.length;
  const firstId = route.pieces[0].id, ids = route.pieces.map(piece => piece.id);
  const total = bends.reduce((sum, bend) => sum + bend, 0), sense = Math.sign(total) || 1;
  // B travels into its first piece at joints[0]; A leaves at joints[n]. The turn still missing closes A onto B.
  const turn = normalize(joints[0].heading - joints[n].heading);
  const centre = { x: joints.reduce((sum, joint) => sum + joint.x, 0) / joints.length, y: joints.reduce((sum, joint) => sum + joint.y, 0) / joints.length };

  // The loop's curve shape: its commonest curve piece turning the loop's way.
  const shapes = new Map<string, { family: string; sector: number; count: number }>();
  route.pieces.forEach((piece, index) => {
    if (kinds[index] !== 'curve' || Math.sign(bends[index]) !== sense || pieceDefinition(piece.family).legacy?.sweep === undefined) return;
    const key = `${piece.family}:${Math.abs(bends[index]).toFixed(6)}`, shape = shapes.get(key) ?? { family: piece.family, sector: Math.abs(bends[index]), count: 0 };
    shape.count++; shapes.set(key, shape);
  });
  const shape = [...shapes.values()].sort((x, y) => y.count - x.count)[0];
  const exact = shape ? turn / shape.sector : NaN, missing = Math.round(exact);
  const whole = shape !== undefined && Math.abs(exact - missing) * shape.sector < WHOLE_ANGLE;
  const curve = shape && whole ? { family: shape.family, sector: shape.sector, missing } : null;

  const bendsOf = stretches(n, index => kinds[index] === 'curve', (x, y) => Math.sign(bends[x]) === Math.sign(bends[y]))
    .filter(stretch => Math.sign(bends[stretch.from]) === sense);
  const runs = stretches(n, index => kinds[index] === 'straight', () => true);
  const runLength = (stretch: Stretch) => ids.slice(stretch.from, stretch.to + 1)
    .reduce((sum, _, k) => sum + Math.hypot(joints[stretch.from + k + 1].x - joints[stretch.from + k].x, joints[stretch.from + k + 1].y - joints[stretch.from + k].y), 0);

  // Where the missing curves can go: the end of each bend turning the loop's way, the bend turning least first.
  const curveSpots: { bend: Stretch | null; at: number | 'end' }[] = !curve || curve.missing === 0 ? [{ bend: null, at: 'end' }] : curve.missing < 0 ? [] :
    [...bendsOf].sort((x, y) => (x.to - x.from) - (y.to - y.from)).map(bend => ({ bend, at: bend.to === n - 1 ? 'end' as const : bend.to + 1 }));

  type Plan = { bend: Stretch | null; curveAt: number | 'end'; run: Stretch | null; runAt: number | 'end'; straights: number;
    along: number; lateral: number; aligned: boolean; closes: boolean; laid: Pose[]; moved: (index: number) => number };
  const plans: Plan[] = [];
  for (const spot of curveSpots) {
    let laid = joints.slice(), shift = 0;
    const at = spot.at === 'end' ? n : spot.at;
    if (curve && curve.missing > 0) {
      const local = pose(primaryEnd({ id: 'probe', family: curve.family, x: 0, y: 0, z: 0, heading: 0, sweep: sense * curve.sector }, project));
      for (let k = 0; k < curve.missing; k++) laid = insertPose(laid, at + k, local);
      shift = curve.missing;
    }
    // A piece's index once the curves are in.
    const moved = (index: number) => index >= at ? index + shift : index;
    const end = laid.at(-1)!, residual = relative(end, laid[0]);
    const aligned = Math.abs(normalize(residual.heading)) <= WHOLE_ANGLE && Math.abs(residual.z) <= WHOLE_LENGTH;
    const plan: Plan = { bend: spot.bend, curveAt: spot.at, run: null, runAt: 'end', straights: 0, along: residual.x, lateral: residual.y, aligned, closes: false, laid, moved };
    plans.push(plan);
    if (!aligned) continue;
    const gap = { x: laid[0].x - end.x, y: laid[0].y - end.y }, distance = Math.hypot(gap.x, gap.y);
    if (distance <= GAP_POSITION_TOLERANCE) { plan.closes = true; continue; }
    const count = Math.round(distance / STRAIGHT);
    if (count < 1 || Math.abs(distance - count * STRAIGHT) > WHOLE_LENGTH) continue;
    // A run heading the way B lies from A: straights there carry everything after them onto B. The shortest such side first.
    const run = runs.filter(item => {
      const start = laid[moved(item.from)];
      return Math.abs(Math.cos(start.heading) * gap.y - Math.sin(start.heading) * gap.x) / distance < PARALLEL &&
        Math.cos(start.heading) * gap.x + Math.sin(start.heading) * gap.y > 0;
    }).sort((x, y) => runLength(x) - runLength(y))[0];
    if (!run) continue;
    Object.assign(plan, { run, runAt: run.to === n - 1 ? 'end' : moved(run.to + 1), straights: count, closes: true });
  }
  const plan = plans.find(item => item.closes) ?? plans[0];

  // The plain words: the missing turn, the short side against its opposite side, what's still off.
  const causes: GapCause[] = [];
  if (curve && curve.missing > 0) {
    const bend = plan?.bend ?? null;
    causes.push({ kind: 'curves-short', count: curve.missing, sector: curve.sector, bend: bend ? sideOf(joints, bend, centre) : null,
      pieces: bend ? bend.to - bend.from + 1 : 0,
      others: bend ? bendsOf.filter(other => other !== bend).map(other => ({ side: sideOf(joints, other, centre), pieces: other.to - other.from + 1 })) : [] });
  } else if (curve && curve.missing < 0) causes.push({ kind: 'curves-over', count: -curve.missing, sector: curve.sector });
  else if (!curve && Math.abs(turn) > WHOLE_ANGLE) causes.push({ kind: 'turn', degrees: Math.abs(turn) * DEG });
  if (plan?.run) {
    // The short side against the opposite (anti-parallel) side, as laid once the curves are in; a side the gap splits counts both parts.
    const headingOf = (run: Stretch) => plan.laid[plan.moved(run.from)].heading;
    const head = runs[0], tail = runs.at(-1)!;
    const split = head !== tail && head.from === 0 && tail.to === n - 1 && Math.abs(normalize(headingOf(head) - headingOf(tail))) < PARALLEL;
    const parts = (run: Stretch) => split && (run === head || run === tail) ? runLength(head) + runLength(tail) : runLength(run);
    const short = parts(plan.run), heading = headingOf(plan.run);
    const opposite = runs.filter(run => Math.abs(normalize(headingOf(run) - heading - Math.PI)) < PARALLEL)
      .find(run => Math.abs(parts(run) - short - plan.straights * STRAIGHT) <= WHOLE_LENGTH);
    causes.push({ kind: 'short-side', side: sideOf(joints, plan.run, centre), straights: plan.straights, than: opposite ? sideOf(joints, opposite, centre) : null });
  } else if (plan?.aligned && !plan.closes) {
    if (Math.abs(plan.lateral) > SIDEWAYS) causes.push({ kind: 'offset', distance: Math.abs(plan.lateral), along: plan.along });
    else if (Math.abs(plan.along) > GAP_POSITION_TOLERANCE) causes.push({ kind: 'in-line', distance: plan.along });
  }

  // Where the pieces belong: the short side, and the pieces either side of the joint the curves go into.
  const belong = new Set<string>([a.pieceId, b.pieceId]);
  if (plan?.run) ids.slice(plan.run.from, plan.run.to + 1).forEach(id => belong.add(id));
  if (curve && curve.missing > 0 && plan) {
    const at = plan.curveAt === 'end' ? n : plan.curveAt;
    [at - 1, at].filter(index => index >= 0 && index < n).forEach(index => belong.add(ids[index]));
  }

  let fix: GapFix | null = null;
  if (plan?.closes && (plan.straights > 0 || (curve?.missing ?? 0) > 0)) fix = closingFix(project, firstId, curve, sense, plan, causes);
  return { turn, along: plan?.along ?? raw.x, lateral: plan?.lateral ?? raw.y, curve, straights: plan?.straights ?? 0, causes,
    text: describe(causes, curve ? pieceDefinition(curve.family).label : undefined), pieceIds: [...belong], fix };
}

/** The pieces the plan lays, owned first: verified by laying them, and offered only when the loop then closes exactly. */
function closingFix(project: WorkshopProject, firstId: string, curve: GapExplanation['curve'], sense: number,
  plan: { curveAt: number | 'end'; runAt: number | 'end'; straights: number }, causes: readonly GapCause[]): GapFix | null {
  const curveCount = Math.max(0, curve?.missing ?? 0);
  const curves = curve && curveCount ? stock(project, curve.family, curveCount) : null;
  const straights = plan.straights ? stock(project, STRAIGHT_FAMILY, plan.straights) : null;
  if ((curveCount && !curves) || (plan.straights && !straights)) return null;
  const steps: Step[] = [
    ...(curves?.families ?? []).map((family, k): Step => ({ family, sweep: sense * curve!.sector, at: plan.curveAt === 'end' ? 'end' : plan.curveAt + k })),
    ...(straights?.families ?? []).map((family, k): Step => ({ family, at: plan.runAt === 'end' ? 'end' : plan.runAt + k }))];
  let next: WorkshopProject;
  try { next = layPieces(project, firstId, steps); } catch { return null; }
  const before = unoccupiedPiecePorts(project).length;
  if (!closesExactly(next, firstId) || unoccupiedPiecePorts(next).length !== before - 2) return null;
  const side = causes.find(cause => cause.kind === 'short-side')?.side;
  const parts = [
    ...(plan.straights ? [`${plan.straights} × ${STRAIGHT} mm straight${plan.straights === 1 ? '' : 's'}${side ? ` on the ${side} side` : ''}`] : []),
    ...(curveCount ? [plural(curveCount, 'curve piece')] : [])];
  const note = [straights && stockNote('straight', 'straights', plan.straights, straights), curves && stockNote('curve', 'curves', curveCount, curves)].filter(Boolean).join(' · ');
  return { label: `Add ${parts.join(' and ')}`, note, apply: current => layPieces(current, firstId, steps) };
}

/** Two ends of different track: only how they sit to each other. */
function looseCauses(raw: Pose): GapCause[] {
  const causes: GapCause[] = [];
  if (Math.abs(raw.heading) > WHOLE_ANGLE) causes.push({ kind: 'turn', degrees: Math.abs(raw.heading) * DEG });
  if (Math.abs(raw.y) > SIDEWAYS) causes.push({ kind: 'offset', distance: Math.abs(raw.y), along: raw.x });
  else if (Math.abs(raw.x) > GAP_POSITION_TOLERANCE) causes.push({ kind: 'in-line', distance: raw.x });
  return causes;
}

function describe(causes: readonly GapCause[], curveLabel = 'curve'): string {
  const turned = (count: number, sector: number) => `${count === 1 ? '' : `${count} × `}${degrees(sector)}`;
  const sentences = causes.map(cause => {
    switch (cause.kind) {
      case 'curves-short': {
        const head = `The loop is ${plural(cause.count, 'curve piece')} short (${turned(cause.count, cause.sector)})`;
        const [other] = cause.others;
        if (!cause.bend || cause.others.length !== 1 || !other.side || other.side === cause.bend) return `${head}.`;
        return `${head}: the ${cause.bend} bend has ${plural(cause.pieces, curveLabel)}, the ${other.side} bend ${other.pieces}.`;
      }
      case 'curves-over': return `The loop turns ${plural(cause.count, 'curve piece')} too far (${turned(cause.count, cause.sector)}).`;
      case 'turn': return `The ends point ${Number(cause.degrees.toFixed(1))}° apart — not a whole number of curve pieces.`;
      case 'short-side': {
        const amount = `${plural(cause.straights, 'straight')} (${cause.straights * STRAIGHT} mm)`;
        if (cause.side && cause.than && cause.than !== cause.side) return `The ${cause.side} side is ${amount} shorter than the ${cause.than} side.`;
        return `${cause.side ? `The ${cause.side} side` : 'One side'} is ${amount} short.`;
      }
      case 'offset': return `The ends are offset sideways by ${mm(cause.distance)}${Math.abs(cause.along) > SIDEWAYS ?
        ` and ${mm(cause.along)} ${cause.along > 0 ? 'apart' : 'overlapping'} along the line` : ''} (an S-bend or a wider curve on one end would fix it).`;
      case 'in-line': return cause.distance > 0 ? `The ends are ${mm(cause.distance)} apart in line — not a whole number of ${STRAIGHT} mm straights.` :
        `The ends overlap by ${mm(cause.distance)}.`;
    }
  });
  return sentences.length ? sentences.join(' ') : 'Trains stop at open ends.';
}

/** The open ends of each route that runs nearly round a loop (turning 270°–450°, both ends level) without closing. */
export function loopGaps(project: WorkshopProject): [OpenEnd, OpenEnd][] {
  const open = unoccupiedPiecePorts(project), pairs: [OpenEnd, OpenEnd][] = [];
  const openEnd = (piece: RoutePiece, portId: string): OpenEnd | null => {
    const found = open.find(item => item.part.id === piece.id && item.port.id === portId);
    return found ? { pieceId: piece.id, portId, port: found.port } : null;
  };
  for (const route of project.routes) {
    if (route.pieces.length < 2) continue;
    const a = openEnd(route.pieces.at(-1)!, 'out'), b = openEnd(route.pieces[0], 'in');
    if (!a || !b || Math.abs(a.port.z - b.port.z) > LOOP_LEVEL) continue;
    const { bends } = chainOf(project, route), total = Math.abs(bends.reduce((sum, bend) => sum + bend, 0));
    if (total >= LOOP_TURN_MIN && total <= LOOP_TURN_MAX) pairs.push([a, b]);
  }
  return pairs;
}
