import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type PointerEvent, type ReactNode, type WheelEvent } from 'react';
import { furnitureType } from '../domain/furniture';
import type { Furniture, RoutePiece, WorkshopProject } from '../domain/project';
import { pieceIsFast, styleCounts } from '../domain/printer';
import { BRICK_TRACK, railDimension } from '../domain/track';
import { gaugeLayout } from '../domain/gauges';
import { CLIMB_FAMILY, OWNED_DEFINITIONS, climbLevel, pieceDefinitions, PIECE_GROUPS, TRACK_KINDS, applyChoice, kindOfFamily, paramValue, physicalPaths, pieceDefinition, piecePaths, piecePorts, placePoint, portsFromPaths, primaryEnd, type Gauge, type KindShape, type PieceDefinition, type PieceGroup, type ShapePath, type TrackKind } from '../domain/pieces';
import { mechanismFootprints } from '../domain/track-footprints';
import { pieceParts, type FitResult } from '../fitting/fit';
import { pieceLeavesRoom } from '../fitting/room';
import { hardwareRequest } from '../export/hardware';
import { AlsoNeeds } from '../export/shopping-list';
import type { Account } from '../account/account';
import { track } from '../net/telemetry';
import { heightMarks, heightText, heightTint, routeHeightWords } from './heights';
import { buildChecks, targetBounds } from './checks';
import { ChecksPanel } from './checks-ui';
import { canFlipPiece, flipPiece, insertPiece, movePieceRoute, pieceRotation, placePiece, placePreview, previewPiece, previewRouteMove, removePiece, rotatePiece, rotatePieceRoute, tileFits, unoccupiedPiecePorts, type OpenedGap, type PiecePreview, type PieceSource, type Placement, type TileFamily } from './operations';
import { PlacementBar, barActions, barNote, type BarContext, type BarHandlers } from './placement-bar';
import { ShortcutSheet } from './shortcut-sheet';
import { footerHint, keyLabel, shortcutFor } from './shortcuts';
import { frozenPoint, recordSamples, type PointerSample } from './ghost-freeze';
import { NO_SELECTION, wayOf, activeVariant, choose, cleanLandings, facings, findJoint, fitsCleanly, intentOf, jointVariants, nearestLanding, otherFacing, otherHand,
  stepLock, stepSelection, type JointVariant, type Landing, type LockJoint, type Selection } from './joint-lock';
import { BuilderScene, type BuilderSceneHandle } from './builder-scene';
import { CommunityFootprint, CommunityMeshHint } from './community-mesh';
import { furnitureFootprint, furniturePosition, moveFurniture, nextOrientation, placeFurniture, removeFurniture, rotateFurniture } from './furniture';
import { braceBands, connectorCentre, connectorOutlines, connectorPorts, curveTieLayout, endStudPoses, narrowConnectorOutlines, partStations, portPoint, splitPath, studPoses, tieBands, type PreviewPose, type TieLayout } from './track-preview';
import { MonorailBeam } from './monorail-visual';
import { GapOverlay, GapPanel, useGapCloser } from './gap-closer-ui';
import { placeLadder, previewLadder } from './ladder';
import { LADDER_INITIAL, LADDER_KEY, LadderMiniature, LadderSettings, ladderSummary, useLadderKit } from './ladder-ui';
import { placeTriple, previewTriple } from './triple';
import { TRIPLE_INITIAL, TRIPLE_KEY, TripleSettings, tripleSummary } from './triple-ui';
import { planRamp } from '../domain/elevation';
import { climbFit, climbWords, placeKitPieces, previewFlyover, surfaceAhead } from './elevation-kits';
import { CLIMB_INITIAL, ClimbSettings, FLYOVER_INITIAL, FLYOVER_KEY, FlyoverSettings, climbSummary, flyoverSummary } from './elevation-ui';
import { planHelix, previewHelix } from './helix';
import { HELIX_INITIAL, HELIX_KEY, HelixSettings, WALL_RUN_INITIAL, WALL_RUN_KEY, WallRunSettings, helixSummary, wallRunLabel, wallRunSummary } from './helix-ui';
import { Palette, ownsAny, tileSource, type OwnedStock, type PaletteEntry } from './palette';
import { DriveChoice, FurniturePanel, KindEditor, PlacingPanel, SelectedPiecePanel, driveSpec, driveSummary } from './piece-panel';
import { furnitureTiles } from './furniture-tiles';
import { CommunityRows, communityItems } from './community-mark';
import { ToolButton, TurnIndicator, ZoomCluster } from './canvas-tools';
import { chainTurn, closesWithOneMore, turnWords } from './chain-turn';
import { firstPlacementView, pinchView, useViewMotion, widenView, type Viewport } from './view-motion';
import { previewWallRun } from './wall-run';
import { PlanAssistPanel, usePlanAssist } from './plan-assist-ui';
import { BUILD_BY_HAND_TIP, StartScreen } from './start-screen';
import { startScreenShown } from './start-examples';
import './builder.css';
import './builder-canvas.css';

/**
 * One palette tile per printed family outside the track kinds; an official shape's tile also offers the owned piece.
 * Read when drawn: community pieces register at start-up (src/domain/library.ts), after this module loads.
 */
const paletteDefinitions=()=>pieceDefinitions().filter(definition=>definition.source==='printed'&&!definition.hidden&&!kindOfFamily(definition.family));
const kindKey=(kind:TrackKind)=>`kind:${kind.id}`;
/** Elevation tiles in the order a climb is usually built: the height kits first, then single pieces. */
const ELEVATION_ORDER=[CLIMB_FAMILY,HELIX_KEY,FLYOVER_KEY,WALL_RUN_KEY,'bridge_deck','kind:ramp','vertical_transition','helix_curve','kind:banked'];
/** A group's tiles with Elevation's in ELEVATION_ORDER (tiles it does not name keep their order, after them). */
function inElevationOrder(entries:PaletteEntry[]):PaletteEntry[] {
  const rank=(entry:PaletteEntry)=>entry.group!=='elevation'||!ELEVATION_ORDER.includes(entry.key)?ELEVATION_ORDER.length:ELEVATION_ORDER.indexOf(entry.key);
  return [...entries].sort((a,b)=>rank(a)-rank(b));
}
const NO_CUTS:readonly number[]=[];
/** The pointer is over placed track when within this many mm of a centreline (about half a track's width). */
const INSERT_RADIUS=BRICK_TRACK.bodyWidth/2+4;
/** Set once the first-placement keys tip has been seen (dismissed, or its placement ended). */
const PLACEMENT_TIP_KEY='train-layout-workshop:placement-tip-seen';
/** Names the open end a snapped ghost meets, so Tab's pick stays with that end. */
/** Kits lock only to open ends of standard-gauge track; this family stands for their first piece's gauge. */
const KIT_GAUGE_FAMILY='track_straight';
/** Words for a variant at a locked joint: where its branch (or far end) goes and which way it faces. */
function variantWords(variant:JointVariant,lock:LockJoint):string {
  const side=variant.loopSide?`${variant.loopSide==='out'?'outside':'inside'} the loop`:variant.side?`to the ${variant.side>0?'left':'right'}`:'straight on';
  const facing=variant.facing==='with'?lock.kind==='end'?'points first':'facing along the track':variant.facing==='against'?
    lock.kind==='end'?'trailing':'facing back along the track':`joined by its ${variant.facing}`;
  return `${pieceDefinition(variant.family).label} · goes ${side} · ${facing}`;
}
/** A thin outline of a piece's bed, for the other variants at a locked joint. */
function bedOutline(points:readonly PlanPoint[],width:number):string {
  const side=(sign:number)=>points.map(point=>({x:point.x-Math.sin(point.heading)*width*sign/2,y:point.y+Math.cos(point.heading)*width*sign/2}));
  return `${planPath([...side(1),...side(-1).reverse()])} Z`;
}
/** The first `fraction` of a polyline's length, for the arrow showing which way a snapped ghost goes. */
function leadingPoints(points:readonly CanvasPoint[],fraction:number):CanvasPoint[] {
  const lengths=points.slice(1).map((point,index)=>Math.hypot(point.x-points[index].x,point.y-points[index].y));
  let left=lengths.reduce((sum,length)=>sum+length,0)*fraction;
  const kept=[points[0]];
  for(let index=0;index<lengths.length&&left>0;index++){
    const t=Math.min(1,left/(lengths[index]||1)),a=points[index],b=points[index+1];
    kept.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});left-=lengths[index];
  }
  return kept;
}
/** A palette tile as a piece at the origin: curves turn left, ramps climb 8 mm. */
function tilePiece(family:TileFamily,fast=false):RoutePiece {
  const legacy=pieceDefinition(family).legacy??{};
  return {id:'tile-preview',family,x:0,y:0,z:0,heading:0,...(fast?{style:'fast' as const}:{}),
    ...(legacy.sweep!==undefined?{sweep:legacy.sweep}:{}),...(legacy.rise!==undefined?{rise:8}:{})};
}
/** A kind tile's current shape as a piece at the origin. */
function shapePiece(shape:KindShape,fast=false):RoutePiece {
  return {id:'tile-preview',family:shape.family,x:0,y:0,z:0,heading:0,...(fast?{style:'fast' as const}:{}),
    ...(shape.sweep!==undefined?{sweep:shape.sweep}:{}),...(shape.params?{params:shape.params}:{})};
}
const plural=(count:number,word:string)=>`${count} ${word}${count===1?'':'s'}`;

type PlanPoint = PreviewPose;
type CanvasPoint = {x:number;y:number};
function pieceSamples(project:WorkshopProject,piece:RoutePiece):PlanPoint[] {
  const definition=pieceDefinition(piece.family);
  if(definition.body!=='rail')return piecePaths(piece,project).flatMap(path=>path.points);
  const run=definition.run(piece,project),count=Math.max(2,Math.ceil(run/16));
  const end=primaryEnd(piece,project);
  if(piece.sweep===undefined) return Array.from({length:count+1},(_,index)=>{
    const t=index/count;
    return {x:piece.x+(end.x-piece.x)*t,y:piece.y+(end.y-piece.y)*t,
      z:piece.z+(end.z-piece.z)*(3*t*t-2*t*t*t),heading:piece.heading,
      pitch:Math.atan((end.z-piece.z)*6*t*(1-t)/run)};
  });
  const sweep=piece.sweep,radius=definition.radius!,sign=Math.sign(sweep);
  return Array.from({length:count+1},(_,index)=>{
    const heading=piece.heading+sweep*index/count;
    return {x:piece.x+sign*radius*(Math.sin(heading)-Math.sin(piece.heading)),
      y:piece.y+sign*radius*(Math.cos(piece.heading)-Math.cos(heading)),z:piece.z,heading};
  });
}
function planPath(points:readonly CanvasPoint[]):string {
  return points.map((point,index)=>`${index?'L':'M'} ${point.x} ${point.y}`).join(' ');
}
/** `lite`: fast print keeps only the end ties, rails, solid rail supports and gauge braces (full-width sleepers on a `ramp`).
 * `trackGauge`: the standard-mode cross-section (rails, stringers, ties, studs, braces, ends) per `gaugeLayout`. */
function TrackVisual({points,width,gauge,railWidth,run,printed,bridge=false,selected=false,preview=false,
  unresolved=false,rise,standard=false,tieLayout='modular',halfTieStuds,lite=false,ramp=false,trackGauge='standard',rack=false}:{
  points:PlanPoint[];width:number;gauge:number;railWidth:number;run:number;printed:boolean;bridge?:boolean;
  selected?:boolean;preview?:boolean;unresolved?:boolean;rise?:number;standard?:boolean;
  tieLayout?:TieLayout;halfTieStuds?:readonly number[];lite?:boolean;ramp?:boolean;trackGauge?:Gauge;rack?:boolean
}) {
  const center=planPath(points);
  if(trackGauge==='monorail') return <MonorailBeam points={points} selected={selected} preview={preview} unresolved={unresolved} printed={printed} lite={lite} rise={rise}/>;
  if(standard){
    const middle=connectorCentre(points,run),across=gaugeLayout(trackGauge);
    const outlines=across.narrowEnds?narrowConnectorOutlines:connectorOutlines;
    const bandPath=(band:readonly PlanPoint[],low:number,high:number)=>{
      const left=band.map(point=>portPoint(point,0,low));
      const right=band.map(point=>portPoint(point,0,high));
      return `${planPath([...left,...right.reverse()])} Z`;
    };
    const braceSpan=ramp?across.bodyWidth:across.braceSpan;
    return <g className={`builder-piece is-standard ${printed?'is-printed':'is-owned'} ${lite?'is-fast':''} ${selected?'is-selected':''} ${preview?'is-preview':''} ${unresolved?'is-unresolved':''}`}>
      <title>{printed?lite?'Printed · fast print':'Printed':'Owned'}</title>
      {lite ? braceBands(middle,run,tieLayout,ramp).map((band,index)=><path key={`brace-${index}`}
        d={bandPath(band,-braceSpan/2,braceSpan/2)} className="builder-piece-solid"/>) :
        tieBands(middle,run,tieLayout).map((band,index)=><path key={`tie-${index}`} d={bandPath(band,-across.bodyWidth/2,across.bodyWidth/2)} className="builder-piece-solid"/>)}
      {across.stringers.map(([low,high],index)=><path key={`stringer-${index}`} className="builder-piece-solid"
        d={bandPath(middle,low,high)}/>)}
      {connectorPorts(points).map((port,index)=><path key={index} className="builder-piece-solid" fillRule="evenodd"
        d={outlines[index].map(loop=>`${planPath(loop.map(([x,y])=>portPoint(port,x,y)))} Z`).join(' ')}/>)}
      {across.rails.map(rail=><path key={rail} className="builder-piece-rail" strokeWidth={BRICK_TRACK.railInterfaceWidth}
        d={planPath(middle.map(point=>portPoint(point,0,rail,BRICK_TRACK.railTop)))}/>)}
      {(lite?endStudPoses(points,halfTieStuds??across.studs):studPoses(points,run,tieLayout,halfTieStuds,across)).map((point,index)=><ellipse key={`stud-${index}`} className="builder-piece-rail" strokeWidth={0.65}
        cx={point.x} cy={point.y} rx={BRICK_TRACK.brickAttachment.studDiameter/2*Math.cos(point.pitch??0)}
        ry={BRICK_TRACK.brickAttachment.studDiameter/2} transform={`rotate(${point.heading*180/Math.PI} ${point.x} ${point.y})`}/>)}
      {/* Rack railway: the rack bar and its teeth on the centreline (brick gear-rack pitch). */}
      {rack&&<path d={planPath(middle)} className="builder-piece-rack" strokeWidth={6} strokeDasharray="1.6 1.6"><title>Rack</title></path>}
      {selected&&<path d={center} className="builder-piece-selection" strokeWidth={across.bodyWidth+15}/>}
      {rise!==undefined&&<text x={points[Math.floor(points.length/2)].x} y={points[Math.floor(points.length/2)].y-across.bodyWidth/2-15}
        className="builder-piece-rise" textAnchor="middle">{rise>0?'+':''}{rise} mm</text>}
    </g>;
  }
  const railPaths=[-1,1].map(side=>planPath(points.map(point=>({
    x:point.x-Math.sin(point.heading)*gauge*side/2,
    y:point.y+Math.cos(point.heading)*gauge*side/2
  }))));
  const count=Math.max(2,Math.round(run/22));
  const sleepers=Array.from({length:count-1},(_,index)=>points[Math.round((index+1)*(points.length-1)/count)]);
  return <g className={`builder-piece ${printed?'is-printed':'is-owned'} ${points.some(point=>point.z>0)?'is-elevated':''} ${selected?'is-selected':''} ${preview?'is-preview':''} ${unresolved?'is-unresolved':''}`}>
    <path d={center} className="builder-piece-bed" strokeWidth={width}/>
    {bridge&&<path d={center} className="builder-piece-deck" strokeWidth={Math.max(12,width-9)}/>}
    {sleepers.map((point,index)=><line key={index} className="builder-piece-tie"
      x1={point.x-Math.sin(point.heading)*(width-8)/2}
      y1={point.y+Math.cos(point.heading)*(width-8)/2}
      x2={point.x+Math.sin(point.heading)*(width-8)/2}
      y2={point.y-Math.cos(point.heading)*(width-8)/2}/>)}
    {railPaths.map((path,index)=><path key={index} d={path} className="builder-piece-rail" strokeWidth={railWidth}/>)}
    <path d={center} className="builder-piece-spine"/>
    {selected&&<path d={center} className="builder-piece-selection" strokeWidth={width+15}/>}
    {rise!==undefined&&<text x={points[Math.floor(points.length/2)].x} y={points[Math.floor(points.length/2)].y-width/2-15}
      className="builder-piece-rise" textAnchor="middle">{rise>0?'+':''}{rise} mm</text>}
  </g>;
}
/** `cuts`: stations where fit splits a composite piece into bed-sized parts; each part shows its own end connectors. */
const PieceVisual=memo(function PieceVisual({project,piece,paths:geometryPaths,cuts=NO_CUTS,selected=false,preview=false,showRiseLabel=true}:{
  project:WorkshopProject;piece:RoutePiece;paths?:readonly ShapePath[];cuts?:readonly number[];selected?:boolean;preview?:boolean;showRiseLabel?:boolean
}) {
  const lite=pieceIsFast(project,piece),definition=pieceDefinition(piece.family);
  const pointsRun=(points:readonly PlanPoint[])=>points.slice(1).reduce((sum,point,index)=>sum+Math.hypot(point.x-points[index].x,point.y-points[index].y),0);
  const pathRun=(path:ShapePath)=>pointsRun(path.points);
  if(definition.body==='path')return <g>{(geometryPaths??piecePaths(piece,project)).flatMap(path=>splitPath(path.points,cuts).map((points,index)=>
    <TrackVisual key={`${path.id}:${index}`} points={points}
      width={BRICK_TRACK.bodyWidth} gauge={BRICK_TRACK.railGauge} railWidth={BRICK_TRACK.railInterfaceWidth} run={pointsRun(points)}
      printed={definition.source==='printed'} standard selected={selected} preview={preview} lite={lite} trackGauge={path.gauge} rack={path.rack}/>))}</g>;
  if(definition.body==='assembly'){
    const paths=geometryPaths??piecePaths(piece,project);
    return <g className={`builder-assembly ${preview?'is-preview':''}`}>
    <title>{`${definition.label} · ${definition.source==='owned'?'Owned':lite?'Printed · fast print':'Printed'}`}</title>
    {definition.outline?.(piece,project).map((outline,index)=><polygon key={`outline-${index}`} className="builder-mechanism-body"
      points={outline.map(point=>placePoint(piece,{...point,z:0,heading:0})).map(point=>`${point.x},${point.y}`).join(' ')}/>)}
    {selected&&mechanismFootprints(piece,project).map((footprint,index)=><polygon key={`travel-${index}`}
      points={footprint.polygon.map(point=>`${point.x},${point.y}`).join(' ')}
      fill="#ffc18a" fillOpacity=".08" stroke="#ffc18a" strokeWidth="1" strokeDasharray="5 4" vectorEffect="non-scaling-stroke">
      <title>Selector travel</title></polygon>)}
    {definition.fixedTrack?.(piece,project).map((points,index)=>{const placed=points.map(point=>placePoint(piece,point));
      return <TrackVisual key={`fixed-${index}`} points={placed} width={BRICK_TRACK.bodyWidth} gauge={BRICK_TRACK.railGauge} railWidth={BRICK_TRACK.railInterfaceWidth}
        run={pointsRun(placed)} printed={definition.source==='printed'} standard selected={selected} preview={preview} lite={lite}/>;})}
    {physicalPaths(paths).map(path=><TrackVisual key={path.id} points={path.points}
      width={BRICK_TRACK.bodyWidth} gauge={BRICK_TRACK.railGauge} railWidth={BRICK_TRACK.railInterfaceWidth}
      run={pathRun(path)}
      printed={definition.source==='printed'} standard selected={selected} preview={preview}
      halfTieStuds={definition.flexEnds?BRICK_TRACK.brickAttachment.flexStudLateralOffsets:undefined} lite={lite} trackGauge={path.gauge}/>)}
    {/* A moving deck's other positions show only on the selected piece. */}
    {paths.filter(path=>!path.moving||path.enabled||selected).map(path=><path key={`${path.id}:state`} d={planPath(path.points)}
      className={`builder-path-state ${path.enabled?'is-enabled':'is-disabled'}`}><title>{path.enabled?'Active path':path.moving?'Other position':'Inactive path'}</title></path>)}
  </g>;
  }
  return <TrackVisual points={pieceSamples(project,piece)}
    width={(definition.deck && project.trackSystem==='custom-joiner-v1' ?
      project.partDesign.deck_width : railDimension(project,'railBodyWidth'))??60}
    gauge={railDimension(project,'railGauge')??37.5}
    railWidth={railDimension(project,'railInterfaceWidth')??4}
    run={definition.run(piece,project)} printed={definition.source==='printed'}
    bridge={definition.deck}
    standard={project.trackSystem==='brick-v1'}
    tieLayout={piece.sweep===undefined?'modular':curveTieLayout(definition.radius!,piece.sweep)}
    rise={showRiseLabel&&definition.legacy?.rise!==undefined?piece.rise??0:undefined}
    selected={selected} preview={preview} lite={lite} ramp={definition.legacy?.rise!==undefined}/>;
});

/** A palette tile picture: the piece's drawn extent (track beds around its centrelines plus any mechanism outline) fitted into the tile's box with a small margin. */
const TilePreview=memo(function TilePreview({project,piece}:{project:WorkshopProject;piece:RoutePiece}) {
  const definition=pieceDefinition(piece.family),half=BRICK_TRACK.bodyWidth/2,margin=6;
  const track=[...pieceSamples(project,piece),...(definition.fixedTrack?.(piece,project).flat().map(point=>placePoint(piece,point))??[])];
  const outline=definition.outline?.(piece,project).flat().map(point=>placePoint(piece,{...point,z:0,heading:0}))??[];
  const xs=[...track.flatMap(point=>[point.x-half,point.x+half]),...outline.map(point=>point.x)];
  // A ramp's grade line runs just outside its bed.
  const ys=[...track.flatMap(point=>[point.y-half,point.y+half]),...outline.map(point=>point.y),...(definition.legacy?.rise!==undefined?[66]:[])];
  const x0=Math.min(...xs)-margin,y0=Math.min(...ys)-margin,width=Math.max(...xs)-x0+margin,height=Math.max(...ys)-y0+margin;
  return <svg className="builder-tile-preview" viewBox={project.trackSystem==='brick-v1'?`${x0} ${y0} ${width} ${height}`:'-24 -67 252 148'} aria-hidden="true">
    <PieceVisual project={project} piece={piece} showRiseLabel={false}/>
    {definition.legacy?.rise!==undefined&&<path className="builder-tile-grade" d="M 0 66 C 66 66 134 58 200 58"/>}
    {definition.deck&&project.trackSystem==='custom-joiner-v1'&&<path className="builder-tile-girder" d="M 0 68 H 160"/>}
  </svg>;
});

function FurnitureVisual({ item, selected = false, preview = false }: {
  item: Furniture; selected?: boolean; preview?: boolean;
}) {
  const { width, depth, plan, placeholder } = furnitureType(item.family);
  return <g className={`builder-furniture ${selected ? 'selected' : ''} ${preview ? 'preview' : ''}${placeholder ? ' placeholder' : ''}`}
    transform={`translate(${item.x} ${item.y}) rotate(${item.quarterTurns * 90})`}>
    <rect x={-width / 2} y={-depth / 2} width={width} height={depth}/>
    {plan.lines.map(({ a, b }, index) => <line key={index + 1} x1={a.x} x2={b.x} y1={a.y} y2={b.y}/>)}
    <text x="0" y="6" textAnchor="middle">{plan.caption}</text>
  </g>;
}

function layoutViewport(project:WorkshopProject):Viewport {
  let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
  const include=(point:{x:number;y:number})=>{
    x0=Math.min(x0,point.x);x1=Math.max(x1,point.x);
    y0=Math.min(y0,point.y);y1=Math.max(y1,point.y);
  };
  for(const route of project.routes)for(const piece of route.pieces)for(const point of pieceSamples(project,piece))include(point);
  if(x0===Infinity)return {x:-100,y:-100,width:(project.measurements.roomWidth.value??2400)+200,
    height:(project.measurements.roomDepth.value??2100)+200};
  const width=Math.max(720,x1-x0+280),height=Math.max(576,y1-y0+260);
  return {x:(x0+x1-width)/2,y:(y0+y1-height)/2,width,height};
}

/** Project changes stay in the parent; local history contains only edits made in this view. */
export function RouteEditor({project,fit,account,onChange,onOpenSetup,inventoryCue,startDismissed,onDismissStart}:{project:WorkshopProject;fit:FitResult;
  /** Visitor or member: the shopping list needs the service; Describe track needs a verified member. */
  account:Account;onChange:(project:WorkshopProject)=>void;
  /** Opens Setup at the owned-track counts, or at `target`. */
  onOpenSetup:(target?:'track'|'car'|'roomWidth')=>void;
  /** Owned counts are still the new-project default and Setup has never been opened. */
  inventoryCue:boolean;
  /** The user chose Build by hand on this project's start screen: it does not come back. */
  startDismissed:boolean;onDismissStart:()=>void}) {
  const [selected,setSelected]=useState<string|null>(null);
  const [selectedFurnitureId,setSelectedFurnitureId]=useState<string|null>(null);
  /** A printed family, or `kind:<id>` for a track kind tile. */
  const [armed,setArmed]=useState<TileFamily|null>(null);
  /** Per palette tile (its printed family, kind key or kit key): the user's Own / Print / Fast pick sticks until changed. */
  const [sources,setSources]=useState<Record<string,PieceSource>>({});
  /** Per palette tile with a drive setting (its printed family): how the next one placed is worked, until changed. */
  const [drives,setDrives]=useState<Record<string,number>>({});
  /** The tile's drive pick as a parameter of the piece it places. */
  const driveParams=(family:TileFamily):Record<string,number>|undefined=>{
    const spec=driveSpec(pieceDefinition(family)),value=drives[family];
    return spec&&value!==undefined&&value!==spec.default?{[spec.key]:value}:undefined;
  };
  /** How new prints come out on tiles without their own Print / Fast pick. */
  const [defaultStyle,setDefaultStyle]=useState<'printed'|'fast'>('printed');
  /** Each kind tile's chosen shape (hand positive; Curve left/right sets it on placement). */
  const [kindValues,setKindValues]=useState<Record<string,Record<string,number>>>(()=>Object.fromEntries(TRACK_KINDS.map(kind=>[kind.id,kind.initial])));
  const [armedFurniture,setArmedFurniture]=useState(false);
  /** Siding-ladder kit settings; the kit arms as `LADDER_KEY`. */
  const [ladderValues,setLadderValues]=useState<Record<string,number>>(LADDER_INITIAL);
  /** Triple-crossover kit settings; the kit arms as `TRIPLE_KEY`. */
  const [tripleValues,setTripleValues]=useState(TRIPLE_INITIAL);
  /** 'Go up or down' settings (the height to reach and the steepest grade; it arms as `CLIMB_FAMILY`) and the flyover kit's (as `FLYOVER_KEY`). */
  const [climbValues,setClimbValues]=useState(CLIMB_INITIAL);
  const [flyoverValues,setFlyoverValues]=useState(FLYOVER_INITIAL);
  /** Helix and wall/shelf-run kit settings; they arm as `HELIX_KEY` / `WALL_RUN_KEY`. */
  const [helixValues,setHelixValues]=useState(HELIX_INITIAL);
  const [wallRunValues,setWallRunValues]=useState(WALL_RUN_INITIAL);
  const [furnitureRotation,setFurnitureRotation]=useState<Furniture['quarterTurns']>(0);
  /** The furniture family the armed Furniture tile places. */
  const [furnitureFamily,setFurnitureFamily]=useState('kallax_5x5');
  const [furnitureError,setFurnitureError]=useState('');
  const [ghost,setGhost]=useState<CanvasPoint|null>(null);
  const [view,setView]=useState<'top'|'3d'>('top');
  const [paletteCollapsed,setPaletteCollapsed]=useState(false);
  const [summaryCollapsed,setSummaryCollapsed]=useState(false);
  const [orientation,setOrientation]=useState(0);
  const [bend,setBend]=useState<1|-1>(1);
  const [riseDirection,setRiseDirection]=useState<1|-1>(1);
  /** The armed parametric shape is laid mirrored, its parameters flipped (F / Flip on the piece controls). */
  const [mirrored,setMirrored]=useState(false);
  /** The joint the ghost is locked to, the variant the pointer points at and what F/Tab chose, from the last pointer move. */
  const selectionRef=useRef<{selection:Selection;revision:string;family:string|null}>({selection:NO_SELECTION,revision:'',family:null});
  /** F and Tab change the selection's intent in `selectionRef`; this re-renders with it. */
  const [,setChoiceTick]=useState(0);
  /** The Keyboard shortcuts sheet (? or the ? button) is open. */
  const [shortcutsOpen,setShortcutsOpen]=useState(false);
  /** The one-time first-placement tip ('R rotates · F flips · …') was dismissed in this browser. */
  const [tipSeen,setTipSeen]=useState(()=>{try{return localStorage.getItem(PLACEMENT_TIP_KEY)!==null;}catch{return true;}});
  const tipWasShown=useRef(false);
  /** Where the armed ghost followed the pointer lately: on the placement bar the ghost goes back to where the pointer rested. */
  const ghostTrail=useRef<PointerSample[]>([]);
  /** Where on screen the pointer was when it last moved the ghost (client px). */
  const ghostClient=useRef<{x:number;y:number}|null>(null);
  /** Ends an insert pulled apart, while that insert is the current project: offered to Close gap. */
  const [insertGaps,setInsertGaps]=useState<{revision:string;gaps:OpenedGap[]}|null>(null);
  const [panMode,setPanMode]=useState(false);
  /** The top view: programmatic changes ease (`animateTo`), the wheel and drag-pan act at once. */
  const {viewport,setViewport,animateTo,target:viewTarget}=useViewMotion(()=>layoutViewport(project));
  /** The user zoomed by hand since the last fit: auto-widen then only pans. */
  const manualZoom=useRef(false);
  /** The piece just laid by hand: auto-widen follows its open end while it stays selected. */
  const [placedId,setPlacedId]=useState<string|null>(null);
  const [history,setHistory]=useState<WorkshopProject[]>([]);
  // A slider drag previews locally and commits once on release.
  const [draft,setDraft]=useState<WorkshopProject|null>(null);
  const [sceneDrag,setSceneDrag]=useState<{kind:'track'|'furniture';id:string;origin:CanvasPoint}|null>(null);
  const [dragging,setDragging]=useState<
    {kind:'tile';id:TileFamily;startX:number;startY:number} |
    {kind:'furniture-tile';startX:number;startY:number} |
    {kind:'furniture';id:string;startX:number;startY:number;grab:CanvasPoint;origin:CanvasPoint} |
    {kind:'piece';id:string;startX:number;startY:number;grab:CanvasPoint;origin:CanvasPoint} | null>(null);
  const svg=useRef<SVGSVGElement>(null);
  const loadedProjectId=useRef(project.id);
  const sceneRef=useRef<BuilderSceneHandle>(null);
  const pan=useRef<{x:number;y:number;view:Viewport}|null>(null);
  const panJustFinished=useRef(false);
  /** Fingers down on the top view's table, and the two-finger gesture they make. */
  const touches=useRef(new Map<number,CanvasPoint>());
  const pinch=useRef<{view:Viewport;scale:{a:number;d:number};anchor:CanvasPoint;from:[CanvasPoint,CanvasPoint]}|null>(null);
  const spaceHeld=useRef(false);
  const tileJustDropped=useRef(false);
  const tileWasArmed=useRef(false);
  const keyHandler=useRef<(event:KeyboardEvent)=>void>(()=>{});
  const shown=draft??project;
  const geometry=useMemo(()=>shown.routes.flatMap(route=>route.pieces.map(piece=>{
    const paths=piecePaths(piece,shown);
    return {piece,paths,ports:portsFromPaths(paths),hitPath:paths.map(path=>planPath(path.points)).join(' ')};
  })),[shown]);
  /** How high the track goes: the plan tints raised track on a 0 → `heightTop` scale and marks heights at ends and slopes. */
  const heightTop=useMemo(()=>geometry.reduce((top,{paths})=>paths.reduce((high,path)=>path.points.reduce((most,point)=>Math.max(most,point.z),high),top),0),[geometry]);
  const heightTints=useMemo(()=>geometry.flatMap(({piece,paths})=>paths.flatMap(path=>path.points.slice(1).flatMap((point,index)=>{
    const from=path.points[index],tint=heightTint((from.z+point.z)/2,heightTop);
    return tint?[{key:`${piece.id}:${path.id}:${index}`,from,to:point,...tint}]:[];
  }))),[geometry,heightTop]);
  const marks=useMemo(()=>heightMarks(shown),[shown]);
  const snapPorts=useMemo(()=>unoccupiedPiecePorts(project),[project]);
  /** Bed-part cuts of each composite piece, for the committed layout only (a draft has not been fitted). */
  const partCuts=useMemo(()=>new Map(project.routes.flatMap(route=>route.pieces).map(piece=>[piece.id,partStations(fit.partInstances,piece.id)] as const)),[project,fit]);
  const openPorts=useMemo(()=>draft?unoccupiedPiecePorts(draft):snapPorts,[draft,snapPorts]);
  const current=geometry.find(({piece})=>piece.id===selected)?.piece;
  const committedPiece=project.routes.flatMap(route=>route.pieces).find(piece=>piece.id===selected);
  /** A selected piece turns on its own only about the one joint holding it; inside a chain this says why not. */
  const selectedRotation=committedPiece&&!armed?pieceRotation(project,committedPiece.id):null;
  const rotateBlocked=selectedRotation&&'reason' in selectedRotation?selectedRotation.reason:'';
  const selectedFurniture=project.furniture.find(item=>item.id===selectedFurnitureId);
  const roomWidth=project.measurements.roomWidth.value??2400;
  const roomDepth=project.measurements.roomDepth.value??2100;
  const roomMeasured=[project.measurements.roomWidth,project.measurements.roomDepth].every(item=>item.value!==null&&item.status!=='estimate');
  const pieces=project.routes.flatMap(route=>route.pieces);
  const ownedUse=OWNED_DEFINITIONS.map(({family})=>{
    const used=pieces.filter(piece=>piece.family===family).length,owned=project.inventory[family]??0;
    return {family,used,owned,left:Math.max(0,owned-used)};
  });
  const ownedUsed=ownedUse.reduce((sum,use)=>sum+use.used,0),ownedStock=ownedUse.reduce((sum,use)=>sum+use.owned,0);
  const ownedShort=ownedUse.some(use=>use.used>use.owned);
  const printedCount=pieces.length-ownedUsed;
  const printedStyles=styleCounts(project);
  const fastAvailable=project.trackSystem==='brick-v1';
  const checks=useMemo(()=>buildChecks(project,fit),[project,fit]);
  /** The check whose targets the views frame and outline, while it lasts (a fix that clears it clears this too). */
  const [checkId,setCheckId]=useState<string|null>(null);
  const check=checks.find(item=>item.id===checkId)??null;
  const highlighted=useMemo(()=>new Set(check?.targets.pieceIds),[check]);
  const ownedLeft=(family:string)=>ownedUse.find(use=>use.family===family)!.left;
  /** Unless the user picked a source, an official shape uses owned pieces while any remain; prints follow the default style. */
  const sourceOf=(tile:PieceDefinition):PieceSource=>tile.owned&&!tileFits(project,tile.family)?'owned':
    tileSource({pick:sources[tile.family],defaultStyle,fast:fastAvailable&&tile.styles.includes('fast'),ownedLeft:tile.owned&&ownedLeft(tile.owned.family)});
  /** A kind tile's owned and printed shapes for its chosen values, turning the way Curve left/right says. */
  const kindShapes=(kind:TrackKind,values=kindValues[kind.id])=>{
    const handed=kind.hand?{...values,[kind.hand]:bend*Math.abs(values[kind.hand])}:values;
    const owned=kind.shape(handed,'owned'),printed=kind.shape(handed,'printed',!fastAvailable);
    return {owned:owned&&tileFits(project,owned.family)?owned:null,printed:printed&&tileFits(project,printed.family)?printed:null};
  };
  /** Like `sourceOf`: owned track while any remain where an official piece has the shape, otherwise printed. */
  const kindSource=(kind:TrackKind):PieceSource=>{
    const {owned,printed}=kindShapes(kind);
    return printed?tileSource({pick:sources[kindKey(kind)],defaultStyle,fast:fastAvailable,ownedLeft:owned?ownedLeft(owned.family):undefined}):'owned';
  };
  const kindShape=(kind:TrackKind)=>{const shapes=kindShapes(kind);return kindSource(kind)==='owned'?shapes.owned:shapes.printed;};
  const armedKind=TRACK_KINDS.find(kind=>armed===kindKey(kind));
  const armedShape=armedKind?kindShape(armedKind):null;
  const armedTile=armed===null||armedKind?undefined:paletteDefinitions().find(tile=>tile.family===armed||tile.owned?.family===armed);
  const armedLadder=armed===LADDER_KEY,armedTriple=armed===TRIPLE_KEY,armedFlyover=armed===FLYOVER_KEY,
    armedHelix=armed===HELIX_KEY,armedWallRun=armed===WALL_RUN_KEY;
  /** A multi-piece kit (not a single piece family) is armed. */
  const armedKit=armedLadder||armedTriple||armedFlyover||armedHelix||armedWallRun;
  const armedFamily=armedKit?null:armedKind?armedShape?.family??null:armedTile?(sourceOf(armedTile)==='owned'?armedTile.owned!.family:armedTile.family):armed;
  const armedDefinition=armedFamily===null?undefined:pieceDefinition(armedFamily);
  const armedFast=armedKind?kindSource(armedKind)==='fast':armedTile!==undefined&&sourceOf(armedTile)==='fast';
  const commit=(next:WorkshopProject,id?:string|null)=>{
    if(next===project) return;
    setHistory(prior=>[...prior.slice(-29),project]);onChange(next);
    if(id!==undefined)setSelected(id);
  };
  const gap=useGapCloser(project);
  const startShown=startScreenShown(project,startDismissed);
  const assist=usePlanAssist(project);
  /** Describe track's result, ghosted: the pieces and shelves it would add; a fresh start fades the track it replaces. */
  const assistPieces=useMemo(()=>{
    if(!assist.preview)return [];
    const ids=new Set(project.routes.flatMap(route=>route.pieces).map(piece=>piece.id));
    return assist.preview.project.routes.flatMap(route=>route.pieces).filter(piece=>!ids.has(piece.id));
  },[assist.preview,project]);
  const assistFurniture=assist.preview?assist.preview.project.furniture.filter(item=>!project.furniture.some(other=>other.id===item.id)):[];
  const replacing=assist.preview!==null&&assist.mode==='fresh';
  const commitDraft=()=>{if(draft)commit(draft);};
  /** Start screen: Build by hand opens Pieces at its search; an example lands as one undoable change, framed. */
  const buildByHand=()=>{onDismissStart();setPaletteCollapsed(false);requestAnimationFrame(()=>document.querySelector<HTMLInputElement>('.builder-palette-search')?.focus());};
  const pickExample=(next:WorkshopProject)=>{commit(next,null);manualZoom.current=false;animateTo(layoutViewport(next));};
  const describeLayout=(text:string)=>{setArmed(null);setArmedFurniture(false);setSelected(null);gap.cancel();assist.describe(text);};
  const undo=()=>{
    const previous=history.at(-1);
    if(previous){setHistory(history.slice(0,-1));onChange(previous);setSelected(null);setSelectedFurnitureId(null);}
  };
  useEffect(()=>setDraft(null),[project]);
  useEffect(()=>{
    if(loadedProjectId.current===project.id)return;
    loadedProjectId.current=project.id;
    setViewport(layoutViewport(project));manualZoom.current=false;setHistory([]);setSelected(null);setSelectedFurnitureId(null);
    setArmed(null);setArmedFurniture(false);setGhost(null);setFurnitureError('');setSources({});
  },[project.id,project]);
  const turnShelf=()=>{
    if(!selectedFurnitureId)return;
    try{commit(rotateFurniture(project,selectedFurnitureId));setFurnitureError('');}
    catch(error){setFurnitureError((error as Error).message);}
  };
  /** R turns the ghost, or the selected piece on its own (never silently the whole route: that is Rotate route); ⇧R turns back. */
  const rotate=(direction:1|-1=1)=>{
    if(armed)setOrientation(angle=>angle+direction*Math.PI/8);
    else if(armedFurniture)setFurnitureRotation(value=>nextOrientation(furnitureFamily,value,direction));
    else if(selectedFurniture)turnShelf();
    else if(committedPiece&&!rotateBlocked)commit(rotatePiece(project,committedPiece.id,direction*Math.PI/8));
  };
  const flipSelected=()=>{if(committedPiece&&canFlipPiece(committedPiece))commit(flipPiece(project,committedPiece.id));};
  /** What F changes on the armed piece: a curve's (or kind's) hand, a ramp's direction, or a mirrored family or shape. */
  const ghostFlip=armedKind?(armedKind.hand?'bend':armedDefinition?.flip?'mirror':null):armedDefinition?.legacy?.sweep!==undefined?'bend':
    armedDefinition?.legacy?.rise!==undefined?'rise':armedDefinition&&(armedDefinition.mirror||armedDefinition.flip)?'mirror':null;
  const flipGhost=()=>{
    if(ghostFlip==='bend')setBend(value=>value===1?-1:1);
    else if(ghostFlip==='rise')setRiseDirection(value=>value===1?-1:1);
    // A family with a mirror twin (left ↔ right turnout) arms that twin's tile, so the palette and its options follow.
    else if(ghostFlip==='mirror'&&!armedKind&&armed&&armedDefinition?.mirror)setArmed(pieceDefinition(armed).mirror??armed);
    else if(ghostFlip==='mirror')setMirrored(value=>!value);
  };
  /** The piece panel beside the Pieces sidebar: Options… on the placement bar moves the keyboard into it. */
  const panelRef=useRef<HTMLElement>(null);
  const focusPanel=()=>panelRef.current?.querySelector<HTMLElement>('button:not(.builder-flyout-close),select,input,summary')?.focus();
  const removeSelection=()=>{
    if(selectedFurniture){commit(removeFurniture(project,selectedFurniture.id));setSelectedFurnitureId(null);}
    else if(current)commit(removePiece(project,current.id),null);
  };
  /** Esc and the placement bar's Done: stop placing, and clear the selection, the framed check and Close gap. */
  const escape=()=>{setArmed(null);setArmedFurniture(false);setGhost(null);setFurnitureError('');setSelected(null);setSelectedFurnitureId(null);setCheckId(null);gap.cancel();};
  /** Build's keys, as the shortcuts table names them (the same table lists them in the Keyboard shortcuts sheet). */
  keyHandler.current=event=>{
    if((event.target instanceof HTMLElement)&&(/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)||event.target.isContentEditable))return;
    if(event.code==='Space'){spaceHeld.current=true;if(document.activeElement===svg.current)event.preventDefault();}
    const id=shortcutFor(event);
    // The sheet is modal: Esc or ? closes it and other keys wait.
    if(shortcutsOpen){if(id==='escape'||id==='help'){event.preventDefault();setShortcutsOpen(false);}return;}
    switch(id){
      case 'undo':event.preventDefault();undo();break;
      case 'rotate':case 'rotate-back':event.preventDefault();rotate(id==='rotate'?1:-1);break;
      case 'flip':
        if(armedFamily&&(ghostFlip||variant&&otherHand(variants,variant))){event.preventDefault();flipArmed();}
        else if(!armed&&committedPiece&&canFlipPiece(committedPiece)){event.preventDefault();flipSelected();}
        break;
      case 'attach-next':case 'attach-back':if(variant&&facingList.length>1){event.preventDefault();turnFacing(id==='attach-next'?1:-1);}break;
      case 'escape':escape();break;
      case 'delete':if(selectedFurniture||current){event.preventDefault();removeSelection();}break;
      case 'help':event.preventDefault();setShortcutsOpen(true);break;
    }
  };
  // Selecting a check (or switching views with one selected) frames its targets, no closer than a few pieces.
  useEffect(()=>{
    const bounds=check&&targetBounds(project,fit,check.targets);
    if(!bounds)return;
    if(view==='3d'){sceneRef.current?.frameBounds(bounds);return;}
    const width=Math.max(720,bounds.max.x-bounds.min.x+300),height=Math.max(576,bounds.max.y-bounds.min.y+300);
    animateTo({x:(bounds.min.x+bounds.max.x-width)/2,y:(bounds.min.y+bounds.max.y-height)/2,width,height});
  },[checkId,view]);
  useEffect(() => {
    const keyDown=(event:KeyboardEvent)=>keyHandler.current(event);
    const keyUp=(event:KeyboardEvent)=>{if(event.code==='Space')spaceHeld.current=false;};
    window.addEventListener('keydown',keyDown);window.addEventListener('keyup',keyUp);
    return ()=>{window.removeEventListener('keydown',keyDown);window.removeEventListener('keyup',keyUp);};
  },[]);
  /** The view `factor` times wider (in when below 1) round `anchor`, within 300 mm and the room plus 200 mm a side. */
  const zoomedView=(before:Viewport,factor:number,anchor={x:before.x+before.width/2,y:before.y+before.height/2}):Viewport=>{
    const width=Math.max(300,Math.min(roomWidth+400,before.width*factor));
    const height=Math.max(300,Math.min(roomDepth+400,before.height*factor));
    return {x:anchor.x-(anchor.x-before.x)*width/before.width,
      y:anchor.y-(anchor.y-before.y)*height/before.height,width,height};
  };
  /** A manual zoom: the wheel acts at once round the pointer, the buttons ease round the centre. */
  const zoom=(factor:number,point?:CanvasPoint)=>{
    manualZoom.current=true;
    if(view==='3d'){sceneRef.current?.zoom(factor);return;}
    if(point)setViewport(before=>zoomedView(before,factor,point));
    else animateTo(zoomedView(viewTarget(),factor));
  };
  const fitTrack=()=>{manualZoom.current=false;if(view==='top')animateTo(layoutViewport(project));else sceneRef.current?.frame('track');setGhost(null);};
  const fitRoom=()=>{manualZoom.current=false;if(view==='top')animateTo({x:-100,y:-100,width:roomWidth+200,height:roomDepth+200});else sceneRef.current?.frame('room');setGhost(null);};
  /** Millimetres per screen pixel at the middle of the view. */
  const mmPerPx=()=>{
    if(view==='top')return 1/(svg.current?.getScreenCTM()?.a||1);
    const rect=document.querySelector('.builder-scene')?.getBoundingClientRect();
    if(!rect)return 90/70;
    const first=sceneRef.current?.projectPointer(rect.left+rect.width/2,rect.top+rect.height/2);
    const second=sceneRef.current?.projectPointer(rect.left+rect.width/2+70,rect.top+rect.height/2);
    return first&&second?Math.hypot(first.x-second.x,first.y-second.y)/70:90/70;
  };
  /** About 70 screen pixels, kept between 30 and 130 mm. */
  const snapRadius=()=>Math.max(30,Math.min(130,70*mmPerPx()));
  /** 'Go up or down' laid from an end at height `z` (mm): its rise reaches the height picked. */
  const climbParams=(z:number)=>({rise:Math.max(-1000,Math.min(1000,Math.round((climbValues.target-z)*100)/100)),grade:climbValues.grade});
  /** The armed piece at `pos`; `startZ` is the height of the joint it is laid from (a climb's rise depends on it). */
  const candidatePlacement=(family:TileFamily,pos:CanvasPoint,startZ=0):Placement=>{
    const definition=pieceDefinition(family);
    // Mirrored shapes without a mirror family flip their parameters (a radius turnout's hand).
    const shapeParams=(params?:Record<string,number>)=>ghostFlip==='mirror'&&mirrored&&definition.flip&&!definition.mirror?definition.flip(params??{}):params;
    if(armedShape&&armedShape.family===family){
      const params=shapeParams(armedShape.params);
      return {...pos,heading:orientation,...(armedShape.sweep!==undefined?{sweep:armedShape.sweep}:{}),
        ...(params?{params}:{}),...(armedFast?{style:'fast' as const}:{})};
    }
    const own=family===CLIMB_FAMILY?climbParams(startZ):driveParams(family);
    const legacy=definition.legacy??{},params=shapeParams(own);
    return {...pos,heading:orientation,...(legacy.sweep!==undefined?{sweep:bend*legacy.sweep}:{}),
      ...(legacy.rise!==undefined?{rise:riseDirection*8}:{}),...(params?{params}:{}),...(armedFast?{style:'fast' as const}:{})};
  };
  const ghostPlacement=armedFamily&&ghost?candidatePlacement(armedFamily,ghost):null;
  /** Flyovers cross track anywhere; every other kit starts on an open end. */
  const kitLocks=armedKit&&!armedFlyover;
  /**
   * The ghost locks to the joint it reaches (an open end, or a joint inside a route to insert at) and keeps it while the pointer
   * stays near; a new project, piece or tile starts afresh, keeping only what F and Tab chose.
   */
  const lockFamily=armedFamily??(kitLocks?KIT_GAUGE_FAMILY:null);
  const priorState=selectionRef.current;
  const prior:Selection=priorState.revision===project.revision&&priorState.family===lockFamily?priorState.selection:{...NO_SELECTION,intent:priorState.selection.intent};
  const scale=ghost&&lockFamily?mmPerPx():1;
  const lock=ghost&&lockFamily?stepLock(prior.lock,()=>findJoint(project,lockFamily,ghostPlacement??ghost,snapRadius(),INSERT_RADIUS,!armedFamily,snapPorts),ghost,scale):null;
  /** The shape the armed piece has (without where it is), so the variants at a joint are worked out once per joint. */
  const shapeKey=armedFamily&&ghost?JSON.stringify([armedFamily,{...candidatePlacement(armedFamily,{x:0,y:0},lock?.point.z),x:0,y:0}]):'';
  const variants=useMemo(()=>{
    if(!lock||!shapeKey||lock.kind==='end'&&!armedFamily)return [];
    const [family,shape]=JSON.parse(shapeKey) as [TileFamily,Placement];
    try{return jointVariants(project,family,shape,lock);}catch{return [];}
  },[lock?.key,shapeKey,project]);
  const selection=lock&&ghost?stepSelection(prior,lock,variants,ghost,scale):{...prior,lock:null,pick:null,basis:null};
  useLayoutEffect(()=>{selectionRef.current={selection,revision:project.revision,family:lockFamily};});
  /** The variant chosen at the locked joint (pointing, F and Tab act on these). */
  const variant=armedFamily&&lock?activeVariant(selection,variants):undefined;
  const facingList=facings(variants);
  /** Where it would move track or open a gap, the same way of laying it fits cleanly at a joint nearby along the route. */
  const landings=useMemo(()=>{
    // Moving the track on was chosen (Tab): it stays where it is.
    if(!variant||!lock||fitsCleanly(variant)||variant.fill==='shift'||!shapeKey)return [];
    const [family,shape]=JSON.parse(shapeKey) as [TileFamily,Placement];
    try{return cleanLandings(project,family,shape,lock,intentOf(variant));}catch{return [];}
  },[lock?.key,variant?.key,shapeKey,project]);
  const priorLanding=useRef<string|undefined>(undefined);
  const landing=ghost?nearestLanding(landings,ghost,priorLanding.current):undefined;
  useLayoutEffect(()=>{priorLanding.current=landing?.lock.key;});
  /** The variant shown and laid: at the clean joint nearby when there is one. */
  const shownVariant=landing?.variant??variant;
  /** The family and hand the ghost shows, which the palette follows. */
  const shownFamily=shownVariant?.family??armedFamily,shownMirrored=mirrored!==(shownVariant?.hand==='mirror');
  /** Off any joint the ghost floats free where the pointer is. */
  const preview=shownVariant?shownVariant.snap??null:ghostPlacement?previewPiece(project,armedFamily!,ghostPlacement,-1):null;
  const insertPlan=shownVariant?.insert??null;
  /** F or Tab picked `target` at this joint: it becomes the intent, here and at the next joint. */
  const chooseVariant=(target:JointVariant|undefined)=>{
    if(!target)return;
    selectionRef.current={...selectionRef.current,selection:choose(selectionRef.current.selection,target)};
    setChoiceTick(tick=>tick+1);
  };
  /** F while placing: the other hand at a locked joint, else the armed piece's own flip. */
  const flipArmed=()=>{const other=variant&&otherHand(variants,variant);if(other)chooseVariant(other);else flipGhost();};
  /** Tab / ⇧Tab at a locked joint: the piece faces the next way round. */
  const turnFacing=(step:1|-1)=>{if(variant)chooseVariant(otherFacing(variants,variant,step));};
  /** Laying a variant leaves the tile armed as laid (so the palette and the next ghost match it) and makes it the intent at the next joint. */
  const keepHand=(laid:JointVariant|undefined)=>{
    if(!laid)return;
    selectionRef.current={...selectionRef.current,selection:choose(selectionRef.current.selection,laid)};
    if(laid.hand==='mirror')flipGhost();
  };
  /** Where a kit goes: the locked open end, else the pointer. */
  const kitAt=(pos:CanvasPoint)=>lock&&kitLocks?{x:lock.point.x,y:lock.point.y}:pos;
  /** Each kit keeps its own Print / Fast pick, like a palette tile. */
  const kitFast=(key:string)=>tileSource({pick:sources[key],defaultStyle,fast:fastAvailable})==='fast';
  const ladderFast=kitFast(LADDER_KEY);
  const ladderKit=useLadderKit(project,ladderValues,ladderFast);
  const ladder=armedLadder?ladderKit.options:null;
  const tripleOptions={...tripleValues,...(kitFast(TRIPLE_KEY)?{style:'fast' as const}:{})};
  const elevationStyle=kitFast(FLYOVER_KEY)?{style:'fast' as const}:{};
  const elevationKit=armedFlyover&&ghost?previewFlyover(project,{...ghost,heading:orientation},{...flyoverValues,...elevationStyle},snapRadius()):null;
  /** The armed climb's ghost: where it starts, its length, whether it stays in the room and the furniture surface ahead of it. */
  const armedClimb=armedFamily===CLIMB_FAMILY,climbPiece=armedClimb&&preview?preview.piece:null;
  /** It climbs from the open end it meets, out along that end; on the table from its own start. */
  const climbStart=preview?.target??climbPiece;
  const climbPlan=climbPiece&&planRamp(climbPiece.params?.rise??0,climbValues.grade/100);
  const climbLead=climbPiece?climbLevel(climbPiece.params?.lead??0):0;
  const climbHover=climbPiece&&climbStart?{start:climbStart,plan:climbPlan||null,lead:climbLead,
    fit:climbPlan?climbFit(project,climbStart,[climbPiece],pieceDefinition(CLIMB_FAMILY).run(climbPiece,project)):null,
    ahead:surfaceAhead(project,climbStart,climbValues.grade,climbLead),problem:pieceDefinition(CLIMB_FAMILY).problem?.(climbPiece)??''}:null;
  /** While a climb is armed, the 3D view says how high each open end is (where a climb would start). */
  const climbArmed=armedClimb||armedFlyover||armedHelix||armedWallRun;
  const climbLabels=useMemo(()=>climbArmed?openPorts.map(({port})=>({x:port.x,y:port.y,z:port.z,text:heightText(port.z)})):undefined,[climbArmed,openPorts]);
  const helixOptions={...helixValues,...(kitFast(HELIX_KEY)?{style:'fast' as const}:{})};
  const wallRunOptions={...wallRunValues,...(kitFast(WALL_RUN_KEY)?{style:'fast' as const}:{})};
  const helixKit=armedHelix&&ghost?previewHelix(project,{...kitAt(ghost),heading:orientation},helixOptions,snapRadius()):null;
  const wallRunKit=armedWallRun&&ghost?previewWallRun(project,{...kitAt(ghost),heading:orientation},wallRunOptions,snapRadius()):null;
  const kitGhost=ladder&&ghost?previewLadder(project,{...kitAt(ghost),heading:orientation},ladder,snapRadius()):
    armedTriple&&ghost?previewTriple(project,{...kitAt(ghost),heading:orientation},tripleOptions,snapRadius()):
    helixKit??wallRunKit??elevationKit?.pieces??null;
  // Keep the same grab point under the pointer instead of snapping the piece origin to it.
  const dragOrigin=(drag:{origin:CanvasPoint;grab:CanvasPoint},release:CanvasPoint)=>({x:drag.origin.x+release.x-drag.grab.x,y:drag.origin.y+release.y-drag.grab.y});
  const moving=view==='top'?(dragging?.kind==='piece'&&ghost?{id:dragging.id,origin:dragOrigin(dragging,ghost)}:null):
    sceneDrag?.kind==='track'?sceneDrag:null;
  const movePreview=moving&&project.routes.some(route=>route.pieces.some(piece=>piece.id===moving.id))?
    previewRouteMove(project,moving.id,moving.origin.x,moving.origin.y,snapRadius()):null;
  const armedOutline=furnitureFootprint(furnitureFamily,furnitureRotation);
  const canPlaceFurniture=roomWidth>=armedOutline.width&&roomDepth>=armedOutline.depth;
  const ghostFurniture: Furniture|null=armedFurniture&&ghost&&canPlaceFurniture?
    {id:'preview',family:furnitureFamily,...furniturePosition(project,ghost,furnitureRotation,furnitureFamily),quarterTurns:furnitureRotation}:null;
  const sceneFurniture=sceneDrag?.kind==='furniture'?project.furniture.find(item=>item.id===sceneDrag.id):undefined;
  let movedFurniture:Furniture|null=null;
  if(sceneFurniture&&sceneDrag)try{movedFurniture={...sceneFurniture,...furniturePosition(project,sceneDrag.origin,sceneFurniture.quarterTurns,sceneFurniture.family)};}catch{movedFurniture=null;}
  const coordinates=(event:{clientX:number;clientY:number})=>{
    if(view==='3d')return sceneRef.current?.projectPointer(event.clientX,event.clientY)??null;
    const matrix=svg.current?.getScreenCTM();
    if(!matrix)return null;
    const point=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());
    return {x:point.x,y:point.y};
  };
  /**
   * While a piece is armed: the pointer's way over the canvas (every coalesced sample with its own time, so a slow frame is not a
   * rest), and on its first move over the placement bar the ghost goes back to where the pointer last rested and stays there (no
   * follow, no re-snap) until the pointer is back on the canvas.
   */
  const trackPointer=(event:PointerEvent<HTMLDivElement>)=>{
    if(!(armed||armedFurniture))return;
    const native=event.nativeEvent,coalesced=native.getCoalescedEvents?.()??[],target=event.target as Element;
    const samples=(coalesced.length?coalesced:[native]).map(item=>({x:item.clientX,y:item.clientY,t:item.timeStamp}));
    if(target.closest('.builder-plan,.builder-scene')){ghostTrail.current=recordSamples(ghostTrail.current,samples);return;}
    if(!ghostTrail.current.length||!target.closest('.placement-bar-dock'))return;
    const at=frozenPoint(ghostTrail.current,samples[0].t);
    ghostTrail.current=[];
    const pos=at&&coordinates({clientX:at.x,clientY:at.y});
    if(pos)setGhost(pos);
  };
  /** The variant a click or drop at `pos` lays: the shown one when the ghost is there, else the one the intent picks at the joint there. */
  const variantAt=(family:TileFamily,pos:CanvasPoint):JointVariant|undefined=>{
    if(family===armedFamily&&ghost&&lock&&Math.hypot(pos.x-ghost.x,pos.y-ghost.y)<1)return shownVariant;
    const placement=candidatePlacement(family,pos),there=findJoint(project,family,placement,snapRadius(),INSERT_RADIUS);
    if(!there)return undefined;
    const shape={...candidatePlacement(family,pos,there.point.z),x:0,y:0},options=jointVariants(project,family,shape,there);
    const chosen=activeVariant(stepSelection({...NO_SELECTION,intent:selection.intent},there,options,pos,mmPerPx()),options);
    return chosen&&!fitsCleanly(chosen)?nearestLanding(cleanLandings(project,family,shape,there,intentOf(chosen)),pos)?.variant??chosen:chosen;
  };
  /** Where `landing` is from the locked joint on screen, in words ('1 joint left'). */
  const landingWords=(landed:Landing,from:LockJoint)=>{
    const toScreen=(point:{x:number;y:number;z:number})=>{
      if(view==='3d')return sceneRef.current?.projectToScreen(point)??null;
      const matrix=svg.current?.getScreenCTM();
      return matrix?new DOMPoint(point.x,point.y).matrixTransform(matrix):null;
    };
    const a=toScreen(from.point),b=toScreen(landed.lock.point),count=Math.abs(landed.steps);
    const way=!a||!b?(landed.steps>0?'on':'back'):Math.abs(b.x-a.x)>=Math.abs(b.y-a.y)?(b.x<a.x?'left':'right'):(b.y<a.y?'up':'down');
    return `fits cleanly ${count} joint${count===1?'':'s'} ${way}`;
  };
  /** A community piece laid counts in the usage totals (src/net/telemetry.ts). */
  const countCommunity=(next:WorkshopProject,id:string)=>{
    const family=next.routes.flatMap(route=>route.pieces).find(piece=>piece.id===id)?.family;
    if(family&&pieceDefinition(family).community)track('community_item_placed');
  };
  const place=(family:TileFamily,pos:CanvasPoint)=>{
    const wasEmpty=!pieces.length,laid=variantAt(family,pos);
    if(laid?.insert){
      commit(laid.insert.next,laid.insert.pieceId);setSelectedFurnitureId(null);keepHand(laid);countCommunity(laid.insert.next,laid.insert.pieceId);
      setInsertGaps(laid.insert.gaps.length?{revision:laid.insert.next.revision,gaps:laid.insert.gaps}:null);
      return;
    }
    const [next,id]=laid?.snap?placePreview(project,laid.snap):placePiece(project,family,candidatePlacement(family,pos),-1);
    commit(next,id);setSelectedFurnitureId(null);setPlacedId(id);keepHand(laid);countCommunity(next,id);
    if(wasEmpty){
      // Ease in towards the first piece, keeping the furniture and at least an owned oval's area in view.
      const piece=next.routes.flatMap(route=>route.pieces).find(candidate=>candidate.id===id)!;
      const shelves=next.furniture.flatMap(item=>{const {width,depth}=furnitureFootprint(item.family,item.quarterTurns);
        return [{x:item.x-width/2,y:item.y-depth/2},{x:item.x+width/2,y:item.y+depth/2}];});
      manualZoom.current=false;
      animateTo(firstPlacementView(viewTarget(),[piece,primaryEnd(piece,next),...shelves],{width:roomWidth,height:roomDepth}));
    }
  };
  /** Lay the whole siding-ladder kit as one undoable change; its first turnout is selected. */
  const placeKit=(pos:CanvasPoint)=>{
    const placement={...(ghost&&Math.hypot(pos.x-ghost.x,pos.y-ghost.y)<1?kitAt(pos):pos),heading:orientation};
    const elevation=armedFlyover?previewFlyover(project,placement,{...flyoverValues,...elevationStyle},snapRadius()):null;
    const kit=armedTriple?placeTriple(project,placement,tripleOptions,snapRadius()):ladder?placeLadder(project,placement,ladder,snapRadius()):
      elevation&&!elevation.problem&&elevation.pieces.length?placeKitPieces(project,elevation.pieces):
      armedHelix&&!planHelix(helixOptions).problem?placeKitPieces(project,previewHelix(project,placement,helixOptions,snapRadius())):
      armedWallRun?placeKitPieces(project,previewWallRun(project,placement,wallRunOptions,snapRadius())):null;
    if(!kit)return;
    const [next,ids]=kit;
    commit(next,ids[0]);setSelectedFurnitureId(null);
  };
  const placeShelf=(pos:CanvasPoint)=>{
    if(pos.x<0||pos.x>roomWidth||pos.y<0||pos.y>roomDepth)return;
    try{
      const [next,id]=placeFurniture(project,pos,furnitureRotation,furnitureFamily);
      commit(next,null);setSelectedFurnitureId(id);setArmedFurniture(false);setGhost(null);setFurnitureError('');
      if(furnitureType(furnitureFamily).community)track('community_item_placed');
    }catch(error){setFurnitureError((error as Error).message);}
  };
  const moveShelf=(id:string,pos:CanvasPoint)=>{
    try{commit(moveFurniture(project,id,pos));setFurnitureError('');}
    catch(error){setFurnitureError((error as Error).message);}
    setDragging(null);setGhost(null);
  };
  const finishPieceDrag=(event:PointerEvent<SVGSVGElement|SVGPathElement>)=>{
    if(dragging?.kind!=='piece')return;
    const location=coordinates(event);
    if(location&&Math.hypot(event.clientX-dragging.startX,event.clientY-dragging.startY)>4){
      const target=dragOrigin(dragging,location);
      commit(movePieceRoute(project,dragging.id,target.x,target.y,snapRadius()));
    }
    setDragging(null);setGhost(null);
  };
  const finishFurnitureDrag=(event:PointerEvent<SVGSVGElement|SVGGElement>)=>{
    if(dragging?.kind!=='furniture')return;
    const location=coordinates(event);
    if(location&&Math.hypot(event.clientX-dragging.startX,event.clientY-dragging.startY)>4)moveShelf(dragging.id,dragOrigin(dragging,location));
    setDragging(null);setGhost(null);
  };
  const arm=(family:TileFamily|null)=>{setArmed(family);setArmedFurniture(false);setFurnitureError('');setSelected(null);setSelectedFurnitureId(null);gap.cancel();
    if(family!==armed){setGhost(null);setMirrored(false);ghostTrail.current=[];}};
  const tileHandlers=(key:TileFamily)=>({
    onPointerDown:(event:PointerEvent<HTMLButtonElement>)=>{
      if(event.button!==0)return;
      tileWasArmed.current=armed===key||armedFamily===key;arm(key);
      setDragging({kind:'tile',id:key,startX:event.clientX,startY:event.clientY});
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove:pointerMoveTile,onPointerUp:pointerUpTile,onPointerCancel:()=>{setDragging(null);setGhost(null);},
    onClick:()=>{if(tileJustDropped.current)tileJustDropped.current=false;else{const next=tileWasArmed.current?null:key;arm(next);if(next)tableInReach();}}
  });
  /** Phones stack the palette above the table and the piece sheet over the screen's foot: a tile tapped to place brings the table up between them. */
  const tableInReach=()=>{if(matchMedia('(max-width: 760px)').matches)document.querySelector('.builder-table')?.scrollIntoView({block:'start',behavior:'smooth'});};
  function pointerMoveTile(event:PointerEvent<HTMLButtonElement>){
    if(dragging?.kind==='tile'||dragging?.kind==='furniture-tile')setGhost(coordinates(event));
  }
  function pointerUpTile(event:PointerEvent<HTMLButtonElement>){
    if(dragging?.kind==='tile'||dragging?.kind==='furniture-tile'){
      const location=coordinates(event);
      const rect=(view==='top'?svg.current:document.querySelector('.builder-scene'))?.getBoundingClientRect();
      if(location&&rect&&event.clientX>=rect.left&&event.clientX<=rect.right&&event.clientY>=rect.top&&event.clientY<=rect.bottom){
        // A drag is one placement; a click on the tile keeps it armed for laying pieces in a row.
        tileJustDropped.current=true;
        if(dragging.kind==='tile'){if(armedFamily)place(armedFamily,location);else if(armedKit)placeKit(location);setArmed(null);}else placeShelf(location);
        setGhost(null);
      }else setGhost(null);
    }
    setDragging(null);
  }
  const movePiece=(id:string,origin:CanvasPoint)=>{
    if(project.routes.some(route=>route.pieces.some(piece=>piece.id===id)))commit(movePieceRoute(project,id,origin.x,origin.y,snapRadius()));
    setDragging(null);setGhost(null);
  };
  const wheel=(event:WheelEvent<SVGSVGElement>)=>{
    event.preventDefault();
    zoom(event.deltaY>0?1.16:1/1.16,coordinates(event)??undefined);
  };
  const startPan=(event:PointerEvent<SVGSVGElement>)=>{
    if(event.pointerType==='touch'){touchDown(event);return;}
    if(event.button!==1 && !((spaceHeld.current||panMode)&&event.button===0))return;
    event.preventDefault();pan.current={x:event.clientX,y:event.clientY,view:viewport};
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  /** A finger on the table (pieces and furniture take their own drags first): one finger pans and a tap still clicks; a second pinch-zooms. */
  const touchDown=(event:PointerEvent<SVGSVGElement>)=>{
    if(dragging)return;
    touches.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
    event.currentTarget.setPointerCapture(event.pointerId);
    const [first,second]=[...touches.current.values()];
    if(!second){pan.current={...first,view:viewport};return;}
    pan.current=null;setGhost(null);manualZoom.current=true;
    const matrix=svg.current?.getScreenCTM(),anchor=coordinates({clientX:(first.x+second.x)/2,clientY:(first.y+second.y)/2});
    pinch.current=matrix&&anchor?{view:viewport,scale:{a:matrix.a,d:matrix.d},anchor,from:[first,second]}:null;
  };
  const snapTarget=movePreview?.target??preview?.target??null;
  /** The chain end being laid onto (the snapped ghost's far end, counting the ghost) or the selected piece's open end: how far round it has turned. */
  const ghostOnEnd=preview?.routeId&&preview.target?preview.piece:null;
  const turnPiece=ghostOnEnd??(!armed&&!armedFurniture?current:undefined);
  const turnEnds=!turnPiece?[]:ghostOnEnd?piecePorts(ghostOnEnd,project).filter(port=>!port.stop&&
    Math.hypot(port.x-preview!.target!.x,port.y-preview!.target!.y,port.z-preview!.target!.z)>1):
    openPorts.filter(item=>item.part.id===turnPiece.id).map(item=>item.port);
  const turnEnd=turnEnds.find(port=>port.id==='out')??turnEnds[0];
  // The ghost is rebuilt on every pointer move; while it stays snapped to the same end the walk's answer does not change.
  const turnKey=turnPiece&&turnEnd?`${turnPiece.id}:${turnPiece.family}:${turnEnd.id}:${turnEnd.x.toFixed(2)},${turnEnd.y.toFixed(2)},${turnEnd.z.toFixed(2)},${turnEnd.heading.toFixed(5)}`:'';
  const turn=useMemo(()=>{
    const chain=turnPiece&&turnEnd?chainTurn(shown,turnPiece.id,turnEnd.id,ghostOnEnd?[ghostOnEnd]:[]):null;
    return chain&&(chain.curved||chain.closed)?{chain,words:turnWords(chain,closesWithOneMore(shown,chain,turnPiece!))}:null;
  },[shown,turnKey]);
  /** What auto-widen keeps in view: the snapped ghost's ends, else the open ends of the piece just laid while it stays selected. */
  const growth=view!=='top'?[]:ghostOnEnd?piecePorts(ghostOnEnd,project):
    placedId!==null&&placedId===selected?snapPorts.filter(item=>item.part.id===placedId).map(item=>item.port):[];
  const growthKey=growth.map(point=>`${Math.round(point.x)},${Math.round(point.y)}`).join(' ');
  useEffect(()=>{
    const element=svg.current;
    if(!growthKey||!element?.clientHeight||pan.current)return;
    const before=viewTarget(),next=widenView(before,growth,{aspect:element.clientWidth/element.clientHeight,manual:manualZoom.current,
      max:{width:roomWidth+400,height:roomDepth+400},keep:geometry.flatMap(item=>item.ports)});
    if(!next)return;
    // While a snapped ghost is under the pointer, only zoom out round the pointer: the end it is snapped to stays under it, so
    // the next move or click still meets that end (panning or zooming elsewhere would slide other track under a still pointer).
    if(!ghostOnEnd||!ghost){animateTo(next);return;}
    if(next.width>before.width+0.5)animateTo({width:next.width,height:next.height,
      x:ghost.x-(ghost.x-before.x)*next.width/before.width,y:ghost.y-(ghost.y-before.y)*next.height/before.height});
  },[growthKey]);
  const crossingWord=(status:string)=>status==='digitally-clear'?'Clear':status==='blocked'?'Blocked':'Not checked';
  /** Print / Fast, with Own first where the tile has an owned shape. */
  const offered=(owned:boolean,fast:boolean):PieceSource[]=>[...(owned?['owned' as const]:[]),'printed',...(fast?['fast' as const]:[])];
  const kitEntry=(key:string,group:PieceGroup,label:string,meta:string,options:ReactNode,preview?:ReactNode):PaletteEntry=>({key,group,label,meta,terms:key,
    source:kitFast(key)?'fast':'printed',preview,sources:offered(false,fastAvailable),options,active:armed===key,handlers:tileHandlers(key)});
  const brickKits=project.trackSystem==='brick-v1';
  /** What a palette tile's piece would need on its own, as fit would make it. */
  const unplacedNeeds=(piece:RoutePiece)=><AlsoNeeds body={hardwareRequest(pieceParts(piece,project),[piece])} account={account}/>;
  /** The user's own track of a family still free, where this track system can use it. */
  const stockOf=(family:string):OwnedStock|undefined=>{
    const use=ownedUse.find(item=>item.family===family);
    return use&&tileFits(project,family)?{left:use.left,total:use.owned}:undefined;
  };
  /** A furniture tile: click arms it (click the table to place, R turns it), a drag places one. */
  const furnitureHandlers=(family:string):ButtonHTMLAttributes<HTMLButtonElement>=>({
    onPointerDown:event=>{if(event.button!==0)return;tileWasArmed.current=armedFurniture&&furnitureFamily===family;setArmed(null);setArmedFurniture(true);setFurnitureError('');
      const {orientations}=furnitureType(family);
      setFurnitureFamily(family);setFurnitureRotation(value=>orientations.includes(value)?value:orientations[0]);
      setDragging({kind:'furniture-tile',startX:event.clientX,startY:event.clientY});event.currentTarget.setPointerCapture(event.pointerId);},
    onPointerMove:pointerMoveTile,onPointerUp:pointerUpTile,onPointerCancel:()=>{setDragging(null);setGhost(null);},
    onClick:()=>{if(tileJustDropped.current)tileJustDropped.current=false;else {setArmed(null);setArmedFurniture(!tileWasArmed.current);setFurnitureError('');if(!tileWasArmed.current)tableInReach();}}});
  /** Every tile in palette order: per group its track kinds, then its families, then its kits (Elevation's in ELEVATION_ORDER); furniture last. */
  const paletteEntries:PaletteEntry[]=[...PIECE_GROUPS.flatMap(group=>inElevationOrder([
    // A kind shows while any of its first-row chips builds a piece this track system can use.
    ...TRACK_KINDS.filter(kind=>(kind.group??'track')===group.id&&kind.rows[0].choices.some(choice=>{
      const shapes=kindShapes(kind,applyChoice(kind,kindValues[kind.id],choice.values));return shapes.owned||shapes.printed;})).map((kind):PaletteEntry=>{
      const key=kindKey(kind),values=kindValues[kind.id],shapes=kindShapes(kind),source=kindSource(kind),shape=kindShape(kind);
      const use=shapes.owned&&ownedUse.find(item=>item.family===shapes.owned!.family);
      return {key,group:group.id,label:kind.label,meta:shape?kind.describe(values):'Not for this track system',terms:[kind.id,...kind.families].join(' '),
        source,preview:shape&&<TilePreview project={project} piece={shapePiece(shape,source==='fast')}/>,owned:use?{left:use.left,total:use.owned}:undefined,owns:ownsAny(kind.families,stockOf),
        experimental:Boolean(kind.caution?.(values)),sources:shapes.printed&&(shapes.owned||fastAvailable)?offered(Boolean(use),fastAvailable):[],
        options:<KindEditor kind={kind} values={values} idPrefix={`palette-${kind.id}`} stock={stockOf}
          fits={next=>{const options=kindShapes(kind,next);return Boolean(options.owned||options.printed);}}
          onChange={next=>{setKindValues(prior=>({...prior,[kind.id]:next}));arm(key);}}/>,
        active:armed===key,unavailable:!shape,handlers:tileHandlers(key),alsoNeeds:armed===key&&shape?unplacedNeeds(shapePiece(shape,source==='fast')):undefined};
    }),
    ...paletteDefinitions().filter(tile=>tile.group===group.id&&tileFits(project,tile.owned?.family??tile.family)).map((tile):PaletteEntry=>{
      const source=sourceOf(tile),family=source==='owned'?tile.owned!.family:tile.family;
      // The tile of the hand the ghost shows is the armed one (a locked joint's variant can be the other hand).
      const use=tile.owned&&ownedUse.find(item=>item.family===tile.owned!.family)!,active=family===shownFamily||shownFamily===armedFamily&&armed===family;
      // The armed tile shows the hand F gave its shape.
      const drive=driveSpec(tile),driven=(piece:RoutePiece):RoutePiece=>{const params=driveParams(tile.family);return params?{...piece,params:{...piece.params,...params}}:piece;};
      const flipped=(piece:RoutePiece)=>{
        const own=driven(piece);
        return active&&shownMirrored&&ghostFlip==='mirror'&&tile.flip&&!tile.mirror?{...own,params:tile.flip(own.params??{})}:own;
      };
      const described=tile.description(flipped(tilePiece(tile.family)));
      // The tile says it can be motorised; once a drive is picked, the description says which (unless it already does).
      const driveValue=drive?drives[tile.family]??drive.default:0;
      const driveWord=drive&&(driveValue===drive.default||described===tile.description(tilePiece(tile.family)))?driveSummary(drive,driveValue):'';
      const driveWords=driveWord?` · ${driveWord}`:'';
      return {key:tile.family,group:group.id,label:tile.label,meta:`${described}${driveWords}`,
        terms:[tile.family,tile.owned?.family,tile.community&&`community ${tile.community.credit}`].join(' '),community:tile.community,
        source,preview:<TilePreview project={project} piece={flipped(tilePiece(family,source==='fast'))}/>,owned:use?{left:use.left,total:use.owned}:undefined,owns:ownsAny([tile.owned?.family],stockOf),
        experimental:Boolean(tile.caution),caution:tile.caution,notes:pieceDefinition(family).notes,
        sources:tile.owned?(tileFits(project,tile.family)?offered(true,fastAvailable):[]):fastAvailable&&tile.styles.includes('fast')?offered(false,true):[],
        active,handlers:tileHandlers(family),
        ...(drive?{drive:<DriveChoice spec={drive} value={driveValue} project={project}
          onSet={value=>{setDrives(prior=>({...prior,[tile.family]:value}));if(!active)arm(family);}}/>}:{}),
        alsoNeeds:active?unplacedNeeds(flipped(tilePiece(family,source==='fast'))):undefined,
        // Go up or down: its height and grade, the ghost's length and fit, and the surface ahead.
        ...(tile.family===CLIMB_FAMILY?{meta:climbSummary(climbValues),terms:`${CLIMB_FAMILY} raise ramp climb descent up down height`,
          options:<ClimbSettings values={climbValues} hover={climbHover} onChange={values=>{setClimbValues(values);arm(CLIMB_FAMILY);}}/>}:{})};
    }),
    ...(brickKits&&group.id==='junction'?[
      kitEntry(LADDER_KEY,'junction','Siding ladder',ladderSummary(ladderValues,ladderKit.pieces),
        <LadderSettings project={project} values={ladderValues} problem={ladderKit.problem} onChange={values=>{setLadderValues(values);arm(LADDER_KEY);}}/>,
        ladderKit.pieces.length?<LadderMiniature project={project} pieces={ladderKit.pieces}/>:undefined),
      kitEntry(TRIPLE_KEY,'junction','Triple crossover',tripleSummary(tripleValues),<TripleSettings values={tripleValues} onChange={values=>{setTripleValues(values);arm(TRIPLE_KEY);}}/>)]:[]),
    ...(brickKits&&group.id==='elevation'?[
      kitEntry(FLYOVER_KEY,'elevation','Flyover',flyoverSummary(flyoverValues),<FlyoverSettings values={flyoverValues} onChange={values=>{setFlyoverValues(values);arm(FLYOVER_KEY);}}/>),
      kitEntry(HELIX_KEY,'elevation','Helix',helixSummary(helixValues),<HelixSettings values={helixValues} onChange={values=>{setHelixValues(values);arm(HELIX_KEY);}}/>),
      kitEntry(WALL_RUN_KEY,'elevation',wallRunLabel(wallRunValues),wallRunSummary(wallRunValues),<WallRunSettings values={wallRunValues} onChange={values=>{setWallRunValues(values);arm(WALL_RUN_KEY);}}/>)]:[]),
  ])),...furnitureTiles().map(({family,...tile}):PaletteEntry=>({...tile,key:`furniture:${family}`,group:'furniture',sources:[],
    active:armedFurniture&&furnitureFamily===family,handlers:furnitureHandlers(family)}))];
  const panelOpen=paletteEntries.some(entry=>entry.active)||Boolean(selectedFurniture||current);
  const ghostHeld=Boolean(preview?.target||insertPlan);
  /** The other ways the piece can go at the locked joint: faint outlines, named on hover. */
  /** When the ghost landed at a joint nearby, the outlines go with it (the same ways, carried along the track). */
  const outlinePiece=(piece:RoutePiece):RoutePiece=>{
    if(!landing||!lock)return piece;
    const angle=landing.lock.travel-lock.travel,c=Math.cos(angle),s=Math.sin(angle),dx=piece.x-lock.point.x,dy=piece.y-lock.point.y;
    return {...piece,x:landing.lock.point.x+c*dx-s*dy,y:landing.lock.point.y+s*dx+c*dy,heading:piece.heading+angle};
  };
  // Moving the track on lays the piece where its spacer twin lies: one outline for both, none for the shown piece's own twin.
  const baseKey=(item:JointVariant)=>item.key.replace(/:shift$/,'');
  const variantOutlines=view==='top'&&lock&&variants.length>1?variants.filter(item=>item.fill!=='shift'&&(!variant||baseKey(item)!==baseKey(variant))).map(item=>({key:item.key,words:variantWords(item,lock),
    d:piecePaths(outlinePiece(item.piece),project).filter(path=>!path.moving||path.enabled).map(path=>bedOutline(path.points,BRICK_TRACK.bodyWidth)).join(' ')})):[];
  /** What going in here does to the track: what it replaces (and any spacer), or what moves and the gap it opens. */
  const insertWords=!insertPlan?'':insertPlan.mode==='replace'?(()=>{
    const labels=[...new Set(insertPlan.removed.map(piece=>pieceDefinition(piece.family).label.toLowerCase()))];
    const what=`${insertPlan.removed.length} ${labels.length===1?labels[0].split(' ')[0]:'piece'}${insertPlan.removed.length===1?'':'s'}`;
    const owned=insertPlan.removed.filter(piece=>pieceDefinition(piece.family).source==='owned').length;
    return `replaces ${what}${owned?` (${owned} back to stock)`:''}${insertPlan.spacer?` + a ${Math.round(paramValue(pieceDefinition(insertPlan.spacer.family),insertPlan.spacer,'length'))} mm printed spacer`:''} · nothing moves`;
  })():`moves ${plural(insertPlan.shifted.length,'piece')} along${insertPlan.gaps.length?` · opens a ${Math.round(insertPlan.gaps[0].distance)} mm gap`:''}`;
  /** The same words beside the ghost, on the side away from where it branches. */
  const insertCallout=insertPlan&&view==='top'?(()=>{
    const {piece}=insertPlan,end=primaryEnd(piece,insertPlan.next),size=Math.max(18,viewport.width/55);
    const side=shownVariant?.side===1?-1:1,offset=BRICK_TRACK.bodyWidth/2+size*1.6,heading=piece.heading;
    return {x:(piece.x+end.x)/2-Math.sin(heading)*offset*side,y:(piece.y+end.y)/2+Math.cos(heading)*offset*side+size/3,size,
      text:`${insertWords[0].toUpperCase()}${insertWords.slice(1)}`,shift:insertPlan.mode!=='replace'};
  })():null;
  /** The placement bar: the armed piece (or furniture) being placed, else the selected piece or furniture; the active tile names what is armed. */
  const activeEntry=paletteEntries.find(entry=>entry.active);
  const selectedKind=committedPiece&&kindOfFamily(committedPiece.family);
  const barContext:BarContext|null=armedFurniture?{mode:'placing-furniture',name:activeEntry?.label??furnitureType(furnitureFamily).label}:
    armed?{mode:'placing',name:activeEntry?`${activeEntry.label} · ${activeEntry.meta}`:armedDefinition?.label??'piece',
      flip:armedFamily||ghostFlip==='bend'?ghostFlip??(variant&&otherHand(variants,variant)?'mirror':null):null,
      bend:ghostFlip==='bend'&&variant?.side?variant.side:bend,sbend:armedKind?.id==='sbend',rise:armedDefinition?.legacy?.rise!==undefined?riseDirection:null,
      attach:variant&&facingList.length>1?{index:facingList.indexOf(wayOf(variant)),count:facingList.length}:null,held:ghostHeld}:
    selectedFurniture?{mode:'selected-furniture',name:furnitureType(selectedFurniture.family).label}:
    committedPiece?{mode:'selected',name:selectedKind?`${selectedKind.label} · ${selectedKind.describe(selectedKind.values(committedPiece))}`:committedPiece.family===CLIMB_FAMILY?`${pieceDefinition(CLIMB_FAMILY).label} · ${pieceDefinition(CLIMB_FAMILY).description(committedPiece)}`:pieceDefinition(committedPiece.family).label,
      flip:canFlipPiece(committedPiece)?pieceDefinition(committedPiece.family).mirror?'mirror':'turn':null,rotateBlocked}:null;
  const barHandlers:BarHandlers={rotate,flip:()=>{if(armed)flipArmed();else flipSelected();},ramp:()=>setRiseDirection(value=>value===1?-1:1),
    attach:()=>turnFacing(1),done:escape,rotateRoute:()=>{if(committedPiece)commit(rotatePieceRoute(project,committedPiece.id,Math.PI/8));},
    options:focusPanel,remove:removeSelection};
  /** The one-time keys tip shows on a placement until dismissed; once shown, the end of that placement also retires it. */
  const tipShown=!tipSeen&&barContext?.mode==='placing';
  const dismissTip=()=>{setTipSeen(true);try{localStorage.setItem(PLACEMENT_TIP_KEY,'1');}catch{/* the tip just shows again next time */}};
  useEffect(()=>{if(tipShown)tipWasShown.current=true;else if(tipWasShown.current&&!tipSeen)dismissTip();},[tipShown]);
  /** Which way a snapped ghost goes from the joint: an arrow along each of its paths from there. */
  const snapArrows=preview?.target&&!insertPlan?piecePaths(preview.piece,project).filter(path=>!path.moving||path.enabled).flatMap(path=>{
    const target=preview.target!,first=path.points[0],last=path.points.at(-1)!;
    const ordered=Math.hypot(first.x-target.x,first.y-target.y)<1?path.points:Math.hypot(last.x-target.x,last.y-target.y)<1?[...path.points].reverse():null;
    return ordered?[planPath(leadingPoints(ordered,0.6))]:[];
  }):[];
  /** The layout's community pieces and furniture, credited under To print and Furniture in This build. */
  const community=communityItems(project);
  return <div className={`builder ${paletteCollapsed?'is-palette-collapsed':''} ${summaryCollapsed?'is-summary-collapsed':''} ${panelOpen?'has-flyout':''}`}>
    <Palette entries={paletteEntries} brickTrack={brickKits} onOpenSetup={()=>onOpenSetup()} collapsed={paletteCollapsed} onCollapse={()=>setPaletteCollapsed(value=>!value)} fastAvailable={fastAvailable}
      defaultStyle={defaultStyle} onDefaultStyle={style=>{
        // A new default replaces every tile's own Print / Fast pick; Own picks stay.
        setDefaultStyle(style);setSources(prior=>Object.fromEntries(Object.entries(prior).filter(([,source])=>source==='owned')));
      }}/>
    {/* One panel for the piece being worked with: the armed tile wins over a selection. */}
    {activeEntry?<PlacingPanel key={activeEntry.key} entry={activeEntry} panelRef={panelRef} onSource={(key,source)=>setSources(prior=>({...prior,[key]:source}))}
      onClose={()=>{arm(null);setGhost(null);}}/>:
      selectedFurniture&&barContext?<FurniturePanel name={barContext.name} item={selectedFurniture} panelRef={panelRef} actions={barActions(barContext,barHandlers)} onClose={()=>setSelectedFurnitureId(null)}/>:
      current&&barContext?<SelectedPiecePanel project={project} piece={current} committed={committedPiece} fit={fit} account={account} fastAvailable={fastAvailable}
        stock={stockOf} panelRef={panelRef} actions={barActions(barContext,barHandlers).filter(action=>['flip','route','delete'].includes(action.id))}
        onChange={next=>commit(next)} onDraft={setDraft} onCommitDraft={commitDraft} onClose={()=>setSelected(null)}/>:null}
    <div className={`builder-table ${barContext?'has-placement-bar':''}`} onPointerMove={trackPointer}>
      {/* Fixed groups that never change with context; what the selection or armed piece can do is on the placement bar. */}
      <div className="builder-table-toolbar" role="group" aria-label="Canvas tools">
        <div className="builder-tool-group is-view" role="group" aria-label="View">
          <ToolButton icon="view-top" label="Top" name="Top view" pressed={view==='top'} onClick={()=>{setView('top');setGhost(null);}}/>
          <ToolButton icon="view-3d" label="3D" name="3D view" pressed={view==='3d'} onClick={()=>{setView('3d');setGhost(null);}}/>
        </div>
        <div className="builder-tool-groups">
          <div className="builder-tool-group" role="group" aria-label="Navigate">
            <ToolButton icon="zoom-in" label="Zoom in" minor onClick={()=>zoom(1/1.5)}/>
            <ToolButton icon="zoom-out" label="Zoom out" minor onClick={()=>zoom(1.5)}/>
            <ToolButton icon="fit-track" label="Fit track" title={pieces.length?'Fit track':'Fit track: no track yet'} disabled={!pieces.length} onClick={fitTrack}/>
            <ToolButton icon="fit-room" label="Fit room" onClick={fitRoom}/>
            <ToolButton icon="pan" label="Pan" title={view==='top'?'Pan: drag to move the view (or hold Space and drag)':'Pan: in 3D, right-drag pans'} pressed={view==='top'&&panMode}
              disabled={view!=='top'} onClick={()=>{setPanMode(value=>!value);setGhost(null);}}/>
          </div>
          <div className="builder-tool-group" role="group" aria-label="Tools">
            <ToolButton icon="describe" label="Describe" name="Describe track" title="Describe the track you want; the app lays and checks it" pressed={assist.open}
              onClick={()=>{setArmed(null);setArmedFurniture(false);setSelected(null);gap.cancel();assist.toggle();}}/>
            <ToolButton icon="close-gap" label="Close gap" pressed={gap.active} disabled={view!=='top'||snapPorts.length<2}
              title={view!=='top'?'Close gap: in the top view':snapPorts.length<2?'Close gap: needs two open ends':'Join two open ends with a made-to-measure piece'}
              onClick={()=>{setArmed(null);setArmedFurniture(false);setSelected(null);if(assist.open)assist.toggle();gap.toggle();}}/>
          </div>
          <div className="builder-tool-group" role="group" aria-label="History">
            <ToolButton icon="undo" label="Undo" title={`Undo (${keyLabel('undo')})`} disabled={!history.length} onClick={undo}/>
          </div>
        </div>
      </div>
      {view==='3d'&&<div className="builder-scene"><BuilderScene ref={sceneRef} project={shown} fit={fit} selectedId={selected}
        selectedFurnitureId={selectedFurnitureId} preview={movePreview?.pieces??(insertPlan?[insertPlan.piece,...(insertPlan.spacer?[insertPlan.spacer]:[]),...insertPlan.shifted]:preview?[preview.piece]:kitGhost??(gap.option?gap.option.pieces:assistPieces))} snapTarget={snapTarget}
        previewFurniture={ghostFurniture??movedFurniture??assistFurniture[0]??null}
        armed={Boolean(armed)} armedFurniture={armedFurniture} heightLabels={climbLabels}
        onHover={pos=>{if((armed||armedFurniture)&&pos)setGhost(pos);}} onPlace={pos=>{if(armedFamily)place(armedFamily,pos);else if(armedKit)placeKit(pos);}}
        onDrag={setSceneDrag} onDeselect={()=>{setSelected(null);setSelectedFurnitureId(null);setCheckId(null);}}
        onFurniturePlace={placeShelf} onFurnitureSelect={id=>{setSelectedFurnitureId(id);setSelected(null);setArmed(null);setArmedFurniture(false);setGhost(null);}}
        onFurnitureMove={moveShelf} onSelect={id=>{setSelected(id);setSelectedFurnitureId(null);setCheckId(null);setArmed(null);setArmedFurniture(false);setGhost(null);}} onMove={movePiece}
        highlight={check?.targets??null}/>
      </div>}
      {view==='top'&&<svg ref={svg} tabIndex={0} className="builder-plan" viewBox={`${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Top view of room, furniture and track"
        onWheel={wheel} onPointerDown={startPan} onPointerMove={event=>{
          if(touches.current.has(event.pointerId)){
            touches.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
            const gesture=pinch.current,[first,second]=[...touches.current.values()];
            if(gesture&&second){setViewport(pinchView(gesture.view,gesture.scale,gesture.anchor,gesture.from,[first,second],zoomedView));return;}
          }
          if(pan.current){
            const matrix=svg.current?.getScreenCTM();
            setViewport({...pan.current.view,x:pan.current.view.x-(event.clientX-pan.current.x)/(matrix?.a??1),
              y:pan.current.view.y-(event.clientY-pan.current.y)/(matrix?.d??1)});
          }else if(dragging?.kind==='piece'||dragging?.kind==='furniture'||(armed||armedFurniture)&&!dragging){setGhost(coordinates(event));ghostClient.current={x:event.clientX,y:event.clientY};}
        }} onPointerLeave={()=>{if(!dragging&&!armed&&!armedFurniture)setGhost(null);}} onPointerUp={event=>{
          // A finger lifting ends its pan or pinch; unlike a mouse pan it leaves the click alone, since a tap is how touch places.
          if(touches.current.delete(event.pointerId)){pan.current=null;if(touches.current.size<2)pinch.current=null;return;}
          if(pan.current){pan.current=null;panJustFinished.current=true;return;}
          finishPieceDrag(event);finishFurnitureDrag(event);
        }} onPointerCancel={event=>{touches.current.delete(event.pointerId);pinch.current=null;pan.current=null;setDragging(null);setGhost(null);}}
        onClick={event=>{if(panJustFinished.current){panJustFinished.current=false;return;}if(dragging)return;
          // Auto-widen can move the view under a still pointer (a long ghost snapped to an end): the click lays what the ghost shows.
          const still=ghost&&ghostClient.current&&Math.hypot(event.clientX-ghostClient.current.x,event.clientY-ghostClient.current.y)<3;
          const pos=still?ghost:coordinates(event);
          if(armedFamily){if(pos)place(armedFamily,pos);}
          else if(armedKit){if(pos)placeKit(pos);}
          else if(armedFurniture){if(pos)placeShelf(pos);}
          else{setSelected(null);setSelectedFurnitureId(null);setCheckId(null);}}}>
        <defs><pattern id="builder-world-grid" width="100" height="100" patternUnits="userSpaceOnUse">
          <path d="M 100 0 H 0 V 100" fill="none" stroke="#39534d" strokeWidth="1"/>
          <circle cx="0" cy="0" r="2" fill="#54736b"/>
        </pattern>
        <marker id="builder-snap-arrowhead" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#b8e788"/></marker></defs>
        <rect x="0" y="0" width={roomWidth} height={roomDepth} className="builder-room"/><text x="26" y="-20" className="builder-room-label">Room · {roomWidth} × {roomDepth} mm{!roomMeasured&&<tspan className="builder-default"> · default</tspan>}</text>
        <rect x="0" y="0" width={roomWidth} height={roomDepth} className="builder-world-grid"/>
        {project.furniture.map(item=><g key={item.id} onPointerDown={event=>{
          if(armed||armedFurniture||panMode||pan.current||spaceHeld.current||event.button!==0)return;
          event.stopPropagation();svg.current?.focus();const grab=coordinates(event);if(!grab)return;
          setSelectedFurnitureId(item.id);setSelected(null);
          setDragging({kind:'furniture',id:item.id,startX:event.clientX,startY:event.clientY,grab,origin:{x:item.x,y:item.y}});
          event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerUp={event=>{if(dragging?.kind==='furniture'){event.stopPropagation();finishFurnitureDrag(event);}}}
          onClick={event=>{if(!armed&&!armedFurniture)event.stopPropagation();}}>
          <FurnitureVisual item={item} selected={selectedFurnitureId===item.id}/>
        </g>)}
        {check&&<path className="builder-check-glow" d={geometry.filter(({piece})=>highlighted.has(piece.id)).map(({hitPath})=>hitPath).join(' ')}/>}
        {/* A community piece's uploaded model, seen from above, under its track: a platform's or a portal's full width. */}
        {geometry.map(({piece})=>pieceDefinition(piece.family).libraryMesh&&<CommunityFootprint key={`${piece.id}:footprint`} piece={piece}/>)}
        <g className={replacing?'is-replaced':undefined}>{geometry.map(({piece,paths})=><PieceVisual key={piece.id} project={shown} piece={piece} paths={paths} cuts={draft?undefined:partCuts.get(piece.id)} selected={selected===piece.id}/>)}</g>
        {heightTints.length>0&&<g className="builder-height-tint" aria-hidden="true">{heightTints.map(({key,from,to,colour,opacity})=>
          <line key={key} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={colour} strokeOpacity={opacity} strokeWidth={BRICK_TRACK.bodyWidth}/>)}</g>}
        {fit.supports.map(support=>support.family==='layout_riser'?<rect key={support.id} x={support.pose.x-16} y={support.pose.y-32} width="32" height="64" rx="3" className="builder-support"
          transform={`rotate(${support.pose.heading*180/Math.PI} ${support.pose.x} ${support.pose.y})`}><title>{`Riser stack · ${support.blocks!.length} block${support.blocks!.length===1?'':'s'} · ${Math.round(support.height*10)/10} mm`}</title></rect>:
          <circle key={support.id} cx={support.pose.x} cy={support.pose.y} r="14" className="builder-support"/>)}
        {fit.partInstances.map(part=>part.family==='helix_column'?<circle key={part.id} cx={part.pose.x} cy={part.pose.y} r="8" className="builder-support"><title>Helix column</title></circle>:
          part.family==='track_bracket'?<rect key={part.id} x={part.pose.x-7.6} y={part.pose.y} width="15.2" height={part.parameters.reach} className="builder-support"
            transform={`rotate(${part.pose.heading*180/Math.PI} ${part.pose.x} ${part.pose.y})`}><title>{part.parameters.mount===1?'Wall bracket':'Shelf bracket'}</title></rect>:null)}
        {fit.crossings.map(crossing=><g key={crossing.crossingId}><rect x={crossing.upperPoint.x-65} y={crossing.upperPoint.y-65} width="130" height="130" rx="14" className="builder-crossing"/><text x={crossing.upperPoint.x+90} y={crossing.upperPoint.y-78} className="builder-crossing-label">Crossing · {crossingWord(crossing.status)}</text></g>)}
        {shown.routes.map((route,index)=>route.points[0]&&<text key={route.id} x={route.points[0].x} y={route.points[0].y-70} className={`builder-route-label ${index%2?'orange':''}`}>{route.name} · {routeHeightWords(shown,route)}</text>)}
        {marks.map(mark=><text key={`${mark.x}:${mark.y}:${mark.z}`} x={mark.x} y={mark.y+44} className="builder-height-mark" textAnchor="middle">{mark.text}</text>)}
        {openPorts.map(({part,port})=><g key={`${part.id}:${port.id}`} className="builder-socket"><title>Open end</title>
          <circle cx={port.x} cy={port.y} r="12"/><circle cx={port.x} cy={port.y} r="3"/></g>)}
        {/* A moving deck's free ends are route ends, not connectors: no label. */}
        {geometry.filter(({piece})=>piece.id===selected).flatMap(({piece,ports})=>ports.filter(port=>!(port.stop&&pieceDefinition(piece.family).halt)).map(port=>
          <text key={`${piece.id}:${port.id}:label`} x={port.x} y={port.y-20} className="builder-port-label" textAnchor="middle">{port.id}</text>))}
        {geometry.map(({piece,hitPath})=><path key={`${piece.id}:hit`} d={hitPath} className="builder-hit" onPointerDown={event=>{
          if(armed||armedFurniture||panMode||pan.current||spaceHeld.current)return;
          event.stopPropagation();if(event.button!==0)return;
          svg.current?.focus();const grab=coordinates(event);if(!grab)return;
          setSelected(piece.id);setSelectedFurnitureId(null);setCheckId(null);
          setDragging({kind:'piece',id:piece.id,startX:event.clientX,startY:event.clientY,grab,origin:{x:piece.x,y:piece.y}});
          event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerUp={event=>{if(dragging?.kind==='piece'){event.stopPropagation();finishPieceDrag(event);}}}
          onClick={event=>{if(!armed&&!panMode)event.stopPropagation();}}/>)}
        <GapOverlay project={project} gap={gap}>{gap.option&&<g className="builder-placement-preview snapped">
          {gap.option.pieces.map(piece=><PieceVisual key={piece.id} project={gap.option!.next} piece={piece} preview/>)}</g>}</GapOverlay>
        {check&&<g className="builder-check-highlight" aria-hidden="true">
          <path className="is-core" d={geometry.filter(({piece})=>highlighted.has(piece.id)).map(({hitPath})=>hitPath).join(' ')}/>
          {fit.supports.filter(support=>check.targets.supportIds?.includes(support.id)).map(support=><circle key={support.id} cx={support.pose.x} cy={support.pose.y} r="42"/>)}
          {check.targets.points?.map((point,index)=><g key={index}><circle cx={point.x} cy={point.y} r="34"/><circle className="is-dot" cx={point.x} cy={point.y} r="9"/></g>)}
        </g>}
        {movePreview&&<g className="builder-move-preview">
          {movePreview.pieces.map(piece=><PieceVisual key={`${piece.id}:move`} project={project} piece={piece} preview/>)}
        </g>}
        {preview&&!insertPlan&&<g className={`builder-placement-preview ${preview.routeId?'snapped':''}`}>
          {/* A climb past a wall is drawn red: the room ends there. */}
          <g className={armedClimb&&pieceLeavesRoom(project,preview.piece)?'is-outside-room':undefined}><PieceVisual project={project} piece={preview.piece} preview/></g>
        </g>}
        {variantOutlines.length>0&&<g className="builder-variant-outlines">{variantOutlines.map(item=>
          <path key={item.key} d={item.d} className="builder-variant-outline"><title>{`${item.words} · point this way, or F / Tab`}</title></path>)}</g>}
        {snapArrows.map((d,index)=><path key={`arrow-${index}`} d={d} className="builder-snap-arrow" markerEnd="url(#builder-snap-arrowhead)"/>)}
        {insertPlan&&<g className="builder-insert-preview">
          {insertPlan.removed.length>0&&<path className="builder-insert-removed" d={geometry.filter(({piece})=>insertPlan.removed.some(removed=>removed.id===piece.id)).map(({hitPath})=>hitPath).join(' ')}/>}
          <g className="builder-move-preview">{insertPlan.shifted.map(piece=><PieceVisual key={`${piece.id}:shift`} project={insertPlan.next} piece={piece} preview/>)}</g>
          <g className="builder-placement-preview snapped"><PieceVisual project={insertPlan.next} piece={insertPlan.piece} preview/>
            {insertPlan.spacer&&<PieceVisual project={insertPlan.next} piece={insertPlan.spacer} preview/>}</g>
          <circle cx={insertPlan.joint.x} cy={insertPlan.joint.y} r="22" className="builder-snap-target"/>
          {insertPlan.gaps.map(({a,b,distance},index)=><g key={`gap-${index}`} className="builder-insert-gap">
            <line x1={a.port.x} y1={a.port.y} x2={b.port.x} y2={b.port.y}/><circle cx={a.port.x} cy={a.port.y} r="16"/><circle cx={b.port.x} cy={b.port.y} r="16"/>
            <text x={(a.port.x+b.port.x)/2} y={(a.port.y+b.port.y)/2-34} textAnchor="middle">{Math.round(distance)} mm gap</text></g>)}
          {insertCallout&&<text className={`builder-insert-callout ${insertCallout.shift?'is-shift':''}`} x={insertCallout.x} y={insertCallout.y}
            textAnchor="middle" fontSize={insertCallout.size}>{insertCallout.text}</text>}
        </g>}
        {turn&&<TurnIndicator chain={turn.chain} words={turn.words} size={Math.max(18,viewport.width/55)}/>}
        {assist.preview&&(assistPieces.length>0||assistFurniture.length>0)&&<g className="builder-placement-preview plan-assist-preview">
          {assistFurniture.map(item=><FurnitureVisual key={`${item.id}:assist`} item={item} preview/>)}
          {assistPieces.map(piece=><PieceVisual key={`${piece.id}:assist`} project={assist.preview!.project} piece={piece} preview/>)}
        </g>}
        {kitGhost&&<g className="builder-placement-preview">
          {/* A kit piece past a wall is drawn red: the room ends there. */}
          {kitGhost.map(piece=><g key={piece.id} className={pieceLeavesRoom(project,piece)?'is-outside-room':undefined}><PieceVisual project={project} piece={piece} preview/></g>)}
        </g>}
        {snapTarget&&<circle cx={snapTarget.x} cy={snapTarget.y} r="22" className="builder-snap-target"/>}
        {dragging?.kind==='furniture'&&ghost&&project.furniture.filter(item=>item.id===dragging.id).map(item=>
          <FurnitureVisual key={`${item.id}:move`} item={{...item,...dragOrigin(dragging,ghost)}} preview/>)}
        {ghostFurniture&&<FurnitureVisual item={ghostFurniture} preview/>}
        <g className="builder-ruler" aria-label="100 millimetre scale">
          <path d={`M ${viewport.x+viewport.width-180} ${viewport.y+103} v -10 h 100 v 10`}/>
          <text x={viewport.x+viewport.width-130} y={viewport.y+110}
            textAnchor="middle" dominantBaseline="hanging" fontSize={Math.max(20,viewport.width/60)}>100 mm</text>
        </g>
      </svg>}
      {view==='top'&&<CommunityMeshHint project={shown}/>}
      {!pieces.length&&!armed&&!armedFurniture&&!dragging&&!assist.open&&!assist.preview&&startShown?
        <StartScreen project={project} onDescribe={describeLayout} onPick={pickExample} onBuildByHand={buildByHand}/>:<>
        {!pieces.length&&!armed&&!armedFurniture&&!dragging&&!assist.open&&!assist.preview&&<div className="builder-empty-hint" role="status">{BUILD_BY_HAND_TIP}</div>}
        <ZoomCluster onZoomIn={()=>zoom(1/1.5)} onZoomOut={()=>zoom(1.5)} onFit={pieces.length?fitTrack:fitRoom} fitLabel={pieces.length?'Fit track':'Fit room'} onHelp={()=>setShortcutsOpen(true)}/>
        {view==='top'&&heightTints.length>0&&<div className="builder-height-legend" role="img" aria-label={`Track height: tint from 0 to ${Math.round(heightTop*10)/10} mm`}>
          <span>0</span><i/><span>{Math.round(heightTop*10)/10} mm</span></div>}
      </>}
      {view==='3d'&&turn&&<div className="builder-turn-chip" role="status">{turn.words.join(' · ')}</div>}
      {armedFamily&&<div className="builder-placement-hint" role="status">{insertPlan?`◆ INSERTS INTO TRACK · ${insertWords.toUpperCase()}`:preview?.routeId?'● SNAPS TO OPEN END':'○ CLICK TO START A ROUTE'}{variant&&lock&&variants.length>1?` · ${variants.indexOf(variant)+1} OF ${variants.length} WAYS: ${variantWords(variant,lock).split(' · ').slice(1).join(', ').toUpperCase()}`:''}{landing&&lock?` · ${landingWords(landing,lock).toUpperCase()}`:''} · {armedKind?`${armedKind.label} ${armedKind.describe(kindValues[armedKind.id])}`:pieceDefinition(shownFamily??armedFamily).label} · {Math.round(((preview?.piece.heading??orientation)%(Math.PI*2))*180/Math.PI)}°{armedDefinition?.legacy?.rise!==undefined?` · ${riseDirection*8} mm`:''}
        {climbHover?.fit&&!climbHover.problem&&<span className={`builder-climb-fit ${climbHover.fit.fits?'is-fits':'is-short'}`}> · {climbWords(climbHover.fit).toUpperCase()}</span>}</div>}
      {armedTriple&&<div className="builder-placement-hint" role="status">○ PLACE TRIPLE CROSSOVER · {tripleValues.spacing/8}-stud spacing · {Math.round(((kitGhost?.[0].heading??orientation)%(Math.PI*2))*180/Math.PI)}°</div>}
      {armedFlyover&&<div className="builder-placement-hint" role="status">{elevationKit?.problem||`○ FLYOVER · ${flyoverValues.clearance} mm clear · click over the track to cross`} · {Math.round(((kitGhost?.[0]?.heading??orientation)%(Math.PI*2))*180/Math.PI)}°</div>}
      {armedHelix&&<div className="builder-placement-hint" role="status">{planHelix(helixOptions).problem??`○ PLACE HELIX · R${helixValues.radius/8} · ${helixValues.turns} turns · drop on a level open end`} · {Math.round(((kitGhost?.[0]?.heading??orientation)%(Math.PI*2))*180/Math.PI)}°</div>}
      {armedWallRun&&<div className="builder-placement-hint" role="status">○ PLACE {wallRunValues.mount===1?'WALL':'SHELF'} RUN · {wallRunValues.length} mm at {wallRunValues.height} mm · {Math.round(((kitGhost?.[0]?.heading??orientation)%(Math.PI*2))*180/Math.PI)}°</div>}
      {armedLadder&&<div className="builder-placement-hint" role="status">{ladder?`○ PLACE SIDING LADDER · ${ladderValues.sidings} tracks · ${Math.round(((kitGhost?.[0].heading??orientation)%(Math.PI*2))*180/Math.PI)}°`:'Siding ladder: fix its settings in the palette'}</div>}
      {armedFurniture&&<div className="builder-placement-hint" role="status">○ PLACE {furnitureType(furnitureFamily).label.toUpperCase()} · {furnitureRotation*90}°</div>}
      {furnitureError&&<div className="builder-furniture-error" role="alert">{furnitureError}</div>}
      {insertGaps?.revision===project.revision&&!gap.active&&<div className="builder-insert-notice" role="status">
        The insert left {insertGaps.gaps.length===1?`a ${Math.round(insertGaps.gaps[0].distance)} mm gap`:`${insertGaps.gaps.length} gaps`} in the track.
        <button type="button" onClick={()=>{setArmed(null);setSelected(null);gap.show([insertGaps.gaps[0].a,insertGaps.gaps[0].b]);}}>Close gap</button>
        <button type="button" onClick={undo}>Undo</button>
      </div>}
      {barContext&&<PlacementBar context={barContext} actions={barActions(barContext,barHandlers)} note={barNote(barContext)} tip={tipShown} onDismissTip={dismissTip}/>}
      <GapPanel gap={gap} onPlace={commit}/>
      <PlanAssistPanel assist={assist} hasTrack={pieces.length>0} onAccept={next=>commit(next,null)}/>
      <div className="builder-table-footer"><span>{footerHint(view)}</span><span>Printed rails are plastic — only pieces fitted with 9 V metal rails carry power.</span></div>
    </div>
    <aside className={`builder-summary ${summaryCollapsed?'is-collapsed':''}`} aria-label="Build summary sidebar">
      <div className="builder-heading builder-aside-heading"><strong className="builder-aside-label">THIS BUILD</strong><button type="button" className="builder-collapse" aria-label={`${summaryCollapsed?'Expand':'Collapse'} build summary sidebar`} aria-expanded={!summaryCollapsed} aria-controls="builder-summary-content" onClick={()=>setSummaryCollapsed(value=>!value)}>{summaryCollapsed?'‹':'›'}</button></div>
      <div id="builder-summary-content" className="builder-summary-content" hidden={summaryCollapsed}><p>{plural(project.routes.filter(route=>route.pieces.length).length,'route')} · {plural(fit.crossings.length,'crossing')} · {(fit.sections.reduce((sum,section)=>sum+section.run,0)/1000).toFixed(1)} m of track</p>
      <div className="builder-tally"><button type="button" className={ownedShort?'is-short':''} title="Edit the track you own" onClick={()=>onOpenSetup()}><span className="lime">●</span> Your track <strong>{ownedUsed} / {ownedStock} owned</strong></button>
      {inventoryCue&&<p className="builder-inventory-cue">Typical starter set · 8 straights, 16 curves · <button type="button" onClick={()=>onOpenSetup()}>Edit</button></p>}<div><span className="orange">●</span> To print <strong>{!fastAvailable||printedCount===0?plural(printedCount,'piece'):
        [printedStyles.detailed?`${printedStyles.detailed} detailed`:'',printedStyles.fast?`${printedStyles.fast} fast`:''].filter(Boolean).join(' · ')}</strong></div><CommunityRows items={community.pieces} label="Community pieces to print"/>
      <div><span className="blue">●</span> Supports <strong>{fit.supports.length} · {project.mounting==='reversible'?'freestanding':'anchored'}</strong></div><div><span className="blue">●</span> Furniture <strong>{project.furniture.length} placed</strong></div>
      <CommunityRows items={community.furniture} label="Community furniture"/></div>
      <div className="builder-heading checks"><strong>CHECKS</strong></div>
      <ChecksPanel checks={checks} selectedId={check?.id??null} onSelect={setCheckId} onFix={item=>{if(item.fix)commit(item.fix.apply(project));}}
        extra={item=>item.action==='close-gap'?item.gap&&<button type="button" className="builder-check-action" title="Join the two ends with a made-to-measure printed piece"
          onClick={()=>{setArmed(null);setArmedFurniture(false);setSelected(null);gap.show(item.gap!);}}>Close this gap</button>:
          item.action==='add-cars'?<button type="button" className="builder-check-action" onClick={()=>onOpenSetup('car')}>Add cars in Setup</button>:
          item.action==='room-size'?<button type="button" className="builder-check-action" onClick={()=>onOpenSetup('roomWidth')}>Set the room size in Setup</button>:null}/>
      </div>
    </aside>
    {shortcutsOpen&&<ShortcutSheet onClose={()=>setShortcutsOpen(false)}/>}
  </div>;
}
