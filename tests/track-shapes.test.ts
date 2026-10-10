import { describe, expect, it } from 'vitest';
import { createProject, parseProject, serializeProject, type RoutePiece, type WorkshopProject } from '../src/domain/project';
import { FLEX_MAX_BEND, OWNED_DEFINITIONS, counterpartFamily, piecePorts, primaryEnd } from '../src/domain/pieces';
import { placePiece, previewPiece, rebuildPiecePoints, setFlexBend, setPieceState } from '../src/editor/operations';
import { fitProject } from '../src/fitting/fit';
import { routePath, samplePath } from '../src/drive/traversal';
import { currentInspectionMesh, type InspectionMesh } from '../src/drive/scene';

function authored(family:RoutePiece['family'], extra:Partial<RoutePiece>={}):WorkshopProject {
  const project=createProject('Track geometry regression');
  const piece:RoutePiece={id:'piece',family,x:500,y:500,z:0,heading:0,...extra};
  const route={id:'route',name:'Track',pieces:[piece],points:[]};
  rebuildPiecePoints(project,route);project.routes=[route];
  return project;
}

describe('current-compatible official track range',()=>{
  it('keeps one physical instance per assembly while exposing each independent route path',()=>{
    for (const shape of OWNED_DEFINITIONS) for (const family of [shape.family,counterpartFamily(shape.family,'printed')!]) {
      const project=authored(family,shape.legacy?.sweep!==undefined?{sweep:Math.PI/8}:{});
      const fit=fitProject(project);
      expect(fit.issues.filter(issue=>issue.severity==='error'),family).toEqual([]);
      expect(fit.partInstances.map(part=>part.source),family).toEqual([family===shape.family?'owned':'printed']);
      expect(fit.partInstances[0].id).toBe('piece');
      if (shape.family==='brick_crossing90') expect(fit.sections.map(section=>section.pathId)).toEqual(['main','crossing']);
      if (shape.family==='brick_double_crossover') expect(fit.sections.map(section=>section.pathId)).toEqual(['main','parallel','cross','cross-back']);
      expect(fit.crossings).toEqual([]);
      expect(parseProject(serializeProject(project)).routes).toEqual(project.routes);
    }
  });

  it('preserves physical left/right handedness and cardinal crossing ports in CAD coordinates',()=>{
    const right=authored('printed_switch_right'),left=authored('brick_switch_left');
    const rightBranch=piecePorts(right.routes[0].pieces![0],right).find(port=>port.id==='branch')!;
    const leftBranch=piecePorts(left.routes[0].pieces![0],left).find(port=>port.id==='branch')!;
    // LDraw 53404 transformed to Z-up: right branch is (261.5408, -103.6412).
    expect(rightBranch.x).toBeCloseTo(761.5408,2);
    expect(rightBranch.y).toBeCloseTo(396.3588,2);
    expect(rightBranch.heading).toBeCloseTo(-Math.PI/8);
    expect(leftBranch.y).toBeCloseTo(603.6412,2);
    expect(leftBranch.heading).toBeCloseTo(Math.PI/8);
    const crossing=authored('printed_crossing90'),ports=piecePorts(crossing.routes[0].pieces![0],crossing);
    expect(ports.find(port=>port.id==='north')).toMatchObject({x:564,y:564});
    expect(ports.find(port=>port.id==='south')).toMatchObject({x:564,y:436});
  });

  it('keeps prepared-layout revisions current when reselecting effective switch and flex settings',()=>{
    const turnout=authored('printed_switch_right'),flex=authored('printed_flex');
    const straight=setPieceState(turnout,'piece','straight'),zero=setFlexBend(flex,'piece',0);
    expect(straight.layoutRevision).toBe(turnout.layoutRevision);
    expect(straight.revision).toBe(turnout.revision);
    expect(zero.layoutRevision).toBe(flex.layoutRevision);
    expect(zero.revision).toBe(flex.revision);
    expect(setPieceState(turnout,'piece','diverging').layoutRevision).not.toBe(turnout.layoutRevision);
    expect(setFlexBend(flex,'piece',FLEX_MAX_BEND).layoutRevision).not.toBe(flex.layoutRevision);
    expect(()=>setPieceState(flex,'piece','straight')).toThrow(/turnout/);
    expect(()=>setFlexBend(turnout,'piece',0)).toThrow(/flexible/);
  });

  it('snaps a branch into its own connected route and does not reuse the occupied branch port',()=>{
    let project=authored('brick_switch_left');
    const branch=piecePorts(project.routes[0].pieces![0],project).find(port=>port.id==='branch')!;
    const preview=previewPiece(project,'printed_brick_straight',{x:branch.x+2,y:branch.y+1});
    expect(preview.portId).toBe('branch');expect(preview.edge).toBeNull();
    let id:string;[project,id]=placePiece(project,'printed_brick_straight',{x:branch.x+2,y:branch.y+1});
    expect(project.routes).toHaveLength(2);
    const placed=project.routes[1].pieces![0];
    expect(placed).toMatchObject({id,x:branch.x,y:branch.y,z:branch.z,heading:branch.heading});
    expect(previewPiece(project,'printed_brick_straight',{x:branch.x,y:branch.y},1).routeId).toBeNull();
    expect(project.crossings).toEqual([]);
  });

  it('routes through the selected turnout outlet across route boundaries without moving the main port',()=>{
    let project=authored('brick_switch_right');
    const main=primaryEnd(project.routes[0].pieces![0],project);
    const branch=piecePorts(project.routes[0].pieces![0],project).find(port=>port.id==='branch')!;
    [project]=placePiece(project,'printed_brick_straight',{x:main.x,y:main.y});
    [project]=placePiece(project,'printed_brick_straight',{x:branch.x,y:branch.y});
    let path=routePath(fitProject(project).sections,'route');
    expect(path.gap).toBeNull();expect(path.sections.map(section=>section.pathId??'rail')).toEqual(['main','rail']);
    expect(samplePath(path,path.length)?.y).toBeCloseTo(500);
    const before=project;project=setPieceState(project,'piece','diverging');
    expect(before.routes[0].pieces![0].state).toBeUndefined();
    expect(primaryEnd(project.routes[0].pieces![0],project)).toEqual(main);
    path=routePath(fitProject(project).sections,'route');
    expect(path.gap).toBeNull();expect(path.sections.map(section=>section.pathId??'rail')).toEqual(['branch','rail']);
    const finish=samplePath(path,path.length)!;
    expect(finish.x).toBeCloseTo(branch.x+128*Math.cos(branch.heading));
    expect(finish.y).toBeCloseTo(branch.y+128*Math.sin(branch.heading));
  });

  it('switches a double crossover between parallel and crossed paths without duplicating inventory',()=>{
    let project=authored('brick_double_crossover');project.inventory.brick_double_crossover=1;
    let fit=fitProject(project),path=routePath(fit.sections,'route');
    expect(samplePath(path,path.length)).toMatchObject({x:884,y:500});
    project=setPieceState(project,'piece','diverging');fit=fitProject(project);path=routePath(fit.sections,'route');
    expect(samplePath(path,path.length)!.x).toBeCloseTo(884);
    expect(samplePath(path,path.length)!.y).toBeCloseTo(628);
    expect(fit.partInstances.filter(part=>part.family==='brick_double_crossover')).toHaveLength(1);
    expect(fit.issues.filter(issue=>issue.code==='owned-piece-unavailable')).toEqual([]);
    project.inventory.brick_double_crossover=0;fit=fitProject(project);
    expect(fit.issues.find(issue=>issue.code==='owned-piece-unavailable')?.severity).toBe('warning');
    expect(fit.partInstances[0].source).toBe('owned');
  });

  it('enforces signed flex limits, preserves immutable state and repositions the downstream chain',()=>{
    let project=authored('printed_flex');
    [project]=placePiece(project,'printed_brick_straight',{x:532,y:500});
    const before=project;project=setFlexBend(project,'piece',-FLEX_MAX_BEND);
    expect(before.routes[0].pieces![0].bend).toBeUndefined();
    const end=primaryEnd(project.routes[0].pieces![0],project),next=project.routes[0].pieces![1];
    expect(end.x).toBeCloseTo(516+16*Math.cos(FLEX_MAX_BEND));
    expect(end.y).toBeCloseTo(500-16*Math.sin(FLEX_MAX_BEND));
    expect(next).toMatchObject({x:end.x,y:end.y,heading:-FLEX_MAX_BEND});
    expect(routePath(fitProject(project).sections,'route').gap).toBeNull();
    expect(()=>setFlexBend(project,'piece',FLEX_MAX_BEND+1e-6)).toThrow(/5.625/);
    expect(()=>previewPiece(project,'brick_flex',{x:0,y:0,bend:NaN})).toThrow(/5.625/);
    const invalid=structuredClone(project);invalid.routes[0].pieces![0].bend=FLEX_MAX_BEND+1e-6;
    expect(()=>parseProject(JSON.stringify(invalid))).toThrow(/authored/);
  });

  it('keeps internal crossing paths legal while flagging unrelated overlapping rails',()=>{
    let project=authored('printed_crossing90');
    expect(fitProject(project).issues.filter(issue=>issue.severity==='error')).toEqual([]);
    [project]=placePiece(project,'printed_brick_straight',{x:530,y:450,heading:Math.PI/2},0);
    expect(fitProject(project).issues.some(issue=>issue.code==='crossing-clearance')).toBe(true);
  });

  it('preserves curve sign and exact standard printed dimensions',()=>{
    for(const sign of [-1,1]) {
      const project=authored('printed_curve_r40',{sweep:sign*Math.PI/8});
      const end=primaryEnd(project.routes[0].pieces![0],project);
      expect(end.x).toBeCloseTo(500+320*Math.sin(Math.PI/8));
      expect(end.y).toBeCloseTo(500+sign*320*(1-Math.cos(Math.PI/8)));
      expect(fitProject(project).partInstances[0].parameters).toMatchObject({radius:320,sweep:sign*Math.PI/8});
    }
    expect(fitProject(authored('printed_brick_straight')).partInstances[0].parameters.run).toBe(128);
  });

  it('samples crossing secondary and reverse-connected paths without treating them as branch choices',()=>{
    const project=authored('brick_crossing90');
    const fit=fitProject(project),secondary=fit.sections.find(section=>section.pathId==='crossing')!;
    const path=routePath([secondary],'route');
    expect(samplePath(path,64)).toMatchObject({x:564,y:500,heading:Math.PI/2});
    const opposite={...fit.sections[0],id:'opposite',routeId:'opposite',pieceId:'other',pathId:undefined,
      start:{...fit.sections[0].start,pose:{x:756,y:500,z:0,heading:Math.PI,pitch:0}},
      end:{...fit.sections[0].end,pose:{x:628,y:500,z:0,heading:Math.PI,pitch:0}},pathPoints:undefined};
    const connected=routePath([...fit.sections,opposite],'route');
    expect(connected.gap).toBeNull();expect(samplePath(connected,connected.length)!.x).toBeCloseTo(756);
  });

  it('accepts component geometry only with current logical assembly identity',()=>{
    const fit=fitProject(authored('printed_flex')),part=fit.partInstances[0];
    const mesh:InspectionMesh={sectionId:part.sectionId,interfaceKind:'track-assembly',layoutRevision:fit.layoutRevision,
      parameters:{component:2},assemblyParameters:{...part.parameters},componentRole:'pivot',pose:part.pose,
      digest:'a'.repeat(64),requestDigest:'b'.repeat(64),url:'/component.stl'};
    expect(currentInspectionMesh(fit,part,mesh)).toBe(true);
    expect(currentInspectionMesh(fit,part,{...mesh,assemblyParameters:{...part.parameters,bend:0.1}})).toBe(false);
    expect(currentInspectionMesh(fit,part,{...mesh,assemblyParameters:undefined})).toBe(false);
  });
});
