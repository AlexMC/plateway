import { ELEVATION } from '../domain/elevation';
import { compositeUnderside, primaryEnd, type CompositeTrack } from '../domain/pieces';
import { HELIX_COLUMN_OFFSET } from '../domain/pieces/families/helix';
import { changeProject, routeBase, type RoutePiece, type WorkshopProject } from '../domain/project';
import { BRICK_TRACK } from '../domain/track';
import { HELIX_COLUMN } from '../fitting/own-supports';
import { previewPiece, rebuildPiecePoints, reflowFollowingPieces, syncBuilderCrossings, unoccupiedPiecePorts, type Placement } from './operations';

/**
 * Helix kit: an editor macro that lays a spiral of `helix_curve` sections of HELIX_SECTOR each. Short sectors keep
 * each printed wedge thin (its flat underside sits at its low end, so its high end is a sector's rise thicker, eating
 * into the clearance above the turn below) and every section fits both printer beds whole. The grade eases in from level and back out over whole sections with
 * vertical curves no tighter than ELEVATION.verticalRadius, so both ends are level and lie on the 22.5° grid (quarter
 * turns). Sections at every `columns`-th sector carry a column lug; the lugs of every turn stack on the same spot, and
 * fit lays the printed column tubes through them.
 */
export interface HelixOptions {
  radius: number;
  /** Whole and quarter turns. */
  turns: number;
  /** Height gained per full turn at full grade, mm. */
  rise: number;
  /** +1 turns left (anticlockwise seen from above), -1 right. */
  hand: 1 | -1;
  /** +1 climbs, -1 descends. */
  direction: 1 | -1;
  /** Column lugs per turn: 0, 4, 8 or 16. */
  columns: number;
  /** +1 columns inside the curve, -1 outside. */
  side: 1 | -1;
  /** Track centreline to column axis, mm. */
  offset: number;
  style?: 'fast';
}
/** R56, R72 (recommended), R88, R104. */
export const HELIX_RADII: readonly number[] = [448, 576, 704, 832];
export const HELIX_COLUMNS: readonly number[] = [0, 4, 8, 16];
/** Below this rise per turn even a thin deck leaves less than the 118 mm trains need (research: 125 mm). */
export const HELIX_MIN_RISE = 125;
const DEG = Math.PI / 180;

/** Degrees per section: 32 per turn. */
export const HELIX_SECTOR = 11.25;
export const helixGrade = (radius: number, rise: number) => rise / (2 * Math.PI * radius);

export interface HelixPlan {
  sections: { sweep: number; grade0: number; grade1: number; socket: number }[];
  sector: number; perTurn: number; easing: number;
  /** Full grade (fraction), total height change (signed, mm), least rail-top-to-underside clearance between turns. */
  grade: number; height: number; clearance: number;
  problem: string | null; caution: string | null;
}

const sectionTrack = (radius: number, sweep: number, grade0: number, grade1: number): CompositeTrack => {
  const len = radius * Math.abs(sweep) * DEG;
  return { segments: [{ len, k0: 1 / radius, k1: 1 / radius }], z0: 0, z1: len * (grade0 + grade1) / 200,
    grade0: grade0 / 100, grade1: grade1 / 100, cant0: 0, cant1: 0, vcurve: 0 };
};

/** Section grades, heights and lugs; `base` is the start height above the ground (lugs need room for a tube under them). */
export function planHelix(options: HelixOptions, base = 0): HelixPlan {
  const { radius, turns, rise, hand, direction, columns } = options;
  const sector = HELIX_SECTOR, perTurn = Math.round(360 / sector), count = Math.round(turns * perTurn);
  const grade = helixGrade(radius, rise), length = radius * sector * DEG;
  const easing = Math.max(1, Math.ceil(ELEVATION.verticalRadius * grade / length - 1e-9));
  const sign = direction * 100, every = columns ? perTurn / columns : 0;
  const sections: HelixPlan['sections'] = [];
  const lows: number[] = [], highs: number[] = [], floors: number[] = [];
  let z = 0;
  for (let index = 0; index < count; index++) {
    const ramp = (k: number) => grade * Math.min(1, k / easing, (count - k) / easing);
    const grade0 = sign * ramp(index), grade1 = sign * ramp(index + 1);
    const track = sectionTrack(radius, sector, grade0, grade1);
    lows.push(Math.min(z, z + track.z1)); highs.push(Math.max(z, z + track.z1)); floors.push(z + compositeUnderside(track));
    const socket = every && index % every === 0 && base + floors[index] >= HELIX_COLUMN.footMin ? 1 : 0;
    sections.push({ sweep: hand * sector, grade0, grade1, socket });
    z += track.z1;
  }
  // Each section against the one a turn later, directly above or below it.
  let clearance = Infinity;
  for (let index = 0; index + perTurn < count; index++) {
    const [low, high] = direction > 0 ? [index, index + perTurn] : [index + perTurn, index];
    // Under a section's flat underside, a half body width past its ends: its own turn below, and where it overhangs
    // the start of the next section down at their joint (fit measures the same).
    clearance = Math.min(clearance, floors[high] - highs[low] - BRICK_TRACK.railTop - grade * BRICK_TRACK.bodyWidth / 2);
    const before = direction > 0 ? high - 1 : high + 1;
    if (before >= 0 && before < count && before !== low)
      clearance = Math.min(clearance, floors[before] - lows[low] - BRICK_TRACK.railTop - grade * BRICK_TRACK.bodyWidth / 2);
  }
  // Level track entering and leaving on the tangent stays under (or over) the neighbouring turn for as long as the
  // circle stays within half a body width of the tangent: entry at the start height, exit at the end height.
  const hugging = Math.ceil(Math.acos(1 - BRICK_TRACK.bodyWidth / 2 / radius) / (sector * DEG) - 1e-9);
  for (let k = 0; k < hugging && perTurn + k < count; k++) {
    const first = perTurn - 1 - k, last = count - perTurn + k;
    clearance = Math.min(clearance, direction > 0 ? floors[first] - BRICK_TRACK.railTop : -highs[first] - BRICK_TRACK.railTop,
      direction > 0 ? z - highs[last] - BRICK_TRACK.railTop : floors[last] - z - BRICK_TRACK.railTop);
  }
  const percent = (grade * 100).toFixed(1);
  const problem = !Number.isInteger(turns * 4) || turns < 1 ? 'Use whole or quarter turns, at least one.' :
    Number(percent) > ELEVATION.maxGrade * 100 ? `Too steep: ${percent}% (${ELEVATION.maxGrade * 100}% at most); use a wider radius or less rise per turn.` :
    count < 2 * easing + 1 ? 'Too few turns for its easements; add turns.' :
    radius < 320 ? 'Radius must be R40 or wider.' : null;
  const caution = rise < HELIX_MIN_RISE ? `Less than ${HELIX_MIN_RISE} mm per turn: trains will not fit under the turn above.` :
    clearance < ELEVATION.clearance ? `Only ${Math.max(0, clearance).toFixed(0)} mm between turns; ${ELEVATION.clearance} mm clears most trains.` :
    grade > ELEVATION.cautionGrade + 1e-9 ? `Steep: ${percent}% on a curve; long trains may stall (R72 or wider is easier).` : null;
  return { sections, sector, perTurn, easing, grade, height: z, clearance, problem, caution };
}

/** The least rise per turn (whole plates) that leaves 118 mm between turns at this radius. */
export function minimumRise(radius: number): number {
  for (let rise = HELIX_MIN_RISE; rise < 400; rise += ELEVATION.plate) {
    const plates = Math.ceil(rise / ELEVATION.plate - 1e-9) * ELEVATION.plate;
    if (planHelix({ radius, turns: 2, rise: plates, hand: 1, direction: 1, columns: 0, side: 1, offset: HELIX_COLUMN_OFFSET }).clearance >= ELEVATION.clearance)
      return Number(plates.toFixed(1));
  }
  return 400;
}

/** The helix's sections laid from `start` (the first section's `in`), without changing the project. */
export function layHelix(project: WorkshopProject, start: { x: number; y: number; z: number; heading: number }, options: HelixOptions,
  base = 0): RoutePiece[] {
  const plan = planHelix(options, start.z - base);
  const pieces: RoutePiece[] = [];
  let at = start;
  plan.sections.forEach((section, index) => {
    const piece: RoutePiece = { id: `helix-${index}`, family: 'helix_curve', ...at, params: { radius: options.radius,
      sweep: section.sweep, grade0: Number(section.grade0.toFixed(4)), grade1: Number(section.grade1.toFixed(4)),
      ...(section.socket ? { socket: 1, column_side: options.side, column_offset: options.offset } : {}) },
      ...(options.style ? { style: options.style } : {}) };
    pieces.push(piece);
    const end = primaryEnd(piece, project);
    at = { x: end.x, y: end.y, z: end.z, heading: end.heading };
  });
  return pieces;
}

/** Where the kit lands for a drop: the first section snaps like any piece (onto a level open end); the rest follow. */
export function previewHelix(project: WorkshopProject, placement: Placement, options: HelixOptions, snapRadius = 30): RoutePiece[] {
  const first = previewPiece(project, 'helix_curve', { ...placement, params: { radius: options.radius,
    sweep: options.hand * HELIX_SECTOR, grade0: 0, grade1: 0 } }, snapRadius);
  const route = first.routeId ? project.routes.find(item => item.id === first.routeId) : undefined;
  return layHelix(project, first.piece, options, route?.base ?? 0);
}

/** A helix the kit laid: its run of sections on a route, read back as kit options. */
export interface LaidHelix { routeId: string; pieceIds: string[]; options: HelixOptions }

/**
 * Every helix on the layout the kit laid: a run of `helix_curve` sections from level back to level, one radius, hand
 * and sector, whole or quarter turns, whose grades are exactly the kit's plan at the rise they reach. A hand-graded run
 * is not one (re-planning it would change its shape).
 */
export function laidHelices(project: WorkshopProject): LaidHelix[] {
  const found: LaidHelix[] = [];
  for (const route of project.routes) {
    let run: RoutePiece[] = [];
    for (const piece of route.pieces) {
      const params = piece.params ?? {};
      if (piece.family !== 'helix_curve' || Math.abs(params.sweep) !== HELIX_SECTOR) { run = []; continue; }
      if (params.grade0 === 0 || run.length && (params.radius !== run[0].params!.radius || params.sweep !== run[0].params!.sweep)) run = [];
      run.push(piece);
      if (params.grade1 !== 0) continue;
      const sections = run;
      run = [];
      if (sections[0].params!.grade0 !== 0) continue;
      const radius = params.radius, peak = sections.reduce((top, item) => Math.abs(item.params!.grade0) > Math.abs(top) ? item.params!.grade0 : top, 0);
      const turns = sections.length * HELIX_SECTOR / 360;
      if (!peak || !Number.isInteger(turns * 4)) continue;
      const options: HelixOptions = { radius, turns, rise: Math.abs(peak) / 100 * 2 * Math.PI * radius, hand: Math.sign(params.sweep) as 1 | -1,
        direction: Math.sign(peak) as 1 | -1, columns: 0, side: 1, offset: HELIX_COLUMN_OFFSET };
      const plan = planHelix(options);
      if (plan.sections.length === sections.length && plan.sections.every((section, index) =>
        Math.abs(section.grade0 - sections[index].params!.grade0) < 1e-3 && Math.abs(section.grade1 - sections[index].params!.grade1) < 1e-3))
        found.push({ routeId: route.id, pieceIds: sections.map(item => item.id), options });
    }
  }
  return found;
}

/** The re-graded layout before crossings are declared again, or null where the change cannot work. */
function regradeHelices(project: WorkshopProject, routeId: string, rise: number): WorkshopProject | null {
  const helices = laidHelices(project).filter(helix => helix.routeId === routeId && helix.options.rise < rise - 1e-6);
  if (!helices.length) return null;
  const plans = helices.map(helix => planHelix({ ...helix.options, rise }));
  if (plans.some(plan => plan.problem || plan.grade > ELEVATION.maxGrade + 1e-9)) return null;
  const openEnds = unoccupiedPiecePorts(project).length;
  const next = changeProject(project, draft => {
    const laid = draft.routes.find(item => item.id === routeId)!;
    helices.forEach((helix, number) => helix.pieceIds.forEach((id, index) => {
      const piece = laid.pieces.find(item => item.id === id)!, section = plans[number].sections[index];
      piece.params = { ...piece.params, grade0: Number(section.grade0.toFixed(4)), grade1: Number(section.grade1.toFixed(4)) };
    }));
    reflowFollowingPieces(draft, laid, laid.pieces.find(item => item.id === helices[0].pieceIds[0])!);
    rebuildPiecePoints(draft, laid);
  });
  const laid = next.routes.find(item => item.id === routeId)!;
  if (unoccupiedPiecePorts(next).length > openEnds) return null;
  if (laid.points.some(point => point.z < routeBase(laid) - 1e-6)) return null;
  return next;
}

/**
 * Whether `setHelixRise` can make this change: no grade over 5%, no joint pulled apart (a closed loop's helices must
 * change together) and no track pushed below its ground. Cheaper than making it (crossings are not re-declared).
 */
export function canSetHelixRise(project: WorkshopProject, routeId: string, rise: number): boolean {
  return regradeHelices(project, routeId, rise) !== null;
}

/**
 * One undoable edit: every kit helix on the route that rises less than `rise` per turn is re-graded to it (column lugs stay
 * where they are) and the rest of the route follows. Null where `canSetHelixRise` says it cannot work.
 */
export function setHelixRise(project: WorkshopProject, routeId: string, rise: number): WorkshopProject | null {
  const next = regradeHelices(project, routeId, rise);
  // The clone is ours until returned: crossings follow the new heights in the same edit.
  if (next) syncBuilderCrossings(next);
  return next;
}
