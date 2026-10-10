import { GAUGE_LABEL, gaugeCarries, type CarGauge } from '../domain/gauges';
import { portsMatch, type Pose3, type Section } from '../domain/route';

export interface RoutePath {
  routeId: string;
  sections: readonly Section[];
  length: number;
  gap: string | null;
  /** Why the route stops at its first / last section: a moving piece not lined up with it (C4). The route still drives. */
  startHalt?: string;
  endHalt?: string;
}

/** A section's far end turned to face back along it, as a candidate's `start` would have to be met from there. */
const endFacing=(section:Section)=>({...section.end,pose:{...section.end.pose,heading:section.end.pose.heading+Math.PI,pitch:-section.end.pose.pitch}});
/** The stop message of a moving piece's disabled path met at `end` (from outside that piece), if any. */
function haltAt(sections:readonly Section[],end:Section['end'],pieceId:string|undefined):string|undefined {
  return sections.find(section=>section.enabled===false && section.halt!==undefined && section.pieceId!==pieceId &&
    (portsMatch(end,section.start) || portsMatch(end,endFacing(section))))?.halt;
}

/**
 * Distance follows the fitted section ports, never the sketch's unfitted centreline. With a train `gauge`, track that
 * doesn't carry it is never taken where another way exists (a dual-gauge divergence), and ends the path where it doesn't.
 * A route laid on track of another gauge is followed as its own track's trains run it, so the path stays on the route
 * (drive/compat then flags the train instead).
 */
export function routePath(sections: readonly Section[], routeId: string, gauge?: CarGauge): RoutePath {
  const eligible=sections.filter(section=>section.enabled!==false);
  let first=eligible.find(section=>section.routeId===routeId);
  if (!first) return {routeId,sections:[],length:0,gap:'This route has no track yet.'};
  const own=first.gauge ?? 'standard';
  const steer:CarGauge|undefined=gauge===undefined||gaugeCarries(own,gauge)?gauge:own==='dual'?undefined:own;
  const carries=(section:Section)=>steer===undefined || gaugeCarries(section.gauge ?? 'standard',steer);
  const goesOn=(from:Section)=>(to:Section)=>!carries(from) || carries(to);
  // A branch is stored in a separate authored chain, but belongs to the same
  // drivable component. Walk back to its open entry before sampling forwards.
  let startHalt:string|undefined;
  if (sections.some(section=>section.pathId)) {
    const backwards=new Set<string>();
    while (!backwards.has(first.id)) {
      backwards.add(first.id);
      const previous:Section[]=[];
      for (const candidate of eligible) {
        if (backwards.has(candidate.id) || first.pieceId && candidate.pieceId===first.pieceId) continue;
        if (portsMatch(candidate.end,first.start)) previous.push(candidate);
        else {
          const reversed=reverseSection(candidate);
          if (portsMatch(reversed.end,first.start)) previous.push(reversed);
        }
      }
      if (!previous.length) startHalt=haltAt(sections,reverseSection(first).end,first.pieceId) ?? first.startHalt;
      const usable:Section[]=previous.filter(goesOn(first));
      if (usable.length!==1) break;
      first=usable[0];
    }
  }
  const route:Section[]=[],visited=new Set<string>();
  let current:Section|undefined=first,gap:string|null=null,endHalt:string|undefined;
  while (current && !visited.has(current.id)) {
    route.push(current);visited.add(current.id);
    if (current.kind==='unresolved') {gap='Part of this route doesn’t fit together.';break;}
    const candidates:Section[]=[];
    for (const candidate of eligible) {
      if (visited.has(candidate.id) || current.pieceId && candidate.pieceId===current.pieceId) continue;
      if (portsMatch(current.end,candidate.start)) candidates.push(candidate);
      else if (portsMatch(current.end,endFacing(candidate))) candidates.push(reverseSection(candidate));
    }
    // Sprung points: a train arriving at a disabled path's far end trails through it, pushing the blades over.
    if (!candidates.length) for (const candidate of sections) {
      if (!candidate.trailable || visited.has(candidate.id) || current.pieceId && candidate.pieceId===current.pieceId) continue;
      if (portsMatch(current.end,endFacing(candidate))) candidates.push(reverseSection(candidate));
    }
    const next:Section[]=candidates.filter(goesOn(current));
    if (next.length>1) {gap='Two tracks leave the same connector.';break;}
    if (!candidates.length) {
      // Back at track this path already drove (a loop closing on a turnout's points, its other road set aside): the lap is complete.
      if (route.some(section=>portsMatch(current!.end,section.start))) break;
      endHalt=haltAt(sections,current.end,current.pieceId) ?? current.endHalt;
      const inactive=sections.some(section=>section.enabled===false && section.pieceId!==current!.pieceId &&
        (portsMatch(current!.end,section.start) || portsMatch(current!.end,endFacing(section))));
      // A moving piece lined up elsewhere ends the route there (it still drives); a switch set against it is a fault.
      if (endHalt!==undefined) break;
      if (inactive) gap='A switch is set against this route.';
      // An authored chain without branches must mate end to end; an unexplained break is not an open branch.
      else if (!sections.some(section=>section.routeId===routeId && section.pathId) &&
        eligible.some(section=>section.routeId===routeId && !visited.has(section.id))) gap='Two pieces on this route don’t connect.';
      break;
    }
    if (!next.length) {
      // Only track of another gauge goes on: this route's own chain can't be driven by this train; another route's just ends it.
      const track=GAUGE_LABEL[candidates[0].gauge ?? 'standard'];
      if (candidates.some(candidate=>candidate.routeId===routeId))
        gap=`${track[0].toUpperCase()}${track.slice(1)} track ahead: a ${GAUGE_LABEL[steer!]} train can’t run on it.`;
      break;
    }
    current=next[0];
  }
  return {routeId,sections:route,length:route.reduce((sum,section)=>sum+section.run,0),gap,
    ...(startHalt===undefined?{}:{startHalt}),...(endHalt===undefined?{}:{endHalt})};
}

function reverseSection(section:Section):Section {
  // Driven the other way, the rail that was on the right is on the left: the roll changes sign.
  const reversePose=(pose:Pose3):Pose3=>({...pose,heading:pose.heading+Math.PI,pitch:-pose.pitch,...(pose.roll?{roll:-pose.roll}:{})});
  // A free deck end stays with its end of the path.
  const {startHalt,endHalt,...rest}=section;
  return {...rest,...(endHalt===undefined?{}:{startHalt:endHalt}),...(startHalt===undefined?{}:{endHalt:startHalt}),
    fromPointId:section.toPointId,toPointId:section.fromPointId,
    start:{...section.end,pose:reversePose(section.end.pose)},end:{...section.start,pose:reversePose(section.start.pose)},
    ...(section.arc?{arc:{...section.arc,sweep:-section.arc.sweep}}:{}),
    ...(section.pathPoints?{pathPoints:[...section.pathPoints].reverse().map(reversePose)}:{})};
}

/**
 * The pose at `distance` along the path. Distance is plan run, as the fitted sections' `run` (and `length`) measure it;
 * a train's own spacing along a slope is converted with `offsetAlong`.
 */
export function samplePath(path: RoutePath, distance: number): Pose3 | null {
  // `run * i / n` can overshoot the length by an ulp; treat that as the end instead of dropping the sample.
  const tolerance = 1e-6 * Math.max(1, path.length);
  if (!Number.isFinite(distance) || distance < -tolerance || distance > path.length + tolerance || path.gap) return null;
  let remaining = Math.min(Math.max(distance, 0), path.length);
  for (let index = 0; index < path.sections.length; index++) {
    const section = path.sections[index];
    if (remaining > section.run && index < path.sections.length - 1) {
      remaining -= section.run;
      continue;
    }
    const t = section.run ? Math.max(0, Math.min(1, remaining / section.run)) : 0;
    const a = section.start.pose, b = section.end.pose;
    if (section.pathPoints) {
      let offset=remaining;
      for (let i=1;i<section.pathPoints.length;i++) {
        // Plan length, as `run`; level segments keep their original 3D measure (identical value).
        const from=section.pathPoints[i-1],to=section.pathPoints[i],length=to.z===from.z?Math.hypot(to.x-from.x,to.y-from.y,to.z-from.z):Math.hypot(to.x-from.x,to.y-from.y);
        if (offset>length && i<section.pathPoints.length-1) {offset-=length;continue;}
        const u=length?Math.max(0,Math.min(1,offset/length)):0;
        const angle=Math.atan2(Math.sin(to.heading-from.heading),Math.cos(to.heading-from.heading));
        // Banked track carries a roll; uncanted track's samples stay as they were (no roll key).
        const roll=from.roll||to.roll?{roll:(from.roll??0)+((to.roll??0)-(from.roll??0))*u}:{};
        return {x:from.x+(to.x-from.x)*u,y:from.y+(to.y-from.y)*u,z:from.z+(to.z-from.z)*u,
          heading:from.heading+angle*u,pitch:from.pitch+(to.pitch-from.pitch)*u,...roll};
      }
    }
    if (section.arc) {
      const { center, radius, sweep } = section.arc;
      const angle = Math.atan2(a.y - center.y, a.x - center.x) + sweep * t;
      return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle),
        z: a.z + (b.z - a.z) * t, heading: a.heading + sweep * t, pitch: a.pitch + (b.pitch - a.pitch) * t };
    }
    if (section.kind === 'transition') {
      const u = t, m0 = Math.tan(a.pitch) * section.run, m1 = Math.tan(b.pitch) * section.run;
      const z = (2*u*u*u - 3*u*u + 1)*a.z + (u*u*u - 2*u*u + u)*m0 +
        (-2*u*u*u + 3*u*u)*b.z + (u*u*u - u*u)*m1;
      const grade = ((6*u*u - 6*u)*a.z + (3*u*u - 4*u + 1)*m0 +
        (-6*u*u + 6*u)*b.z + (3*u*u - 2*u)*m1) / section.run;
      return { x: a.x + (b.x - a.x)*t, y: a.y + (b.y - a.y)*t, z,
        heading: a.heading, pitch: Math.atan(grade) };
    }
    return { x: a.x + (b.x - a.x)*t, y: a.y + (b.y - a.y)*t, z: a.z + (b.z - a.z)*t,
      heading: a.heading, pitch: a.pitch + (b.pitch - a.pitch)*t };
  }
  return null;
}

/**
 * The path distance reached by moving `along` mm along the track itself (3D arc length, + forwards) from `distance`:
 * a car's length, wheelbase and coupler gap are measured along a slope, not in plan. Exact on level track.
 */
export function offsetAlong(path: RoutePath, distance: number, along: number): number {
  const steps = Math.max(1, Math.ceil(Math.abs(along) / 4)), step = along / steps;
  let at = distance, level = true;
  for (let i = 0; i < steps; i++) {
    const pitch = samplePath(path, at + step / 2)?.pitch ?? 0;
    if (pitch) level = false;
    at += step * Math.cos(pitch);
  }
  return level ? distance + along : at;
}
