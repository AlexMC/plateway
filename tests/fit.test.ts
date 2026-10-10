import { describe, expect, it } from 'vitest';
import { createProject, setMeasurement, type WorkshopProject } from '../src/domain/project';
import { portsMatch } from '../src/domain/route';
import { BRICK_TRACK } from '../src/domain/track';
import { primaryEnd } from '../src/domain/pieces';
import { fitProject, pieceParts } from '../src/fitting/fit';
import { createStandardProject } from '../src/editor/setup-defaults';
import { placePiece, type Placement, type TileFamily } from '../src/editor/operations';
import { routePath, samplePath } from '../src/drive/traversal';

function customJoiner(project: WorkshopProject) {
  project.trackSystem = 'custom-joiner-v1';
  for (const [key,value] of Object.entries({railGauge:38,railInterfaceWidth:12,railBodyWidth:60,railBaseThickness:3,railHeight:5})) {
    project.measurements[key as keyof typeof project.measurements]={value,source:'Synthetic test fixture',measuredAt:'2026-09-25'};
  }
  project.partDesign = { ...project.partDesign, joint_width: 6, joint_depth: 5, joint_height: 2, joint_clearance: .2 };
}
/** Adds a piece at the open end of the last route. */
function extend(project: WorkshopProject, family: TileFamily, placement: Partial<Placement> = {}): WorkshopProject {
  const last = project.routes.at(-1)!.pieces.at(-1)!;
  const end = primaryEnd(last, project);
  return placePiece(project, family, { x: end.x, y: end.y, heading: end.heading, ...placement })[0];
}

describe('tile fitting',()=>{
  it('rejects a ramp longer than the measured ramp space',()=>{
    const project=placePiece(createProject('Ramp space'),'vertical_transition',{x:100,y:100,rise:8})[0];
    expect(fitProject(project).geometryFeasible).toBe(true);
    const tight=setMeasurement(project,'availableApproachRun',150);
    const fit=fitProject(tight);
    expect(fit.issues).toContainEqual(expect.objectContaining({code:'grade-unfitted',severity:'error'}));
    expect(fit.sections[0].kind).toBe('unresolved');
    expect(fit.partInstances).toHaveLength(0);
  });

  it('splits a ramp into continuous printable modules on a small printer',()=>{
    const project=placePiece(createProject('Ramp modules'),'vertical_transition',{x:100,y:100,rise:8})[0];
    project.printer='A1 mini';
    const fit=fitProject(project), transitions=fit.sections.filter(s=>s.kind==='transition');
    expect(transitions.length).toBeGreaterThan(1);
    expect(transitions.every(s=>s.run<=180-14-10 && s.parameters.rise>0)).toBe(true);
    expect(transitions[0].start.pose.pitch).toBe(0);
    expect(transitions.at(-1)?.end.pose.pitch).toBeCloseTo(0);
    for (let i=1;i<transitions.length;i++) expect(portsMatch(transitions[i-1].end,transitions[i].start)).toBe(true);
    expect(fit.issues.some(i=>i.code==='port-discontinuity')).toBe(false);
  });

  it.each(['printed_straight','bridge_deck'] as const)('rejects a %s longer than the A1 mini plate allows',family=>{
    const project=placePiece(createProject('Plate length'),family,{x:500,y:500})[0];
    expect(fitProject(project).geometryFeasible).toBe(true);
    project.printer='A1 mini';
    const fit=fitProject(project);
    expect(fit.issues).toContainEqual(expect.objectContaining({code:'piece-too-long',message:'Too long for the selected printer; use a shorter piece.'}));
    expect(fit.partInstances.some(part=>part.family===family)).toBe(false);
  });

  it('withholds CAD generation inputs when a custom rail dimension is only a default',()=>{
    const project=createProject('Unmeasured profile');customJoiner(project);
    project.measurements.railHeight={value:5,source:'Default',status:'estimate'};
    const fit=fitProject(placePiece(project,'printed_straight',{x:500,y:500})[0]);
    expect(fit.partInstances[0].geometryAvailable).toBe(false);
    expect(fit.partInstances[0].parameters).not.toHaveProperty('rail_height');
    expect(fit.issues.some(i=>i.code==='cad-profile-unmeasured')).toBe(true);
  });

  it('blocks a custom-joiner seam between owned brick and printed track',()=>{
    let project=createProject('Mixed');customJoiner(project);
    project.inventory.brick_straight_nominal=1;
    project=placePiece(project,'brick_straight_nominal',{x:0,y:0})[0];
    project=extend(project,'vertical_transition',{rise:6});
    const result=fitProject(project);
    expect(result.issues.some(issue=>issue.code==='brick-coupling-unfitted')).toBe(true);
    expect(result.geometryFeasible).toBe(false);
  });

  it('asks CAD for the library connector on assemblies and names each assembly failure',()=>{
    const project=placePiece(createProject('Turnout'),'printed_switch_left',{x:500,y:500})[0];
    const turnout=fitProject(project).partInstances.find(part=>part.family==='printed_switch_left');
    expect(turnout?.parameters.connector_version).toBe(BRICK_TRACK.version);
    const custom=structuredClone(project);custom.trackSystem='custom-joiner-v1';
    expect(fitProject(custom).issues).toContainEqual(expect.objectContaining({code:'assembly-track-system',message:'Needs standard brick track.'}));
    const low=structuredClone(project);
    low.routes[0].pieces[0].z=-1;low.routes[0].points.forEach(point=>{point.z-=1;});
    expect(fitProject(low).issues).toContainEqual(expect.objectContaining({code:'below-table',message:'Below the table — raise it.'}));
  });

  it('reports one inventory shortfall per owned shape naming the extra pieces',()=>{
    let project=createProject('Shortfall');
    project.inventory.brick_straight_nominal=1;
    project=placePiece(project,'brick_straight_nominal',{x:500,y:500})[0];
    project=extend(project,'brick_straight_nominal');
    project=extend(project,'brick_straight_nominal');
    const pieces=project.routes[0].pieces;
    expect(pieces).toHaveLength(3);
    const fit=fitProject(project);
    const shortfalls=fit.issues.filter(issue=>issue.code==='owned-piece-unavailable');
    expect(shortfalls).toEqual([expect.objectContaining({severity:'warning',message:'2 more Straight than you own.',
      shortfall:{family:'brick_straight_nominal',used:3,owned:1,pieceIds:[pieces[1].id,pieces[2].id]}})]);
    expect(fit.geometryFeasible).toBe(true);
    project.inventory.brick_straight_nominal=3;
    expect(fitProject(project).issues.some(issue=>issue.code==='owned-piece-unavailable')).toBe(false);
  });

  it('uses actual R40 and printed R56 arcs rather than fitting either as straight lines',()=>{
    const project=createProject('Two selected curve families');
    project.inventory.brick_curve_r40=1;
    const owned=placePiece(project,'brick_curve_r40',{x:10,y:20})[0];
    const printed=placePiece(owned,'printed_curve_r56',{x:700,y:700,sweep:-Math.PI/8})[0];
    const fit=fitProject(printed);
    expect(fit.sections.map(section=>section.family)).toEqual(['brick_curve_r40','printed_curve']);
    expect(fit.sections.map(section=>section.kind)).toEqual(['curve','curve']);
    expect(fit.sections[0].arc?.radius).toBe(320);
    expect(fit.sections[1].arc?.radius).toBe(448);
    expect(fit.sections[1].arc?.sweep).toBeCloseTo(-Math.PI/8);
    expect(fit.issues.some(issue=>issue.code==='curve-unfitted' || issue.code==='owned-piece-unavailable')).toBe(false);
    const path=routePath(fit.sections,printed.routes[1].id);
    expect(path.gap).toBeNull();
    expect(path.length).toBeCloseTo(448*Math.PI/8);
    expect(samplePath(path,path.length/2)?.heading).toBeCloseTo(-Math.PI/16);
  });

  it('rejects a printed quarter arc that fits neither printer plate',()=>{
    const project=placePiece(createProject('Unprintable arc'),'printed_curve_r56',{x:900,y:900,sweep:Math.PI/2})[0];
    for (const printer of ['X1 Carbon','A1 mini'] as const) {
      project.printer=printer;
      const fit=fitProject(project);
      expect(fit.issues.some(issue=>issue.code==='curve-unfitted')).toBe(true);
      expect(fit.partInstances.some(part=>part.family==='printed_curve')).toBe(false);
    }
  });

  it.each(['roomWidth', 'roomDepth'] as const)('fails tiles outside an entered %s, and holds track to an estimated one as the room drawn', key => {
    const [project] = placePiece(createProject('Optional boundary'), 'printed_straight', { x: 500, y: 500 });
    project.measurements[key] = { value: 100, source: 'Default', status: 'estimate' };
    const estimated = fitProject(project);
    expect(estimated.sections[0].kind).not.toBe('unresolved');
    expect(estimated.issues.filter(issue=>issue.severity==='error').map(issue=>issue.code)).toEqual(['track-outside-room']);
    const entered = setMeasurement(project, key, 100);
    const result = fitProject(entered);
    expect(result.sections[0].kind).toBe('unresolved');
    expect(result.issues).toContainEqual(expect.objectContaining({code:'piece-outside-room',severity:'error'}));
    expect(fitProject(setMeasurement(entered, key, null)).geometryFeasible).toBe(true);
  });

  it('places supports for the selected mounting mode',()=>{
    let project=placePiece(createProject('Raised'),'vertical_transition',{x:100,y:500,rise:40})[0];
    project=extend(project,'printed_straight');
    let fit=fitProject(project);
    expect(fit.supports.length).toBeGreaterThan(0);
    expect(fit.supports.every(support=>support.family==='reversible_column')).toBe(true);
    expect(fit.partInstances.find(part=>part.family==='reversible_column')?.geometryAvailable).toBe(false);
    expect(fit.issues.some(issue=>issue.code==='support-design-incomplete')).toBe(true);
    project.mounting='anchored';
    project.partDesign={reach:40,plate_width:24,plate_thickness:5,arm_width:8,arm_thickness:8,
      hole_diameter:5,hole_spacing:35,seat_width:24,seat_depth:20,seat_thickness:5};
    fit=fitProject(project);
    const bracket=fit.partInstances.find(part=>part.family==='anchored_bracket');
    expect(bracket?.geometryAvailable).toBe(true);
    if (bracket?.interfaceKind==='mounting') {
      expect(bracket.parameters.height).toBe(bracket.mountingSeat.z);
      expect(bracket.pose.x).toBeCloseTo(bracket.mountingSeat.x-40*Math.cos(bracket.mountingSeat.heading));
    }
    expect(fit.supports.every(support=>support.family==='anchored_bracket')).toBe(true);
  });
});

it('fits a shared R56 rail on X1 Carbon independently of room heading, but not on A1 mini', () => {
  for (const heading of [0, Math.PI / 2]) {
    const project = placePiece(createProject('Shared curve footprint'), 'printed_curve_r56',
      { x: 500, y: 500, heading, sweep: Math.PI / 8 })[0];
    expect(fitProject(project).partInstances.find(part => part.family === 'printed_curve')?.geometryAvailable).toBe(true);
    project.printer = 'A1 mini';
    expect(fitProject(project).sections.some(section => section.kind === 'unresolved')).toBe(true);
  }
});

it('describes an unplaced piece with the parts fit makes once it is placed (composite track unsplit)', () => {
  const project = createStandardProject('Unplaced parts');
  const own = ([placed, id]: [WorkshopProject, string]) => {
    const piece = placed.routes.flatMap(route => route.pieces).find(item => item.id === id)!;
    const shape = ({ id, family, parameters }: { id: string; family: string; parameters: Record<string, number> }) => ({ id, family, parameters });
    return { unplaced: pieceParts(piece, placed).map(shape), fitted: fitProject(placed).partInstances.filter(part => part.sectionId === id).map(shape) };
  };
  const turnout = own(placePiece(project, 'turnout_radius', { x: 600, y: 600, params: { servo: 1 } }));
  expect(turnout.unplaced).toEqual(turnout.fitted);
  expect(turnout.unplaced[0].parameters.servo).toBe(1);
  const shelf = own(placePiece(project, 'track_straight', { x: 600, y: 600, z: 80,
    params: { length: 512, bracket: 2, bracket_spacing: 128, bracket_height: 40 } }));
  const brackets = (parts: typeof shelf.fitted) => parts.filter(part => part.family === 'track_bracket');
  expect(brackets(shelf.unplaced)).toHaveLength(4);
  expect(brackets(shelf.unplaced)).toEqual(brackets(shelf.fitted));
  expect(shelf.unplaced.filter(part => part.family === 'composite_track')).toHaveLength(1);
});
