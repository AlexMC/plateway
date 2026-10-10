import { planRamp, type RampPlan } from '../domain/elevation';
import { CLIMB_FAMILY, pieceDefinition, primaryEnd, type ShapePort } from '../domain/pieces';
import { placedEntries } from '../domain/furniture';
import type { RoutePiece, WorkshopProject } from '../domain/project';
import { BRICK_TRACK } from '../domain/track';
import { pieceLeavesRoom, roomSize } from '../fitting/room';
import { placePiece, unoccupiedPiecePorts, type Placement } from './operations';

type Pose = { x: number; y: number; z: number; heading: number };
/** 'Go up or down': one climb piece from the start height to `target` (mm above the table) at no more than `grade` percent. */
export interface ClimbOptions { target: number; grade: number; style?: 'fast' }
/** Flyover: ramp up, `decks` bridge decks `clearance` mm above the rail tops of a track at `under`, ramp back down. */
export interface FlyoverOptions { clearance: number; grade: number; decks: number; under: number; style?: 'fast' }
export interface KitLayout { pieces: RoutePiece[]; problem: string }

const metres = (mm: number) => (mm / 1000).toFixed(1);

/** A laid climb against the room: whether every piece stays inside, its run, and how far the room goes from its start along its heading (mm). */
export interface ClimbFit { fits: boolean; run: number; room: number }
export function climbFit(project: WorkshopProject, start: Pose, pieces: readonly RoutePiece[], run: number): ClimbFit {
  const { width, depth } = roomSize(project), c = Math.cos(start.heading), s = Math.sin(start.heading);
  // Distance along the heading to the wall it meets on one axis (Infinity when running parallel to it).
  const toWall = (at: number, direction: number, far: number) => direction > 1e-9 ? (far - at) / direction : direction < -1e-9 ? -at / direction : Infinity;
  return { fits: !pieces.some(piece => pieceLeavesRoom(project, piece)), run,
    room: Math.max(0, Math.min(toWall(start.x, c, width), toWall(start.y, s, depth))) };
}
/** 'fits · 1.16 m climb' or 'needs 3.41 m, room has ~1.90 m this way'. */
export function climbWords({ fits, run, room }: ClimbFit): string {
  return fits ? `fits · ${metres(run)} m climb` : `needs ${metres(run)} m, room has ~${metres(room)} m this way`;
}

const BRIDGE = 'bridge_deck';

/** Ramp pieces of `plan` laid one after another from `start`. */
function layPlan(project: WorkshopProject, start: Pose, plan: RampPlan, style: FlyoverOptions['style'], prefix: string): RoutePiece[] {
  const pieces: RoutePiece[] = [];
  let at = start;
  plan.pieces.forEach((part, index) => {
    const piece: RoutePiece = { id: `${prefix}-${index}`, family: 'track_ramp', ...at,
      params: { part: part.part, grade: part.grade, length: part.length }, ...(style ? { style } : {}) };
    pieces.push(piece);
    const end = primaryEnd(piece, project);
    at = { x: end.x, y: end.y, z: end.z, heading: end.heading };
  });
  return pieces;
}

/**
 * Where a kit starts: the nearest open end within `snapRadius`, laid outward from it (it must be level), else the
 * placement itself at the table or the given height.
 */
function kitStart(project: WorkshopProject, placement: Placement, snapRadius: number): { start: Pose; snapped: boolean; problem: string } {
  let best: { port: ShapePort; distance: number } | null = null;
  for (const { port } of unoccupiedPiecePorts(project)) {
    const distance = Math.hypot(port.x - placement.x, port.y - placement.y);
    if (distance <= snapRadius && (!best || distance < best.distance)) best = { port, distance };
  }
  if (!best) return { start: { x: placement.x, y: placement.y, z: placement.z ?? 0, heading: placement.heading ?? 0 }, snapped: false, problem: '' };
  const { port } = best;
  return { start: { x: port.x, y: port.y, z: port.z, heading: port.heading }, snapped: true,
    problem: Math.abs(port.pitch ?? 0) > 1e-6 ? 'Start from level track: that end is on a slope.' : '' };
}

/**
 * The 'Go up or down' climb piece from `start` to `options.target`: rise = target − start height (eased start, constant grade,
 * eased end), after `lead` mm of level (what a junction close behind `start` still needs, `levelLeadAt`).
 */
export function layClimb(start: Pose, options: ClimbOptions & { lead?: number }): KitLayout & { plan: RampPlan | null } {
  const rise = options.target - start.z, plan = planRamp(rise, options.grade / 100);
  if (!plan) return { pieces: [], plan: null, problem: `Already at ${Math.round(start.z)} mm.` };
  return { pieces: [{ id: 'climb', family: CLIMB_FAMILY, x: start.x, y: start.y, z: start.z, heading: start.heading,
    params: { rise, grade: options.grade, ...(options.lead ? { lead: options.lead } : {}) }, ...(options.style ? { style: options.style } : {}) }],
    plan, problem: '' };
}

/** A furniture surface whose entry lies ahead of a climb's start: its height and name ('KALLAX 5×5 · cubby floor'). */
export interface SurfaceAhead { height: number; name: string; distance: number; furnitureId: string; surfaceId: string }
/** An entry this far off the heading or more is not ahead (radians). */
const AHEAD_ANGLE = Math.PI / 4;
/**
 * The furniture surface a climb from `start` could reach: the ray from `start` along its heading meets the room's surface
 * entries (each furniture type's surface data), crossing into the surface, with the track's width inside the edge and inside the room.
 * Of the entries at the nearest such edge, the one whose height differs least from the start's and whose climb at
 * `grade` percent (after `lead` mm of level) ends before the edge; null when none is reachable there.
 */
export function surfaceAhead(project: WorkshopProject, start: Pose, grade: number, lead = 0): SurfaceAhead | null {
  const { width, depth } = roomSize(project), dx = Math.cos(start.heading), dy = Math.sin(start.heading), half = BRICK_TRACK.bodyWidth / 2;
  const hits: (SurfaceAhead & { rise: number })[] = [];
  for (const placed of placedEntries(project.furniture)) {
    if (Math.cos(start.heading - placed.heading) < Math.cos(AHEAD_ANGLE)) continue;
    const ex = placed.b.x - placed.a.x, ey = placed.b.y - placed.a.y, length = Math.hypot(ex, ey), cross = dx * ey - dy * ex;
    if (Math.abs(cross) < 1e-9 || length < 2 * half) continue;
    const wx = placed.a.x - start.x, wy = placed.a.y - start.y;
    const distance = (wx * ey - wy * ex) / cross, along = (wx * dy - wy * dx) / cross * length;
    const x = start.x + dx * distance, y = start.y + dy * distance;
    if (distance <= 1 || along < half || along > length - half || x < 0 || x > width || y < 0 || y > depth) continue;
    hits.push({ height: placed.surface.height, rise: placed.surface.height - start.z, name: `${placed.type.label} · ${placed.surface.name}`, distance,
      furnitureId: placed.furniture.id, surfaceId: placed.surface.id });
  }
  const nearest = Math.min(...hits.map(hit => hit.distance));
  const reachable = hits.filter(hit => hit.distance < nearest + 1 && Math.abs(hit.rise) >= 0.5 && lead + planRamp(hit.rise, grade / 100)!.run <= hit.distance)
    .sort((a, b) => Math.abs(a.rise) - Math.abs(b.rise) || a.height - b.height);
  if (!reachable.length) return null;
  const { rise: _, ...ahead } = reachable[0];
  return ahead;
}

/** Height of the flyover deck: `clearance` above the rail tops of the track below (deck underside = piece z). */
export function flyoverDeck(options: FlyoverOptions): number {
  return options.under + BRICK_TRACK.railTop + options.clearance;
}
/** The flyover kit from `start` (ramp up, decks, ramp down, back at the start height). */
export function layFlyover(project: WorkshopProject, start: Pose, options: FlyoverOptions): KitLayout & { up: RampPlan | null } {
  const up = planRamp(flyoverDeck(options) - start.z, options.grade / 100);
  if (!up || up.rise <= 0) return { pieces: [], up: null, problem: 'Start the flyover below the deck height.' };
  const style = options.style ? { style: options.style } : {};
  const pieces = layPlan(project, start, up, options.style, 'up');
  let end = primaryEnd(pieces.at(-1)!, project);
  for (let index = 0; index < options.decks; index++) {
    const deck: RoutePiece = { id: `deck-${index}`, family: BRIDGE, x: end.x, y: end.y, z: end.z, heading: end.heading, ...style };
    pieces.push(deck);
    end = primaryEnd(deck, project);
  }
  pieces.push(...layPlan(project, { x: end.x, y: end.y, z: end.z, heading: end.heading }, planRamp(-up.rise, options.grade / 100)!, options.style, 'down'));
  return { pieces, up, problem: '' };
}
/** Unsnapped, the click marks the middle of the decks (over the track to cross); snapped, the kit starts at the open end. */
export function previewFlyover(project: WorkshopProject, placement: Placement, options: FlyoverOptions, snapRadius = 30): KitLayout & { up: RampPlan | null } {
  const { start, snapped, problem } = kitStart(project, placement, snapRadius);
  const laid = layFlyover(project, start, options);
  if (!laid.pieces.length || snapped) return { ...laid, problem: problem || laid.problem };
  const decks = laid.pieces.filter(piece => piece.family === BRIDGE), first = decks[0], last = primaryEnd(decks.at(-1)!, project);
  const dx = placement.x - (first.x + last.x) / 2, dy = placement.y - (first.y + last.y) / 2;
  return { ...laid, pieces: laid.pieces.map(piece => ({ ...piece, x: piece.x + dx, y: piece.y + dy })) };
}

/** Lay a kit's pieces as one change (they join each other and any open end they meet); returns the new ids. */
export function placeKitPieces(project: WorkshopProject, pieces: readonly RoutePiece[]): [WorkshopProject, string[]] {
  const ids: string[] = [];
  let next = project;
  for (const piece of pieces) {
    const [after, id] = placePiece(next, piece.family, { x: piece.x, y: piece.y, z: piece.z, heading: piece.heading,
      ...(piece.params ? { params: piece.params } : {}), ...(piece.style && pieceDefinition(piece.family).styles.includes('fast') ? { style: piece.style } : {}) }, -1);
    next = after; ids.push(id);
  }
  return [next, ids];
}

/** Ramp run summary: total run and each part, for the kit tiles. */
export function describePlan(plan: RampPlan): string {
  const slope = plan.run - 2 * plan.transition;
  return `${(plan.run / 1000).toFixed(2)} m at ${(plan.grade * 100).toFixed(1)}% · ease ${plan.transition} mm${slope > 0 ? ` · slope ${(slope / 1000).toFixed(2)} m` : ''} · ease ${plan.transition} mm`;
}
