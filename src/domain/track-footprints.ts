import assemblyProfile from '../../cad/profiles/track-assemblies-v1.json';
import { furnitureType } from './furniture';
import type { Furniture, RoutePiece, WorkshopProject } from './project';
import type { FitIssue } from './route';
import { NARROW_TRACK } from './gauges';
import { BRICK_TRACK, railDimension } from './track';
import { pieceDefinition, pieceIsAssembly, piecePaths, portsFromPaths, type Gauge, type ShapePath, type ShapePort } from './pieces';

type XY = { x: number; y: number };
export interface Footprint { polygon: XY[]; bottom: number; top: number; minX:number; maxX:number; minY:number; maxY:number }
const cross = (a: XY, b: XY, p: XY) => (b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x);
const rectangle = (x0:number,y0:number,x1:number,y1:number):XY[] => [{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}];
function footprint(polygon:XY[],bottom:number,top:number):Footprint {
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for(const p of polygon) {
    minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);
    minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);
  }
  return {polygon,bottom,top,minX,maxX,minY,maxY};
}
function transform(points:XY[],x:number,y:number,heading:number):XY[] {
  const c=Math.cos(heading),s=Math.sin(heading);
  return points.map(p=>({x:x+c*p.x-s*p.y,y:y+s*p.x+c*p.y}));
}

/** Convex intersection; footprints are counterclockwise in the planning XY frame. */
function intersection(subject:XY[],clip:XY[]):XY[] {
  let result=subject;
  for(let i=0;i<clip.length&&result.length;i++) {
    const a=clip[i],b=clip[(i+1)%clip.length],input=result;
    result=[];
    let previous=input.at(-1)!,before=cross(a,b,previous);
    for(const current of input) {
      const after=cross(a,b,current);
      if((before>=0)!==(after>=0)) {
        const t=before/(before-after);
        result.push({x:previous.x+t*(current.x-previous.x),y:previous.y+t*(current.y-previous.y)});
      }
      if(after>=0) result.push(current);
      previous=current;before=after;
    }
  }
  return result;
}
export function area(points:XY[]|null):number {
  if(!points) return 0;
  return Math.abs(points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p.x*q.y-p.y*q.x;},0))/2;
}
/** The plan polygon where two footprints overlap, if they also overlap in height. */
export function overlap(a:Footprint,b:Footprint):XY[]|null {
  if(a.top<=b.bottom+.01||b.top<=a.bottom+.01) return null;
  if(a.maxX<=b.minX||b.maxX<=a.minX||a.maxY<=b.minY||b.maxY<=a.minY) return null;
  return intersection(a.polygon,b.polygon);
}

/** Reserve full selector travel, not just the currently selected mesh silhouette. */
export function pieceFootprints(piece:RoutePiece,project:WorkshopProject,paths:readonly ShapePath[],ports:readonly ShapePort[]):Footprint[] {
  const standard=(railDimension(project,'railBodyWidth')??BRICK_TRACK.bodyWidth)/2;
  // A monorail beam is 32 mm (4 studs) wide (cad/models/monorail.py); narrow track 47.8 mm (cad/profiles/brick-narrow-v1.json).
  const halfWidth=(gauge:Gauge)=>gauge==='monorail'?16:gauge==='narrow'?NARROW_TRACK.bodyWidth/2:standard;
  const height=(railDimension(project,'railBaseThickness')??BRICK_TRACK.baseThickness)+
    (railDimension(project,'railHeight')??BRICK_TRACK.railHeight);
  const result:Footprint[]=[];
  for(const path of paths) for(let i=1;i<path.points.length;i++) {
    const a=path.points[i-1],b=path.points[i],h=Math.atan2(b.y-a.y,b.x-a.x),half=halfWidth(path.gauge),nx=-Math.sin(h)*half,ny=Math.cos(h)*half;
    result.push(footprint([{x:a.x-nx,y:a.y-ny},{x:b.x-nx,y:b.y-ny},{x:b.x+nx,y:b.y+ny},{x:a.x+nx,y:a.y+ny}],
      Math.min(a.z,b.z),Math.max(a.z,b.z)+height));
  }
  for(const port of ports) result.push(footprint(
    transform(rectangle(0,-halfWidth(port.gauge),6,halfWidth(port.gauge)),port.x,port.y,port.heading),port.z,port.z+height));
  result.push(...mechanismFootprints(piece,project));
  return result;
}

/** Full travel of the piece's moving parts: its definition's envelopes, else the static assembly profile. */
export function mechanismFootprints(piece:RoutePiece,project:WorkshopProject):Footprint[] {
  const own=pieceDefinition(piece.family).envelopes?.(piece,project);
  const polygons=own??(assemblyProfile.operationalEnvelopes as Record<string,number[][][]>)[piece.family]?.map(polygon=>polygon.map(([x,y])=>({x,y})))??[];
  return polygons.map(polygon=>footprint(transform(polygon,piece.x,piece.y,piece.heading),
    piece.z,piece.z+assemblyProfile.operationalHeight));
}

/** A piece of furniture's panels as boxes (its type's data): for a KALLAX the shell, four shelves and the dividers between its cubbies. */
export function furnitureFootprints(item:Furniture):Footprint[] {
  return furnitureType(item.family).panels.map(({x,y,z,width,depth,height})=>footprint(
    transform(rectangle(x-width/2,y-depth/2,x+width/2,y+depth/2),item.x,item.y,item.quarterTurns*Math.PI/2),z-height/2,z+height/2));
}

/** Scope to new assemblies; retain historical ordinary-track fitting behavior. */
export function checkAssemblyFootprints(project:WorkshopProject):FitIssue[] {
  const pieces=project.routes.flatMap(route=>(route.pieces??[]).map(piece=>({piece,routeId:route.id})));
  if(!pieces.some(({piece})=>pieceIsAssembly(piece))) return [];
  const shapes=pieces.map(({piece,routeId})=>{
    const paths=piecePaths(piece,project),ports=portsFromPaths(paths);
    return {piece,routeId,footprints:pieceFootprints(piece,project,paths,ports),ports};
  });
  const obstacles=project.furniture.flatMap(furnitureFootprints),issues:FitIssue[]=[];
  const width=project.measurements.roomWidth.status==='estimate'?null:project.measurements.roomWidth.value;
  const depth=project.measurements.roomDepth.status==='estimate'?null:project.measurements.roomDepth.value;
  for(let i=0;i<shapes.length;i++) {
    const a=shapes[i];
    if(pieceIsAssembly(a.piece)) {
      if(a.footprints.some(f=>f.polygon.some(p=>width!==null&&(p.x<0||p.x>width)||depth!==null&&(p.y<0||p.y>depth))))
        issues.push({code:'assembly-envelope-outside-room',severity:'error',routeId:a.routeId,pieceIds:[a.piece.id],
          message:`${a.piece.id}: track body or full mechanism travel extends outside the confirmed room.`});
      if(a.footprints.some(f=>obstacles.some(obstacle=>area(overlap(f,obstacle))>.1)))
        issues.push({code:'assembly-furniture-collision',severity:'error',routeId:a.routeId,pieceIds:[a.piece.id],
          message:`${a.piece.id}: track body or full mechanism travel intersects a shelf panel.`});
    }
    for(let j=i+1;j<shapes.length;j++) {
      const b=shapes[j];
      if(!pieceIsAssembly(a.piece)&&!pieceIsAssembly(b.piece)) continue;
      const shared=a.ports.filter(p=>b.ports.some(q=>Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)<.05 &&
        Math.abs(Math.atan2(Math.sin(p.heading-q.heading-Math.PI),Math.cos(p.heading-q.heading-Math.PI)))<.001));
      const collides=a.footprints.some(f=>b.footprints.some(g=>{
        const polygon=overlap(f,g);
        if(!polygon||area(polygon)<=.1) return false;
        // Only the small integral connector band may overlap at a matched physical port.
        return !shared.some(port=>polygon.every(p=>{
          const x=p.x-port.x,y=p.y-port.y,c=Math.cos(port.heading),s=Math.sin(port.heading);
          return Math.abs(x*c+y*s)<=6.1 && Math.abs(-x*s+y*c)<=32.1;
        }));
      }));
      if(collides) issues.push({code:'assembly-track-collision',severity:'error',routeId:a.routeId,pieceIds:[a.piece.id,b.piece.id],
        message:`${a.piece.id} and ${b.piece.id}: track bodies or full mechanism travel overlap away from a matched connector.`});
    }
  }
  return issues;
}
