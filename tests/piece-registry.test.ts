import { describe, expect, it } from 'vitest';
import parity from './fixtures/registry-parity.json';
import { createProject, parseProject, serializeProject, type RoutePiece, type WorkshopProject } from '../src/domain/project';
import { PIECE_DEFINITIONS, compositeLength, compositeSlice, gaugesMate, piecePaths, piecePorts, primaryEnd, splitComposite, tieStations, type CompositeTrack, type ShapePort } from '../src/domain/pieces';
import { BRICK_TRACK } from '../src/domain/track';
import { portsMatch } from '../src/domain/route';
import { fitProject } from '../src/fitting/fit';
import { placePiece, previewPiece, rebuildPiecePoints, setPieceParam, setPieceState, unoccupiedPiecePorts } from '../src/editor/operations';
import { routePath, samplePath } from '../src/drive/traversal';

/** Families and variants recorded from the pre-registry geometry (tests/fixtures/registry-parity.json). */
const LEGACY_FAMILIES = ['brick_straight_nominal','brick_curve_r40','printed_straight','vertical_transition','bridge_deck','printed_curve_r56',
  'printed_brick_straight','printed_curve_r40','brick_flex','printed_flex','brick_switch_left','brick_switch_right',
  'printed_switch_left','printed_switch_right','brick_crossing90','printed_crossing90','brick_double_crossover','printed_double_crossover'];
function variants(family: string): Partial<RoutePiece>[] {
  if (['brick_curve_r40','printed_curve_r40','printed_curve_r56'].includes(family))
    return [{sweep:Math.PI/8},{sweep:-Math.PI/8},...(family==='printed_curve_r56'?[{sweep:Math.PI/4},{sweep:0.3}]:[])];
  if (family==='vertical_transition') return [{rise:8},{rise:-8},{rise:40},{rise:0}];
  if (family.endsWith('_flex')) return [{},{bend:0.05},{bend:-Math.PI/32}];
  if (/_(switch_left|switch_right|double_crossover)$/.test(family)) return [{},{state:'straight'},{state:'diverging'}];
  return [{}];
}
const POSES = [{x:500,y:500,z:0,heading:0},{x:1234.5,y:321.25,z:40,heading:0.7},{x:900,y:800,z:0,heading:-2.3}];
function single(family: string, extra: Partial<RoutePiece> = {}, pose = POSES[0]): WorkshopProject {
  const project = createProject('Registry');
  project.id='p';project.revision='r';project.layoutRevision='r';
  const route = { id:'route', name:'Track', pieces:[{ id:'piece', family, ...pose, ...extra }], points:[] };
  rebuildPiecePoints(project, route); project.routes=[route];
  return project;
}
/** Digest of an output, ignoring fields the registry added (port/path gauge, path states). */
async function digest(value: unknown): Promise<string> {
  const text = JSON.stringify(value, (key, item) => key==='gauge'||key==='states' ? undefined : item);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2,'0')).join('').slice(0,16);
}

describe('piece registry parity with the pre-registry track', () => {
  it('reproduces every legacy family\'s paths, ports and chain end exactly', async () => {
    const cases: {label:string;value:unknown}[] = [];
    for (const family of LEGACY_FAMILIES) for (const extra of variants(family)) for (const pose of POSES) {
      const project = single(family, extra, pose), piece = project.routes[0].pieces[0];
      cases.push({label:`${family} ${JSON.stringify(extra)} ${JSON.stringify(pose)}`,
        value:{ input:{family,...extra,...pose}, paths:piecePaths(piece,project), ports:piecePorts(piece,project), end:primaryEnd(piece,project) }});
    }
    const digests = await Promise.all(cases.map(item => digest(item.value)));
    expect(cases.filter((_, index) => digests[index] !== parity.geometry[index]).map(item => item.label)).toEqual([]);
    expect(digests).toHaveLength(parity.geometry.length);
  });

  it('fits, drives and parameterises every legacy family exactly as before, on both printers and track systems', async () => {
    const cases: {label:string;value:unknown}[] = [];
    for (const family of LEGACY_FAMILIES) for (const extra of variants(family)) for (const printer of ['X1 Carbon','A1 mini'] as const)
      for (const style of family.startsWith('brick_') ? [undefined] : [undefined, 'fast'] as const)
        for (const system of ['brick-v1','custom-joiner-v1'] as const) {
          if (system==='custom-joiner-v1' && style) continue;
          const project = single(family, {...extra, ...(style?{style}:{})});
          project.printer = printer; project.trackSystem = system;
          if (system==='custom-joiner-v1') {
            for (const [key,value] of Object.entries({railGauge:38,railInterfaceWidth:12,railBodyWidth:60,railBaseThickness:3,railHeight:5}))
              project.measurements[key as 'railGauge']={value,source:'fixture',measuredAt:'2026-09-25'};
            project.partDesign={joint_width:6,joint_depth:5,joint_height:2,joint_clearance:.2,deck_width:70,deck_thickness:6};
          }
          const fit = fitProject(project), path = routePath(fit.sections,'route');
          cases.push({label:`${family} ${JSON.stringify(extra)} ${printer} ${style} ${system}`,
            value:{ input:{family,...extra,printer,style,system}, fit, drive:{length:path.length,gap:path.gap,
              samples:path.gap?[]:[0,.25,.5,.75,1].map(t=>samplePath(path,path.length*t))} }});
        }
    const digests = await Promise.all(cases.map(item => digest(item.value)));
    expect(cases.filter((_, index) => digests[index] !== parity.fits[index]).map(item => item.label)).toEqual([]);
    expect(digests).toHaveLength(parity.fits.length);
  });

  it('registers each family once, with owned pieces never printable and every printed shape linked to its owned counterpart', () => {
    const families = PIECE_DEFINITIONS.map(definition => definition.family);
    expect(new Set(families).size).toBe(families.length);
    expect(families).toEqual(expect.arrayContaining(LEGACY_FAMILIES));
    for (const definition of PIECE_DEFINITIONS) {
      if (definition.source === 'owned') expect(definition.styles, definition.family).toEqual([]);
      if (definition.owned) expect(families, definition.family).toContain(definition.owned.family);
    }
  });
});

describe('saved projects', () => {
  it('migrates a saved switchState to state and keeps the routing', () => {
    const project = single('brick_switch_left');
    const saved = JSON.parse(serializeProject(project));
    delete saved.routes[0].pieces[0].state;
    saved.routes[0].pieces[0].switchState = 'diverging';
    const loaded = parseProject(JSON.stringify(saved));
    expect(loaded.routes[0].pieces[0]).not.toHaveProperty('switchState');
    expect(loaded.routes[0].pieces[0].state).toBe('diverging');
    expect(piecePaths(loaded.routes[0].pieces[0], loaded).map(path => [path.id, path.enabled])).toEqual([['main', false], ['branch', true]]);
    expect(fitProject(loaded).partInstances[0].parameters.switch_state).toBe(1);
  });

  it('rejects states, parameters and fields a family does not declare', () => {
    const load = (piece: Record<string, unknown>) => {
      const saved = JSON.parse(serializeProject(single('brick_switch_left')));
      saved.routes[0].pieces[0] = { ...saved.routes[0].pieces[0], ...piece };
      return () => parseProject(JSON.stringify(saved));
    };
    expect(load({state:'crossed'})).toThrow(/Invalid authored pieces/);
    expect(load({family:'brick_crossing90',switchState:'straight'})).toThrow(/Invalid authored pieces/);
    expect(load({family:'printed_track',params:{length:4000}})).toThrow(/Invalid authored pieces/);
    expect(load({family:'printed_track',params:{gauge:1}})).toThrow(/Invalid authored pieces/);
    expect(load({family:'brick_straight_nominal',style:'fast'})).toThrow(/Invalid authored pieces/);
    expect(load({family:'printed_track',params:{length:512}})()).toBeTruthy();
  });
});

describe('port gauges', () => {
  it('mates equal gauges, and dual gauge with standard and narrow only', () => {
    expect(gaugesMate('standard','standard')).toBe(true);
    expect(gaugesMate('standard','narrow')).toBe(false);
    expect(gaugesMate('dual','narrow')).toBe(true);
    expect(gaugesMate('standard','dual')).toBe(true);
    expect(gaugesMate('dual','monorail')).toBe(false);
    expect(gaugesMate('monorail','monorail')).toBe(true);
  });

  it('snaps a new piece only onto an open port of a compatible gauge', () => {
    const project = single('printed_brick_straight');
    const [candidate] = unoccupiedPiecePorts(project).filter(item => item.port.id === 'out');
    const at = (gauge: ShapePort['gauge']) => previewPiece(project,'printed_brick_straight',{x:candidate.port.x+3,y:candidate.port.y},30,
      [{...candidate,port:{...candidate.port,gauge}}]).routeId;
    expect(at('standard')).toBe('route');
    expect(at('dual')).toBe('route');
    expect(at('narrow')).toBeNull();
    expect(at('monorail')).toBeNull();
  });
});

describe('piece states', () => {
  it('enables exactly the paths listed for the current state, and traversal follows them', () => {
    let project = single('printed_double_crossover');
    const enabled = () => piecePaths(project.routes[0].pieces[0], project).filter(path => path.enabled).map(path => path.id);
    expect(enabled()).toEqual(['main','parallel']);
    project = setPieceState(project,'piece','diverging');
    expect(enabled()).toEqual(['cross','cross-back']);
    expect(fitProject(project).sections.map(section => [section.pathId, section.enabled]))
      .toEqual([['main',false],['parallel',false],['cross',true],['cross-back',true]]);
    const crossing = single('printed_crossing90');
    expect(piecePaths(crossing.routes[0].pieces[0], crossing).every(path => path.enabled)).toBe(true);
    expect(() => setPieceState(crossing,'piece','straight')).toThrow(/turnout/);
    expect(() => setPieceState(project,'piece','sideways')).toThrow(/Invalid piece state/);
  });
});

describe('printed track (composite)', () => {
  const straight = (len: number): CompositeTrack =>
    ({segments:[{len,k0:0,k1:0}],z0:0,z1:0,grade0:0,grade1:0,cant0:0,cant1:0,vcurve:0});

  it('lists full-tie centres inward from both ends with the residual in the middle', () => {
    expect(tieStations(128)).toEqual([32,64,96]);
    expect(tieStations(160)).toEqual([32,64,96,128]);
    expect(tieStations(200)).toEqual([32,64,100,136,168]);
    expect(tieStations(40)).toEqual([]);
  });

  it('cuts at tie stations into the fewest, most even parts that fit, and gives up only when a stretch cannot fit', () => {
    const shorter = (limit: number) => (part: CompositeTrack) => compositeLength(part) <= limit + 1e-9;
    expect(splitComposite(straight(200), shorter(232))).toEqual([0,200]);
    expect(splitComposite(straight(500), shorter(232))).toEqual([0,160,340,500]);
    // Every cut lies on a parent tie centre, so each part's own modular ties land on the parent's.
    for (const cut of splitComposite(straight(1000), shorter(156))!.slice(1,-1)) expect(tieStations(1000)).toContain(cut);
    expect(splitComposite(straight(100), shorter(40))).toEqual([0,32,68,100]);
    expect(splitComposite(straight(100), shorter(30))).toBeNull();
    const canted = {...straight(500), cant0:2, cant1:2};
    expect(splitComposite(canted, shorter(232))).toBeNull();
  });

  it('slices curvature, height and grade continuously', () => {
    const clothoid: CompositeTrack = {segments:[{len:100,k0:0,k1:0.004},{len:50,k0:0.004,k1:0.004}],z0:0,z1:9,grade0:0,grade1:0,cant0:0,cant1:0,vcurve:0};
    const first = compositeSlice(clothoid,0,60), second = compositeSlice(clothoid,60,150);
    expect(first.segments).toEqual([{len:60,k0:0,k1:expect.closeTo(0.0024,12)}]);
    expect(second.segments[0]).toMatchObject({len:40,k0:expect.closeTo(0.0024,12),k1:0.004});
    expect(first.z1 + second.z1).toBeCloseTo(9, 9);
    expect(first.grade1).toBeCloseTo(second.grade0, 12);
    expect(second.z0).toBe(0);
  });

  it('splits a long straight into standalone parts whose ports meet, without changing traversal or supports', () => {
    const project = single('printed_track', {params:{length:1000}});
    const reference = single('printed_track', {params:{length:200}});
    for (const printer of ['X1 Carbon','A1 mini'] as const) {
      project.printer = printer;
      const fit = fitProject(project), parts = fit.partInstances.filter(part => part.family==='composite_track');
      const usable = (printer==='X1 Carbon' ? 256 : 180) - 14 - 10;
      expect(fit.issues.filter(issue => issue.severity==='error')).toEqual([]);
      expect(fit.sections).toHaveLength(1);
      // Cuts fall on 32 mm tie stations, so at most one more part than a free cut would need.
      expect(parts.length).toBeGreaterThanOrEqual(Math.ceil(1000/usable));
      expect(parts.length).toBeLessThanOrEqual(Math.ceil(1000/usable)+1);
      expect(parts.every(part => part.sectionId==='piece' && part.parameters.ends===3 && part.parameters.s0_len<=usable)).toBe(true);
      expect(parts.reduce((sum, part) => sum + part.parameters.s0_len, 0)).toBeCloseTo(1000, 9);
      for (let index = 1; index < parts.length; index++) {
        const before = parts[index-1], after = parts[index];
        if (before.interfaceKind!=='rail' || after.interfaceKind!=='rail') throw new Error('rail parts expected');
        expect(portsMatch(before.endPort, after.startPort, 1e-9)).toBe(true);
      }
      const path = routePath(fit.sections,'route');
      expect(path.gap).toBeNull();
      expect(path.length).toBeCloseTo(1000, 9);
      expect(samplePath(path, 1000)).toMatchObject({x:expect.closeTo(1500,9),y:expect.closeTo(500,9)});
      expect(fit.supports).toEqual([]);
    }
    const whole = fitProject(reference).partInstances;
    expect(whole.map(part => part.id)).toEqual(['piece']);
    expect(whole[0].parameters).toMatchObject({segments:1,s0_len:200,s0_k0:0,s0_k1:0,z0:0,z1:0,grade0:0,grade1:0,vcurve:0,cant0:0,cant1:0,ends:3,
      connector_version:BRICK_TRACK.version});
  });

  it('splits a wide curve so each part fits the plate and the chain still ends at the piece end', () => {
    const project = single('printed_track', {params:{radius:800,sweep:60}});
    const fit = fitProject(project), parts = fit.partInstances;
    expect(fit.issues.filter(issue => issue.severity==='error')).toEqual([]);
    expect(parts.length).toBeGreaterThan(1);
    const last = parts.at(-1)!;
    if (last.interfaceKind!=='rail') throw new Error('rail part expected');
    const end = primaryEnd(project.routes[0].pieces[0], project);
    expect(last.endPort.pose.x).toBeCloseTo(end.x, 6);
    expect(last.endPort.pose.y).toBeCloseTo(end.y, 6);
    expect(last.endPort.pose.heading).toBeCloseTo(end.heading, 9);
    expect(parts.every(part => part.parameters.s0_k0===1/800)).toBe(true);
  });

  it('edits a parameter as one undoable change that carries the rest of the chain', () => {
    let [project] = placePiece(createProject('Params'),'printed_track',{x:100,y:100,params:{length:128}});
    const id = project.routes[0].pieces[0].id;
    [project] = placePiece(project,'printed_brick_straight',{x:228,y:100});
    const longer = setPieceParam(project,id,'length',256);
    expect(longer.routes).toHaveLength(1);
    expect(longer.routes[0].pieces[1]).toMatchObject({x:356,y:100});
    expect(setPieceParam(longer,id,'length',256)).toBe(longer);
    expect(() => setPieceParam(project,id,'length',5000)).toThrow(/Length/);
    expect(() => setPieceParam(project,id,'twist',1)).toThrow(/no twist/);
  });
});
