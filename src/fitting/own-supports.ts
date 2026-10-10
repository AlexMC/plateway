import { realCars, routeBase, trainEnvelope, type WorkshopProject } from '../domain/project';
import { PRINTER_ENVELOPES } from '../domain/printer';
import { sectionPiece, type FitIssue, type PartInstance, type Section } from '../domain/route';
import { BRICK_TRACK } from '../domain/track';
import { curveSweep, type CrossingClearance } from './crossing';

/** A helix piece's column lug (composite `socket`) in the world: bore axis and lug underside height. */
export interface Lug { routeId: string; pieceId: string; x: number; y: number; z: number }
/** A wall/shelf bracket seat under a full sleeper: seat top at z, `heading` puts the wall on the bracket's +y side. */
export interface BracketSeat { routeId: string; pieceId: string; index: number; x: number; y: number; z: number; heading: number;
  mount: 1 | 2; reach: number; height: number }

/** cad/models/helix_column.py and composite.LUG_THICKNESS. */
/** composite.LUG_RING: the lug's ring diameter around the column bore. */
export const HELIX_LUG_RING = 20;
export const HELIX_COLUMN = { diameter: 16, engage: 8, lug: BRICK_TRACK.baseThickness, footMin: 6, socketMin: 15.4, maxHeight: 240 } as const;
/** cad/models/track_bracket.py knee_height: the wall bracket's plate reaches this far below its seat. */
export const bracketKnee = (reach: number) => reach - 5 + 16 + 8 + 2;
/** Most brick trains clear 118 mm above the rail tops (TrixBrix 11.8 cm; Eurobricks 12 bricks). */
export const TRAIN_CLEARANCE = 118;
const STACK_TOLERANCE = 1;
/** A 6 % grade drops under 4 mm over a body width; anything lower than this under a helix piece is another turn. */
const NEIGHBOUR_DROP = 8;

/**
 * Parts and checks for pieces that carry their own supports: helix column stacks through the lugs that share a plan
 * position (a footed tube from the ground up to the lowest lug, then one tube between each pair of lugs, split for the
 * printer's height), wall/shelf brackets, clearance between stacked helix turns, and columns or walls in a train's way.
 * `undersides`: each piece's lowest printed underside in the world, for the clearance under it.
 */
export function planOwnSupports(project: WorkshopProject, sections: readonly Section[], lugs: readonly Lug[],
  brackets: readonly BracketSeat[], undersides: ReadonlyMap<string, number>, crossings: readonly CrossingClearance[] = []):
  { parts: PartInstance[]; issues: FitIssue[]; measured: { crossingId: string; clearance: number }[] } {
  const parts: PartInstance[] = [], issues: FitIssue[] = [];
  const envelope = trainEnvelope(project), cars = realCars(project), halfBody = BRICK_TRACK.bodyWidth / 2, radius = HELIX_COLUMN.diameter / 2;
  const tallest = Math.min(HELIX_COLUMN.maxHeight, PRINTER_ENVELOPES[project.printer].z - HELIX_COLUMN.engage - HELIX_COLUMN.lug - 2);
  const routeOf = (routeId: string) => project.routes.find(route => route.id === routeId);
  const tube = (lug: Lug, id: string, bottom: number, height: number, foot: boolean, spigot: number) => parts.push({
    id, routeId: lug.routeId, sectionId: lug.pieceId, family: 'helix_column', parameters: { height, foot: foot ? 1 : 0, spigot },
    pose: { x: lug.x, y: lug.y, z: bottom, heading: 0, pitch: 0 }, interfaceKind: 'accessory', source: 'printed', status: 'unverified', geometryAvailable: true });
  /** `total` mm of column from `bottom` in equal tubes no taller than the printer allows; the last spigot passes a lug. */
  const run = (lug: Lug, id: string, bottom: number, total: number, foot: boolean) => {
    const count = Math.ceil(total / tallest - 1e-9), height = total / count;
    for (let index = 0; index < count; index++)
      tube(lug, `${id}${count > 1 ? `-${index + 1}` : ''}`, bottom + height * index, height, foot && !index,
        index === count - 1 ? HELIX_COLUMN.engage + HELIX_COLUMN.lug : HELIX_COLUMN.engage);
  };
  const stacks: Lug[][] = [];
  for (const lug of lugs) {
    const stack = stacks.find(other => Math.hypot(other[0].x - lug.x, other[0].y - lug.y) < STACK_TOLERANCE);
    if (stack) stack.push(lug); else stacks.push([lug]);
  }
  for (const [number, stack] of stacks.entries()) {
    stack.sort((a, b) => a.z - b.z);
    const lowest = stack[0], ground = routeBase(routeOf(lowest.routeId)), id = `${lowest.routeId}:column-${number + 1}`;
    if (lowest.z - ground >= HELIX_COLUMN.footMin) run(lowest, `${id}:base`, ground, lowest.z - ground, true);
    for (let index = 1; index < stack.length; index++) {
      const below = stack[index - 1], lug = stack[index], gap = lug.z - below.z - HELIX_COLUMN.lug;
      if (gap < HELIX_COLUMN.socketMin) {
        issues.push({ code: 'helix-column-short', severity: 'error', routeId: lug.routeId, pieceIds: [below.pieceId, lug.pieceId],
          points: [{ x: lug.x, y: lug.y, z: lug.z }], message: `Helix lugs only ${Math.max(0, gap).toFixed(0)} mm apart; raise the rise per turn.` });
        continue;
      }
      run(lug, `${id}:${index}`, below.z + HELIX_COLUMN.lug, gap, false);
    }
    // A column runs from the ground to its top lug: no track and no car may pass through it there.
    const top = stack.at(-1)!.z + HELIX_COLUMN.lug;
    let hit: 'track' | 'car' | null = null, hitPiece: string | null = null;
    for (const section of sections) {
      if (hit === 'track' || !section.pathPoints) continue;
      const sweep = envelope ? envelope.width / 2 + curveSweep(section, cars) : 0;
      for (const point of section.pathPoints) {
        if (point.z < ground - 1 || point.z > top) continue;
        const distance = Math.hypot(point.x - lowest.x, point.y - lowest.y) - radius;
        if (distance < halfBody + 1) { hit = 'track'; hitPiece = sectionPiece(section); break; }
        if (envelope && distance < sweep && hit !== 'car') { hit = 'car'; hitPiece = sectionPiece(section); }
      }
    }
    if (hit) issues.push({ code: 'helix-column-collision', severity: 'error', routeId: lowest.routeId,
      pieceIds: [...new Set([...stack.map(lug => lug.pieceId), hitPiece!])], points: [{ x: lowest.x, y: lowest.y, z: ground }],
      message: hit === 'track' ? 'A helix column stands in the track; put the columns on the other side of the curve.' :
        'Your widest car hits a helix column; move the columns further from the track.' });
  }
  for (const seat of brackets) {
    const ground = routeBase(routeOf(seat.routeId));
    parts.push({ id: `${seat.pieceId}:bracket-${seat.index + 1}`, routeId: seat.routeId, sectionId: seat.pieceId, family: 'track_bracket',
      parameters: { mount: seat.mount, reach: seat.reach, height: seat.mount === 1 ? 0 : seat.height },
      pose: { x: seat.x, y: seat.y, z: seat.z, heading: seat.heading, pitch: 0 }, interfaceKind: 'accessory', source: 'printed',
      status: 'unverified', geometryAvailable: true });
    if (seat.z - (seat.mount === 1 ? bracketKnee(seat.reach) : seat.height) < ground - 1e-6)
      issues.push({ code: 'bracket-below-ground', severity: 'error', routeId: seat.routeId, pieceIds: [seat.pieceId],
        points: [{ x: seat.x, y: seat.y, z: seat.z }],
        message: seat.mount === 1 ? 'A wall bracket reaches below the table; raise the track or use shelf brackets.' :
          'A shelf bracket would stand below the table; lower its height above the shelf.' });
  }
  if (envelope) for (const pieceId of new Set(brackets.map(seat => seat.pieceId))) {
    const seat = brackets.find(item => item.pieceId === pieceId)!, section = sections.find(item => item.id === pieceId);
    if (seat.reach < envelope.width / 2 + (section ? curveSweep(section, cars) : 0) + 2)
      issues.push({ code: 'bracket-wall-collision', severity: 'error', routeId: seat.routeId, pieceIds: [pieceId],
        message: `Your widest car would scrape the wall; set the track at least ${Math.ceil(envelope.width / 2 + 2)} mm from it.` });
  }
  for (const route of project.routes) {
    const raised = route.pieces.some(piece => piece.family === 'helix_curve' && (undersides.get(piece.id) ?? 0) - routeBase(route) >= HELIX_COLUMN.footMin);
    if (raised && !lugs.some(lug => lug.routeId === route.id))
      issues.push({ code: 'helix-unsupported', severity: 'error', routeId: route.id,
        pieceIds: route.pieces.filter(piece => piece.family === 'helix_curve').map(piece => piece.id),
        message: 'This helix has no column lugs to hold it up; turn on column lugs on some of its sections.' });
  }
  const helix = helixClearance(project, sections, undersides);
  issues.push(...helix.issues);
  // A crossing at a helix is measured here, against every helix turn on its routes: fit marks it clear once every car
  // fits under them, and blocked when the tallest car does not.
  const helixPoints = sections.filter(section => helix.pieces.has(section.id)).flatMap(section => section.pathPoints ?? []);
  const measured = crossings.filter(crossing => crossing.status === 'unknown' &&
    [crossing.upperRouteId, crossing.lowerRouteId].some(routeId => helix.gaps.has(routeId)) &&
    [crossing.upperPoint, crossing.lowerPoint].some(point => helixPoints.some(other => Math.hypot(other.x - point.x, other.y - point.y, other.z - point.z) < 1)))
    .map(crossing => ({ crossingId: crossing.crossingId,
      clearance: Math.min(...[crossing.upperRouteId, crossing.lowerRouteId].map(routeId => helix.gaps.get(routeId)?.gap ?? Infinity)) }));
  return { parts, issues, measured };
}

/** Clearance over and under a helix (its turns, and track entering or leaving on the tangent): rail tops to the underside above. */
function helixClearance(project: WorkshopProject, sections: readonly Section[], undersides: ReadonlyMap<string, number>):
  { issues: FitIssue[]; gaps: Map<string, { gap: number; pieceIds: string[]; point: { x: number; y: number; z: number } }>; pieces: Set<string> } {
  const helix = new Set(project.routes.flatMap(route => route.pieces.filter(piece => piece.family === 'helix_curve').map(piece => piece.id)));
  if (!helix.size) return { issues: [], gaps: new Map(), pieces: helix };
  const envelope = trainEnvelope(project), railTop = BRICK_TRACK.railTop, issues: FitIssue[] = [];
  const samples = sections.filter(section => section.pathPoints).map(section => {
    const points = section.pathPoints!.filter((_, index, all) => index % 2 === 0 || index === all.length - 1);
    const xs = points.map(point => point.x), ys = points.map(point => point.y);
    return { section, points, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  });
  const reach = BRICK_TRACK.bodyWidth / 2;
  const worst = new Map<string, { gap: number; pieceIds: string[]; point: { x: number; y: number; z: number } }>();
  for (const upper of samples) {
    const underside = undersides.get(upper.section.id);
    if (underside === undefined) continue;
    for (const lower of samples) {
      if (lower.section === upper.section || !helix.has(upper.section.id) && !helix.has(lower.section.id)) continue;
      const [a, b] = [upper.box, lower.box];
      if (a[0] - reach > b[2] || b[0] - reach > a[2] || a[1] - reach > b[3] || b[1] - reach > a[3]) continue;
      for (const top of upper.points) for (const point of lower.points) {
        // Track just before or after this piece passes under it by at most a grade's drop over a body width.
        if (underside - point.z < NEIGHBOUR_DROP || Math.hypot(top.x - point.x, top.y - point.y) >= BRICK_TRACK.bodyWidth / 2) continue;
        const gap = underside - (point.z + railTop), routeId = upper.section.routeId;
        if (gap < (worst.get(routeId)?.gap ?? Infinity))
          worst.set(routeId, { gap, pieceIds: [...new Set([sectionPiece(upper.section), sectionPiece(lower.section)])], point: { x: point.x, y: point.y, z: point.z } });
      }
    }
  }
  for (const [routeId, { gap, pieceIds, point }] of worst) {
    const shown = Math.max(0, gap).toFixed(0), at = { routeId, pieceIds, points: [point] };
    const clearance = { measured: gap, needed: envelope && gap < envelope.height ? envelope.height : TRAIN_CLEARANCE };
    if (gap <= 0) issues.push({ code: 'helix-clearance', severity: 'error', ...at, clearance, message: 'Helix turns run into each other; raise the rise per turn.' });
    else if (envelope && gap < envelope.height) issues.push({ code: 'helix-clearance', severity: 'error', ...at, clearance,
      message: `Only ${shown} mm between helix turns; your tallest car is ${envelope.height} mm. Raise the rise per turn.` });
    else if (gap < TRAIN_CLEARANCE) issues.push({ code: 'helix-clearance', severity: 'warning', ...at, clearance,
      message: `Only ${shown} mm between helix turns; ${TRAIN_CLEARANCE} mm clears most brick trains. Raise the rise per turn.` });
  }
  return { issues, gaps: worst, pieces: helix };
}
