import type { RoutePiece } from '../project';
import { BRICK_LAYOUT } from '../track';
import { arc, origin } from './geometry';
import type { PieceDefinition, PiecePath, ShapePoint, StateSpec } from './types';

export const FLEX_MAX_BEND = Math.PI / 32;
const OWNED_COLOR = 0xa9d788, PRINTED_COLOR = 0xe7a871;
const TURNOUT_STATES: readonly StateSpec[] = [{id:'straight',label:'Straight'},{id:'diverging',label:'Diverging'}];
const CROSSOVER_STATES: readonly StateSpec[] = [{id:'straight',label:'Straight'},{id:'diverging',label:'Crossed'}];
const SELECTOR_NOTE = 'The sliding selector is held by M3 screws; leave room for its full travel.';

type Shape = Omit<PieceDefinition, 'family' | 'source' | 'styles' | 'owned' | 'color' | 'cad'> & {
  owned: NonNullable<PieceDefinition['owned']>;
  printed: string;
  ownedColor?: number; printedColor?: number;
  /** CAD part of the printed piece; `ownedPart` describes the nominal brick part. */
  cad: PieceDefinition['cad']; ownedPart?: PieceDefinition['cad'];
  ownedNotes?: readonly string[];
};
/** One official brick shape: the owned piece and its printed counterpart share geometry. */
function official({owned,printed,ownedColor=OWNED_COLOR,printedColor=PRINTED_COLOR,cad,ownedPart=cad,notes,ownedNotes,...shape}:Shape):PieceDefinition[] {
  return [
    {...shape,family:owned.family,source:'owned',owned,styles:[],color:ownedColor,cad:ownedPart,...(ownedNotes?{notes:ownedNotes}:{})},
    {...shape,family:printed,source:'printed',owned,styles:['detailed','fast'],color:printedColor,cad,...(notes?{notes}:{})}
  ];
}
const straightPaths=(run:number)=>():PiecePath[]=>[{id:'main',from:'in',to:'out',points:[origin(),{x:run,y:0,z:0,heading:0}]}];
function curvePaths(radius:number) {
  return (piece:RoutePiece):PiecePath[]=>{ const points=[origin()];arc(points,radius,piece.sweep!);return [{id:'main',from:'in',to:'out',points}]; };
}
function curveEnd(radius:number) {
  return (piece:RoutePiece):ShapePoint=>{
    const heading=piece.sweep!,side=Math.sign(heading);
    return {x:side*radius*Math.sin(heading),y:side*radius*(1-Math.cos(heading)),z:0,heading};
  };
}
const straightEnd=(run:number)=>():ShapePoint=>({x:run,y:0,z:0,heading:0});
const assemblyPart=(piece:RoutePiece)=>[{family:piece.family,parameters:{bend:piece.bend??0,switch_state:piece.state==='diverging'?1:0}}];

const R40=BRICK_LAYOUT.curveRadius, R56=BRICK_LAYOUT.wideCurveRadius, SWEEP=BRICK_LAYOUT.curveSweep;
const STRAIGHT=BRICK_LAYOUT.straightLength, LONG=BRICK_LAYOUT.printedStraightLength;
const degrees=(radians:number)=>Number((radians*180/Math.PI).toFixed(3));

function turnout(side:'left'|'right',partNumber:string):PieceDefinition[] {
  const sign=side==='left'?1:-1,other=side==='left'?'right':'left';
  return official({
    label:`${side==='left'?'Left':'Right'} turnout`,description:()=>`256 mm main · ${side} branch`,group:'junction',
    owned:{family:`brick_switch_${side}`,partNumbers:[partNumber]},printed:`printed_switch_${side}`,
    params:[],states:TURNOUT_STATES,gauge:'standard',body:'assembly',handed:true,customJoiner:false,
    run:()=>256,end:straightEnd(256),notes:[SELECTOR_NOTE],
    paths:()=>{
      const points=[origin()],turn=Math.atan(3/4);
      arc(points,320,sign*turn);arc(points,320,-sign*(turn-Math.PI/8));
      return [{id:'main',from:'in',to:'out',points:[origin(),{x:256,y:0,z:0,heading:0}],states:['straight']},
        {id:'branch',from:'in',to:'branch',points,states:['diverging']}];
    },
    cad:assemblyPart
  }).map(definition=>({...definition,mirror:definition.family.replace(side,other)}));
}

/** Every family that existed before the registry, in palette order. */
export const CATALOGUE: readonly PieceDefinition[] = [
  ...official({
    label:'Straight',description:()=>`${STRAIGHT} mm straight`,group:'track',
    owned:{family:'brick_straight_nominal',partNumbers:['53401']},printed:'printed_brick_straight',
    params:[],gauge:'standard',body:'rail',customJoiner:false,
    run:()=>STRAIGHT,end:straightEnd(STRAIGHT),paths:straightPaths(STRAIGHT),
    cad:()=>[{family:'printed_straight',parameters:{run:STRAIGHT}}],
    ownedPart:()=>[{family:'brick_straight_nominal',parameters:{run:STRAIGHT}}]
  }).map(definition=>definition.source==='owned'?{...definition,customJoiner:true}:definition),
  ...official({
    label:'R40 curve',description:()=>`${R40} mm radius · ${degrees(SWEEP)}°`,group:'track',
    owned:{family:'brick_curve_r40',partNumbers:['53400']},printed:'printed_curve_r40',ownedColor:0x9ac879,printedColor:0xdf9476,
    params:[],gauge:'standard',body:'rail',customJoiner:false,legacy:{sweep:SWEEP},radius:R40,
    run:piece=>R40*Math.abs(piece.sweep!),end:curveEnd(R40),paths:curvePaths(R40),
    cad:piece=>[{family:'printed_curve',parameters:{radius:R40,sweep:piece.sweep!}}],
    ownedPart:piece=>[{family:'brick_curve_r40',parameters:{radius:R40,sweep:piece.sweep!}}]
  }).map(definition=>definition.source==='owned'?{...definition,customJoiner:true}:definition),
  ...official({
    label:'Flexible track',description:()=>'32 mm · bend ±5.625°',group:'track',
    owned:{family:'brick_flex',partNumbers:['64022']},printed:'printed_flex',
    params:[],gauge:'standard',body:'assembly',customJoiner:false,legacy:{bend:0},flexEnds:true,
    run:()=>32,notes:['Prints as two leaves joined with an M3 screw.'],
    end:piece=>{const heading=piece.bend??0;return {x:16+16*Math.cos(heading),y:16*Math.sin(heading),z:0,heading};},
    paths:piece=>{
      const bend=piece.bend??0;
      return [{id:'main',from:'in',to:'out',points:[origin(),{x:16,y:0,z:0,heading:bend/2},{x:16+16*Math.cos(bend),y:16*Math.sin(bend),z:0,heading:bend}]}];
    },
    cad:assemblyPart
  }),
  ...turnout('left','53407'),
  ...turnout('right','53404'),
  ...official({
    label:'90° crossing',description:()=>'128 × 128 mm · retired metal-rail 9 V shape',group:'junction',
    owned:{family:'brick_crossing90',partNumbers:['32087']},printed:'printed_crossing90',
    params:[],gauge:'standard',body:'assembly',customJoiner:false,
    run:()=>128,end:straightEnd(128),
    paths:()=>[{id:'main',from:'in',to:'out',points:[origin(),{x:128,y:0,z:0,heading:0}]},
      {id:'crossing',from:'south',to:'north',points:[{x:64,y:-64,z:0,heading:Math.PI/2},{x:64,y:64,z:0,heading:Math.PI/2}]}],
    cad:assemblyPart
  }),
  ...official({
    label:'Double crossover',description:()=>'384 mm · two-half assembly · retired',group:'junction',
    owned:{family:'brick_double_crossover',partNumbers:['60128'],kit:'7996 · 2 × 60128'},printed:'printed_double_crossover',
    params:[],states:CROSSOVER_STATES,gauge:'standard',body:'assembly',handed:true,customJoiner:false,
    run:()=>384,end:straightEnd(384),notes:[SELECTOR_NOTE],ownedNotes:['One assembly is two 60128 halves.'],
    paths:()=>{
      const paths:PiecePath[]=[{id:'main',from:'in',to:'out',points:[origin(),{x:384,y:0,z:0,heading:0}],states:['straight']},
        {id:'parallel',from:'parallel-in',to:'parallel-out',points:[origin(128),{x:384,y:128,z:0,heading:0}],states:['straight']}];
      for (const side of [1,-1]) {
        const points=[origin(side===1?0:128)],turn=Math.atan(3/4);
        arc(points,320,side*turn);arc(points,320,-side*turn);
        paths.push({id:side===1?'cross':'cross-back',from:side===1?'in':'parallel-in',to:side===1?'parallel-out':'out',points,states:['diverging']});
      }
      return paths;
    },
    cad:assemblyPart
  }),
  {
    family:'printed_straight',label:'Long straight',description:()=>`${LONG} mm`,group:'track',source:'printed',
    styles:['detailed','fast'],params:[],gauge:'standard',body:'rail',customJoiner:true,color:PRINTED_COLOR,
    run:()=>LONG,end:straightEnd(LONG),paths:straightPaths(LONG),
    cad:()=>[{family:'printed_straight',parameters:{run:LONG}}]
  },
  {
    family:'printed_curve_r56',label:'Wide curve',description:()=>`${R56} mm radius · ${degrees(SWEEP)}°`,group:'track',source:'printed',
    styles:['detailed','fast'],params:[],gauge:'standard',body:'rail',customJoiner:true,color:0xdf9476,legacy:{sweep:SWEEP},radius:R56,
    run:piece=>R56*Math.abs(piece.sweep!),end:curveEnd(R56),paths:curvePaths(R56),
    cad:piece=>[{family:'printed_curve',parameters:{radius:R56,sweep:piece.sweep!}}]
  },
  {
    family:'vertical_transition',label:'Ramp piece · 8 mm',description:()=>'8 mm rise per piece — use Go up or down for a height',group:'elevation',source:'printed',
    styles:['detailed','fast'],params:[],gauge:'standard',body:'rail',customJoiner:true,color:0x7dc5d7,legacy:{rise:0},
    run:piece=>rampRun(piece.rise??0),
    end:piece=>({x:rampRun(piece.rise??0),y:0,z:piece.rise??0,heading:0}),
    paths:piece=>{
      const run=rampRun(piece.rise??0),rise=piece.rise??0,count=rise?Math.ceil(run/8):1;
      return [{id:'main',from:'in',to:'out',points:Array.from({length:count+1},(_,i)=>{const t=i/count;return {x:run*t,y:0,z:rise*(3*t*t-2*t*t*t),heading:0};})}];
    },
    cad:piece=>[{family:'vertical_transition',parameters:{run:rampRun(piece.rise??0),rise:piece.rise??0}}]
  },
  {
    family:'bridge_deck',label:'Bridge',description:()=>`${LONG} mm`,group:'elevation',source:'printed',
    styles:['detailed','fast'],params:[],gauge:'standard',body:'rail',customJoiner:true,color:0xd2ad82,deck:true,
    run:()=>LONG,end:straightEnd(LONG),paths:straightPaths(LONG),
    cad:()=>[{family:'bridge_deck',parameters:{run:LONG}}]
  }
];
/** 6% ramps in whole 200 mm modules; the 1.5 factor leaves room for the eased ends. */
export function rampRun(rise:number):number {
  return Math.max(200,Math.ceil(Math.abs(rise)*1.5/(0.06*200))*200);
}
