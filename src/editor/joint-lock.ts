import type { RoutePiece, WorkshopProject } from '../domain/project';
import { gaugesMate, pieceDefinition, piecePorts, primaryEnd, type ShapePort } from '../domain/pieces';
import { hoveredJoints, insertAtJoint, type InsertFill, previewPiece, routeJoint, unoccupiedPiecePorts, type InsertPlan, type PiecePreview,
  type Placement, type RouteJoint, type SnapCandidate, type TileFamily } from './operations';

/**
 * Laying a piece onto track: the ghost locks to one joint (an open end, or a joint inside a route to insert at) and stays there while
 * the pointer moves about it; at the locked joint every physically distinct way the piece can go there is a variant, and the user
 * points towards the one they want, or steps through them with F (other hand) and Tab (other facing). What F and Tab chose is kept
 * as an intent relative to the track (branch to the left of travel or outside the loop, facing along or against it), not as an index,
 * so it carries over to the next joint.
 */
type Point = { x: number; y: number };

/** The lock lets go once the pointer is this many screen pixels beyond the joint's snap region. */
export const RELEASE_PX = 40;
/** Another joint the pointer reaches takes the lock at once when it is at least this many screen pixels nearer than the locked one. */
export const SWITCH_PX = 8;
/** Within this many screen pixels of the joint the pointer points nowhere: the pick stays. */
export const DEAD_PX = 14;
/** Another variant takes over the pick only when the pointer is this much (radians) closer to its direction. */
export const PICK_HYSTERESIS = 10 * Math.PI / 180;
/** At most this many variants are offered (and outlined) at a joint. */
export const MAX_VARIANTS = 6;

/** Where the ghost is locked: an open end, or a joint inside a route. `travel` is the track's direction there (out of the open end, or
 * along the route); `loop` is +1 when the closed route runs anticlockwise (left of travel is inside), −1 clockwise, null when open. */
export type LockJoint =
  | { kind: 'end'; key: string; point: Point & { z: number }; radius: number; travel: number; loop: null; candidate: SnapCandidate }
  | { kind: 'insert'; key: string; point: Point & { z: number }; radius: number; travel: number; loop: 1 | -1 | null; joint: RouteJoint };

/** One distinct way to put the armed piece at the locked joint. */
export interface JointVariant {
  /** Stable at this joint: its hand (`base` as armed, `mirror` the other hand) and facing. */
  key: string;
  hand: 'base' | 'mirror';
  family: TileFamily;
  placement: Placement;
  /** `with` / `against` the track's travel, or the own port that meets an open end when that is neither its `in` nor `out` (a branch). */
  facing: string;
  /** Where it goes: its diverging end (a turnout's branch), else the middle of its far ends. */
  aim: Point;
  /** +1 when it goes to the left of travel, −1 right, 0 straight on. */
  side: -1 | 0 | 1;
  /** Inside or outside a closed loop; null off a loop or straight on. */
  loopSide: 'in' | 'out' | null;
  piece: RoutePiece;
  snap?: PiecePreview;
  insert?: InsertPlan;
  /** Going into track over a straight run longer than the piece: a printed spacer makes up the rest, or (`shift`, the same piece
   * in the same place, its key ending ':shift') the track moves on instead. */
  fill?: InsertFill;
}

/** What F and Tab chose, relative to the track, so it applies at any joint (`fill`: moving the track on rather than a spacer). */
export interface Intent { facing: string; side: -1 | 0 | 1; loopSide: 'in' | 'out' | null; fill?: InsertFill }

/** The pointer's lock, pick and the user's intent, carried from one pointer move to the next. */
export interface Selection {
  lock: LockJoint | null;
  /** The variant the pointer points at (its key at the locked joint). */
  pick: string | null;
  /** What F, Tab or the last piece laid chose; only those set it, so the pointer leaving a joint never changes it. */
  intent: Intent | null;
  /** The pick when the intent was set or the joint was reached: pointing at another variant shows that one instead. */
  basis: string | null;
}
export const NO_SELECTION: Selection = { lock: null, pick: null, intent: null, basis: null };

/** The variants that differ only in hand: as armed, then mirrored (a curve's other way, a left/right turnout's twin, a hand parameter). */
export function hands(family: TileFamily, placement: Placement): { hand: 'base' | 'mirror'; family: TileFamily; placement: Placement }[] {
  const definition = pieceDefinition(family), legacy = definition.legacy ?? {};
  const base = { hand: 'base' as const, family, placement };
  if (legacy.sweep !== undefined) return [base, { hand: 'mirror', family, placement: { ...placement, sweep: -(placement.sweep ?? legacy.sweep) } }];
  if (definition.mirror) return [base, { hand: 'mirror', family: definition.mirror, placement }];
  if (definition.flip) return [base, { hand: 'mirror', family, placement: { ...placement, params: definition.flip(placement.params ?? {}) } }];
  return [base];
}

/** Twice the signed area of a closed route's joints: positive when it runs anticlockwise in the plan frame (+x forward, +y left). */
function loopTurn(project: WorkshopProject, routeId: string): 1 | -1 {
  const pieces = project.routes.find(route => route.id === routeId)!.pieces;
  let area = 0;
  pieces.forEach((piece, index) => { const next = pieces[(index + 1) % pieces.length]; area += piece.x * next.y - next.x * piece.y; });
  return area >= 0 ? 1 : -1;
}

/**
 * The joint the pointer reaches: the nearest open end within `snapRadius` that the piece's gauge mates, else (for pieces that can
 * go into track, unless `endsOnly`) the nearer joint of the placed piece under the pointer. Null when there is neither.
 * `ports`: the project's open ends, when the caller already has them.
 */
export function findJoint(project: WorkshopProject, family: TileFamily, placement: Placement, snapRadius: number, insertRadius: number,
  endsOnly = false, ports: readonly SnapCandidate[] = unoccupiedPiecePorts(project)): LockJoint | null {
  const gauge = pieceDefinition(family).gauge;
  let best: { candidate: SnapCandidate; distance: number } | null = null;
  for (const candidate of ports) {
    if (!gaugesMate(candidate.port.gauge, gauge)) continue;
    const distance = Math.hypot(candidate.port.x - placement.x, candidate.port.y - placement.y);
    if (distance <= snapRadius && (!best || distance < best.distance)) best = { candidate, distance };
  }
  if (best) {
    const { port, part } = best.candidate;
    return { kind: 'end', key: `end:${part.id}:${port.id}`, point: { x: port.x, y: port.y, z: port.z }, radius: snapRadius, travel: port.heading,
      loop: null, candidate: best.candidate };
  }
  if (endsOnly) return null;
  const hovered = hoveredJoints(project, family, placement, insertRadius);
  if (!hovered?.joints.length) return null;
  const lock = insertLock(project, hovered.route.id, hovered.joints[0], snapRadius);
  return { ...lock, radius: Math.max(snapRadius, Math.hypot(lock.point.x - placement.x, lock.point.y - placement.y)) };
}
/** The lock on joint `index` of `routeId` (before `pieces[index]`). */
function insertLock(project: WorkshopProject, routeId: string, index: number, radius: number): Extract<LockJoint, { kind: 'insert' }> {
  const joint = routeJoint(project, routeId, index), { at } = joint;
  return { kind: 'insert', key: `joint:${joint.routeId}:${joint.pieceId}`, point: { x: at.x, y: at.y, z: at.z }, travel: at.heading, radius,
    loop: joint.closed ? loopTurn(project, joint.routeId) : null, joint };
}

/** The lock keeps its joint while the pointer stays within the joint's snap region plus `RELEASE_PX`. */
export function lockHolds(lock: Pick<LockJoint, 'point' | 'radius'>, pointer: Point, mmPerPx: number): boolean {
  return Math.hypot(pointer.x - lock.point.x, pointer.y - lock.point.y) <= lock.radius + RELEASE_PX * mmPerPx;
}
/**
 * The joint the ghost locks to for this pointer. The held lock survives jitter between nearby joints (it lets go only `RELEASE_PX`
 * beyond its snap region), but a joint the pointer reaches now (`found`) takes over at once when the pointer is at least `SWITCH_PX`
 * nearer to it than to the locked one: at a zoom where a piece's two ends are only a few dozen pixels apart, the far end is reachable.
 */
export function stepLock(prior: LockJoint | null, found: () => LockJoint | null, pointer: Point, mmPerPx: number): LockJoint | null {
  const next = found();
  if (!prior || !lockHolds(prior, pointer, mmPerPx)) return next;
  if (!next || next.key === prior.key) return prior;
  const distance = (lock: LockJoint) => Math.hypot(pointer.x - lock.point.x, pointer.y - lock.point.y);
  return distance(prior) - distance(next) >= SWITCH_PX * mmPerPx ? next : prior;
}

const footprintOf = (ports: readonly ShapePort[]) =>
  ports.map(port => `${Math.round(port.x * 2)},${Math.round(port.y * 2)},${Math.round(port.z * 2)}`).sort().join('|');

/** Where a variant goes, seen from the joint, and which side of travel and of the loop that is. */
function aimOf(piece: RoutePiece, project: WorkshopProject, lock: LockJoint) {
  const ports = piecePorts(piece, project), end = primaryEnd(piece, project);
  const away = ports.filter(port => Math.hypot(port.x - lock.point.x, port.y - lock.point.y) > 1);
  const diverging = away.filter(port => port.id !== 'in' && port.id !== 'out');
  const ends = diverging.length ? diverging : away.length ? away : [{ ...end }];
  const aim = { x: ends.reduce((sum, port) => sum + port.x, 0) / ends.length, y: ends.reduce((sum, port) => sum + port.y, 0) / ends.length };
  const dx = aim.x - lock.point.x, dy = aim.y - lock.point.y, length = Math.hypot(dx, dy) || 1;
  const cross = (Math.cos(lock.travel) * dy - Math.sin(lock.travel) * dx) / length;
  const side: -1 | 0 | 1 = Math.abs(cross) < 0.05 ? 0 : cross > 0 ? 1 : -1;
  const loopSide = lock.loop === null || side === 0 ? null : side === lock.loop ? 'in' as const : 'out' as const;
  return { aim, side, loopSide, footprint: footprintOf(ports) };
}

/**
 * Every physically distinct way to put `family` (as `placement` describes its shape) at the locked joint: its hands × facings — at an
 * open end, each own port that can meet it; inside a route, facing along or against the route (main line on the route). Pieces that
 * land the same either way (a straight) are one variant; a `fromJoint` piece (a climb) meets an open end by its `in` only. At most
 * `MAX_VARIANTS`, the armed hand first.
 */
export function jointVariants(project: WorkshopProject, family: TileFamily, placement: Placement, lock: LockJoint, only?: Intent): JointVariant[] {
  const variants: JointVariant[] = [], seen = new Set<string>();
  const add = (hand: 'base' | 'mirror', handFamily: TileFamily, handPlacement: Placement, facing: string, piece: RoutePiece,
    result: { snap?: PiecePreview; insert?: InsertPlan }) => {
    const { aim, side, loopSide, footprint } = aimOf(piece, project, lock);
    if (seen.has(footprint)) return;
    seen.add(footprint);
    variants.push({ key: `${hand}:${facing}`, hand, family: handFamily, placement: handPlacement, facing, aim, side, loopSide, piece, ...result });
  };
  for (const { hand, family: handFamily, placement: handPlacement } of hands(family, placement)) {
    if (lock.kind === 'end') {
      const at = { ...handPlacement, x: lock.point.x, y: lock.point.y, z: lock.point.z };
      const first = previewPiece(project, handFamily, at, 1, [lock.candidate]);
      for (let attachment = 0; attachment < first.attachments; attachment++) {
        const snap = attachment ? previewPiece(project, handFamily, at, 1, [lock.candidate], attachment) : first;
        const own = snap.ownPortId ?? 'in';
        if (own !== 'in' && pieceDefinition(handFamily).fromJoint) continue;
        add(hand, handFamily, handPlacement, own === 'in' ? 'with' : own === 'out' ? 'against' : own, snap.piece, { snap });
      }
    } else {
      // Posed where it would go (its `in` on the joint, along or against the route); the insert itself is worked out below.
      const { at } = lock.joint;
      for (const backward of [false, true]) {
        let piece: RoutePiece;
        try { piece = previewPiece(project, handFamily, { ...handPlacement, x: at.x, y: at.y, z: at.z, heading: backward ? at.heading + Math.PI : at.heading }, -1).piece; }
        catch { continue; }
        add(hand, handFamily, handPlacement, backward ? 'against' : 'with', piece, {});
      }
    }
  }
  const offered = variants.slice(0, MAX_VARIANTS);
  const wanted = only ? [variantForIntent(offered, only)].filter((variant): variant is JointVariant => variant !== undefined) : offered;
  if (lock.kind === 'end') return wanted;
  return wanted.flatMap(variant => {
    const insert = (fill: InsertFill) => insertAtJoint(project, variant.family, variant.placement, lock.joint.routeId, lock.joint.index, variant.facing === 'against', fill);
    let spaced: InsertPlan;
    try { spaced = insert('spacer'); } catch { return []; }
    if (!spaced.spacer) return [{ ...variant, insert: spaced }];
    // A spacer makes room by default; moving the track on instead stays one Tab away.
    const variants: JointVariant[] = [{ ...variant, insert: spaced, fill: 'spacer' }];
    try { variants.push({ ...variant, key: `${variant.key}:shift`, insert: insert('shift'), fill: 'shift' }); } catch { /* spacer only */ }
    return variants;
  });
}

/** It goes in without moving other track or leaving a gap (laid on an open end, or replacing a run of whole pieces). */
export function fitsCleanly(variant: JointVariant): boolean {
  return !variant.insert || variant.insert.mode === 'replace' && !variant.insert.gaps.length && !variant.insert.shifted.length;
}
/** The same way of laying the piece at another joint of the route, `steps` joints along it (negative: back along it). */
export interface Landing { lock: LockJoint; variant: JointVariant; steps: number }
/** How many joints either way along the route a piece that would move track looks for a joint where it fits cleanly. */
export const LANDING_REACH = 3;
/**
 * The joints within `LANDING_REACH` of the locked one, both ways along its route, where `intent` (the same hand, facing and side) fits
 * cleanly. Empty off a route or when none does.
 */
export function cleanLandings(project: WorkshopProject, family: TileFamily, placement: Placement, lock: LockJoint, intent: Intent): Landing[] {
  if (lock.kind !== 'insert') return [];
  const { routeId, index, closed } = lock.joint, count = project.routes.find(route => route.id === routeId)!.pieces.length;
  const landings: Landing[] = [];
  for (let steps = -LANDING_REACH; steps <= LANDING_REACH; steps++) {
    if (!steps || closed && Math.abs(steps) * 2 >= count) continue;
    const at = closed ? ((index + steps) % count + count) % count : index + steps;
    if (!closed && (at <= 0 || at >= count)) continue;
    const there = insertLock(project, routeId, at, lock.radius);
    const [variant] = jointVariants(project, family, placement, there, intent);
    if (variant && fitsCleanly(variant) && variant.facing === intent.facing && variant.side === intent.side) landings.push({ lock: there, variant, steps });
  }
  return landings;
}
/** A landing keeps the ghost until another is this much (mm) nearer the pointer. */
export const LANDING_HYSTERESIS = 24;
/** The landing nearest the pointer (then nearest along the route); `prior` (a lock key) stays unless another is clearly nearer. */
export function nearestLanding(landings: readonly Landing[], pointer: Point, prior?: string): Landing | undefined {
  const distance = (landing: Landing) => Math.hypot(landing.lock.point.x - pointer.x, landing.lock.point.y - pointer.y);
  const best = [...landings].sort((a, b) => distance(a) - distance(b) || Math.abs(a.steps) - Math.abs(b.steps))[0];
  const kept = landings.find(landing => landing.lock.key === prior);
  return kept && best && distance(kept) - distance(best) < LANDING_HYSTERESIS ? kept : best;
}

const angleBetween = (a: Point, b: Point) => Math.abs(Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y));
/**
 * The variant the pointer points at: the one whose aim, seen from the joint, is the nearest direction to the pointer. Near the joint
 * (within `DEAD_PX`) the pointer points nowhere and `prior` stays; another variant takes over only when clearly nearer (`PICK_HYSTERESIS`).
 */
export function pointerVariant(variants: readonly JointVariant[], lock: Pick<LockJoint, 'point'>, pointer: Point, prior: string | null,
  mmPerPx: number): string | null {
  const towards = { x: pointer.x - lock.point.x, y: pointer.y - lock.point.y };
  const known = variants.find(variant => variant.key === prior);
  if (Math.hypot(towards.x, towards.y) < DEAD_PX * mmPerPx || !variants.length) return known ? known.key : null;
  const off = (variant: JointVariant) => angleBetween(towards, { x: variant.aim.x - lock.point.x, y: variant.aim.y - lock.point.y });
  const best = variants.reduce((winner, variant) => off(variant) < off(winner) ? variant : winner);
  return known && off(known) - off(best) < PICK_HYSTERESIS ? known.key : best.key;
}

export function intentOf(variant: JointVariant): Intent {
  return { facing: variant.facing, side: variant.side, loopSide: variant.loopSide, ...(variant.fill === 'shift' ? { fill: 'shift' as const } : {}) };
}
/** The variant that carries out `intent` here: its facing first, then its side of the loop (on a loop) or of travel. */
export function variantForIntent(variants: readonly JointVariant[], intent: Intent): JointVariant | undefined {
  const score = (variant: JointVariant) => (variant.facing === intent.facing ? 4 : 0) + ((variant.fill === 'shift') === (intent.fill === 'shift') ? 1 : 0) +
    (variant.loopSide && intent.loopSide ? variant.loopSide === intent.loopSide ? 2 : 0 : variant.side === intent.side ? 2 : 0);
  return variants.reduce<JointVariant | undefined>((winner, variant) => !winner || score(variant) > score(winner) ? variant : winner, undefined);
}

/**
 * One pointer move: the lock (held, or found afresh) and the pointed-at variant. Reaching a joint, or first leaving its dead zone,
 * takes the pick as the basis, so the intent shows until the pointer points at another variant.
 */
export function stepSelection(prior: Selection, lock: LockJoint | null, variants: readonly JointVariant[], pointer: Point, mmPerPx: number): Selection {
  if (!lock) return { ...prior, lock: null, pick: null, basis: null };
  const sameJoint = prior.lock?.key === lock.key;
  const pick = pointerVariant(variants, lock, pointer, sameJoint ? prior.pick : null, mmPerPx);
  if (!sameJoint || prior.basis === null) return { ...prior, lock, pick, basis: pick };
  return { ...prior, lock, pick };
}

/** The variant shown and laid: the pointed-at one once the pointer points somewhere new, else what the intent asks for, else the first. */
export function activeVariant(selection: Selection, variants: readonly JointVariant[]): JointVariant | undefined {
  const picked = variants.find(variant => variant.key === selection.pick);
  if (picked && (selection.pick !== selection.basis || !selection.intent)) return picked;
  return (selection.intent && variantForIntent(variants, selection.intent)) ?? picked ?? variants[0];
}

/** F: the same facing, the other hand. */
export function otherHand(variants: readonly JointVariant[], active: JointVariant): JointVariant | undefined {
  return variants.find(variant => variant.hand !== active.hand && wayOf(variant) === wayOf(active)) ??
    variants.find(variant => variant.hand !== active.hand && variant.facing === active.facing) ??
    variants.find(variant => variant.hand !== active.hand);
}
/** What Tab steps through: its facing, and whether it moves the track on instead of taking a spacer. */
export function wayOf(variant: JointVariant): string {
  return variant.fill === 'shift' ? `${variant.facing}:shift` : variant.facing;
}
/** The ways offered here (facings, each with its spacer or moving the track on), in order. */
export function facings(variants: readonly JointVariant[]): string[] {
  return [...new Set(variants.map(wayOf))];
}
/** Tab (`step` 1) and ⇧Tab (−1): the next way round, keeping the hand where it can. */
export function otherFacing(variants: readonly JointVariant[], active: JointVariant, step: 1 | -1): JointVariant | undefined {
  const order = facings(variants);
  if (order.length < 2) return undefined;
  const way = order[(order.indexOf(wayOf(active)) + step + order.length) % order.length];
  return variants.find(variant => wayOf(variant) === way && variant.hand === active.hand) ?? variants.find(variant => wayOf(variant) === way);
}
/** F or Tab chose `variant`, or it was laid: it becomes the intent, against the current pick. */
export function choose(selection: Selection, variant: JointVariant): Selection {
  return { ...selection, intent: intentOf(variant), basis: selection.pick };
}
