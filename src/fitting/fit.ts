import { routeBase, type RoutePiece, type WorkshopProject } from '../domain/project';
import { PLATE_EDGE_MARGIN_MM, PRINTER_ENVELOPES, pieceIsFast } from '../domain/printer';
import { port, portsMatch, type FitIssue, type PartInstance, type Pose3, type Section } from '../domain/route';
import { FAMILIES, type Family } from './catalog';
import { checkCrossings, type CrossingClearance } from './crossing';
import { checkElevation } from './elevation';
import { checkElectrical } from './electrical';
import { planMounting, type MountingPlan, type Support } from './mounting';
import { HELIX_LUG_RING, planOwnSupports, type BracketSeat, type Lug } from './own-supports';
import { ROOM_CODES, roomIssues } from './room';
import { BRICK_TRACK, railDimension } from '../domain/track';
import { effectiveFitAdjustment } from '../domain/calibration';
import { BALLAST_SHOULDER, COMPOSITE_FAMILY, MARKER_INSERT_FAMILY, MARKER_SEAT, TRACK_OPTION_KEYS, compositeCentreline, compositeLength, compositeParameters, compositeSlice, compositeUnderside, findPieceDefinition, gaugesMate, paramValue, pieceDefinition, piecePaths, piecePorts, portsFromPaths, primaryEnd, sliceEnds, sliceTrackOptions, splitComposite, tieStations, type CompositeTrack } from '../domain/pieces';
import { GAUGE_LABEL } from '../domain/gauges';
import { checkAssemblyFootprints } from '../domain/track-footprints';

export interface FitResult {
  units: 'mm';
  layoutRevision: string;
  sections: Section[];
  issues: FitIssue[];
  crossings: CrossingClearance[];
  supports: Support[];
  mounting: Pick<MountingPlan, 'siteChecks'>;
  partInstances: PartInstance[];
  geometryFeasible: boolean;
}
const EPS = 1e-5;
const TOO_LONG = 'Too long for the selected printer; use a shorter piece.';
const PIECE_ERRORS: Record<string, string> = {
  'piece-pose-mismatch': 'Piece is out of line with its neighbours; re-place it.',
  'below-table': 'Below the table — raise it.',
  'below-ground': 'Below this route’s ground — raise it or lower the ground.',
  'piece-outside-room': 'Outside the room — move it or enlarge the room in Setup.',
  'piece-family-unavailable': 'This piece type is not available.',
  // An unavailable-piece placeholder (KTD9): the library didn't load, or no longer has it.
  'piece-not-in-library': 'A piece is not in the library: reload the page to load the library again, or replace the piece.',
  'assembly-track-system': 'Needs standard brick track.',
  'standard-shape-track-system': 'Needs standard brick track.',
  'piece-off-catalog': 'This piece is outside the supported size range.',
  'curve-unfitted': 'This curve does not fit the selected printer plate.',
  'piece-too-long': TOO_LONG,
  'grade-unfitted': 'Ramp is too steep or longer than your ramp space; lower the rise.',
  'marker-no-tie': 'A colour marker needs a piece with a full sleeper (64 mm or longer).'
};
const point = (x: number, y: number, z: number) => ({ x, y, z });
const pose = (p: { x: number; y: number; z: number }, direction: number, grade: number): Pose3 =>
  ({ x:p.x,y:p.y,z:p.z,heading:direction,pitch:Math.atan(grade) });
const hermite = (u: number) => 3*u*u-2*u*u*u;
const derivative = (u: number) => 6*u-6*u*u;
/** Brick ends: the connector parameters fit adds to every assembly part (none on custom-joiner track). */
function brickConnectorParameters(project: WorkshopProject): Record<string, number> {
  return project.trackSystem==='brick-v1' ?
    { connector_version: BRICK_TRACK.version, fit_adjustment: effectiveFitAdjustment(project) } : {};
}
/** Wall/shelf brackets under a composite piece `length` mm long, about `spacing` apart (fewer where it has too few full sleepers). */
export const bracketCount=(length:number,spacing:number)=>Math.max(1,Math.round(length/spacing));

/** A printed part as fit makes it, without its placement. */
export type PiecePart = Pick<PartInstance, 'id' | 'sectionId' | 'family' | 'parameters' | 'source'>;
/**
 * The printed parts fit would make for one piece on its own (a palette tile's current options), unsplit and unplaced:
 * an assembly's part with fit's connector parameters; a composite piece's whole part, its loose parts and one track
 * bracket per bracket fit would place under it; a rail piece's part. Owned brick track makes none. Ids follow fit's.
 */
export function pieceParts(piece: RoutePiece, project: WorkshopProject): PiecePart[] {
  const definition=pieceDefinition(piece.family);
  if (definition.source!=='printed') return [];
  const [part,...extras]=definition.cad(piece,project);
  if (!part) return [];
  const lite:Record<string,number>=pieceIsFast(project,piece)?{lite:1}:{};
  const own=(id:string,family:string,parameters:Record<string,number>):PiecePart=>({id,sectionId:piece.id,family,parameters,source:'printed'});
  if (definition.body==='assembly') return [own(piece.id,part.family,{...brickConnectorParameters(project),...part.parameters,...lite})];
  if (!definition.composite) return [own(piece.id,part.family,part.parameters)];
  const parts=[own(piece.id,part.family,{...part.parameters,...lite}),
    ...extras.map((extra,index)=>own(extra.family===MARKER_INSERT_FAMILY?`${piece.id}:marker`:`${piece.id}:part-${index+1}`,extra.family,extra.parameters))];
  if (!definition.ownSupports?.(piece) || !piece.params?.bracket) return parts;
  const setting=(key:string)=>paramValue(definition,piece,key),mount=setting('bracket')===2?2:1;
  const count=bracketCount(compositeLength(definition.composite(piece,project)),setting('bracket_spacing'));
  return [...parts,...Array.from({length:count},(_,index)=>own(`${piece.id}:bracket-${index+1}`,'track_bracket',
    {mount,reach:setting('bracket_reach'),height:mount===1?0:setting('bracket_height')}))];
}

export function fitProject(project: WorkshopProject): FitResult {
  const brickConnector = project.trackSystem === 'brick-v1';
  const plate = PRINTER_ENVELOPES[project.printer];
  // Reserve projecting ends, graded rail tops and localized curve blends.
  const endAllowance = brickConnector ? 10 : 0;
  const longestFlatPart = plate.x - 2 * PLATE_EDGE_MARGIN_MM - endAllowance;
  const usablePlate = {x:longestFlatPart,y:plate.y-2*PLATE_EDGE_MARGIN_MM-endAllowance};
  const sections: Section[]=[], issues: FitIssue[]=[], instances: PartInstance[]=[];
  /** Pieces carrying their own supports: helix column lugs, bracket seats, and every composite piece's lowest underside. */
  const lugs: Lug[]=[], brackets: BracketSeat[]=[], undersides=new Map<string,number>();
  const gauge=railDimension(project,'railGauge'), width=railDimension(project,'railInterfaceWidth');
  const bodyWidth=railDimension(project,'railBodyWidth');
  const baseThickness=railDimension(project,'railBaseThickness');
  const railHeight=railDimension(project,'railHeight');
  const design = { ...project.partDesign };
  if (!brickConnector && Number.isFinite(design.joint_clearance))
    design.joint_clearance += effectiveFitAdjustment(project);
  const jointKeys=['joint_width','joint_depth','joint_height','joint_clearance'] as const;
  const jointReady=brickConnector || jointKeys.every(k=>Number.isFinite(design[k]) && design[k]>0) &&
    design.joint_depth > design.joint_clearance;
  const connectorParameters=brickConnectorParameters(project);
  const completeProfile=gauge!==null && width!==null && bodyWidth!==null && baseThickness!==null &&
    railHeight!==null && jointReady;
  const designParameters=(keys:readonly string[]):Record<string,number> =>
    Object.fromEntries(keys.filter(k=>Number.isFinite(design[k]) && design[k]>0).map(k=>[k,design[k]]));
  const railProfile=()=>({
    ...(gauge===null?{}:{rail_gauge:gauge}),...(width===null?{}:{rail_interface_width:width}),
    ...(bodyWidth===null?{}:{body_width:bodyWidth}),
    ...(baseThickness===null?{}:{base_thickness:baseThickness}),
    ...(railHeight===null?{}:{rail_height:railHeight}),
    ...(brickConnector ? connectorParameters : designParameters(jointKeys))
  });
  const deckKeys = brickConnector ? ['deck_width','deck_thickness'] : ['deck_width','deck_thickness',...jointKeys];
  const columnKeys=['foot_length','foot_width','foot_thickness','stem_width','stem_depth','seat_width','seat_depth','seat_thickness'] as const;
  const bracketKeys=['reach','plate_width','plate_thickness','arm_width','arm_thickness','hole_diameter','hole_spacing','seat_width','seat_depth','seat_thickness'] as const;
  const deckParameters = brickConnector ?
    { deck_width: BRICK_TRACK.bodyWidth, deck_thickness: BRICK_TRACK.baseThickness } : designParameters(deckKeys);
  const deckGeometry = brickConnector ? { ...deckParameters, ...connectorParameters } : deckParameters;
  const deckReady=gauge!==null && width!==null && railHeight!==null &&
    deckKeys.every(k=>Object.hasOwn(deckParameters,k));
  const roomWidth=project.measurements.roomWidth.status==='estimate' ? null : project.measurements.roomWidth.value;
  const roomDepth=project.measurements.roomDepth.status==='estimate' ? null : project.measurements.roomDepth.value;
  const approach=project.measurements.availableApproachRun;
  const rampSpace=approach.status==='estimate' ? null : approach.value;
  /** Owned pieces in route order, so the pieces past the inventory are the ones to print instead. */
  const ownedUse=new Map<RoutePiece['family'], string[]>();
  const useOwned=(tile: RoutePiece) => ownedUse.set(tile.family, [...ownedUse.get(tile.family) ?? [], tile.id]);
  const add=(section: Section, family: Family, lite=false) => {
    sections.push(section);
    instances.push({ id:section.id, routeId:section.routeId, sectionId:section.id, family:family.id,
      parameters:lite?{...section.parameters,lite:1}:section.parameters, pose:section.start.pose, interfaceKind:'rail', startPort:section.start,endPort:section.end,
      source:family.source,status:'unverified',
      // Declares generator input availability, never a generated/validated mesh.
      geometryAvailable:family.source==='printed' && (family.id==='bridge_deck' ? deckReady : family.geometryAvailable && completeProfile) });
  };
  /** Bounding box of a composite part flat on the plate, in its start frame, against the usable plate either way round; `shoulder` widens each side. */
  /** `lug`: a helix column lug's outer reach (signed, left +), counted along the whole part to be safe. */
  const fitsPlate=(part:CompositeTrack,shoulder=0,lug?:number)=>{
    const half=(bodyWidth ?? BRICK_TRACK.bodyWidth)/2+shoulder;
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    for (const p of compositeCentreline(part)) for (const side of lug===undefined?[-half,half]:[-half,half,lug]) {
      const x=p.x-Math.sin(p.heading)*side,y=p.y+Math.cos(p.heading)*side;
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
    }
    const extentX=maxX-minX,extentY=maxY-minY;
    return Math.max(extentX,extentY)<=Math.max(usablePlate.x,usablePlate.y)+EPS &&
      Math.min(extentX,extentY)<=Math.min(usablePlate.x,usablePlate.y)+EPS;
  };
  for (const route of project.routes) {
    const ground=routeBase(route),under=ground?'below-ground':'below-table';
    if (!route.pieces.length) {
      issues.push({code:'route-incomplete',severity:'error',routeId:route.id,message:'Add at least one track piece.'});
      continue;
    }
    for (let i=0;i<route.pieces.length;i++) {
      const tile=route.pieces[i],start=point(tile.x,tile.y,tile.z),terminal=primaryEnd(tile,project);
      // Fast print changes only printed track geometry; supports, joiners and owned brick track keep their identity.
      const fast=pieceIsFast(project,tile);
      const span:[string,string]=[`${tile.id}:start`,`${tile.id}:end`];
      const definition=pieceDefinition(tile.family),[part,...extras]=definition.cad(tile,project);
      const familyId=part?.family;
      const family=FAMILIES.find(item=>item.id===familyId);
      const mismatch=Math.hypot(terminal.x-route.points[i+1].x,terminal.y-route.points[i+1].y,terminal.z-route.points[i+1].z)>.01 ||
        i===0 && Math.hypot(tile.x-route.points[0].x,tile.y-route.points[0].y,tile.z-route.points[0].z)>.01;
      const outside=(p: { x: number; y: number }) =>
        roomWidth!==null&&(p.x<0||p.x>roomWidth) || roomDepth!==null&&(p.y<0||p.y>roomDepth);
      // Experimental gauges (C1): consecutive pieces of one route must mate; narrow and standard meet only through dual track.
      const previous=route.pieces[i-1],into=previous&&piecePorts(tile,project).find(item=>item.id==='in');
      const out=previous&&piecePorts(previous,project).find(item=>item.id==='out');
      if (out&&into&&!gaugesMate(out.gauge,into.gauge)) issues.push({code:'gauge-mismatch',severity:'error',routeId:route.id,span,
        message:`A ${GAUGE_LABEL[into.gauge]} piece cannot join ${GAUGE_LABEL[out.gauge]} track; put dual-gauge track between them.`});
      const trackGauge=definition.gauge==='standard'?{}:{gauge:definition.gauge};
      if (definition.community) {
        // A community piece prints as uploaded (R20): one part along the path between its marked ends, no print style.
        const points=piecePaths(tile,project)[0].points.map(p=>({...p,pitch:p.pitch??0}));
        let invalid:string|null=null;
        if(mismatch) invalid='piece-pose-mismatch';
        else if(points.some(p=>p.z<ground-EPS)) invalid=under;
        else if(points.some(outside)) invalid='piece-outside-room';
        else if(!brickConnector) invalid='standard-shape-track-system';
        const from=port(points[0],gauge,width),to=port(points.at(-1)!,gauge,width);
        const base={id:tile.id,routeId:route.id,fromPointId:span[0],toPointId:span[1],run:definition.run(tile,project),pathPoints:points,start:from,end:to};
        if (invalid) {
          sections.push({...base,family:null,kind:'unresolved',parameters:{}});
          issues.push({code:invalid,severity:'error',routeId:route.id,span,message:PIECE_ERRORS[invalid]});
          continue;
        }
        sections.push({...base,family:tile.family,kind:'straight',parameters:{}});
        instances.push({id:tile.id,routeId:route.id,sectionId:tile.id,family:tile.family,parameters:{},pose:from.pose,interfaceKind:'rail',
          startPort:from,endPort:to,source:'printed',status:'unverified',geometryAvailable:true});
        continue;
      }
      if (definition.composite) {
        const track=definition.composite(tile,project),paths=piecePaths(tile,project);
        const points=paths[0].points.map(p=>({...p,pitch:p.pitch??0}));
        const options=Object.fromEntries(Object.entries(part.parameters).filter(([key])=>TRACK_OPTION_KEYS.includes(key)));
        const length=compositeLength(track),lug=options.socket?options.socket_side*(options.socket_offset+HELIX_LUG_RING/2):undefined;
        // Flexible track prints straight: its parts fit the bed by their straight length, not their drawn curve.
        const printed=(slice:CompositeTrack)=>family?.printsStraight?{...slice,segments:[{len:compositeLength(slice),k0:0,k1:0}]}:slice;
        const stations=splitComposite(track,slice=>fitsPlate(printed(slice),options.ballast?BALLAST_SHOULDER:0,lug));
        const problem=definition.problem?.(tile) ?? null;
        let invalid:string|null=null;
        if(mismatch) invalid='piece-pose-mismatch';
        else if(points.some(p=>p.z<ground-EPS)) invalid=under;
        else if(points.some(outside)) invalid='piece-outside-room';
        else if(!family) invalid='piece-family-unavailable';
        else if(!brickConnector) invalid='standard-shape-track-system';
        // Each bed-sized part is built on its own, so a piece cut into parts (a long climb) may run past the family's longest part.
        else if(length<family.run[0]-EPS||stations&&stations.some((station,n)=>n>0&&station-stations[n-1]>family.run[1]+EPS)) invalid='piece-off-catalog';
        else if(problem) invalid='piece-settings';
        else if(!stations) invalid='piece-too-long';
        const base={id:tile.id,routeId:route.id,fromPointId:span[0],toPointId:span[1],run:length,pathPoints:points,...trackGauge,
          ...(paths[0].rack?{rack:true as const}:{}),
          start:port(points[0],gauge,width),end:port(points.at(-1)!,gauge,width)};
        if (invalid || !family || !stations) {
          sections.push({...base,family:null,kind:'unresolved',parameters:{}});
          issues.push({code:invalid!,severity:'error',routeId:route.id,span,message:invalid==='piece-settings'?problem!:PIECE_ERRORS[invalid!]});
          continue;
        }
        const {slices,marker,socket}=sliceTrackOptions(options,length,stations,track);
        if (options.marker && !marker) issues.push({code:'marker-no-tie',severity:'error',routeId:route.id,span,message:PIECE_ERRORS['marker-no-tie']});
        sections.push({...base,family:family.id,kind:'straight',parameters:compositeParameters(track)});
        // Each bed-sized part is a standalone piece with connectors at both ends; the joints are ordinary track joints.
        const poseAt=(station:number):Pose3=>{
          const local=station?compositeCentreline(compositeSlice(track,0,station)).at(-1)!:compositeCentreline(track)[0];
          const c=Math.cos(tile.heading),s=Math.sin(tile.heading);
          return {x:tile.x+c*local.x-s*local.y,y:tile.y+s*local.x+c*local.y,z:tile.z+local.z,heading:tile.heading+local.heading,pitch:local.pitch??0};
        };
        // A part's flat underside in the world: where lugs, bracket seats and the clearance under the piece are measured.
        const floors:number[]=[];
        for (let n=1;n<stations.length;n++) {
          const from=poseAt(stations[n-1]),to=poseAt(stations[n]);
          const slice=compositeSlice(track,stations[n-1],stations[n]),ends=sliceEnds(track,stations[n-1],stations[n]);
          floors.push(from.z+compositeUnderside(slice,ends));
          const parameters={...compositeParameters(slice,ends),...slices[n-1],...railProfile(),...(fast?{lite:1}:{})};
          instances.push({id:stations.length===2?tile.id:`${tile.id}:${n}`,routeId:route.id,sectionId:tile.id,family:family.id,parameters,
            pose:from,interfaceKind:'rail',startPort:port(from,gauge,width),endPort:port(to,gauge,width),
            source:'printed',status:'unverified',geometryAvailable:completeProfile});
        }
        undersides.set(tile.id,Math.min(...floors));
        const sideways=(at:Pose3,offset:number)=>({x:at.x-Math.sin(at.heading)*offset,y:at.y+Math.cos(at.heading)*offset});
        if (socket) lugs.push({routeId:route.id,pieceId:tile.id,
          ...sideways(poseAt(socket.station),options.socket_side*options.socket_offset),z:floors[socket.slice]});
        if (definition.ownSupports?.(tile) && tile.params?.bracket) {
          // Brackets go under full sleepers (their clutch grips the seat studs), about `bracket_spacing` apart.
          const setting=(key:string)=>paramValue(definition,tile,key);
          const ties=stations.slice(1).flatMap((end,n)=>tieStations(end-stations[n]).map(tie=>({station:stations[n]+tie,slice:n})));
          const count=bracketCount(length,setting('bracket_spacing')),chosen=new Set<number>();
          for (let k=0;k<count&&ties.length;k++) {
            const target=(k+.5)*length/count;
            let best=-1;
            ties.forEach((tie,index)=>{
              if (!chosen.has(index)&&(best<0||Math.abs(tie.station-target)<Math.abs(ties[best].station-target))) best=index;
            });
            if (best<0) break;
            chosen.add(best);
          }
          const side=setting('bracket_side')<0?-1:1;
          [...chosen].sort((a,b)=>ties[a].station-ties[b].station).forEach((index,number)=>{
            const at=poseAt(ties[index].station);
            brackets.push({routeId:route.id,pieceId:tile.id,index:number,x:at.x,y:at.y,z:floors[ties[index].slice],
              heading:at.heading+(side<0?Math.PI:0),mount:setting('bracket')===2?2:1,reach:setting('bracket_reach'),height:setting('bracket_height')});
          });
        }
        // Loose parts: the marker insert sits in its sleeper's recess; road tiles are drawn in the piece frame.
        extras.forEach((extra,index)=>{
          const onTie=extra.family===MARKER_INSERT_FAMILY;
          if (onTie && !marker) return;
          const at=onTie?poseAt(marker!.station):{x:tile.x,y:tile.y,z:tile.z,heading:tile.heading,pitch:0};
          instances.push({id:onTie?`${tile.id}:marker`:`${tile.id}:part-${index+1}`,routeId:route.id,sectionId:tile.id,family:extra.family,
            parameters:extra.parameters,pose:onTie?{...at,z:at.z+MARKER_SEAT}:at,interfaceKind:'accessory',
            source:'printed',status:'unverified',geometryAvailable:true});
        });
        continue;
      }
      if (definition.body==='assembly') {
        const paths=piecePaths(tile,project);
        let invalid:string|null=null;
        const problem=definition.problem?.(tile) ?? null;
        if(mismatch) invalid='piece-pose-mismatch';
        else if(tile.z<ground-EPS) invalid=under;
        else if(paths.some(path=>path.points.some(outside))) invalid='piece-outside-room';
        else if(!family) invalid='piece-family-unavailable';
        else if(!brickConnector) invalid='assembly-track-system';
        else if(problem) invalid='piece-settings';
        if (invalid) issues.push({code:invalid,severity:'error',routeId:route.id,span,message:invalid==='piece-settings'?problem!:PIECE_ERRORS[invalid]});
        const parameters={...connectorParameters,...part?.parameters};
        const halt=definition.halt?.(tile,project);
        for (const path of paths) {
          const points=path.points.map(p=>({...p,pitch:p.pitch??0}));
          const run=points.slice(1).reduce((sum,p,index)=>sum+Math.hypot(p.x-points[index].x,p.y-points[index].y),0);
          sections.push({id:`${tile.id}:${path.id}`,routeId:route.id,pieceId:tile.id,pathId:path.id,enabled:path.enabled,
            ...(path.gauge==='standard'?{}:{gauge:path.gauge}),...(path.rack?{rack:true as const}:{}),...(path.cable?{cable:true as const}:{}),
            ...(path.trailable&&!path.enabled?{trailable:true}:{}),...(path.moving?{moving:true}:{}),
            ...(halt===undefined?{}:!path.enabled?{halt}:path.stop?{endHalt:`The ${definition.label.toLowerCase()}'s far end faces no track in this setting.`}:{}),
            fromPointId:`${tile.id}:${path.from}`,toPointId:`${tile.id}:${path.to}`,family:invalid?null:familyId,
            kind:invalid?'unresolved':'straight',start:port(points[0],gauge,width),end:port(points.at(-1)!,gauge,width),
            run,parameters,pathPoints:points});
        }
        if (invalid || !family) continue;
        if (family.source==='owned') useOwned(tile);
        instances.push({id:tile.id,routeId:route.id,sectionId:tile.id,family:family.id,parameters:fast?{...parameters,lite:1}:parameters,
          pose:{x:tile.x,y:tile.y,z:tile.z,heading:tile.heading,pitch:0},interfaceKind:'track-assembly',
          ports:portsFromPaths(paths).map(({id,x,y,z,heading,pitch})=>({id,...port({x,y,z,heading,pitch:pitch??0},gauge,width)})),
          paths:paths.map(({id,from,to,enabled})=>({id,from,to,enabled})),
          source:family.source,status:'unverified',geometryAvailable:family.source==='printed'&&family.geometryAvailable});
        continue;
      }
      const isCurve=tile.sweep!==undefined;
      const radius=isCurve?definition.radius!:0;
      const run=definition.run(tile,project);
      const dz=tile.rise ?? 0;
      const h=tile.heading;
      const p=port(pose(start,h,0),gauge,width);
      const q=port(pose(terminal,terminal.heading,0),gauge,width);
      const base={id:tile.id,routeId:route.id,fromPointId:span[0],toPointId:span[1]};
      const fail=(code:string) => {
        sections.push({...base,family:null,kind:'unresolved',start:p,end:q,run,parameters:{}});
        issues.push({code,severity:'error',routeId:route.id,span,message:PIECE_ERRORS[code]});
      };
      if (!definition.customJoiner && !brickConnector) { fail('standard-shape-track-system'); continue; }
      if (!family || (isCurve && family.kind!=='curve') ||
        (!isCurve && family.kind==='curve') || definition.legacy?.rise!==undefined && family.kind!=='transition') {
        fail(findPieceDefinition(tile.family)?'piece-family-unavailable':'piece-not-in-library'); continue;
      }
      if (mismatch) { fail('piece-pose-mismatch'); continue; }
      if (start.z < ground-EPS || terminal.z < ground-EPS) { fail(under); continue; }
      if (roomWidth!==null || roomDepth!==null) {
        const direction=Math.sign(tile.sweep??0),sinHead=Math.sin(h),cosHead=Math.cos(h);
        let leaves=false;
        for (let n=0;n<=(isCurve?12:1) && !leaves;n++) {
          const t=isCurve?n/12:n;
          leaves=outside(isCurve ? {
            x:start.x+direction*radius*(Math.sin(h+tile.sweep!*t)-sinHead),
            y:start.y+direction*radius*(cosHead-Math.cos(h+tile.sweep!*t))
          } : {x:start.x+(terminal.x-start.x)*t,y:start.y+(terminal.y-start.y)*t});
        }
        if (leaves) { fail('piece-outside-room'); continue; }
      }
      const modules=family.kind==='transition' ? Math.ceil(run/Math.min(family.run[1],longestFlatPart)) : 1;
      const moduleRun=run/modules;
      if (moduleRun<family.run[0]-EPS || moduleRun>family.run[1]+EPS ||
        isCurve && (Math.abs(tile.sweep!)> (family.maxSweep ?? 0)+EPS ||
          radius<(family.radius?.[0] ?? Infinity)-EPS || radius>(family.radius?.[1] ?? 0)+EPS)) {
        fail(family.source==='printed'&&isCurve?'curve-unfitted':'piece-off-catalog'); continue;
      }
      if (family.source==='printed' && !isCurve && moduleRun>longestFlatPart+EPS) { fail('piece-too-long'); continue; }
      if (isCurve) {
        const s=Math.sign(tile.sweep!);
        const arc={center:{x:start.x-s*radius*Math.sin(h),y:start.y+s*radius*Math.cos(h)},radius,sweep:tile.sweep!};
        if (family.source==='printed') {
          // CAD is generated in the curve's local tangent frame, independently of its room heading.
          const angle=Math.abs(tile.sweep!), half=(bodyWidth ?? 60)/2;
          const extentX=(radius+half)*Math.sin(angle);
          const extentY=radius*(1-Math.cos(angle))+half*(1+Math.cos(angle));
          if (Math.max(extentX,extentY)>Math.max(usablePlate.x,usablePlate.y)+EPS ||
            Math.min(extentX,extentY)>Math.min(usablePlate.x,usablePlate.y)+EPS) { fail('curve-unfitted'); continue; }
        } else useOwned(tile);
        add({...base,family:family.id,kind:'curve',start:p,end:q,run,arc,
          parameters:family.source==='printed'?{...part.parameters,...railProfile()}:part.parameters},family,fast);
      } else if (family.kind==='transition') {
        if (Math.abs(dz)*1.5/run>family.maxGrade+EPS || rampSpace!==null && run>rampSpace+EPS) { fail('grade-unfitted'); continue; }
        for (let n=0;n<modules;n++) {
          const u=n/modules,v=(n+1)/modules;
          const from=point(start.x+(terminal.x-start.x)*u,start.y+(terminal.y-start.y)*u,start.z+dz*hermite(u));
          const to=point(start.x+(terminal.x-start.x)*v,start.y+(terminal.y-start.y)*v,start.z+dz*hermite(v));
          const firstGrade=dz/run*derivative(u),lastGrade=dz/run*derivative(v);
          add({...base,id:`${tile.id}:${n}`,family:family.id,kind:'transition',start:port(pose(from,h,firstGrade),gauge,width),
            end:port(pose(to,h,lastGrade),gauge,width),run:moduleRun,
            parameters:{run:moduleRun,rise:to.z-from.z,start_grade:firstGrade,end_grade:lastGrade,...railProfile()}},family,fast);
        }
      } else {
        if (family.source==='owned') useOwned(tile);
        if (definition.deck && !deckReady)
          issues.push({code:'bridge-design-incomplete',severity:'warning',routeId:route.id,span,
            message:'Set the bridge dimensions in Print → Advanced before export.'});
        const parameters=definition.deck ?
          {...part.parameters,...deckGeometry,...(gauge===null?{}:{rail_gauge:gauge}),
            ...(width===null?{}:{rail_interface_width:width}),...(railHeight===null?{}:{rail_height:railHeight})} :
          family.source==='owned'?part.parameters:{...part.parameters,...railProfile()};
        add({...base,family:family.id,kind:'straight',start:p,end:q,run,parameters},family,fast);
      }
    }
  }
  for (const [family, pieceIds] of ownedUse) {
    const owned=project.inventory[family] ?? 0;
    if (pieceIds.length<=owned) continue;
    const label=pieceDefinition(family).label;
    issues.push({code:'owned-piece-unavailable',severity:'warning',
      message:`${pieceIds.length-owned} more ${label} than you own.`,
      shortfall:{family,used:pieceIds.length,owned,pieceIds:pieceIds.slice(owned)}});
  }
  for (const route of project.routes) {
    // A junction's chain runs along `main`; a moving piece's along whichever position joins its `in` to its `out`.
    const pieces=sections.filter(s=>s.routeId===route.id && (!s.pathId || s.pathId==='main' ||
      s.moving && s.fromPointId===`${s.pieceId}:in` && s.toPointId===`${s.pieceId}:out`));
    for(let i=1;i<pieces.length;i++) {
      const before=pieces[i-1], after=pieces[i];
      if (!portsMatch(before.end,after.start)) issues.push({code:'port-discontinuity',severity:'error',routeId:route.id,
        span:[before.toPointId,after.fromPointId],message:'Pieces do not line up here; re-place one of them.'});
      if (baseThickness !== null && railHeight !== null && before.family && after.family) {
        const beforeTop=(!brickConnector && before.family==='bridge_deck' ? design.deck_thickness : baseThickness) + railHeight;
        const afterTop=(!brickConnector && after.family==='bridge_deck' ? design.deck_thickness : baseThickness) + railHeight;
        if (Number.isFinite(beforeTop) && Number.isFinite(afterTop) &&
            Math.abs(beforeTop-afterTop)>.01) issues.push({code:'rail-top-discontinuity',severity:'error',
          routeId:route.id,span:[before.toPointId,after.fromPointId],
          message:'Rail tops step at this joint; match the bridge deck thickness to the rail base.'});
      }
    }
  }
  if (!brickConnector) {
    // Custom-joiner track joins through separate printed joiners; brick ends mate directly.
    const socketed = new Set(['printed_straight', 'printed_curve', 'vertical_transition', 'bridge_deck']);
    const joinerParameters = designParameters(jointKeys);
    for (const route of project.routes) {
      const pieces = sections.filter(section => section.routeId === route.id && !section.pathId);
      for (let index = 1; index < pieces.length; index++) {
        const before = pieces[index - 1], after = pieces[index];
        if (!portsMatch(before.end, after.start)) continue;
        const beforeOwned=FAMILIES.find(item=>item.id===before.family)?.source==='owned';
        const afterOwned=FAMILIES.find(item=>item.id===after.family)?.source==='owned';
        if (beforeOwned || afterOwned) {
          if (beforeOwned!==afterOwned) issues.push({ code:'brick-coupling-unfitted', severity:'error',
            routeId:route.id, span:[before.toPointId,after.fromPointId],
            message:'Custom-joiner track cannot join track you own.' });
          continue;
        }
        if (!socketed.has(before.family ?? '') || !socketed.has(after.family ?? '')) continue;
        const seam = before.end.pose;
        const insertion = (design.joint_depth ?? 0) - (design.joint_clearance ?? 0);
        const along = insertion * Math.cos(seam.pitch);
        instances.push({ id:`${route.id}:joiner:${index}`, routeId:route.id, sectionId:before.id,
          family:'connector_joiner', parameters:joinerParameters,
          pose:{x:seam.x-along*Math.cos(seam.heading),y:seam.y-along*Math.sin(seam.heading),
            z:seam.z-insertion*Math.sin(seam.pitch),heading:seam.heading,pitch:seam.pitch},
          interfaceKind:'connector',source:'printed',status:'unverified',geometryAvailable:jointReady });
      }
    }
  }
  issues.push(...checkAssemblyFootprints(project));
  const crossingResult=checkCrossings(project,sections);
  issues.push(...crossingResult.issues);
  issues.push(...checkElevation(project,sections));
  issues.push(...checkElectrical(project));
  const mounting=planMounting(project,sections,instances);
  issues.push(...mounting.issues);
  issues.push(...roomIssues(project,mounting.supports));
  const own=planOwnSupports(project,sections,lugs,brackets,undersides,crossingResult.crossings);
  issues.push(...own.issues);
  instances.push(...own.parts);
  // A crossing at a helix: clear when the tallest car fits between its turns, blocked when it does not (helix-clearance says where).
  for (const { crossingId, clearance } of own.measured) {
    const crossing=crossingResult.crossings.find(item=>item.crossingId===crossingId)!;
    crossing.clearance=clearance;
    if (crossing.needed!==undefined) crossing.status=clearance>=crossing.needed?'digitally-clear':'blocked';
  }
  const supportKeys=project.mounting==='anchored' ? bracketKeys : columnKeys;
  const supportParameters=designParameters(supportKeys);
  const supportsReady=supportKeys.every(k=>Object.hasOwn(supportParameters,k));
  if (mounting.supports.some(support=>support.family!=='layout_riser') && !supportsReady) {
    issues.push({code:'support-design-incomplete',severity:'warning',
      message:'Set the support dimensions in Print → Advanced before export.'});
  }
  for (const support of mounting.supports) {
    const seat=support.pose;
    if (support.family==='layout_riser') {
      // Stackable stud blocks, bottom to top, each seated on the one below.
      let z=support.ground ?? 0;
      support.blocks!.forEach((height,index)=>{
        instances.push({id:`${support.id}:${index+1}`,routeId:support.routeId,sectionId:support.id,family:support.family,
          parameters:{height,fit_adjustment:effectiveFitAdjustment(project)},pose:{x:seat.x,y:seat.y,z,heading:seat.heading,pitch:0},
          interfaceKind:'mounting',mountingSeat:{...seat,z:z+height},source:'printed',status:'unverified',geometryAvailable:true});
        z+=height;
      });
      continue;
    }
    const reach=support.family==='anchored_bracket' ? design.reach ?? 0 : 0;
    // A column under a sloped underside (not a wedge part's flat one) tilts its seat to the track's pitch there.
    const tilt:Record<string,number>=support.family==='reversible_column'&&Math.abs(seat.pitch)>1e-6?{seat_pitch:seat.pitch}:{};
    instances.push({id:support.id,routeId:support.routeId,sectionId:support.id,family:support.family,
      parameters:{height:support.height,...supportParameters,...tilt},
      pose:{x:seat.x-reach*Math.cos(seat.heading),y:seat.y-reach*Math.sin(seat.heading),
        z:support.ground ?? 0,heading:seat.heading,pitch:0},
      interfaceKind:'mounting',mountingSeat:{...seat},source:'printed',status:'unverified',geometryAvailable:supportsReady});
  }
  if (!completeProfile && instances.some(part=>part.source==='printed')) issues.push({code:'cad-profile-unmeasured',severity:'warning',
    message:'Measure your rail profile in Setup and set the joint dimensions in Print → Advanced before printing track.'});
  return {units:'mm',layoutRevision:project.layoutRevision,sections,issues,crossings:crossingResult.crossings,
    supports:mounting.supports,mounting:{siteChecks:mounting.siteChecks},partInstances:instances,
    // Track past the room or into a shelf is the Checks panel's error to show, not a geometry the printer cannot make:
    // export and Build's done step keep working as they did (a measured room's piece-outside-room still fails its piece).
    geometryFeasible:!issues.some(issue=>issue.severity==='error'&&!ROOM_CODES.includes(issue.code))};
}
