import type { Gauge, ShapePoint } from './types';

/** Appends a circular arc to `points`, one sample per ~4 mm of centreline. */
export function arc(points: ShapePoint[], radius: number, sweep: number): void {
  const start=points.at(-1)!, sign=Math.sign(sweep), count=Math.max(1,Math.ceil(Math.abs(sweep)*radius/4));
  for(let i=1;i<=count;i++) {
    const heading=start.heading+sweep*i/count;
    points.push({x:start.x+sign*radius*(Math.sin(heading)-Math.sin(start.heading)),y:start.y+sign*radius*(Math.cos(start.heading)-Math.cos(heading)),z:start.z,heading});
  }
}
export const origin=(y=0,heading=0):ShapePoint=>({x:0,y,z:0,heading});

/** Piece frame → world frame for a piece at `pose`. Pitch and roll are carried unchanged. */
export function placePoint(pose:{x:number;y:number;z:number;heading:number},p:ShapePoint):ShapePoint {
  const c=Math.cos(pose.heading),s=Math.sin(pose.heading);
  return {x:pose.x+c*p.x-s*p.y,y:pose.y+s*p.x+c*p.y,z:pose.z+p.z,heading:pose.heading+p.heading,
    ...(p.pitch===undefined?{}:{pitch:p.pitch}),...(p.roll===undefined?{}:{roll:p.roll})};
}

/** Ports mate only on equal gauges; dual-gauge track also mates standard and narrow. */
export function gaugesMate(a:Gauge,b:Gauge):boolean {
  return a===b || (a==='dual'&&(b==='standard'||b==='narrow')) || (b==='dual'&&(a==='standard'||a==='narrow'));
}
