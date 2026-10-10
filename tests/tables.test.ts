import { describe, expect, it } from 'vitest';
import { createProject, type RoutePiece, type WorkshopProject } from '../src/domain/project';
import { pieceDefinition, piecePaths, piecePorts, pieceState, pieceStates, stepState } from '../src/domain/pieces';
import { turntableShape } from '../src/domain/pieces/families/tables';
import { previewPiece, rebuildPiecePoints, setPieceParam, setPieceState, unoccupiedPiecePorts } from '../src/editor/operations';
import { fitProject } from '../src/fitting/fit';
import { routePath } from '../src/drive/traversal';
import { advanceConsist, startingLeadDistance } from '../src/drive/train';

function authored(family: string, params: Record<string, number> = {}, state?: string): WorkshopProject {
  const project = createProject('Tables');
  const piece: RoutePiece = { id: 'table', family, x: 1000, y: 1000, z: 0, heading: 0, params, ...(state ? { state } : {}) };
  const route = { id: 'route', name: 'Table', pieces: [piece], points: [] };
  rebuildPiecePoints(project, route); project.routes = [route];
  return project;
}
const table = (project: WorkshopProject) => project.routes[0].pieces![0];
/** A 256 mm straight leaving the table's port `id`, as its own route. */
function stall(project: WorkshopProject, id: string, length = 256): WorkshopProject {
  const target = piecePorts(table(project), project).find(port => port.id === id)!;
  const piece: RoutePiece = { id: `stall-${id}`, family: 'track_straight', x: target.x, y: target.y, z: 0, heading: target.heading, params: { length } };
  const route = { id: `stall-${id}`, name: `Stall ${id}`, pieces: [piece], points: [] };
  rebuildPiecePoints(project, route); project.routes = [...project.routes, route];
  return project;
}

describe('turntable (C4)', () => {
  it('offers one state per bridge axis that meets a stall, and every stall port is a fixed snap target', () => {
    const project = authored('turntable', { left: 3, right: 2 });
    const states = pieceStates(table(project))!;
    expect(states.map(state => state.label)).toEqual(['In ↔ Out', 'Left 1', 'Left 2', 'Left 3', 'Right 2', 'Right 1']);
    const ports = piecePorts(table(project), project).filter(port => !port.stop).map(port => port.id).sort();
    expect(ports).toEqual(['in', 'l1', 'l2', 'l3', 'out', 'r1', 'r2']);
    // Ports never move with the state: snapping finds every stall whatever the bridge is turned to.
    const turned = setPieceState(project, 'table', 'a2');
    expect(unoccupiedPiecePorts(turned).map(item => item.port.id).sort()).toEqual(ports);
    const l2 = piecePorts(table(turned), turned).find(port => port.id === 'l2')!;
    const drop = previewPiece(turned, 'track_straight', { x: l2.x + 5, y: l2.y + 5, params: { length: 128 } });
    expect(drop.portId).toBe('l2');
    expect(drop.piece.heading).toBeCloseTo(l2.heading, 9);
  });

  it('turns the bridge: only the set axis is physical, rail ends line up with each stall', () => {
    const project = authored('turntable', { left: 2 }, 'a1');
    const shape = turntableShape(table(project));
    const paths = piecePaths(table(project), project);
    expect(paths.filter(path => path.enabled).map(path => path.id)).toEqual(['bridge-1']);
    const bridge = paths.find(path => path.id === 'bridge-1')!, l1 = piecePorts(table(project), project).find(port => port.id === 'l1')!;
    // The path runs from the stall port through the pit centre.
    expect(Math.hypot(bridge.points[0].x - l1.x, bridge.points[0].y - l1.y)).toBeLessThan(1e-9);
    expect(bridge.points[1].x - 1000).toBeCloseTo(shape.port, 9);
    // Its far end faces no stall: a free deck end that mates nothing.
    expect(bridge.stop).toBe(true);
    expect(Math.hypot(bridge.points[2].x - bridge.points[1].x, bridge.points[2].y - bridge.points[1].y)).toBeCloseTo(shape.half, 9);
  });

  it('drives across the lined-up stall and ends the route with a message at a misaligned one', () => {
    let project = stall(stall(authored('turntable', { left: 2 }, 'a1'), 'l1'), 'l2');
    const aligned = routePath(fitProject(project).sections, 'stall-l1');
    expect(aligned.gap).toBeNull();
    expect(aligned.sections.map(section => section.id)).toEqual(['table:bridge-1', 'stall-l1']);
    expect(aligned.startHalt).toBe("The turntable's far end faces no track in this setting.");
    const blocked = routePath(fitProject(project).sections, 'stall-l2');
    expect(blocked.gap).toBeNull();
    expect(blocked.sections.map(section => section.id)).toEqual(['stall-l2']);
    expect(blocked.startHalt).toBe('The turntable bridge is turned to Left 1.');
    // A train backing towards the table stops there and says why.
    const cars = [{ id: 'loco', name: 'Loco', length: 120, width: 48, height: 80, wheelbase: 80, couplerGap: 8 }] as WorkshopProject['cars'];
    const stopped = advanceConsist(blocked, cars, startingLeadDistance(cars), -100, .1);
    expect(stopped.warning).toBe('The turntable bridge is turned to Left 1.');
    project = setPieceState(project, 'table', 'a2');
    expect(routePath(fitProject(project).sections, 'stall-l2').sections.map(section => section.id)).toEqual(['table:bridge-2', 'stall-l2']);
  });

  it('keeps the chain on the out port through state changes and reports impossible stall layouts', () => {
    const project = stall(authored('turntable', { left: 1 }), 'out');
    const out = piecePorts(table(project), project).find(port => port.id === 'out')!;
    const turned = setPieceState(project, 'table', 'a1');
    expect(piecePorts(table(turned), turned).find(port => port.id === 'out')).toEqual(out);
    expect(stepState(table(turned), 1)).toBe('a0');
    // 11.25° stalls need a 64-stud bridge: the rails of neighbouring stalls would touch at a 32-stud pit edge.
    const crowded = setPieceParam(project, 'table', 'index', 11.25);
    expect(pieceDefinition('turntable').problem!(table(crowded))).toMatch(/at least 64 studs/);
    expect(fitProject(crowded).issues.some(issue => issue.code === 'piece-settings')).toBe(true);
    expect(pieceDefinition('turntable').problem!(table(setPieceParam(crowded, 'table', 'bridge', 512)))).toBeNull();
    // A stall removed by a parameter change falls back to the first state.
    const fewer = setPieceParam(setPieceState(project, 'table', 'a1'), 'table', 'left', 0);
    expect(pieceState(table(fewer))).toBe('a0');
  });
});

describe('transfer table and sector plate (C4)', () => {
  it('slides the deck to a lane 16 studs over and stops trains at the others', () => {
    let project = stall(stall(authored('transfer_table', { lanes: 3 }, 'lane2'), 'out2'), 'out3');
    const ports = piecePorts(table(project), project);
    expect(ports.find(port => port.id === 'in3')!.y - 1000).toBeCloseTo(256, 9);
    expect(routePath(fitProject(project).sections, 'stall-out2').sections.map(section => section.id)).toEqual(['table:lane-2', 'stall-out2']);
    expect(routePath(fitProject(project).sections, 'stall-out3').startHalt).toBe('The transfer table deck is at lane 2.');
    project = setPieceState(project, 'table', 'lane3');
    expect(routePath(fitProject(project).sections, 'stall-out3').sections.map(section => section.id)).toEqual(['table:lane-3', 'stall-out3']);
  });

  it('swings a sector plate within the flex-joint limit and ends each track off the grid', () => {
    const project = authored('sector_plate', { tracks: 3 }, 'track3');
    const paths = piecePaths(table(project), project);
    const kink = (path: typeof paths[number]) => Math.abs(path.points[1].heading - path.points[0].heading) * 180 / Math.PI;
    expect(Math.max(...paths.map(kink))).toBeCloseTo(5.625, 9);
    const far = piecePorts(table(project), project).filter(port => port.id.startsWith('out'));
    expect(far.length).toBe(3);
    // Neighbouring far ends clear each other's 63.8 mm bodies.
    const sorted = far.sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) expect(Math.hypot(sorted[i].x - sorted[i - 1].x, sorted[i].y - sorted[i - 1].y)).toBeGreaterThanOrEqual(64);
    expect(paths.filter(path => path.enabled).map(path => path.id)).toEqual(['track-3']);
  });
});
