import { surfaceBelow } from '../domain/furniture';
import { ELEVATION } from '../domain/elevation';
import { partUnderside, pieceDefinition, piecePorts, tieStations } from '../domain/pieces';
import { realCars, routeBase, trainEnvelope, type Car, type WorkshopProject } from '../domain/project';
import { sectionPiece, type FitIssue, type PartInstance, type Pose3, type Section } from '../domain/route';
import { samplePath } from '../drive/traversal';
import { curveSweep, touching } from './crossing';

/**
 * `pose` is the seat under the track (world z); `ground` what it stands on, the route's base or a furniture surface under
 * it (absent = the table); `height` = seat − ground.
 * A `layout_riser` stack is `blocks` (heights bottom to top) of stackable stud blocks centred under a full tie.
 */
export interface Support {
  id: string;
  routeId: string;
  pose: Pose3;
  height: number;
  ground?: number;
  family: 'reversible_column' | 'anchored_bracket' | 'layout_riser';
  blocks?: number[];
}
export interface MountingPlan {
  supports: Support[];
  siteChecks: string[];
  issues: FitIssue[];
}
/** Tallest riser block (10 plates) and the tallest stack used instead of a column. */
export const RISER_BLOCK = 32;
export const RISER_MAX = 96;

/** Track seated within this of the ground under it rests there (mm): float drift round a closed loop, a surface's height. */
const RESTING = 0.5;

/** Where a support sits for a fraction `t` of its section and the ground it stands on, or null where none is needed. */
type Placer = (t: number) => { pose: Pose3; ground: number; riser: boolean } | null;
interface Location { section: Section; t: number; pose: Pose3; ground: number; spacing: number; riser: boolean; place: Placer }

function supportPose(section: Section, t: number): Pose3 {
  return samplePath({routeId:section.routeId,sections:[section],length:section.run,gap:null},section.run*t)!;
}

/** Block heights of a riser stack: whole 10-plate blocks, then the remainder on top. */
function riserBlocks(height: number): number[] {
  const plates = Math.round(height / ELEVATION.plate), whole = Math.floor(plates / 10), rest = plates % 10;
  return [...Array.from({ length: whole }, () => RISER_BLOCK), ...(rest ? [Number((rest * ELEVATION.plate).toFixed(4))] : [])];
}

/** The lower route's section a support at `pose` would stand in, or null; `surface`: the furniture surface it stands on (else -Infinity). */
function intrudesOnLowerRoute(pose: Pose3, surface: number, own: Section, sections: readonly Section[],
  lowerRoutes: ReadonlySet<string>, selfRoutes: ReadonlySet<string>, corridor: number, cars: readonly Car[]): Section | null {
  for (const lower of sections) {
    if (!lowerRoutes.has(lower.routeId) || lower.kind === 'unresolved') continue;
    // A route passing under itself is checked against its own lower pieces, never the piece holding the support.
    if (lower.routeId === own.routeId && (!selfRoutes.has(own.routeId) || lower === own || touching(lower, own))) continue;
    const a = lower.start.pose, b = lower.end.pose;
    let clearance: number;
    if (lower.pathPoints) {
      clearance=Infinity;
      for(let i=1;i<lower.pathPoints.length;i++) {
        const from=lower.pathPoints[i-1],to=lower.pathPoints[i],dx=to.x-from.x,dy=to.y-from.y,denom=dx*dx+dy*dy;
        const t=denom?Math.max(0,Math.min(1,((pose.x-from.x)*dx+(pose.y-from.y)*dy)/denom)):0;
        clearance=Math.min(clearance,Math.hypot(pose.x-from.x-t*dx,pose.y-from.y-t*dy));
      }
    } else if (lower.arc) {
      const { center, radius, sweep } = lower.arc;
      const startAngle = Math.atan2(a.y-center.y, a.x-center.x);
      const pointAngle = Math.atan2(pose.y-center.y, pose.x-center.x);
      const directed = (pointAngle-startAngle) * Math.sign(sweep);
      const travel = ((directed % (2*Math.PI)) + 2*Math.PI) % (2*Math.PI);
      clearance = travel <= Math.abs(sweep) ?
        Math.abs(Math.hypot(pose.x-center.x, pose.y-center.y) - radius) :
        Math.min(Math.hypot(pose.x-a.x, pose.y-a.y), Math.hypot(pose.x-b.x, pose.y-b.y));
    } else {
      const dx = b.x-a.x, dy = b.y-a.y, denom = dx*dx+dy*dy;
      const t = denom ? Math.max(0, Math.min(1, ((pose.x-a.x)*dx + (pose.y-a.y)*dy)/denom)) : 0;
      clearance = Math.hypot(pose.x-(a.x+t*dx), pose.y-(a.y+t*dy));
    }
    // Track under the surface the support stands on (in a cubby below a shelf top) is not in its way.
    if (clearance < corridor + curveSweep(lower, cars) && Math.min(a.z, b.z) < pose.z && Math.max(a.z, b.z) > surface - RESTING) return lower;
  }
  return null;
}

/**
 * Supports for the selected mounting mode under every raised section, standing on the highest furniture surface under
 * them, else on the route's base; track resting on that ground needs none. Level track at a whole number of plates up to
 * RISER_MAX above its ground (freestanding mounting) sits on riser stacks under full ties; graded composite parts print
 * as wedges with one flat underside, so their columns stop there (two per bed part).
 */
export function planMounting(project: WorkshopProject, sections: readonly Section[], parts: readonly PartInstance[] = []): MountingPlan {
  const locations = new Map<string, Location>();
  const lowerRoutes = new Set(project.crossings.map(crossing => crossing.lowerRouteId));
  const selfRoutes = new Set(project.crossings.filter(crossing => crossing.upperRouteId === crossing.lowerRouteId).map(crossing => crossing.lowerRouteId));
  const envelope = trainEnvelope(project);
  const anchored = project.mounting === 'anchored';
  const routes = new Map(project.routes.map(route => [route.id, route]));
  const pieces = new Map(project.routes.flatMap(route => route.pieces.map(piece => [piece.id, piece] as const)));
  // Joints held by a self-supported piece (a helix section's own column) need no support of their own.
  const heldJoints = [...pieces.values()].filter(piece => pieceDefinition(piece.family).ownSupports?.(piece)).flatMap(piece => piecePorts(piece, project));
  /** What a seat at `pose` stands on: the highest furniture surface under it at or just above its height, else `base`. */
  const groundUnder = (pose: Pose3, base: number) => Math.max(base, surfaceBelow(project.furniture, pose, pose.z + RESTING) ?? -Infinity);
  const add = (section: Section, t: number, spacing: number, place: Placer) => {
    const placed = place(t);
    if (!placed || heldJoints.some(port => Math.hypot(port.x - placed.pose.x, port.y - placed.pose.y, port.z - placed.pose.z) < 0.5)) return;
    const { pose } = placed, key = `${section.routeId}:${pose.x.toFixed(3)}:${pose.y.toFixed(3)}:${pose.z.toFixed(3)}`;
    locations.set(key, { section, t, pose, ground: placed.ground, spacing, riser: placed.riser, place });
  };
  for (const section of sections) {
    if (section.kind === 'unresolved') continue;
    const piece = pieces.get(section.pieceId ?? section.id);
    if (piece && pieceDefinition(piece.family).ownSupports?.(piece)) continue;
    const base = routeBase(routes.get(section.routeId));
    const graded = section.pathPoints?.some(point => Math.abs(point.pitch) > 1e-9) ?? false;
    const wedges = graded ? parts.filter(part => part.sectionId === section.id && part.interfaceKind === 'rail' && part.family === 'composite_track') : [];
    if (wedges.length) {
      let station = 0;
      for (const part of wedges) {
        const p = part.parameters, length = Array.from({ length: p.segments }, (_, i) => p[`s${i}_len`]).reduce((sum, len) => sum + len, 0);
        const from = station / section.run, span = length / section.run, seat = partUnderside(p, part.pose.z);
        station += length;
        if (seat - base <= RESTING) continue;
        const place: Placer = t => {
          const pose = { ...supportPose(section, Math.min(1, Math.max(0, t))), z: seat, pitch: 0 }, ground = groundUnder(pose, base);
          return seat - ground > RESTING ? { pose, ground, riser: false } : null;
        };
        for (const at of length < 96 ? [0.5] : [0.25, 0.75]) add(section, from + span * at, span / 2, place);
      }
      continue;
    }
    const level = !graded && Math.abs(section.start.pose.z - section.end.pose.z) < 1e-6;
    const ties = !anchored && project.trackSystem === 'brick-v1' && level && !section.pathId && section.family !== 'bridge_deck' ?
      tieStations(section.run) : [];
    const place: Placer = t => {
      const pose = supportPose(section, t), ground = groundUnder(pose, base);
      if (pose.z - ground <= RESTING) return null;
      if (ties.length) {
        // A riser's studs clutch the nearest full tie's underside: a whole number of plates above its ground.
        const tie = supportPose(section, ties.reduce((best, at) => Math.abs(at - t * section.run) < Math.abs(best - t * section.run) ? at : best) / section.run);
        const under = groundUnder(tie, base), plates = (tie.z - under) / ELEVATION.plate;
        if (tie.z - under > RESTING && tie.z - under <= RISER_MAX + 1e-6 && Math.abs(plates - Math.round(plates)) < 1e-3) return { pose: tie, ground: under, riser: true };
      }
      return { pose, ground, riser: false };
    };
    const count = Math.ceil(section.run / 200);
    for (let n = 0; n <= count; n++) add(section, n / count, 1 / count, place);
  }
  const entries = [...locations.values()];
  const supports = entries.map(({ section, pose, ground, riser }, index): Support => {
    const height = pose.z - ground;
    return { id: `${project.mounting}:${section.routeId}:${index}`, routeId: section.routeId, pose: { ...pose }, height, ...(ground ? { ground } : {}),
      family: anchored ? 'anchored_bracket' : riser ? 'layout_riser' : 'reversible_column', ...(riser ? { blocks: riserBlocks(height) } : {}) };
  });
  const issues: FitIssue[] = [];
  // Wall brackets hang clear of the floor; only freestanding columns can stand in an underpass.
  if (!anchored && lowerRoutes.size && envelope) {
    const corridor = envelope.width / 2, cars = realCars(project);
    const intrudes = (pose: Pose3, ground: number, section: Section) => intrudesOnLowerRoute(pose,
      ground > routeBase(routes.get(section.routeId)) ? ground : -Infinity, section, sections, lowerRoutes, selfRoutes, corridor, cars);
    for (let index = 0; index < supports.length; index++) {
      const support = supports[index], location = entries[index];
      const obstructed = intrudes(support.pose, support.ground ?? 0, location.section);
      if (!obstructed) continue;
      let relocated: { pose: Pose3; ground: number } | null = null;
      for (let step = 1; step <= 8 && relocated === null; step++) {
        for (const direction of [-1, 1]) {
          const t = location.t + direction * step * location.spacing / 16;
          if (t < 0 || t > 1) continue;
          const candidate = location.place(t);
          if (candidate && !intrudes(candidate.pose, candidate.ground, location.section)) {
            relocated = candidate;
            break;
          }
        }
      }
      if (relocated) {
        support.pose = relocated.pose;
        support.height = relocated.pose.z - relocated.ground;
        if (relocated.ground) support.ground = relocated.ground;
        else delete support.ground;
      } else {
        issues.push({ code: 'support-track-collision', severity: 'error', routeId: support.routeId, supportIds: [support.id],
          pieceIds: [...new Set([sectionPiece(location.section), sectionPiece(obstructed)])], points: [{ x: support.pose.x, y: support.pose.y, z: support.ground ?? 0 }],
          message: 'A support stands in the path of the track below; move the bridge or the lower track.' });
      }
    }
  }
  return {
    supports,
    siteChecks: supports.length ? anchored ?
      ['permission to drill', 'substrate and anchor suitability', 'structural load path', 'accessible installation and derailment recovery'] :
      ['available base footprint', 'base stability', 'accessible derailment recovery'] : [],
    issues
  };
}
