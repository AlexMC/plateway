import { ELEVATION } from '../domain/elevation';
import { trainCurveSweep } from '../domain/car-geometry';
import { HELIX_CURVE } from '../domain/pieces/families/helix';
import { CARS_NEEDED_MESSAGE, realCars, trainEnvelope, type Car, type WorkshopProject, type Point3 } from '../domain/project';
import { sectionPiece, type FitIssue, type Section } from '../domain/route';
import { railDimension } from '../domain/track';

export interface CrossingClearance {
  crossingId: string;
  upperRouteId: string;
  lowerRouteId: string;
  upperPoint: Point3;
  lowerPoint: Point3;
  status: 'blocked' | 'unknown' | 'digitally-clear';
  /** The pieces carrying the upper and lower track where they cross. */
  upperPieceId?: string;
  lowerPieceId?: string;
  /** Measured rail top to the underside above (under a bridge deck, or between helix turns), and the tallest car, mm. */
  clearance?: number;
  needed?: number;
}
interface Sample { x: number; y: number; z: number }
const EPS = 1e-8;

function at(section: Section, t: number): Sample {
  const a = section.start.pose, b = section.end.pose;
  if (section.arc) {
    const { center, radius, sweep } = section.arc;
    const theta = Math.atan2(a.y - center.y, a.x - center.x) + sweep * t;
    return { x: center.x + radius * Math.cos(theta), y: center.y + radius * Math.sin(theta), z: a.z + (b.z - a.z) * t };
  }
  const u = t, m0 = Math.tan(a.pitch) * section.run, m1 = Math.tan(b.pitch) * section.run;
  const z = section.kind === 'transition' ?
    (2*u*u*u - 3*u*u + 1)*a.z + (u*u*u - 2*u*u + u)*m0 +
    (-2*u*u*u + 3*u*u)*b.z + (u*u*u - u*u)*m1 : a.z + (b.z - a.z) * u;
  return { x: a.x + (b.x - a.x)*t, y: a.y + (b.y - a.y)*t, z };
}
function closest(a: Sample, b: Sample, c: Sample, d: Sample): { first: Sample; second: Sample; distance: number } {
  const ux = b.x-a.x, uy = b.y-a.y, vx = d.x-c.x, vy = d.y-c.y;
  const wx = a.x-c.x, wy = a.y-c.y;
  const A = ux*ux+uy*uy, B = ux*vx+uy*vy, C = vx*vx+vy*vy;
  const D = ux*wx+uy*wy, E = vx*wx+vy*wy;
  const denom = A*C-B*B;
  let s = denom > EPS ? Math.max(0, Math.min(1, (B*E-C*D)/denom)) : 0;
  let t = C > EPS ? Math.max(0, Math.min(1, (B*s+E)/C)) : 0;
  s = A > EPS ? Math.max(0, Math.min(1, (B*t-D)/A)) : 0;
  const first = { x:a.x+ux*s, y:a.y+uy*s, z:a.z+(b.z-a.z)*s };
  const second = { x:c.x+vx*t, y:c.y+vy*t, z:c.z+(d.z-c.z)*t };
  return { first, second, distance: Math.hypot(first.x-second.x, first.y-second.y) };
}
function pieces(section: Section): Sample[] {
  if (section.pathPoints) return section.pathPoints;
  const count = section.arc ? Math.max(8, Math.ceil(Math.abs(section.arc.sweep)*section.arc.radius / 8)) :
    section.kind === 'transition' ? Math.max(4, Math.ceil(section.run / 16)) : 1;
  return Array.from({ length: count+1 }, (_, i) => at(section, i/count));
}
/** How far past their half width `cars` swing on a curved section: bodies bridging the curve cut inside it and overhang outside. */
export function curveSweep(section: Section, cars: readonly Car[]): number {
  return section.arc ? trainCurveSweep(cars, section.arc.radius) : 0;
}
/** Sections of one assembly, or joined port to port, only touch; they cannot cross each other. */
export function touching(a: Section, b: Section): boolean {
  if (a.pieceId !== undefined && a.pieceId === b.pieceId) return true;
  return [a.start, a.end].some(p => [b.start, b.end].some(q =>
    Math.hypot(p.pose.x-q.pose.x, p.pose.y-q.pose.y, p.pose.z-q.pose.z) <= 0.01));
}

export function checkCrossings(project: WorkshopProject, sections: readonly Section[]): { crossings: CrossingClearance[]; issues: FitIssue[] } {
  const crossings: CrossingClearance[] = [], issues: FitIssue[] = [];
  const envelope = trainEnvelope(project), cars = realCars(project);
  const lowerBase = railDimension(project, 'railBaseThickness');
  const lowerRail = railDimension(project, 'railHeight');
  const pieceById = new Map(project.routes.flatMap(route => route.pieces.map(piece => [piece.id, piece] as const)));
  for (const crossing of project.crossings) {
    const self = crossing.upperRouteId === crossing.lowerRouteId;
    const fitted = (routeId: string) => sections.filter(s => s.routeId === routeId && s.kind !== 'unresolved').map(section => {
      const samples = pieces(section), xs = samples.map(p => p.x), ys = samples.map(p => p.y);
      return { section, samples, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
    });
    const upper = fitted(crossing.upperRouteId), lower = self ? upper : fitted(crossing.lowerRouteId);
    // Section pairs nearest first by plan bounding box; a pair whose boxes are farther apart than the best hit cannot beat it.
    const pairs = upper.flatMap(a => lower.map(b => ({ a, b, apart: Math.hypot(Math.max(0, a.box[0] - b.box[2], b.box[0] - a.box[2]),
      Math.max(0, a.box[1] - b.box[3], b.box[1] - a.box[3])) }))).sort((p, q) => p.apart - q.apart);
    let best: { first: Sample; second: Sample; distance: number; upper: Section; lower: Section } | undefined;
    for (const { a: { section: a, samples: A }, b: { section: b, samples: B }, apart } of pairs) {
      if (best && apart > best.distance + EPS) break;
      // Sections that only touch (a turnout branch joined to the next route, or one piece's own paths) meet at a
      // joint, not a crossing; a route that also bridges the other elsewhere is measured there.
      if (touching(a, b)) continue;
      for (let i=1; i<A.length; i++) for (let j=1; j<B.length; j++) {
        let candidate = { ...closest(A[i-1], A[i], B[j-1], B[j]), upper: a, lower: b };
        // A route crossing itself has no declared upper side: the higher sample is the bridge.
        if (self && candidate.first.z < candidate.second.z) candidate = { first: candidate.second, second: candidate.first,
          distance: candidate.distance, upper: b, lower: a };
        if (!best || candidate.distance < best.distance ||
          (Math.abs(candidate.distance-best.distance) < EPS && candidate.first.z-candidate.second.z < best.first.z-best.second.z)) {
          best = candidate;
        }
      }
    }
    if (!best) {
      issues.push({ code:'crossing-unfitted', severity:'error', crossingId:crossing.id, message:'Fix the track on both sides of this crossing first.' });
      continue;
    }
    const height = envelope?.height ?? null, width = envelope?.width ?? null;
    const gap = best.first.z-best.second.z;
    const lowerProfileKnown = project.trackSystem === 'brick-v1' ||
      ['printed_straight','printed_curve','vertical_transition'].includes(best.lower.family ?? '');
    const deckThickness = best.upper.parameters.deck_thickness;
    const deck = best.upper.family === 'bridge_deck';
    // A helix checks clearance over and under itself (helix-clearance), with its real wedge undersides.
    const selfChecked = (section: Section) => pieceById.get(section.pieceId ?? section.id)?.family === HELIX_CURVE.family;
    const ownTurns = selfChecked(best.upper) || selfChecked(best.lower);
    const undersideClearance = deck && Number.isFinite(deckThickness) && deckThickness>0 &&
      lowerProfileKnown && lowerBase!==null && lowerRail!==null ?
      best.first.z-(best.second.z+lowerBase+lowerRail) : null;
    const envelopeWidth = width === null ? null : width + curveSweep(best.upper, cars) + curveSweep(best.lower, cars);
    const intersectsSweep = envelopeWidth !== null && best.distance < envelopeWidth;
    // A missing underside datum can disprove a too-low crossing, but cannot certify a clear one.
    const testedGap = undersideClearance ?? gap;
    const clearanceBlocked = testedGap <= 0 || (height !== null && testedGap < height - EPS && intersectsSweep);
    let status: CrossingClearance['status'] = 'unknown';
    if (clearanceBlocked) status = 'blocked';
    else if (undersideClearance!==null && height!==null && best.distance<=0.1 && undersideClearance>=height) status = 'digitally-clear';
    if (best.distance > 0.1) {
      issues.push({ code:'crossing-no-intersection', severity:'error', crossingId:crossing.id, message:'These tracks do not cross; move one of them.' });
      status = 'blocked';
    }
    if (clearanceBlocked) issues.push({ code:'crossing-clearance', severity:'error', crossingId:crossing.id,
      message:`Only ${Math.max(0, testedGap).toFixed(0)} mm under the bridge${height === null ? '' : `; your tallest car is ${height} mm`}. Raise the upper track${height === null ? '' : ` by ${Math.ceil(height - testedGap)} mm`}.` });
    else if (envelope === null) issues.push({ code:'crossing-envelope-unknown', severity:'warning', crossingId:crossing.id, message:CARS_NEEDED_MESSAGE });
    else if (!deck && !ownTurns) issues.push({ code:'deck-clearance-unknown', severity:'warning', crossingId:crossing.id,
      message:'Use a Bridge piece over the crossing to check clearance.' });
    if (intersectsSweep && best.distance > 0.1 && testedGap < (height ?? Infinity)) {
      status = 'blocked';
      issues.push({ code:'swept-envelope-collision', severity:'error', crossingId:crossing.id,
        message:'A car on the curve swings into the other track; move the tracks apart.' });
    }
    // Standard brick-train clearance (rail top to the underside above), whatever the user's own cars: a graded upper
    // piece prints as a wedge whose flat underside sits at its lowest point nearby.
    const upperPoints = best.upper.pathPoints ?? [best.upper.start.pose, best.upper.end.pose];
    const underside = deck ? best.first.z : Math.min(best.first.z, ...upperPoints
      .filter(point => Math.hypot(point.x - best!.first.x, point.y - best!.first.y) <= 130).map(point => point.z));
    const standardGap = lowerProfileKnown && lowerBase !== null && lowerRail !== null ? underside - (best.second.z + lowerBase + lowerRail) : null;
    if (!clearanceBlocked && !ownTurns && best.distance <= 0.1 && standardGap !== null && standardGap < ELEVATION.clearance - EPS) {
      const raise = Math.ceil(ELEVATION.clearance - standardGap);
      issues.push({ code:'crossing-standard-clearance', severity:'warning', crossingId:crossing.id,
        message: envelope === null ?
          `Only ${Math.max(0, standardGap).toFixed(0)} mm under the bridge: trains need ${ELEVATION.clearance} mm from rail top to the bridge underside. Raise the upper track ${raise} mm.` :
          `${standardGap.toFixed(0)} mm under the bridge fits your cars, but standard clearance is ${ELEVATION.clearance} mm: raise the upper track ${raise} mm for taller trains.` });
    }
    crossings.push({ crossingId:crossing.id, upperRouteId:crossing.upperRouteId, lowerRouteId:crossing.lowerRouteId,
      upperPoint:{ id:`${crossing.id}:upper`, ...best.first }, lowerPoint:{ id:`${crossing.id}:lower`, ...best.second }, status,
      upperPieceId:sectionPiece(best.upper), lowerPieceId:sectionPiece(best.lower),
      ...(undersideClearance === null ? {} : { clearance:undersideClearance }), ...(height === null ? {} : { needed:height }) });
  }
  return { crossings, issues };
}
