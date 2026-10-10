import { automationDevices } from '../src/domain/automation';
import { describe, expect, it } from 'vitest';
import { createProject, type RoutePiece, type WorkshopProject } from '../src/domain/project';
import type { PartInstance } from '../src/domain/route';
import { pieceDefinition, piecePaths, piecePorts, pieceStates } from '../src/domain/pieces';
import { dumperEnvelopes, dumperOutline } from '../src/domain/pieces/families/rotary-dumper';
import { rebuildPiecePoints, setPieceState } from '../src/editor/operations';
import { fitProject } from '../src/fitting/fit';
import { routePath } from '../src/drive/traversal';

const X = 1000, Y = 1000;
function route(id: string, piece: RoutePiece) {
  return { id, name: id, pieces: [piece], points: [] };
}
/** A dumper at (X, Y) between a straight up to its `in` port and one leaving its `out` port. */
function siding(params: Record<string, number> = {}, state?: string): WorkshopProject {
  const project = createProject('Dumper');
  const dumper = route('dumper', { id: 'dumper', family: 'rotary_dumper', x: X, y: Y, z: 0, heading: 0, params, ...(state ? { state } : {}) });
  rebuildPiecePoints(project, dumper);
  project.routes = [dumper];
  const out = piecePorts(dumper.pieces[0], project).find(port => port.id === 'out')!;
  const west = route('west', { id: 'west', family: 'track_straight', x: X - 256, y: Y, z: 0, heading: 0, params: { length: 256 } });
  const east = route('east', { id: 'east', family: 'track_straight', x: out.x, y: out.y, z: 0, heading: 0, params: { length: 256 } });
  for (const item of [west, east]) rebuildPiecePoints(project, item);
  project.routes = [dumper, west, east];
  return project;
}
type Assembly = Extract<PartInstance, { interfaceKind: 'track-assembly' }>;
const assembly = (project: WorkshopProject) => fitProject(project).partInstances.find(part => part.id === 'dumper') as Assembly;
const ids = (project: WorkshopProject, routeId: string) => routePath(fitProject(project).sections, routeId).sections.map(section => section.id);

describe('rotary dumper (experimental)', () => {
  it('is an experimental piece with a caution, upright and tipped states', () => {
    const definition = pieceDefinition('rotary_dumper');
    expect(definition.group).toBe('experimental');
    expect(definition.caution).toMatch(/6-wide/);
    expect(definition.states?.map(state => state.id)).toEqual(['upright', 'tipped']);
  });

  it('runs trains through upright; tipped, the route stops at the landing and says why', () => {
    const project = siding();
    expect(ids(project, 'west')).toEqual(['west', 'dumper:main', 'east']);
    const tipped = setPieceState(project, 'dumper', 'tipped');
    const west = routePath(fitProject(tipped).sections, 'west');
    expect(west.gap).toBeNull();
    expect(west.sections.map(section => section.id)).toEqual(['west']);
    expect(west.endHalt).toBe('The dumper is tipped.');
    expect(routePath(fitProject(tipped).sections, 'east').startHalt).toBe('The dumper is tipped.');
    expect(piecePaths(tipped.routes[0].pieces[0], tipped).every(path => path.moving && !path.enabled)).toBe(true);
    expect(piecePorts(tipped.routes[0].pieces[0], tipped).map(port => port.id).sort()).toEqual(['in', 'out']);
    expect(ids(setPieceState(tipped, 'dumper', pieceStates(tipped.routes[0].pieces[0])![0].id), 'west')).toEqual(['west', 'dumper:main', 'east']);
  });

  it('prints one assembly whose parts do not change with the state', () => {
    const project = siding({ span: 160, drive: 1 });
    const upright = assembly(project), tipped = assembly(setPieceState(project, 'dumper', 'tipped'));
    expect(upright.family).toBe('rotary_dumper');
    expect(upright.parameters).toMatchObject({ span: 160, drive: 1, state: 0 });
    expect(tipped.parameters).toEqual({ ...upright.parameters, state: 1 });
    expect(tipped.paths.map(path => path.enabled)).toEqual([false]);
    expect(fitProject(project).issues.filter(issue => issue.severity === 'error')).toEqual([]);
  });

  it('keeps the cradle on the stud grid between 6-stud landings', () => {
    for (const span of [128, 144, 160]) {
      const out = piecePorts(siding({ span }).routes[0].pieces[0], siding({ span })).find(port => port.id === 'out')!;
      expect(out.x - X).toBeCloseTo(96 + span, 9);
    }
  });

  it('publishes the motor only with the motor drive and the crank circle only with the crank', () => {
    expect(dumperOutline(224, 1).length).toBe(dumperOutline(224, 0).length + 1);
    expect(dumperEnvelopes(224, 0).length).toBe(2);
    expect(dumperEnvelopes(224, 1).length).toBe(1);
    // The cradle's swept plan: its 70 mm end rings, from the in face to the out ring's stop lug.
    const [cradle] = dumperEnvelopes(224, 1);
    expect(Math.max(...cradle.map(point => point.y))).toBeCloseTo(70.5, 9);
    expect(Math.max(...cradle.map(point => point.x))).toBeCloseTo(224 - 48.6 + 4.5, 9);
  });

  it('lists the Bluetooth-motor dumper as an automation device and leaves the hand-cranked one out', () => {
    const motor = siding({ drive: 1 }), crank = siding({ drive: 0 });
    const device = automationDevices(motor, fitProject(motor)).find(row => row.id === 'dumper');
    expect(device).toMatchObject({ kind: 'mechanism', control: 'Bluetooth motor', states: [{ id: 'upright' }, { id: 'tipped' }] });
    expect(automationDevices(crank, fitProject(crank)).some(row => row.id === 'dumper')).toBe(false);
  });

  it('lists the infrared-motor dumper as a device and builds it with drive 2', () => {
    const motor = siding({ drive: 2 });
    const device = automationDevices(motor, fitProject(motor)).find(row => row.id === 'dumper');
    expect(device).toMatchObject({ kind: 'mechanism', control: 'Infrared L motor (88003)' });
    expect(assembly(motor).parameters).toMatchObject({ drive: 2 });
    expect(fitProject(motor).issues.filter(issue => issue.severity === 'error')).toEqual([]);
  });
});
