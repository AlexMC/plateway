import { describe, expect, it } from 'vitest';
import { createProject, type RoutePiece, type WorkshopProject } from '../src/domain/project';
import { pieceDefinition, piecePaths, piecePorts } from '../src/domain/pieces';
import { mechanismFootprints } from '../src/domain/track-footprints';
import { placePiece, rebuildPiecePoints, setPieceState, flipPiece } from '../src/editor/operations';
import { fitProject } from '../src/fitting/fit';
import { routePath } from '../src/drive/traversal';

function authored(family: string, params: Record<string, number> = {}, state?: string): WorkshopProject {
  const project = createProject('Turnouts');
  const piece: RoutePiece = { id: 'piece', family, x: 500, y: 500, z: 0, heading: 0, params, ...(state ? { state } : {}) };
  const route = { id: 'route', name: 'Track', pieces: [piece], points: [] };
  rebuildPiecePoints(project, route); project.routes = [route];
  return project;
}
const port = (project: WorkshopProject, id: string) => piecePorts(project.routes[0].pieces![0], project).find(p => p.id === id)!;

/** A straight that ends facing into `id` of the turnout, as its own route. */
function feeding(project: WorkshopProject, id: string): WorkshopProject {
  const target = port(project, id), length = 128;
  const piece: RoutePiece = { id: 'feeder', family: 'printed_brick_straight',
    x: target.x + length*Math.cos(target.heading), y: target.y + length*Math.sin(target.heading), z: 0, heading: target.heading + Math.PI };
  const route = { id: 'feed', name: 'Feed', pieces: [piece], points: [] };
  rebuildPiecePoints(project, route); project.routes = [...project.routes, route];
  return project;
}

describe('point-blade turnouts', () => {
  it('lists each junction\'s states and opens exactly the set route', () => {
    const cases: [string, Record<string, number>, Record<string, string[]>][] = [
      ['turnout_radius', { radius: 104 }, { straight: ['main'], diverging: ['branch'] }],
      ['turnout_curved', { radius: 56, sweep: 45 }, { straight: ['main'], diverging: ['branch'] }],
      ['turnout_wye', {}, { left: ['left'], right: ['right'] }],
      ['turnout_three_way', {}, { straight: ['main'], left: ['left'], right: ['right'] }]
    ];
    for (const [family, params, open] of cases) {
      expect(pieceDefinition(family).states!.map(state => state.id)).toEqual(Object.keys(open));
      for (const [state, ids] of Object.entries(open)) {
        const project = authored(family, params, state);
        expect(piecePaths(project.routes[0].pieces![0], project).filter(path => path.enabled).map(path => path.id), `${family} ${state}`).toEqual(ids);
      }
    }
  });

  it('lands the radius family on the stud grid: R104 and R148 return parallel 16 studs over', () => {
    for (const [radius, length] of [[104, 640], [148, 768]]) {
      const branch = port(authored('turnout_radius', { radius, hand: -1 }), 'branch');
      expect(branch.x).toBeCloseTo(500 + length, 6);
      expect(branch.y).toBeCloseTo(500 - 128, 6);
      expect(Math.cos(branch.heading)).toBeCloseTo(1, 9);
    }
    const oblique = port(authored('turnout_radius', { radius: 56 }), 'branch');
    expect(oblique.heading).toBeCloseTo(Math.PI/8);
    // One more R56 22.5° curve lands the siding 16 studs over.
    expect(oblique.y - 500 + 448*(1 - Math.cos(Math.PI/8))).toBeCloseTo(128, 6);
  });

  it('ends a curved turnout\'s two exits parallel and 16 studs apart', () => {
    for (const sweep of [45, 90]) {
      const project = authored('turnout_curved', { radius: 40, sweep, hand: 1 });
      const outer = port(project, 'out'), inner = port(project, 'branch');
      expect(outer.heading).toBeCloseTo(inner.heading);
      const across = -(outer.x - inner.x)*Math.sin(outer.heading) + (outer.y - inner.y)*Math.cos(outer.heading);
      expect(Math.abs(across)).toBeCloseTo(128, 6);
    }
  });

  it('flips hand in place', () => {
    const left = authored('turnout_radius', { radius: 40, hand: 1 });
    const right = flipPiece(left, 'piece');
    expect(port(left, 'branch').y).toBeGreaterThan(500);
    expect(port(right, 'branch').y).toBeLessThan(500);
    expect(right.routes[0].pieces![0].params!.hand).toBe(-1);
  });

  it('sends the state index and sprung flag to CAD', () => {
    const project = setPieceState(authored('turnout_three_way', { sprung: 1 }), 'piece', 'right');
    const piece = project.routes[0].pieces![0];
    expect(pieceDefinition(piece.family).cad(piece, project)).toEqual([{ family: 'turnout_three_way', parameters: { sprung: 1, switch_state: 2 } }]);
  });

  it('reserves the points\' full travel from the definition envelope', () => {
    const project = authored('turnout_radius', { radius: 40 });
    const [envelope] = mechanismFootprints(project.routes[0].pieces![0], project);
    // Shared port to past the heel keepers, both routes' decks.
    expect(envelope.minX).toBeCloseTo(500, 0);
    expect(envelope.maxX).toBeGreaterThan(500 + 100);
    expect(envelope.minY).toBeLessThan(500 - 31);
    expect(mechanismFootprints(authored('turnout_three_way').routes[0].pieces![0], project)).toHaveLength(2);
  });

  it('lets a train trail through sprung points set against it, and stops it at manual points', () => {
    const sprung = feeding(authored('turnout_radius', { radius: 40, sprung: 1 }, 'straight'), 'branch');
    const trailed = routePath(fitProject(sprung).sections, 'feed');
    expect(trailed.gap).toBeNull();
    expect(trailed.sections.map(section => section.pathId ?? 'rail')).toEqual(['rail', 'branch']);
    expect(trailed.sections[1].end.pose.x).toBeCloseTo(500);
    const manual = feeding(authored('turnout_radius', { radius: 40, sprung: 0 }, 'straight'), 'branch');
    expect(routePath(fitProject(manual).sections, 'feed').gap).toBe('A switch is set against this route.');
    // Facing moves still follow the set route.
    const facing = routePath(fitProject(sprung).sections, 'route');
    expect(facing.sections.map(section => section.pathId)).toEqual(['main']);
  });

  it('places a wye beside other track and chains track onto its toe', () => {
    // A wye's chain ends on its legs, so it has no `out`: placing one used to throw once any other route was on the table.
    const [withStraight] = placePiece(createProject('Wye'), 'printed_brick_straight', { x: 0, y: 0 }, 0);
    const [withWye, wye] = placePiece(withStraight, 'turnout_wye', { x: 1000, y: 0 }, 0);
    expect(withWye.routes).toHaveLength(2);
    const toe = piecePorts(withWye.routes[1].pieces.find(piece => piece.id === wye)!, withWye).find(item => item.id === 'in')!;
    const [joined] = placePiece(withWye, 'printed_brick_straight', { x: toe.x - 128, y: toe.y });
    expect(joined.routes).toHaveLength(2);
    expect(joined.routes[1].pieces.map(piece => piece.family)).toEqual(['printed_brick_straight', 'turnout_wye']);
  });
});
