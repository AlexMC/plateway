import { describe, expect, it } from 'vitest';
import { createProject, type WorkshopProject } from '../src/domain/project';
import { piecePorts, primaryEnd } from '../src/domain/pieces';
import { fitProject } from '../src/fitting/fit';
import { flipPiece, movePieceRoute, placePiece, previewPiece, removePiece, rotatePieceRoute, setPieceSource, setRampRise, unoccupiedPiecePorts } from '../src/editor/operations';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RouteEditor } from '../src/editor/app';

/** Lay `count` pieces in one route, each snapped onto the previous open end. */
function chain(project: WorkshopProject, family: 'printed_curve_r40', count: number, start: { x: number; y: number; heading?: number }) {
  project = placePiece(project, family, { ...start, sweep: Math.PI / 8 })[0];
  const route = project.routes.at(-1)!;
  for (let index = 1; index < count; index++) {
    const end = primaryEnd(project.routes.find(item => item.id === route.id)!.pieces.at(-1)!, project);
    project = placePiece(project, family, { x: end.x, y: end.y, sweep: Math.PI / 8 })[0];
  }
  return project;
}

describe('route editor geometry', () => {
  it('snaps within 30 mm to the open port but starts a second route when farther away', () => {
    let project=createProject('Snap');project.inventory.brick_straight_nominal=4;
    const first=placePiece(project,'brick_straight_nominal',{x:100,y:200});
    project=first[0];
    const second=placePiece(project,'brick_straight_nominal',{x:229,y:200});
    project=second[0];
    expect(project.routes).toHaveLength(1);
    expect(project.routes[0].pieces[1]).toMatchObject({x:228,y:200,heading:0});
    expect(fitProject(project).sections.map(section=>section.start.pose.x)).toEqual([100,228]);
    project=placePiece(project,'brick_straight_nominal',{x:-25,y:200})[0];
    expect(project.routes).toHaveLength(1);
    expect(project.routes[0].pieces[0]).toMatchObject({x:-28,y:200,heading:0});
    expect(fitProject(project).sections.map(section=>section.start.pose.x)).toEqual([-28,100,228]);
    project=placePiece(project,'brick_straight_nominal',{x:300,y:400})[0];
    expect(project.routes).toHaveLength(2);
    expect(fitProject(project).sections.filter(section=>section.kind==='unresolved')).toHaveLength(0);
  });

  it('previews the exact committed pose at either open port, without overlapping the existing tile', () => {
    const project=placePiece(createProject('Two open ports'),'brick_straight_nominal',{x:100,y:200,heading:Math.PI/2})[0];
    const route=project.routes[0];
    const revision=project.revision;
    const start=previewPiece(project,'brick_straight_nominal',{x:103,y:201,heading:0});
    expect(start).toMatchObject({routeId:route.id,edge:'start',distance:Math.sqrt(10)});
    expect(start.piece.x).toBeCloseTo(100);
    expect(start.piece).toMatchObject({y:72,z:0,heading:Math.PI/2});
    const [prepended,prependedId]=placePiece(project,'brick_straight_nominal',{x:103,y:201,heading:0});
    expect(prepended.routes[0].pieces[0]).toEqual({...start.piece,id:prependedId});
    const prependedEnd=primaryEnd(prepended.routes[0].pieces[0],prepended);
    expect(prependedEnd.x).toBeCloseTo(100);
    expect(prependedEnd).toMatchObject({y:200,heading:Math.PI/2});
    expect(project.revision).toBe(revision);
    expect(project.routes[0].pieces).toHaveLength(1);

    const end=primaryEnd(route.pieces[0],project);
    const placement={x:end.x+3,y:end.y-4,heading:Math.PI};
    const append=previewPiece(project,'printed_straight',placement);
    expect(append).toMatchObject({routeId:route.id,edge:'end',distance:5});
    const [extended,extendedId]=placePiece(project,'printed_straight',placement);
    expect(extended.routes[0].pieces[1]).toEqual({...append.piece,id:extendedId});
    expect(append.piece).toMatchObject({x:end.x,y:end.y,z:end.z,heading:end.heading});
  });

  it('aligns signed curves and ramps when prepending or appending, preserving sweep and rise', () => {
    const project=placePiece(createProject('Curved and raised'),'vertical_transition',{x:100,y:100,rise:8})[0];
    const initial=project.routes[0].pieces[0];
    const port=primaryEnd(initial,project);
    const right=previewPiece(project,'brick_curve_r40',{x:port.x+2,y:port.y,sweep:Math.PI/8});
    const left=previewPiece(project,'brick_curve_r40',{x:port.x+2,y:port.y,sweep:-Math.PI/8});
    expect(right.edge).toBe('end');
    expect(left.edge).toBe('end');
    expect(right.piece).toMatchObject({x:port.x,y:port.y,z:8,heading:0,sweep:Math.PI/8});
    expect(left.piece).toMatchObject({x:port.x,y:port.y,z:8,heading:0,sweep:-Math.PI/8});
    expect(primaryEnd(right.piece,project).y).toBeGreaterThan(port.y);
    expect(primaryEnd(left.piece,project).y).toBeLessThan(port.y);
    const [curved,id]=placePiece(project,'brick_curve_r40',{x:port.x+2,y:port.y,sweep:-Math.PI/8});
    expect(curved.routes[0].pieces[1]).toEqual({...left.piece,id});

    const prependCurve=previewPiece(project,'printed_curve_r56',{x:101,y:99,sweep:-Math.PI/8});
    expect(prependCurve).toMatchObject({routeId:project.routes[0].id,edge:'start'});
    expect(prependCurve.piece.heading).toBeCloseTo(Math.PI/8);
    const curveEnd=primaryEnd(prependCurve.piece,project);
    expect(curveEnd.x).toBeCloseTo(100);
    expect(curveEnd.y).toBeCloseTo(100);
    expect(curveEnd).toMatchObject({z:0,heading:0});
    const [prepended,curveId]=placePiece(project,'printed_curve_r56',{x:101,y:99,sweep:-Math.PI/8});
    expect(prepended.routes[0].pieces[0]).toEqual({...prependCurve.piece,id:curveId});

    const descent=previewPiece(project,'vertical_transition',{x:port.x,y:port.y+1,rise:-8});
    expect(descent.piece).toMatchObject({x:port.x,y:port.y,z:8,rise:-8});
    expect(primaryEnd(descent.piece,project).z).toBe(0);
    const [descended,descentId]=placePiece(project,'vertical_transition',{x:port.x,y:port.y+1,rise:-8});
    expect(descended.routes[0].pieces[1]).toEqual({...descent.piece,id:descentId});

    const risingBefore=previewPiece(project,'vertical_transition',{x:101,y:100,rise:8});
    expect(risingBefore.piece).toMatchObject({z:-8,rise:8});
    expect(primaryEnd(risingBefore.piece,project)).toMatchObject({x:100,y:100,z:0});
  });

  it('chooses the nearest free port across routes and respects configurable snap tolerance', () => {
    let project=placePiece(createProject('Nearest ports'),'printed_straight',{x:0,y:0})[0];
    project=placePiece(project,'printed_straight',{x:0,y:50})[0];
    const near=previewPiece(project,'bridge_deck',{x:160,y:47},5);
    expect(near).toMatchObject({routeId:project.routes[1].id,edge:'end',distance:3});
    const far=previewPiece(project,'bridge_deck',{x:160,y:47},2);
    expect(far).toMatchObject({routeId:null,edge:null,distance:null});
    expect(far.piece).toMatchObject({x:160,y:47,z:0,heading:0});
    const [separate,id]=placePiece(project,'bridge_deck',{x:160,y:47},2);
    expect(separate.routes).toHaveLength(3);
    expect(separate.routes[2].pieces[0]).toEqual({...far.piece,id});
    const [joined,joinedId]=placePiece(project,'bridge_deck',{x:160,y:47},5);
    expect(joined.routes).toHaveLength(2);
    expect(joined.routes[1].pieces[1]).toEqual({...near.piece,id:joinedId});
  });

  it('extends the route at a midpoint tie instead of prepending over the existing span', () => {
    const project=placePiece(createProject('Midpoint'),'brick_straight_nominal',{x:0,y:0})[0];
    const placement={x:64,y:0};
    const preview=previewPiece(project,'brick_straight_nominal',placement,70);
    expect(preview).toMatchObject({routeId:project.routes[0].id,edge:'end',distance:64});
    expect(preview.piece).toMatchObject({x:128,y:0,heading:0});
    const [extended,id]=placePiece(project,'brick_straight_nominal',placement,70);
    expect(extended.routes[0].pieces[1]).toEqual({...preview.piece,id});
    expect(extended.routes[0].pieces[0].x).toBe(0);
  });

  it('reconciles raised crossings on moves, ramp changes and removal', () => {
    let project=createProject('Crossings');
    project=placePiece(project,'bridge_deck',{x:100,y:100})[0];
    project=placePiece(project,'vertical_transition',{x:260,y:100,rise:8})[0];
    const raised=project.routes[0].pieces[1];
    const end=primaryEnd(raised,project);
    project=placePiece(project,'bridge_deck',{x:end.x,y:end.y})[0];
    const upper=project.routes[0].id;
    // A separate route intersects the elevated bridge at x=540.
    project=placePiece(project,'bridge_deck',{x:500,y:20,heading:Math.PI/2})[0];
    expect(project.crossings).toHaveLength(1);
    expect(project.crossings[0].upperRouteId).toBe(upper);
    const lower=project.routes[1].pieces[0];
    const moved=movePieceRoute(project,lower.id,900,20);
    expect(moved.crossings).toHaveLength(0);
    expect(project.crossings).toHaveLength(1);
    expect(moved.layoutRevision).not.toBe(project.layoutRevision);
    const restored=movePieceRoute(moved,lower.id,500,20);
    expect(restored.crossings).toHaveLength(1);
    const cleared=setRampRise(restored,raised.id,0);
    expect(cleared.crossings).toHaveLength(1);
    expect(fitProject(cleared).crossings[0].status).toBe('blocked');
    const removed=removePiece(restored,project.routes[0].pieces[2].id);
    expect(removed.crossings).toHaveLength(0);
  });

  it('declares positive-length collinear overlaps across authored routes', () => {
    let project=createProject('Collinear');
    project=placePiece(project,'printed_straight',{x:100,y:100})[0];
    project=placePiece(project,'printed_straight',{x:180,y:100,heading:Math.PI})[0];
    expect(project.crossings).toHaveLength(1);
    expect(fitProject(project).crossings[0].status).toBe('blocked');
  });

  it('flags a ground-level descent but fits a descent from a raised deck', () => {
    let project=placePiece(createProject('Datum'),'vertical_transition',{x:100,y:100,rise:-8})[0];
    let fit=fitProject(project);
    expect(fit.geometryFeasible).toBe(false);
    expect(fit.issues).toContainEqual(expect.objectContaining({code:'below-table',severity:'error'}));
    expect(fit.sections.some(section=>section.kind==='transition')).toBe(false);
    project=placePiece(createProject('Raised descent'),'vertical_transition',{x:100,y:100,rise:8})[0];
    const up=project.routes[0].pieces[0];
    const end=primaryEnd(up,project);
    project=placePiece(project,'vertical_transition',{x:end.x,y:end.y,rise:-8})[0];
    fit=fitProject(project);
    expect(fit.issues.some(issue=>issue.code==='below-table')).toBe(false);
    expect(fit.sections.filter(section=>section.kind==='transition')).toHaveLength(2);
  });

  it('spans a high ramp rise with printable eased modules and aligned connector ports',()=>{
    let project=createProject('High ramp');
    project=placePiece(project,'vertical_transition',{x:100,y:100,rise:0})[0];
    project=placePiece(project,'bridge_deck',{x:300,y:100})[0];
    const id=project.routes[0].pieces[0].id;
    project=setRampRise(project,id,64);
    expect(primaryEnd(project.routes[0].pieces[0],project).z).toBe(64);
    expect(project.routes[0].pieces[1]).toMatchObject({x:1700,y:100,z:64});
    const fitted=fitProject(project);
    const sections=fitted.sections.filter(section=>section.family==='vertical_transition');
    expect(sections).toHaveLength(8);
    expect(sections.every(section=>section.run<=220)).toBe(true);
    expect(sections.at(-1)?.end.pose.z).toBe(64);
    expect(fitted.sections.at(-1)?.start.pose.x).toBe(1700);
    expect(fitted.issues.some(issue=>issue.code==='port-discontinuity'||issue.code==='grade-unfitted')).toBe(false);
    expect(fitted.supports.length).toBeGreaterThan(0);
  });
  it('fits an all-printed climb and descent with grounded exits and signed eased transitions', () => {
    let project=createProject('Printable raised span');
    for (const [family,x] of [
      ['printed_straight',100],['vertical_transition',260],['bridge_deck',460],
      ['vertical_transition',620],['printed_straight',820]
    ] as const) project=placePiece(project,family,{x,y:100})[0];
    const [up,,down]=[project.routes[0].pieces[1],project.routes[0].pieces[2],project.routes[0].pieces[3]];
    project=setRampRise(project,up.id,8);
    project=setRampRise(project,down.id,-8);
    expect(project.routes[0].pieces[4]).toMatchObject({x:820,y:100,z:0});
    expect(primaryEnd(project.routes[0].pieces[4],project).z).toBe(0);
    const fit=fitProject(project);
    expect(fit.sections.filter(section=>section.family==='vertical_transition').map(section=>section.parameters.rise)).toEqual([8,-8]);
    expect(fit.sections.filter(section=>section.family==='printed_straight')).toHaveLength(2);
    expect(fit.issues.some(issue=>['brick-coupling-unfitted','port-discontinuity','grade-unfitted'].includes(issue.code))).toBe(false);
    const reversed=flipPiece(project,down.id);
    expect(reversed.routes[0].pieces[4].z).toBe(16);
    expect(project.routes[0].pieces[4].z).toBe(0);
  });
  it('flips a selected curve, refits its true arc and preserves the previous project for undo', () => {
    let project=createProject('Curve');project.inventory.brick_curve_r40=1;
    const before=placePiece(project,'brick_curve_r40',{x:100,y:100})[0];
    const id=before.routes[0].pieces[0].id;
    const flipped=flipPiece(before,id);
    expect(flipped.routes[0].pieces[0].sweep).toBeCloseTo(-Math.PI/8);
    expect(fitProject(flipped).sections[0].arc?.sweep).toBeCloseTo(-Math.PI/8);
    expect(before.routes[0].pieces[0].sweep).toBeCloseTo(Math.PI/8);
    expect(flipped.layoutRevision).not.toBe(before.layoutRevision);
    expect(project.routes).toHaveLength(0);
  });
  it('mirrors a turnout in place without moving its main line', () => {
    const project=placePiece(createProject('Turnout'),'printed_switch_left',{x:100,y:100})[0];
    const piece=project.routes[0].pieces[0];
    const flipped=flipPiece(project,piece.id).routes[0].pieces[0];
    expect(flipped).toEqual({...piece,family:'printed_switch_right'});
    expect(flipPiece(project,piece.id).routes[0].points).toEqual(project.routes[0].points);
  });
});

describe('joining routes', () => {
  it('snaps a dragged route onto another open end and merges into the first route', () => {
    // Inside the default room, so the fit has no errors at the end.
    let project=placePiece(createProject('Join'),'printed_straight',{x:200,y:200})[0];
    project=placePiece(project,'printed_straight',{x:600,y:500,heading:Math.PI/6})[0];
    const [first,second]=project.routes;
    // Dropped 19 mm off the open end and turned 30°: the chain turns and slides onto the port.
    project=movePieceRoute(project,second.pieces[0].id,375,212,30);
    expect(project.routes).toHaveLength(1);
    expect(project.routes[0]).toMatchObject({id:first.id,name:first.name});
    expect(project.routes[0].pieces.map(piece=>piece.id)).toEqual([first.pieces[0].id,second.pieces[0].id]);
    expect(project.routes[0].pieces[1].x).toBeCloseTo(360);
    expect(project.routes[0].pieces[1].y).toBeCloseTo(200);
    expect(project.routes[0].pieces[1].heading).toBeCloseTo(0);
    expect(unoccupiedPiecePorts(project)).toHaveLength(2);
    expect(fitProject(project).issues.filter(issue=>issue.severity==='error')).toEqual([]);
  });

  it('moves and rotates every route connected through a double crossover as one track', () => {
    let project=placePiece(createProject('Crossover'),'printed_straight',{x:0,y:0})[0];
    project=placePiece(project,'printed_double_crossover',primaryEnd(project.routes[0].pieces[0],project))[0];
    const crossover=project.routes[0].pieces[1];
    for (const port of piecePorts(crossover,project).filter(port=>port.id.startsWith('parallel')))
      project=placePiece(project,'printed_straight',{x:port.x,y:port.y,heading:port.heading})[0];
    expect(project.routes).toHaveLength(3);
    const open=unoccupiedPiecePorts(project).length;
    const parallel=project.routes[1].pieces[0];
    // Dragging the parallel track carries the crossover and main line with it.
    const moved=movePieceRoute(project,parallel.id,parallel.x+300,parallel.y+200);
    const at=(p:WorkshopProject,id:string)=>p.routes.flatMap(route=>route.pieces).find(piece=>piece.id===id)!;
    for (const piece of project.routes.flatMap(route=>route.pieces)) {
      expect(at(moved,piece.id).x-piece.x).toBeCloseTo(300);
      expect(at(moved,piece.id).y-piece.y).toBeCloseTo(200);
    }
    expect(unoccupiedPiecePorts(moved)).toHaveLength(open);
    // Rotating from the main line keeps the parallel track mated.
    expect(unoccupiedPiecePorts(rotatePieceRoute(project,crossover.id,Math.PI/8))).toHaveLength(open);
  });

  it('reverses one chain when two route ends meet end to end', () => {
    let project=placePiece(createProject('End to end'),'printed_straight',{x:0,y:0})[0];
    project=placePiece(project,'printed_straight',{x:1000,y:800,heading:Math.PI/2})[0];
    const [first,second]=project.routes;
    // The second route's far end lands beside the first route's far end.
    project=movePieceRoute(project,second.pieces[0].id,170,-150,30);
    expect(project.routes).toHaveLength(1);
    const route=project.routes[0];
    expect(route.id).toBe(first.id);
    expect(route.pieces.map(piece=>piece.id)).toEqual([second.pieces[0].id,first.pieces[0].id]);
    expect(Math.cos(route.pieces[1].heading)).toBeCloseTo(-1);
    const end=primaryEnd(route.pieces[1],project);
    expect(end.x).toBeCloseTo(0);
    expect(end.y).toBeCloseTo(0);
    expect(unoccupiedPiecePorts(project)).toHaveLength(2);
  });

  it('closes a loop when two half circles are dragged together', () => {
    let project=chain(createProject('Loop'),'printed_curve_r40',8,{x:1000,y:500});
    project=chain(project,'printed_curve_r40',8,{x:2000,y:200});
    expect(project.routes).toHaveLength(2);
    const [first,second]=project.routes;
    const end=primaryEnd(first.pieces.at(-1)!,project);
    project=movePieceRoute(project,second.pieces[0].id,end.x+6,end.y-8,30);
    expect(project.routes).toHaveLength(1);
    expect(project.routes[0].id).toBe(first.id);
    expect(project.routes[0].pieces).toHaveLength(16);
    expect(unoccupiedPiecePorts(project)).toEqual([]);
    expect(project.crossings).toEqual([]);
  });

  it('keeps the route when its first piece is removed and never repeats route names', () => {
    let project=placePiece(createProject('Names'),'printed_straight',{x:0,y:0})[0];
    project=placePiece(project,'printed_straight',{x:160,y:0})[0];
    const route=project.routes[0];
    project=removePiece(project,route.pieces[0].id);
    expect(project.routes.map(item=>[item.id,item.name])).toEqual([[route.id,'Route 1']]);
    project=placePiece(project,'printed_straight',{x:0,y:600})[0];
    project=removePiece(project,route.pieces[1].id);
    project=placePiece(project,'printed_straight',{x:0,y:1200})[0];
    expect(project.routes.map(item=>item.name).sort()).toEqual(['Route 1','Route 2']);
  });
});

describe('piece source and print style', () => {
  /** Owned straight, then a printed straight and a printed ramp snapped on after it, in one route. */
  function mixedRoute(): WorkshopProject {
    let project = createProject('Styles');
    project.inventory.brick_straight_nominal = 1;
    project = placePiece(project, 'brick_straight_nominal', { x: 200, y: 500 })[0];
    for (const family of ['printed_straight', 'vertical_transition'] as const) {
      const end = primaryEnd(project.routes[0].pieces.at(-1)!, project);
      project = placePiece(project, family, { x: end.x, y: end.y, rise: 8, style: family === 'vertical_transition' ? 'fast' : undefined })[0];
    }
    return project;
  }

  it('places a fast piece only when printed', () => {
    const project = mixedRoute();
    expect(project.routes).toHaveLength(1);
    expect(project.routes[0].pieces.map(piece => piece.style)).toEqual([undefined, undefined, 'fast']);
    expect(previewPiece(project, 'brick_straight_nominal', { x: 0, y: 0, style: 'fast' }).piece).not.toHaveProperty('style');
  });

  it('switches a piece between owned, printed and fast in one undoable edit', () => {
    const project = mixedRoute();
    const [owned, printed, ramp] = project.routes[0].pieces.map(piece => piece.id);
    const fast = setPieceSource(project, [owned], 'fast');
    expect(fast.routes[0].pieces[0]).toMatchObject({ family: 'printed_brick_straight', style: 'fast' });
    expect(fast.revision).not.toBe(project.revision);
    expect(project.routes[0].pieces[0].family).toBe('brick_straight_nominal');
    const back = setPieceSource(fast, [owned], 'owned');
    expect(back.routes[0].pieces[0]).toEqual(project.routes[0].pieces[0]);
    expect(setPieceSource(project, [printed], 'printed')).toBe(project);
    expect(setPieceSource(project, [ramp], 'owned')).toBe(project);
    expect(setPieceSource(project, [ramp], 'printed').routes[0].pieces[2]).not.toHaveProperty('style');
    expect(fitProject(fast).geometryFeasible).toBe(true);
  });

  it('applies one print style to every printed piece of a route, leaving owned pieces owned', () => {
    const project = mixedRoute();
    const printed = project.routes[0].pieces.filter(piece => !piece.family.startsWith('brick_')).map(piece => piece.id);
    const all = setPieceSource(project, printed, 'fast');
    expect(all.routes[0].pieces.map(piece => [piece.family, piece.style])).toEqual([
      ['brick_straight_nominal', undefined], ['printed_straight', 'fast'], ['vertical_transition', 'fast']]);
    expect(fitProject(all).partInstances.filter(part => part.parameters.lite === 1).length).toBeGreaterThan(1);
  });

  it('leaves a piece with no fast-print version at full detail when its route goes fast', () => {
    // A turntable prints only in full detail: asking for fast used to fail project validation and change nothing.
    const [withStraight, straight] = placePiece(createProject('Fast route'), 'printed_straight', { x: 500, y: 500 });
    const [project, turntable] = placePiece(withStraight, 'turntable', { x: 2000, y: 500 }, 0);
    const fast = setPieceSource(project, [straight, turntable], 'fast');
    const style = (id: string) => fast.routes.flatMap(route => route.pieces).find(piece => piece.id === id)!.style;
    expect([style(straight), style(turntable)]).toEqual(['fast', undefined]);
  });

  it('lists compact tiles with one New prints switch and draws each placed piece in its own style', () => {
    const project = mixedRoute();
    const shown = renderToStaticMarkup(createElement(RouteEditor, { project, fit: fitProject(project), account: { status: 'offline' },
      onChange: () => {}, onOpenSetup: () => {}, inventoryCue: false, startDismissed: false, onDismissStart: () => {} }));
    // Own / Print / Fast live in the armed tile's options; nothing is armed, so the sidebar offers only the default style.
    const palette = shown.split('aria-label="Pieces sidebar"')[1].split('</aside>')[0];
    expect(palette.match(/data-source="(\w+)"/g)).toEqual(['data-source="printed"', 'data-source="fast"']);
    expect(palette).not.toContain('class="builder-flyout"');
    // The only owned Straight is used, so its tile prints and shows none left.
    const straight = palette.split('<button').find(tile => tile.includes('<strong>Straight</strong>'))!;
    expect(straight).toMatch(/class="builder-tile printed /);
    expect(straight).toContain('aria-label="0 owned left">0</span>');
    expect(shown).toContain('To print <strong>1 detailed · 1 fast</strong>');
    const plan = shown.split('class="builder-plan"')[1].split('</svg>')[0];
    const styles = [...plan.matchAll(/builder-piece is-standard (is-\w+) (is-fast)?/g)].map(match => `${match[1]}${match[2] ? ' fast' : ''}`);
    expect(styles).toEqual(['is-owned', 'is-printed', 'is-printed fast']);
    // Fast pieces keep only their end-tie studs.
    const studs = (piece: string) => (piece.match(/<ellipse/g) ?? []).length;
    const drawn = plan.split('builder-piece is-standard').slice(1);
    expect(studs(drawn[2])).toBe(2 * 6);
    expect(studs(drawn[1])).toBeGreaterThan(studs(drawn[2]));
  });
});
