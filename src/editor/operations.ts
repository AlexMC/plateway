import { ROUTE_BASE_RANGE, changeProject, type Route, type RoutePiece, type WorkshopProject } from '../domain/project';
import { FLEX_MAX_BEND, counterpartFamily, gaugesMate, pieceDefinition, piecePaths, piecePorts, pieceState, pieceStates, placePoint, portsMate, primaryEnd, type ShapePort } from '../domain/pieces';
import { levelLeadAt } from '../fitting/elevation';

export type TileFamily = RoutePiece['family'];
export interface BuilderPort { x: number; y: number; z: number; heading: number }
/** The legacy custom joiner fits only plain tiles; official-shape prints and junctions need standard brick track. */
export function tileFits(project:WorkshopProject,family:TileFamily):boolean {
  return project.trackSystem==='brick-v1' || pieceDefinition(family).customJoiner;
}
/** Ports closer than this (and facing each other) are joined; covers float drift around a closed loop. */
const JOIN_DISTANCE = 0.5, JOIN_ANGLE = 0.01;

function routeById(project: WorkshopProject, routeId: string): Route {
  const route = project.routes.find(item => item.id === routeId);
  if (!route) throw new Error('Select an existing route.');
  return route;
}
function routeOfPiece(project: WorkshopProject, id: string): { route: Route; piece: RoutePiece; index: number } {
  for (const route of project.routes) {
    const index = route.pieces.findIndex(piece => piece.id === id);
    if (index >= 0) return { route, piece: route.pieces[index], index };
  }
  throw new Error('Piece no longer exists.');
}
const normalize = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
function mates(a: ShapePort, b: ShapePort): boolean {
  return portsMate(a, b, JOIN_DISTANCE, JOIN_ANGLE);
}
/** Lowest unused "Route N", so deleting a route never produces duplicate names. */
function nextRouteName(project: WorkshopProject): string {
  const names = new Set(project.routes.map(route => route.name));
  let n = 1;
  while (names.has(`Route ${n}`)) n++;
  return `Route ${n}`;
}
export function rebuildPiecePoints(project: WorkshopProject, route: Route): void {
  const pieces = route.pieces;
  route.points = pieces.length ? [
    { id:`${pieces[0].id}:start`,x:pieces[0].x,y:pieces[0].y,z:pieces[0].z },
    ...pieces.map(piece => { const end=primaryEnd(piece,project); return {id:`${piece.id}:end`,x:end.x,y:end.y,z:end.z}; })
  ] : [];
}
function intersect(a:BuilderPort,b:BuilderPort,c:BuilderPort,d:BuilderPort): {x:number;y:number;za:number;zb:number}|null {
  const ux=b.x-a.x,uy=b.y-a.y,vx=d.x-c.x,vy=d.y-c.y,den=ux*vy-uy*vx;
  const wx=c.x-a.x,wy=c.y-a.y;
  if (Math.abs(den)<1e-8) {
    const length=ux*ux+uy*uy,otherLength=vx*vx+vy*vy;
    if (length<1e-8 || otherLength<1e-8 || Math.abs(wx*uy-wy*ux)>1e-6*Math.sqrt(length)) return null;
    const start=(wx*ux+wy*uy)/length,end=start+(vx*ux+vy*uy)/length;
    const low=Math.max(0,Math.min(start,end)),high=Math.min(1,Math.max(start,end));
    if (high-low<=1e-6) return null;
    const t=(low+high)/2,x=a.x+t*ux,y=a.y+t*uy;
    const u=((x-c.x)*vx+(y-c.y)*vy)/otherLength;
    return {x,y,za:a.z+t*(b.z-a.z),zb:c.z+u*(d.z-c.z)};
  }
  const t=(wx*vy-wy*vx)/den,u=(wx*uy-wy*ux)/den;
  if (t< -1e-6 || t>1+1e-6 || u< -1e-6 || u>1+1e-6) return null;
  return {x:a.x+t*ux,y:a.y+t*uy,za:a.z+t*(b.z-a.z),zb:c.z+u*(d.z-c.z)};
}
/** Declare every centreline intersection, including a route crossing itself and unsafe same-height overlaps. */
export function syncBuilderCrossings(project: WorkshopProject): void {
  const active = new Map<string, {upper:string;lower:string}>();
  const samples = project.routes.map(route => route.pieces.flatMap(piece => piecePaths(piece,project).map(path=>({piece:piece.id,points:path.points}))));
  const endpoint=(points:BuilderPort[],x:number,y:number)=>[points[0],points.at(-1)!].some(p=>Math.hypot(p.x-x,p.y-y)<JOIN_DISTANCE);
  for (let i=0;i<project.routes.length;i++) for (let j=i;j<project.routes.length;j++) {
    const first=project.routes[i],second=project.routes[j];
    for (const A of samples[i]) for (const B of samples[j]) {
      if (A.piece===B.piece) continue;
      for (let ai=1;ai<A.points.length;ai++) for (let bi=1;bi<B.points.length;bi++) {
        const hit=intersect(A.points[ai-1],A.points[ai],B.points[bi-1],B.points[bi]);
        if (!hit) continue;
        // Pieces meeting port-to-port are joined, not crossing.
        if (Math.abs(hit.za-hit.zb)<0.01 && endpoint(A.points,hit.x,hit.y) && endpoint(B.points,hit.x,hit.y)) continue;
        // A coplanar overlap is a blocked crossing, not an absent crossing.
        const upper=hit.za>=hit.zb?first.id:second.id,lower=hit.za>=hit.zb?second.id:first.id;
        active.set([first.id,second.id].sort().join(':'),{upper,lower});
      }
    }
  }
  const kept=project.crossings.filter(c=>active.get([c.upperRouteId,c.lowerRouteId].sort().join(':'))?.upper===c.upperRouteId);
  project.crossings=[...kept,...[...active.values()].filter(pair=>!kept.some(c=>c.upperRouteId===pair.upper&&c.lowerRouteId===pair.lower))
    .map(pair=>({id:crypto.randomUUID(),upperRouteId:pair.upper,lowerRouteId:pair.lower}))];
}

/** `z` places an unsnapped piece at a height (default the table, 0 mm). */
export interface Placement { x:number; y:number; z?:number; heading?:number; rise?:number; sweep?:number; bend?:number; state?:string; params?:Record<string,number>; style?:'fast' }
export interface PiecePreview {
  piece: RoutePiece;
  routeId: string | null;
  edge: 'start' | 'end' | null;
  distance: number | null;
  portId?: string;
  /** Open port the piece snaps onto, for highlighting before the drop. */
  target: ShapePort | null;
  /** The piece's own port that meets `target`. */
  ownPortId?: string;
  /** Distinct ways the piece can attach to the open ends in reach (which of its ends meets which open end); `attachment` is the one shown. */
  attachments: number;
  attachment: number;
}
export interface SnapCandidate { route:Route;part:RoutePiece;port:ShapePort }
/** Ports not mated with another piece's port, where track can still attach (never a buffer stop's end); `routes` narrows the set considered. */
export function unoccupiedPiecePorts(project:WorkshopProject,routes:readonly Route[]=project.routes):SnapCandidate[] {
  const ports=routes.flatMap(route=>route.pieces.flatMap(part=>piecePorts(part,project).map(port=>({route,part,port}))));
  return ports.filter(({part,port})=>!port.stop && !ports.some(other=>other.part.id!==part.id && mates(other.port,port)));
}

/** One way to meet an open end: the piece's own port `own` mates `port`; `preferred` is the historical choice for that end. */
interface SnapOption { route:Route;part:RoutePiece;port:ShapePort;own:string;distance:number;edge:'start'|'end'|null;preferred:boolean;pose:{x:number;y:number;z:number;heading:number} }
/**
 * Resolve a drop without changing the project. Both the ghost and insertion use this pose.
 * The nearest open end in reach takes the piece's `in` (or, on a route's first piece, its far end, so the route grows backwards);
 * `attachment` picks another way among the open ends in reach and the piece's other ends (Tab in the editor), wrapping round.
 */
export function previewPiece(project: WorkshopProject, family: TileFamily, placement: Placement, snapRadius=30, candidates?:readonly SnapCandidate[], attachment=0): PiecePreview {
  if (!Number.isFinite(placement.x) || !Number.isFinite(placement.y) || !Number.isFinite(placement.heading??0)) throw new Error('Place pieces at finite millimetres.');
  const definition=pieceDefinition(family),legacy=definition.legacy??{};
  const sweep = legacy.sweep!==undefined ? placement.sweep ?? legacy.sweep : undefined;
  const rise = legacy.rise!==undefined ? placement.rise ?? legacy.rise : undefined;
  const bend = legacy.bend!==undefined ? placement.bend ?? legacy.bend : undefined;
  if (bend!==undefined && (!Number.isFinite(bend)||Math.abs(bend)>FLEX_MAX_BEND)) throw new Error('Flex bend must be within ±5.625°.');
  if (placement.state!==undefined && !definition.states?.some(state=>state.id===placement.state)) throw new Error('Invalid piece state.');
  for (const [key,value] of Object.entries(placement.params??{})) checkParam(definition,key,value);
  const piece: RoutePiece={id:'preview',family,x:placement.x,y:placement.y,z:placement.z??0,
    heading:placement.heading ?? 0,...(sweep===undefined?{}:{sweep}),...(rise===undefined?{}:{rise}),
    ...(bend===undefined?{}:{bend}),...(definition.states?{state:placement.state??definition.states[0].id}:{}),
    ...(placement.params&&Object.keys(placement.params).length?{params:{...placement.params}}:{}),
    ...(placement.style==='fast'&&definition.styles.includes('fast')?{style:'fast' as const}:{})};
  const options=snapOptions(project,piece,placement,snapRadius,candidates??unoccupiedPiecePorts(project));
  const index=options.length?((attachment%options.length)+options.length)%options.length:0,snap=options[index];
  if (snap) Object.assign(piece,snap.pose);
  // Laid by its `in` on an end with a junction close behind, a slope starts with the level track it still needs there.
  const leadKey=snap?.own==='in'?definition.levelEnds?.in:undefined;
  const lead=leadKey&&placement.params?.[leadKey]===undefined?levelLeadAt(project,snap!.port):0;
  if (lead) piece.params={...piece.params,[leadKey!]:lead};
  return {piece,routeId:snap?.route.id ?? null,edge:snap?.edge ?? null,distance:snap?.distance ?? null,portId:snap?.port.id,target:snap?.port ?? null,
    ...(snap?{ownPortId:snap.own}:{}),attachments:options.length,attachment:index};
}
/** Every distinct way `piece` can meet an open end within `snapRadius`, the historical default (nearest end, `in` or prepended far end) first. */
function snapOptions(project:WorkshopProject,piece:RoutePiece,placement:Placement,snapRadius:number,ports:readonly SnapCandidate[]):SnapOption[] {
  if (snapRadius<0 || !ports.length) return [];
  const definition=pieceDefinition(piece.family),local={...piece,x:0,y:0,z:0,heading:0};
  const localEnd=primaryEnd(local,project);
  // The far end is the authored chain end, which can differ from the raw `out` port on pieces with a custom end.
  const ownPorts=piecePorts(local,project).map(port=>port.id==='out'?{...port,...localEnd}:port);
  const unsnapped=new Map(ownPorts.map(port=>[port.id,placePoint(piece,port)]));
  const options:SnapOption[]=[];
  for (const {route,part,port} of ports) {
    const prepend=part===route.pieces[0] && port.id==='in';
    for (const own of ownPorts) {
      if (own.stop || !gaugesMate(port.gauge,own.gauge ?? definition.gauge)) continue;
      const at=unsnapped.get(own.id)!,toPointer=Math.hypot(placement.x-port.x,placement.y-port.y);
      const distance=own.id==='in'?toPointer:Math.min(toPointer,Math.hypot(at.x-port.x,at.y-port.y));
      if (distance>snapRadius) continue;
      let pose;
      if (own.id==='in' && own.x===0 && own.y===0 && own.z===0) pose={x:port.x,y:port.y,z:port.z,heading:port.heading};
      else {
        const heading=port.heading-Math.PI-own.heading,aligned=placePoint({x:0,y:0,z:0,heading},own);
        pose={x:port.x-aligned.x,y:port.y-aligned.y,z:port.z-own.z,heading};
      }
      const edge=prepend&&own.id==='out'?'start':own.id==='in'&&part===route.pieces.at(-1)&&port.id==='out'?'end':null;
      options.push({route,part,port,own:own.id,distance,edge,pose,preferred:own.id===(prepend?'out':'in')});
    }
  }
  let first:SnapOption|null=null;
  for (const option of options) if (option.preferred && (!first || option.distance<first.distance || option.distance===first.distance && option.edge==='end' && first.edge==='start')) first=option;
  const rest=options.filter(option=>option!==first).sort((a,b)=>a.distance-b.distance);
  // A piece that lands on the same ends either way round (a straight attached by either end) is one option.
  const footprint=(option:SnapOption)=>ownPorts.map(own=>placePoint(option.pose,own)).map(point=>`${Math.round(point.x*2)},${Math.round(point.y*2)},${Math.round(point.z*2)}`).sort().join('|');
  const seen=new Set<string>(),unique:SnapOption[]=[];
  for (const option of first?[first,...rest]:rest) {
    const key=footprint(option);
    if (!seen.has(key)) {seen.add(key);unique.push(option);}
  }
  return unique;
}

/** Turnouts and crossovers are handed: they can only be entered from their `in` side. */
const reversible = (piece: RoutePiece) => !pieceDefinition(piece.family).handed;
/** The same physical piece, authored from its far end. */
function reversePiece(project: WorkshopProject, piece: RoutePiece): RoutePiece {
  const end=primaryEnd(piece,project),next:RoutePiece={...piece,x:end.x,y:end.y,z:end.z,heading:normalize(end.heading+Math.PI)};
  if (piece.sweep!==undefined) next.sweep=-piece.sweep;
  if (piece.rise!==undefined) next.rise=-piece.rise;
  if (piece.bend!==undefined) next.bend=-piece.bend;
  const reverseParams=pieceDefinition(piece.family).reverseParams;
  if (reverseParams) next.params=reverseParams(piece.params??{});
  return next;
}
/** A route's chainable ends: its first piece's `in` and last piece's `out` (a wye ends a chain on its legs, so it has no `out`). */
function routeEnds(project: WorkshopProject, route: Route): {edge:'start'|'end';port:ShapePort}[] {
  if (!route.pieces.length) return [];
  const start=piecePorts(route.pieces[0],project).find(port=>port.id==='in');
  const end=piecePorts(route.pieces.at(-1)!,project).find(port=>port.id==='out');
  return [...(start?[{edge:'start' as const,port:start}]:[]),...(end?[{edge:'end' as const,port:end}]:[])];
}
/** Move a chain rigidly: rotate by `angle` about `pivot`, then carry the pivot onto `destination`. */
function transformChain(pieces: readonly RoutePiece[], pivot: BuilderPort, angle: number, destination: BuilderPort): RoutePiece[] {
  const c=Math.cos(angle),s=Math.sin(angle);
  return pieces.map(piece=>({...piece,
    x:destination.x+c*(piece.x-pivot.x)-s*(piece.y-pivot.y),
    y:destination.y+s*(piece.x-pivot.x)+c*(piece.y-pivot.y),
    z:piece.z+destination.z-pivot.z,heading:angle?normalize(piece.heading+angle):piece.heading}));
}
/**
 * Merge `route` with every other route whose end meets one of its ends, keeping the earlier route's id and name.
 * A handed piece is never reversed; if both chains contain one, the joint stays mated across two routes.
 */
function mergeTouchingRoutes(project: WorkshopProject, route: Route): void {
  for (let guard=0;guard<project.routes.length;guard++) {
    let merged=false;
    for (const own of routeEnds(project,route)) {
      for (const other of project.routes) {
        if (other===route) continue;
        const theirs=routeEnds(project,other).find(end=>mates(own.port,end.port));
        if (!theirs) continue;
        // Close any sub-millimetre residual by carrying the other chain onto this port.
        let otherPieces=transformChain(other.pieces,theirs.port,0,{...own.port});
        let ownPieces=route.pieces,pieces:RoutePiece[]|null=null;
        if (own.edge==='end'&&theirs.edge==='start') pieces=[...ownPieces,...otherPieces];
        else if (own.edge==='start'&&theirs.edge==='end') pieces=[...otherPieces,...ownPieces];
        else {
          const flipOther=otherPieces.every(reversible),flipOwn=ownPieces.every(reversible);
          if (!flipOther&&!flipOwn) continue;
          if (flipOther) otherPieces=otherPieces.map(piece=>reversePiece(project,piece)).reverse();
          else ownPieces=ownPieces.map(piece=>reversePiece(project,piece)).reverse();
          pieces=own.edge==='end'?(flipOther?[...ownPieces,...otherPieces]:[...otherPieces,...ownPieces]):
            (flipOther?[...otherPieces,...ownPieces]:[...ownPieces,...otherPieces]);
        }
        const keep=project.routes.indexOf(route)<project.routes.indexOf(other)?route:other,drop=keep===route?other:route;
        keep.pieces=pieces;
        project.routes=project.routes.filter(item=>item!==drop);
        route=keep;merged=true;break;
      }
      if (merged) break;
    }
    if (!merged) break;
  }
  rebuildPiecePoints(project,route);
}

/** Drop uses millimetres in the same frame as route points; default snap radius is 30 mm; `attachment` picks another way to meet the open ends in reach. */
export function placePiece(project: WorkshopProject, family: TileFamily, placement: Placement, snapRadius=30, attachment=0): [WorkshopProject,string] {
  return placePreview(project,previewPiece(project,family,placement,snapRadius,undefined,attachment));
}
/** Lay a resolved preview (from `previewPiece`, or a variant at a locked joint) as one undoable edit. */
export function placePreview(project: WorkshopProject, {piece: preview,routeId,edge}: Pick<PiecePreview,'piece'|'routeId'|'edge'>): [WorkshopProject,string] {
  const piece={...preview,id:crypto.randomUUID()};
  const next=changeProject(project,draft=>{
    let route: Route;
    if (routeId && edge) {
      route=routeById(draft,routeId);
      if (edge==='end') route.pieces.push(piece);
      else route.pieces.unshift(piece);
    } else {
      route={id:crypto.randomUUID(),name:nextRouteName(draft),points:[],pieces:[piece]};
      draft.routes.push(route);
    }
    mergeTouchingRoutes(draft,route);
    syncBuilderCrossings(draft);
  });
  return [next,piece.id];
}
export function removePiece(project: WorkshopProject, id:string): WorkshopProject {
  return changeProject(project,draft=>{
    const {route,index}=routeOfPiece(draft,id);
    route.pieces.splice(index,1);
    // Removing an inner tile opens the route; the later chain becomes its own route.
    if (index>0 && index<route.pieces.length) {
      const remainder={id:crypto.randomUUID(),name:nextRouteName(draft),pieces:route.pieces.splice(index),points:[],...(route.base===undefined?{}:{base:route.base})};
      draft.routes.push(remainder);rebuildPiecePoints(draft,remainder);
    }
    if (route.pieces.length) rebuildPiecePoints(draft,route);
    else draft.routes=draft.routes.filter(r=>r!==route);
    syncBuilderCrossings(draft);
  });
}
/** Lays every piece after `piece` on its predecessor's end, after `piece` changed shape. */
export function reflowFollowingPieces(project:WorkshopProject,route:Route,piece:RoutePiece):void {
  for(let i=route.pieces.indexOf(piece)+1;i<route.pieces.length;i++) {
    const end=primaryEnd(route.pieces[i-1],project),next=route.pieces[i];
    next.x=end.x;next.y=end.y;next.z=end.z;next.heading=end.heading;
  }
}

export function canFlipPiece(piece:RoutePiece):boolean {
  const definition=pieceDefinition(piece.family);
  return piece.sweep!==undefined || definition.legacy?.rise!==undefined || definition.mirror!==undefined || definition.flip!==undefined;
}
/** Curves turn the other way, ramps climb the other way, turnouts swap hand in place, parametric shapes mirror.
 * A route's first piece held only by its far end keeps that end where it is, so the rest of the chain stays put. */
export function flipPiece(project:WorkshopProject,id:string):WorkshopProject {
  return changeProject(project,draft=>{
    const {route,piece,index}=routeOfPiece(draft,id);
    if (!canFlipPiece(piece)) throw new Error('Select a curve, ramp or turnout to flip.');
    const definition=pieceDefinition(piece.family);
    const anchorEnd=index===0&&route.pieces.length>1&&definition.legacy?.rise===undefined&&!routeClosed(draft,route)&&
      !matedPorts(draft,piece).some(port=>port.id==='in');
    const before=primaryEnd(piece,draft);
    if (piece.sweep !== undefined) piece.sweep = -piece.sweep;
    else if (definition.legacy?.rise!==undefined) piece.rise = -(piece.rise || 8);
    else if (definition.flip) piece.params = definition.flip(piece.params??{});
    else piece.family = definition.mirror!;
    if (anchorEnd) {
      const local=primaryEnd({...piece,x:0,y:0,z:0,heading:0},draft),heading=normalize(before.heading-local.heading);
      const at=placePoint({x:0,y:0,z:0,heading},local);
      Object.assign(piece,{x:before.x-at.x,y:before.y-at.y,z:before.z-local.z,heading});
    } else reflowFollowingPieces(draft,route,piece);
    rebuildPiecePoints(draft,route);syncBuilderCrossings(draft);
  });
}
/** A route whose last piece's far end meets its first piece's `in`. */
function routeClosed(project:WorkshopProject,route:Route):boolean {
  const ends=routeEnds(project,route);
  return route.pieces.length>1 && ends.length===2 && mates(ends[0].port,ends[1].port);
}
/** The piece's ports that meet another piece's port. */
function matedPorts(project:WorkshopProject,piece:RoutePiece):ShapePort[] {
  const others=project.routes.flatMap(route=>route.pieces).filter(part=>part.id!==piece.id).flatMap(part=>piecePorts(part,project));
  return piecePorts(piece,project).filter(port=>others.some(other=>mates(port,other)));
}
export type PieceRotation = {pivot:BuilderPort} | {reason:string};
/**
 * Where a selected piece turns on its own: about the one joint holding it (a chain's end piece, or one already turned away from
 * its chain but still touching it), or its middle when nothing touches it. A piece held at two ends cannot turn alone.
 */
export function pieceRotation(project:WorkshopProject,id:string):PieceRotation {
  const {piece}=routeOfPiece(project,id),mated=matedPorts(project,piece);
  if (mated.length>1) return {reason:'Joined at both ends: turning it alone would break the track. Flip it, or use Rotate route.'};
  const others=project.routes.flatMap(route=>route.pieces).filter(part=>part.id!==piece.id).flatMap(part=>piecePorts(part,project));
  const held=mated[0]??piecePorts(piece,project).find(port=>!port.stop&&others.some(other=>!other.stop&&Math.hypot(port.x-other.x,port.y-other.y,port.z-other.z)<JOIN_DISTANCE));
  if (held) return {pivot:{x:held.x,y:held.y,z:held.z,heading:0}};
  const end=primaryEnd(piece,project);
  return {pivot:{x:(piece.x+end.x)/2,y:(piece.y+end.y)/2,z:piece.z,heading:0}};
}
/** Turn one piece by `angle` about its `pieceRotation` pivot. A chain's end piece leaves the chain (it no longer meets it) and rejoins when turned back. */
export function rotatePiece(project:WorkshopProject,id:string,angle:number):WorkshopProject {
  if (!Number.isFinite(angle)) throw new Error('Rotate by a finite angle.');
  const rotation=pieceRotation(project,id);
  if ('reason' in rotation) throw new Error(rotation.reason);
  return changeProject(project,draft=>{
    const {route,piece,index}=routeOfPiece(draft,id);
    const [turned]=transformChain([piece],rotation.pivot,angle,rotation.pivot);
    let own=route;
    if (route.pieces.length>1) {
      route.pieces.splice(index,1);rebuildPiecePoints(draft,route);
      own={id:crypto.randomUUID(),name:nextRouteName(draft),points:[],pieces:[turned],...(route.base===undefined?{}:{base:route.base})};
      draft.routes.push(own);
    } else route.pieces[0]=turned;
    mergeTouchingRoutes(draft,own);syncBuilderCrossings(draft);
  });
}

/** An open port of a placed piece. */
export interface PieceEnd { pieceId:string; portId:string; port:ShapePort }
/** Two ends an edit left apart, `distance` mm between them. */
export interface OpenedGap { a:PieceEnd; b:PieceEnd; distance:number }
export interface InsertPlan {
  /** The project with the piece in the route; commit it as one undoable edit. */
  next: WorkshopProject;
  pieceId: string;
  routeId: string;
  /** `replace`: the piece took the place of `removed`, a run of whole pieces ending where it ends (or, with `spacer`, just beyond it);
   * `insert`: the pieces after it moved along. */
  mode: 'replace' | 'insert';
  piece: RoutePiece;
  /** The printed straight that fills the rest of a replaced straight run longer than the piece. */
  spacer?: RoutePiece;
  removed: RoutePiece[];
  /** Pieces that moved, at their new poses (including routes hanging off them, such as a siding on a later turnout). */
  shifted: RoutePiece[];
  /** Ends the edit pulled apart: a closed loop opened, or a joint to other track that could not move. */
  gaps: OpenedGap[];
  /** The placed piece under the pointer. */
  hoveredId: string;
  /** Where the piece starts, and the ways to insert at the hovered piece (its joints, either way round); `option` is the one shown. */
  joint: BuilderPort;
  options: number;
  option: number;
}
/** A replaced run longer than the new piece is made up with a printed straight at least this long (the shortest that prints). */
export const SPACER_MIN = 24;
const SPACER_FAMILY = 'track_straight', SPACER_MAX = 2000;
/** How an insert that can't replace a run exactly makes room: a printed spacer over a longer straight run, or moving the track on. */
export type InsertFill = 'spacer' | 'shift';
/**
 * The fewest whole two-ended pieces of a straight run from `piece`'s start (read in travel order by `read`) that are longer than the
 * piece by a printable spacer (`SPACER_MIN` to `SPACER_MAX`), for a junction or mechanism whose far end lies straight ahead of its
 * `in`; null otherwise.
 */
function spacerRun(project:WorkshopProject,piece:RoutePiece,parts:readonly RoutePiece[],read:(part:RoutePiece)=>{start:BuilderPort;end:BuilderPort}):{count:number;length:number}|null {
  // Plain track (two ends) goes in to lengthen the route; a spacer is for junctions and mechanisms that must fit what is there.
  if (piecePorts(piece,project).length<=2) return null;
  const local=primaryEnd({...piece,x:0,y:0,z:0,heading:0},project),length=local.x;
  if (length<=0||Math.abs(local.y)>JOIN_DISTANCE||Math.abs(local.z)>JOIN_DISTANCE||Math.abs(normalize(local.heading))>JOIN_ANGLE) return null;
  const c=Math.cos(piece.heading),s=Math.sin(piece.heading);
  const along=(point:BuilderPort)=>(point.x-piece.x)*c+(point.y-piece.y)*s,off=(point:BuilderPort)=>Math.abs(-(point.x-piece.x)*s+(point.y-piece.y)*c);
  const onLine=(point:BuilderPort)=>off(point)<JOIN_DISTANCE&&Math.abs(point.z-piece.z)<JOIN_DISTANCE&&Math.abs(normalize(point.heading-piece.heading))<JOIN_ANGLE;
  for (let k=0;k<parts.length;k++) {
    if (piecePorts(parts[k],project).length!==2) return null;
    const {start,end}=read(parts[k]);
    if (!onLine(start)||!onLine(end)) return null;
    const spare=along(end)-length;
    if (spare>SPACER_MAX) return null;
    if (spare>=SPACER_MIN-JOIN_DISTANCE) return {count:k+1,length:Math.max(SPACER_MIN,spare)};
  }
  return null;
}
/** The printed spacer straight at `at`, as long as `length`, in the style of `like`. */
function spacerPiece(project:WorkshopProject,at:BuilderPort,length:number,like:Placement):RoutePiece {
  return {...previewPiece(project,SPACER_FAMILY,{x:at.x,y:at.y,z:at.z,heading:at.heading,params:{length},...(like.style?{style:like.style}:{})},-1).piece,id:crypto.randomUUID()};
}
/** Distance from `point` to the segment a–b, in plan. */
function segmentDistance(point:{x:number;y:number},a:{x:number;y:number},b:{x:number;y:number}):number {
  const dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy;
  const t=length?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/length)):0;
  return Math.hypot(point.x-a.x-t*dx,point.y-a.y-t*dy);
}
/** Other routes joined to `moving` pieces (through any port), which move with them; none when that group also meets track that stays. */
function hangingRoutes(project:WorkshopProject,route:Route,moving:readonly RoutePiece[],staying:readonly RoutePiece[]):Route[] {
  const portsOf=(pieces:readonly RoutePiece[])=>pieces.flatMap(part=>piecePorts(part,project));
  const reached=portsOf(moving),group:Route[]=[];
  for (let grown=true;grown;) {
    grown=false;
    for (const other of project.routes) {
      if (other===route||group.includes(other)) continue;
      const own=portsOf(other.pieces);
      if (own.some(port=>reached.some(seen=>mates(port,seen)))) {group.push(other);reached.push(...own);grown=true;}
    }
  }
  const stayingPorts=portsOf(staying);
  return portsOf(group.flatMap(item=>item.pieces)).some(port=>stayingPorts.some(other=>mates(port,other)))?[]:group;
}
/**
 * Dropping a piece onto placed track (not an open end) puts it into that route at the hovered piece's nearer joint, its `in` facing
 * along the route, so a turnout's main line stays on the route. When a run of whole two-ended pieces from that joint ends exactly where
 * the new piece ends (a 256 mm turnout over two 128 mm straights), the piece replaces that run and the removed pieces go back to stock;
 * otherwise it is inserted and everything after it moves along, which can open a closed loop (reported in `gaps`).
 * `option` picks another joint of the hovered piece or the other way round (Tab in the editor); null when no placed piece is within `radius`.
 */
export function previewInsert(project:WorkshopProject,family:TileFamily,placement:Placement,radius:number,option=0):InsertPlan|null {
  const hovered=hoveredJoints(project,family,placement,radius);
  if (!hovered) return null;
  const {route,index,joints}=hovered;
  const choices=[false,true].flatMap(backward=>joints.map(joint=>({joint,backward})));
  if (!choices.length) return null;
  const chosen=((option%choices.length)+choices.length)%choices.length,{joint,backward}=choices[chosen];
  return {...insertAtJoint(project,family,placement,route.id,joint,backward),hoveredId:route.pieces[index].id,options:choices.length,option:chosen};
}
/** A joint inside a route where a piece can go in: before `pieces[index]` (any joint of a closed loop, never an open route's ends). */
export interface RouteJoint { routeId:string; index:number; pieceId:string; at:BuilderPort; closed:boolean }
/** The placed piece within `radius` of `placement` and its joints a `family` piece can go into, nearer first; null over no track. */
export function hoveredJoints(project:WorkshopProject,family:TileFamily,placement:Placement,radius:number):{route:Route;index:number;joints:number[]}|null {
  let hit:{route:Route;index:number;distance:number}|null=null;
  for (const route of project.routes) route.pieces.forEach((piece,index)=>{
    for (const path of piecePaths(piece,project)) for (let i=1;i<path.points.length;i++) {
      const distance=segmentDistance(placement,path.points[i-1],path.points[i]);
      if (distance<=radius && (!hit || distance<hit.distance)) hit={route,index,distance};
    }
  });
  if (!hit) return null;
  const {route,index}=hit as {route:Route;index:number},count=route.pieces.length,closed=routeClosed(project,route);
  const entry=insertEntry(project,family,placement);
  if (!entry) return null;
  const jointAt=(joint:number)=>route.pieces[joint];
  const joints=[...new Set([index,index+1].filter(joint=>closed||joint>0&&joint<count).map(joint=>joint%count))]
    .filter(joint=>gaugesMate(entry.gauge,piecePorts(jointAt(joint),project).find(port=>port.id==='in')?.gauge??entry.gauge))
    .sort((a,b)=>Math.hypot(jointAt(a).x-placement.x,jointAt(a).y-placement.y)-Math.hypot(jointAt(b).x-placement.x,jointAt(b).y-placement.y));
  return {route,index,joints};
}
/** The piece's `in` port, when it sits at its origin and the piece also has an `out`: only such pieces go into placed track. */
function insertEntry(project:WorkshopProject,family:TileFamily,placement:Placement):ShapePort|null {
  const probePorts=piecePorts(previewPiece(project,family,{...placement,x:0,y:0,z:0,heading:0},-1).piece,project),entry=probePorts.find(port=>port.id==='in');
  return entry && Math.hypot(entry.x,entry.y,entry.z)<=1e-6 && probePorts.some(port=>port.id==='out') ? entry : null;
}
/** The joint of `routeId` before `pieces[index]`, as `hoveredJoints` offers it. */
export function routeJoint(project:WorkshopProject,routeId:string,index:number):RouteJoint {
  const route=routeById(project,routeId),start=route.pieces[index];
  return {routeId,index,pieceId:start.id,at:{x:start.x,y:start.y,z:start.z,heading:start.heading},closed:routeClosed(project,route)};
}
/**
 * The piece put into `routeId` at joint `index` (before `pieces[index]`), its `in` there and facing along the route, or against it when
 * `backward`. See `previewInsert` for the replace and insert rules; where no run of whole pieces ends exactly where the piece ends,
 * `fill` 'spacer' replaces the fewest pieces of a straight run longer than it and makes up the rest with a printed straight (nothing
 * moves), and 'shift' (or a run that is not straight) moves the track on. `hoveredId`, `options` and `option` are `previewInsert`'s to fill.
 */
export function insertAtJoint(project:WorkshopProject,family:TileFamily,placement:Placement,routeId:string,index:number,backward:boolean,fill:InsertFill='spacer'):InsertPlan {
  const route=routeById(project,routeId),count=route.pieces.length,closed=routeClosed(project,route);
  if (!insertEntry(project,family,placement)) throw new Error('This piece can’t go into placed track.');
  const readBackward=backward&&route.pieces.every(reversible);
  const probe=previewPiece(project,family,{...placement,x:0,y:0,z:0,heading:0},-1).piece;
  const pieceId=crypto.randomUUID(),openBefore=new Set(unoccupiedPiecePorts(project).map(({part,port})=>`${part.id}:${port.id}`));
  let removed:RoutePiece[]=[],moved=new Set<string>(),mode:InsertPlan['mode']='insert',joint:BuilderPort={x:0,y:0,z:0,heading:0},spacerId:string|undefined;
  const next=changeProject(project,draft=>{
    const target=routeById(draft,route.id);
    let at=index;
    if (backward&&!readBackward) {
      // A handed piece (a turnout) can't be read the other way, so the route keeps its direction and the new piece goes in against it.
      const start=target.pieces[at];
      joint={x:start.x,y:start.y,z:start.z,heading:normalize(start.heading+Math.PI)};
      const piece:RoutePiece={...probe,...joint,id:pieceId};
      ({mode,removed,moved,spacerId}=insertAgainst(draft,target,at,closed,piece,fill,placement));
      syncBuilderCrossings(draft);
      return;
    }
    if (backward) {target.pieces=target.pieces.map(piece=>reversePiece(draft,piece)).reverse();at=(count-at)%count;}
    // A loop has no ends: read it from any joint.
    const from=(first:number)=>[...target.pieces.slice(first),...target.pieces.slice(0,first)];
    const start=target.pieces[at];
    joint={x:start.x,y:start.y,z:start.z,heading:start.heading};
    const piece:RoutePiece={...probe,...joint,id:pieceId},end=primaryEnd(piece,draft),run=pieceDefinition(family).run(piece,draft);
    const ahead=closed?from(at):target.pieces.slice(at);
    let replaced=0,total=0;
    for (let k=0;k<ahead.length-(closed?1:0);k++) {
      const part=ahead[k];
      if (piecePorts(part,draft).length!==2) break;
      total+=pieceDefinition(part.family).run(part,draft);
      if (total>run+JOIN_DISTANCE) break;
      const partEnd=primaryEnd(part,draft);
      if (Math.abs(total-run)<=JOIN_DISTANCE && Math.hypot(partEnd.x-end.x,partEnd.y-end.y,partEnd.z-end.z)<JOIN_DISTANCE &&
        Math.abs(normalize(partEnd.heading-end.heading))<JOIN_ANGLE) {replaced=k+1;break;}
    }
    const spaced=!replaced&&fill==='spacer'?spacerRun(draft,piece,ahead.slice(0,ahead.length-(closed?1:0)),
      part=>{const partEnd=primaryEnd(part,draft);return {start:part,end:{x:partEnd.x,y:partEnd.y,z:partEnd.z,heading:partEnd.heading}};}):null;
    const spacer=spaced&&spacerPiece(draft,{x:end.x,y:end.y,z:end.z,heading:end.heading},spaced.length,placement);
    if (replaced||spaced) {
      mode='replace';
      const count=replaced||spaced!.count;
      // In a loop the replaced run may wrap past the route's first piece: the new piece then starts the route.
      if (closed&&at+count>route.pieces.length) {target.pieces=ahead;at=0;}
      removed=target.pieces.splice(at,count,piece,...(spacer?[spacer]:[]));
      spacerId=spacer?spacer.id:undefined;
    } else {
      // A loop opens on its far side: the pieces from here round to there move along, the rest stay.
      if (closed) {const cut=(at+Math.ceil(count/2))%count;target.pieces=from(cut);at=(at-cut+count)%count;}
      const following=target.pieces.slice(at),hanging=hangingRoutes(draft,target,following,target.pieces.slice(0,at));
      const angle=normalize(end.heading-joint.heading);
      target.pieces=[...target.pieces.slice(0,at),piece,...transformChain(following,joint,angle,end)];
      for (const other of hanging) {other.pieces=transformChain(other.pieces,joint,angle,end);rebuildPiecePoints(draft,other);}
      moved=new Set([...following,...hanging.flatMap(other=>other.pieces)].map(part=>part.id));
    }
    rebuildPiecePoints(draft,target);
    mergeTouchingRoutes(draft,target);syncBuilderCrossings(draft);
  });
  // Ends opened by the edit (the new piece's own extra ends, like a turnout's branch, are just open track).
  const opened:PieceEnd[]=unoccupiedPiecePorts(next).filter(({part,port})=>!openBefore.has(`${part.id}:${port.id}`)&&(part.id!==pieceId||port.id==='in'||port.id==='out'))
    .map(({part,port})=>({pieceId:part.id,portId:port.id,port}));
  const apart=(a:PieceEnd,b:PieceEnd)=>Math.hypot(a.port.x-b.port.x,a.port.y-b.port.y,a.port.z-b.port.z);
  const gaps:OpenedGap[]=[];
  while (opened.length>1) {
    const a=opened.shift()!;
    let nearest=0;
    opened.forEach((end,i)=>{if (apart(a,end)<apart(a,opened[nearest])) nearest=i;});
    const [b]=opened.splice(nearest,1);
    gaps.push({a,b,distance:apart(a,b)});
  }
  const placed=next.routes.flatMap(item=>item.pieces);
  return {next,pieceId,hoveredId:route.pieces[index].id,routeId:next.routes.find(item=>item.pieces.some(part=>part.id===pieceId))!.id,mode,
    piece:placed.find(part=>part.id===pieceId)!,...(spacerId?{spacer:placed.find(part=>part.id===spacerId)!}:{}),
    removed,shifted:placed.filter(part=>moved.has(part.id)),gaps,joint,options:1,option:0};
}
/**
 * `piece` goes in at joint `at` of `target` (before `pieces[at]`) facing against the route, which keeps its direction: it replaces the
 * run of whole two-ended pieces behind the joint that ends where it ends, or the pieces behind the joint (a loop's near half) move back
 * along. The piece, and any chain cut off, start routes of their own, joined back to the route where their ends meet (a handed piece
 * between two routes leaves them mated across, as a turnout's branch is).
 */
function insertAgainst(project:WorkshopProject,target:Route,at:number,closed:boolean,piece:RoutePiece,fill:InsertFill,like:Placement):
  {mode:InsertPlan['mode'];removed:RoutePiece[];moved:Set<string>;spacerId?:string} {
  const count=target.pieces.length,end=primaryEnd(piece,project),run=pieceDefinition(piece.family).run(piece,project);
  // Forward from the joint round the loop, and the pieces behind it, nearest first.
  const order=closed?[...target.pieces.slice(at),...target.pieces.slice(0,at)]:target.pieces.slice(at);
  const behind=closed?[...order].reverse():target.pieces.slice(0,at).reverse();
  let replaced=0,total=0;
  for (let k=0;k<behind.length-(closed?1:0);k++) {
    const part=behind[k];
    if (piecePorts(part,project).length!==2) break;
    total+=pieceDefinition(part.family).run(part,project);
    if (total>run+JOIN_DISTANCE) break;
    // Read backwards, a piece ends where it starts, facing the other way.
    if (Math.abs(total-run)<=JOIN_DISTANCE && Math.hypot(part.x-end.x,part.y-end.y,part.z-end.z)<JOIN_DISTANCE &&
      Math.abs(normalize(part.heading+Math.PI-end.heading))<JOIN_ANGLE) {replaced=k+1;break;}
  }
  // Read backwards, a piece runs from its far end to its start, facing the other way.
  const spaced=!replaced&&fill==='spacer'?spacerRun(project,piece,behind.slice(0,behind.length-(closed?1:0)),part=>{
    const partEnd=primaryEnd(part,project);
    return {start:{x:partEnd.x,y:partEnd.y,z:partEnd.z,heading:normalize(partEnd.heading+Math.PI)},end:{x:part.x,y:part.y,z:part.z,heading:normalize(part.heading+Math.PI)}};
  }):null;
  const spacer=spaced?spacerPiece(project,{x:end.x,y:end.y,z:end.z,heading:end.heading},spaced.length,like):null;
  if (spaced) replaced=spaced.count;
  const created:Route[]=[];
  const routeOf=(pieces:RoutePiece[])=>{
    const route:Route={id:crypto.randomUUID(),name:nextRouteName(project),points:[],pieces,...(target.base===undefined?{}:{base:target.base})};
    project.routes.push(route);created.push(route);
  };
  let removed:RoutePiece[]=[],moved=new Set<string>(),mode:InsertPlan['mode']='insert';
  if (replaced) {
    mode='replace';
    removed=behind.slice(0,replaced).reverse();
    const gone=new Set(removed.map(part=>part.id));
    if (closed) target.pieces=order.filter(part=>!gone.has(part.id));
    else {
      const before=target.pieces.slice(0,at-replaced);
      target.pieces=order;
      if (before.length) routeOf(before);
    }
  } else {
    // A loop opens on its far side: the pieces from there round to the joint move back along, the rest stay.
    const stay=closed?order.slice(0,Math.ceil(count/2)):order,move=closed?order.slice(Math.ceil(count/2)):target.pieces.slice(0,at);
    const hanging=hangingRoutes(project,target,move,stay);
    const pivot={x:piece.x,y:piece.y,z:piece.z,heading:piece.heading},angle=normalize(end.heading-pivot.heading);
    target.pieces=stay;
    if (move.length) routeOf(transformChain(move,pivot,angle,end));
    for (const other of hanging) {other.pieces=transformChain(other.pieces,pivot,angle,end);rebuildPiecePoints(project,other);}
    moved=new Set([...move,...hanging.flatMap(other=>other.pieces)].map(part=>part.id));
  }
  routeOf([piece,...(spacer?[spacer]:[])]);
  rebuildPiecePoints(project,target);
  mergeMovedRoutes(project,[target.id,...created.map(route=>route.id)]);
  return {mode,removed,moved,...(spacer?{spacerId:spacer.id}:{})};
}
/** Commit `previewInsert` as one undoable edit. */
export function insertPiece(project:WorkshopProject,family:TileFamily,placement:Placement,radius:number,option=0):[WorkshopProject,string] {
  const plan=previewInsert(project,family,placement,radius,option);
  if (!plan) throw new Error('Drop the piece onto placed track to insert it.');
  return [plan.next,plan.pieceId];
}
export function setRampRise(project:WorkshopProject,id:string,rise:number):WorkshopProject {
  if (!Number.isFinite(rise)||Math.abs(rise)>90) throw new Error('Ramp height change must be −90 to 90 mm.');
  return changeProject(project,draft=>{
    const {route,piece}=routeOfPiece(draft,id);
    if (pieceDefinition(piece.family).legacy?.rise===undefined) throw new Error('Select a ramp.');
    piece.rise=rise;
    reflowFollowingPieces(draft,route,piece);
    rebuildPiecePoints(draft,route);syncBuilderCrossings(draft);
  });
}
/**
 * Routes joined to `route` through any mated port — including turnout branches and a crossover's parallel
 * track — so the whole physical assembly moves as one piece of track.
 */
function connectedRoutes(project: WorkshopProject, route: Route): Route[] {
  const ports=new Map(project.routes.map(item=>[item,item.pieces.flatMap(part=>piecePorts(part,project))]));
  const group=[route];
  for (let index=0;index<group.length;index++) {
    const own=ports.get(group[index])!;
    for (const other of project.routes) {
      if (group.includes(other)) continue;
      if (ports.get(other)!.some(port=>own.some(mine=>mates(mine,port)))) group.push(other);
    }
  }
  return group;
}
export interface RouteMovePreview { routes: {routeId: string; pieces: RoutePiece[]}[]; pieces: RoutePiece[]; target: ShapePort | null }
/**
 * Where a dragged track lands: every route connected to the grabbed piece is translated so that piece starts
 * at (x, y); then, when one of the group's open ends is within `snapRadius` of another route's open port, the
 * group is rotated and carried so the two ports mate.
 */
export function previewRouteMove(project:WorkshopProject,id:string,x:number,y:number,snapRadius=0):RouteMovePreview {
  if (!Number.isFinite(x)||!Number.isFinite(y)) throw new Error('Move pieces to finite millimetres.');
  const {route,piece}=routeOfPiece(project,id);
  const group=connectedRoutes(project,route);
  const dx=x-piece.x,dy=y-piece.y;
  let routes=group.map(item=>({routeId:item.id,pieces:item.pieces.map(part=>({...part,x:part.x+dx,y:part.y+dy}))}));
  let target:ShapePort|null=null;
  if (snapRadius>0) {
    const others=unoccupiedPiecePorts(project,project.routes.filter(item=>!group.includes(item)));
    const moved=group.map((item,index)=>({...item,pieces:routes[index].pieces}));
    let best:{own:ShapePort;target:ShapePort;distance:number}|null=null;
    for (const own of unoccupiedPiecePorts(project,moved)) for (const other of others) {
      const distance=Math.hypot(own.port.x-other.port.x,own.port.y-other.port.y);
      if (distance<=snapRadius && (!best || distance<best.distance)) best={own:own.port,target:other.port,distance};
    }
    if (best) {
      const {own,target:port}=best,angle=normalize(port.heading+Math.PI-own.heading);
      routes=routes.map(item=>({...item,pieces:transformChain(item.pieces,own,angle,port)}));
      target=port;
    }
  }
  return {routes,pieces:routes.flatMap(item=>item.pieces),target};
}
/** Merge every moved route that now touches another, skipping routes already absorbed by an earlier merge. */
function mergeMovedRoutes(project:WorkshopProject,routeIds:readonly string[]):void {
  for (const id of routeIds) {
    const route=project.routes.find(item=>item.id===id);
    if (route) mergeTouchingRoutes(project,route);
  }
}
export function movePieceRoute(project:WorkshopProject,id:string,x:number,y:number,snapRadius=0):WorkshopProject {
  const {routes}=previewRouteMove(project,id,x,y,snapRadius);
  return changeProject(project,draft=>{
    for (const {routeId,pieces} of routes) routeById(draft,routeId).pieces=pieces;
    mergeMovedRoutes(draft,routes.map(item=>item.routeId));syncBuilderCrossings(draft);
  });
}
/** Turn the whole connected track about the middle of the chosen piece. */
export function rotatePieceRoute(project:WorkshopProject,id:string,angle:number):WorkshopProject {
  if (!Number.isFinite(angle)) throw new Error('Rotate by a finite angle.');
  return changeProject(project,draft=>{
    const {route,piece}=routeOfPiece(draft,id);
    const end=primaryEnd(piece,draft),pivot={x:(piece.x+end.x)/2,y:(piece.y+end.y)/2,z:0,heading:0};
    const group=connectedRoutes(draft,route);
    for (const item of group) item.pieces=transformChain(item.pieces,pivot,angle,pivot);
    mergeMovedRoutes(draft,group.map(item=>item.id));syncBuilderCrossings(draft);
  });
}
/** Raise (or lower) the whole connected track by `dz` mm; level track at whole plates up to 96 mm stands on riser stacks. */
export function liftPieceRoute(project:WorkshopProject,id:string,dz:number):WorkshopProject {
  if (!Number.isFinite(dz)) throw new Error('Lift by a finite height.');
  if (!dz) return project;
  return changeProject(project,draft=>{
    const {route}=routeOfPiece(draft,id);
    for (const item of connectedRoutes(draft,route)) {
      for (const piece of item.pieces) piece.z+=dz;
      rebuildPiecePoints(draft,item);
    }
    syncBuilderCrossings(draft);
  });
}
/** The ground under a route (mm above the table; negative dips below it): supports stand on it and track stays above it. */
export function setRouteBase(project:WorkshopProject,routeId:string,base:number):WorkshopProject {
  if (!Number.isFinite(base)||base<ROUTE_BASE_RANGE[0]||base>ROUTE_BASE_RANGE[1]) throw new Error(`Ground must be ${ROUTE_BASE_RANGE[0]} to ${ROUTE_BASE_RANGE[1]} mm.`);
  if ((routeById(project,routeId).base??0)===base) return project;
  return changeProject(project,draft=>{
    const route=routeById(draft,routeId);
    if (base) route.base=base; else delete route.base;
  });
}
export type PieceSource='owned'|'printed'|'fast';
/** One undoable edit: owned official shapes swap to their printed counterpart and back; printed pieces
 * switch between full detail and fast print. Printed-only pieces have no owned counterpart and stay as they are for 'owned';
 * pieces with no fast-print version (turntables, sector plates...) stay full detail for 'fast'. */
export function setPieceSource(project:WorkshopProject,ids:readonly string[],source:PieceSource):WorkshopProject {
  if (source==='fast'&&project.trackSystem!=='brick-v1') throw new Error('Fast print needs standard brick track.');
  const changes=(piece:RoutePiece)=>{
    const definition=pieceDefinition(piece.family);
    if (source==='owned') return definition.source==='printed'&&definition.owned!==undefined;
    if (source==='fast'&&definition.source==='printed'&&!definition.styles.includes('fast')) return false;
    return definition.source==='owned'||(piece.style==='fast')!==(source==='fast');
  };
  if (!ids.some(id=>changes(routeOfPiece(project,id).piece))) return project;
  return changeProject(project,draft=>{
    for (const id of ids) {
      const {route,piece}=routeOfPiece(draft,id);
      if (!changes(piece)) continue;
      if (source==='fast') piece.style='fast'; else delete piece.style;
      const family=counterpartFamily(piece.family,source==='owned'?'owned':'printed');
      if (!family||family===piece.family) continue;
      piece.family=family;
      reflowFollowingPieces(draft,route,piece);rebuildPiecePoints(draft,route);
    }
    syncBuilderCrossings(draft);
  });
}

/** Selects a junction or mechanism state; the enabled paths and, for moving pieces, the ports follow it. */
export function setPieceState(project:WorkshopProject,id:string,state:string):WorkshopProject {
  const {piece:current}=routeOfPiece(project,id),states=pieceStates(current);
  if(!states) throw new Error('Select a turnout, crossover or other piece with settings.');
  if(!states.some(item=>item.id===state)) throw new Error('Invalid piece state.');
  if(pieceState(current)===state) return project;
  return changeProject(project,draft=>{
    const {route,piece}=routeOfPiece(draft,id);
    piece.state=state;
    reflowFollowingPieces(draft,route,piece);
    rebuildPiecePoints(draft,route);syncBuilderCrossings(draft);
  });
}
function checkParam(definition:ReturnType<typeof pieceDefinition>,key:string,value:number):void {
  const spec=definition.params.find(item=>item.key===key);
  if(!spec) throw new Error(`${definition.label} has no ${key} setting.`);
  if(!Number.isFinite(value)||value<spec.min||value>spec.max) throw new Error(`${spec.label} must be ${spec.min} to ${spec.max}${spec.unit?` ${spec.unit}`:''}.`);
}
/** One undoable edit of a `ParamSpec` value; the rest of the chain follows the piece's new end. */
export function setPieceParam(project:WorkshopProject,id:string,key:string,value:number):WorkshopProject {
  const {piece:current}=routeOfPiece(project,id),definition=pieceDefinition(current.family);
  checkParam(definition,key,value);
  if((current.params?.[key]??definition.params.find(spec=>spec.key===key)!.default)===value) return project;
  return changeProject(project,draft=>{
    const {route,piece}=routeOfPiece(draft,id);
    piece.params={...piece.params,[key]:value};
    reflowFollowingPieces(draft,route,piece);
    rebuildPiecePoints(draft,route);syncBuilderCrossings(draft);
  });
}
/**
 * Level track between a slope and the junction at its end `level.port`, as one undoable edit: a piece with its own level
 * stretch there (a climb's lead or run-out, `levelEnds`) gets `set`; any other gets a printed straight of `missing` mm at
 * that end, and the slope's side of its route (and routes hanging off that side) moves `missing` mm away from the junction.
 */
export function addLevelBeforeSlope(project:WorkshopProject,level:{slopeId:string;port:string;missing:number;set?:{key:string;value:number}}):WorkshopProject {
  if (level.set) return setPieceParam(project,level.slopeId,level.set.key,level.set.value);
  if (level.port!=='in'&&level.port!=='out') throw new Error('Level track goes in at a piece’s in or out end.');
  return changeProject(project,draft=>{
    const {route,index}=routeOfPiece(draft,level.slopeId),slope=route.pieces[index];
    const gate=piecePorts(slope,draft).find(port=>port.id===level.port)!;
    const junction=draft.routes.flatMap(item=>item.pieces).find(piece=>piece.id!==slope.id&&piecePorts(piece,draft).some(port=>mates(port,gate)));
    const before=level.port==='in';
    const moving=before?route.pieces.slice(index):route.pieces.slice(0,index+1),staying=before?route.pieces.slice(0,index):route.pieces.slice(index+1);
    const away={x:gate.x-Math.cos(gate.heading)*level.missing,y:gate.y-Math.sin(gate.heading)*level.missing,z:gate.z,heading:gate.heading};
    const hanging=hangingRoutes(draft,route,moving,[...staying,...junction?[junction]:[]]).filter(other=>!junction||!other.pieces.includes(junction));
    const moved=transformChain(moving,gate,0,away);
    const straight:RoutePiece={id:crypto.randomUUID(),family:'track_straight',params:{length:level.missing},
      ...(before?{x:gate.x,y:gate.y,z:gate.z,heading:normalize(gate.heading+Math.PI)}:away)};
    route.pieces=before?[...staying,straight,...moved]:[...moved,straight,...staying];
    for (const other of hanging) {other.pieces=transformChain(other.pieces,gate,0,away);rebuildPiecePoints(draft,other);}
    rebuildPiecePoints(draft,route);syncBuilderCrossings(draft);
  });
}
/**
 * One undoable reshape of a piece, possibly into another family of the same kind (a 128 mm straight becoming 64 mm):
 * family, legacy sweep and shape parameters change together; parameters the new family also declares (track options)
 * and fast print, where the new family prints fast, carry over. The rest of the chain follows the new end.
 */
export function setPieceShape(project:WorkshopProject,id:string,shape:{family:string;sweep?:number;params?:Record<string,number>}):WorkshopProject {
  const {piece:current}=routeOfPiece(project,id),definition=pieceDefinition(shape.family),legacy=definition.legacy??{};
  if ((legacy.sweep!==undefined)!==(shape.sweep!==undefined)) throw new Error(`${definition.label} ${legacy.sweep!==undefined?'needs':'has no'} sweep.`);
  if (shape.sweep!==undefined && !(Number.isFinite(shape.sweep)&&Math.abs(shape.sweep)>0&&Math.abs(shape.sweep)<=Math.PI/2)) throw new Error('Curve angle must be up to 90°.');
  for (const [key,value] of Object.entries(shape.params??{})) checkParam(definition,key,value);
  const kept=Object.entries(current.params??{}).filter(([key])=>definition.params.some(spec=>spec.key===key));
  const params={...Object.fromEntries(kept),...shape.params};
  const style=current.style==='fast'&&definition.styles.includes('fast')?'fast' as const:undefined;
  const same=current.family===shape.family&&current.sweep===shape.sweep&&current.style===style&&
    JSON.stringify(current.params??{})===JSON.stringify(params);
  if (same) return project;
  return changeProject(project,draft=>{
    const {route,piece}=routeOfPiece(draft,id);
    piece.family=shape.family;
    if (shape.sweep===undefined) delete piece.sweep; else piece.sweep=shape.sweep;
    if (Object.keys(params).length) piece.params=params; else delete piece.params;
    if (style) piece.style=style; else delete piece.style;
    if (!definition.states) delete piece.state;
    if (legacy.rise===undefined) delete piece.rise;
    if (legacy.bend===undefined) delete piece.bend;
    reflowFollowingPieces(draft,route,piece);
    rebuildPiecePoints(draft,route);syncBuilderCrossings(draft);
  });
}

export function setFlexBend(project:WorkshopProject,id:string,bend:number):WorkshopProject {
  if (!Number.isFinite(bend)||Math.abs(bend)>FLEX_MAX_BEND) throw new Error('Flex bend must be within ±5.625°.');
  const {piece:current}=routeOfPiece(project,id);
  if(pieceDefinition(current.family).legacy?.bend===undefined) throw new Error('Select flexible track.');
  if((current.bend??0)===bend) return project;
  return changeProject(project,draft=>{
    const {route,piece}=routeOfPiece(draft,id);
    piece.bend=bend;
    reflowFollowingPieces(draft,route,piece);
    rebuildPiecePoints(draft,route);syncBuilderCrossings(draft);
  });
}
