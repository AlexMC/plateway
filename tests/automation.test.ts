import { describe, expect, it } from 'vitest';
import { automationDevices } from '../src/domain/automation';
import { pieceDefinition } from '../src/domain/pieces';
import { checkAssemblyFootprints } from '../src/domain/track-footprints';
import { createProject, type RoutePiece, type WorkshopProject } from '../src/domain/project';
import { rebuildPiecePoints } from '../src/editor/operations';
import { fitProject } from '../src/fitting/fit';

function layout(...routes: RoutePiece[][]): WorkshopProject {
  const project = createProject('Automation');
  project.routes = routes.map((pieces, index) => {
    const route = { id: `route-${index + 1}`, name: `Track ${index + 1}`, pieces, points: [] };
    rebuildPiecePoints(project, route);
    return route;
  });
  return project;
}
const piece = (id: string, family: string, x: number, y: number, params: Record<string, number> = {}): RoutePiece =>
  ({ id, family, x, y, z: 0, heading: 0, params });

describe('servo-driven turnouts', () => {
  it('print with a servo only on manual points and reserve the servo zone away from the branch', () => {
    const definition = pieceDefinition('turnout_radius');
    const left = piece('t', 'turnout_radius', 0, 0, { radius: 40, hand: 1, servo: 1 });
    expect(definition.cad(left, layout([left]))[0].parameters).toMatchObject({ servo: 1, sprung: 0 });
    expect(definition.description(left)).toContain('servo');
    const [points, servo] = definition.envelopes!(left, layout([left]));
    expect(points.length).toBeGreaterThan(2);
    // The left-hand turnout's branch goes left, so its servo sits on the right, out to 82 mm and never past the toe.
    expect(Math.max(...servo.map(p => p.y))).toBeLessThanOrEqual(1e-9);
    expect(Math.min(...servo.map(p => p.y))).toBeCloseTo(-82, 6);
    expect(Math.min(...servo.map(p => p.x))).toBeGreaterThanOrEqual(-1e-9);
    const right = piece('t', 'turnout_radius', 0, 0, { radius: 40, hand: -1, servo: 1 });
    expect(Math.min(...definition.envelopes!(right, layout([right]))[1].map(p => p.y))).toBeGreaterThanOrEqual(-1e-9);

    const sprung = piece('t', 'turnout_radius', 0, 0, { radius: 40, hand: 1, sprung: 1, servo: 1 });
    expect(definition.cad(sprung, layout([sprung]))[0].parameters).not.toHaveProperty('servo');
    expect(definition.envelopes!(sprung, layout([sprung]))).toHaveLength(1);
    expect(definition.params.find(spec => spec.key === 'servo')!.when).toEqual({ key: 'sprung', values: [0] });
    const threeWay = piece('w', 'turnout_three_way', 0, 0, { servo: 1 });
    expect(pieceDefinition('turnout_three_way').envelopes!(threeWay, layout([threeWay]))).toHaveLength(4);
  });

  it('flags track laid inside the servo zone but not track beside the branch', () => {
    const turnout = piece('t', 'turnout_radius', 0, 0, { radius: 40, hand: 1, servo: 1 });
    const near = (y: number) => [piece('s', 'track_straight', 0, y, { length: 256 })];
    const clashes = (project: WorkshopProject) => checkAssemblyFootprints(project).filter(issue => issue.severity === 'error');
    expect(clashes(layout([turnout], near(-96)))).not.toEqual([]);
    expect(clashes(layout([turnout], near(-128)))).toEqual([]);
    expect(clashes(layout([{ ...turnout, params: { radius: 40, hand: 1 } }], near(-96)))).toEqual([]);
  });
});

describe('automation devices', () => {
  it('lists servo points, motorised mechanisms, servo uncouplers and colour markers by id, and nothing hand-worked', () => {
    const project = layout(
      [piece('points', 'turnout_radius', 0, 0, { radius: 40, hand: 1, servo: 1 })],
      [piece('hand-points', 'turnout_radius', 0, 400, { radius: 40, hand: 1 })],
      [piece('servo-uncoupler', 'uncoupler_track', 0, 800, { drive: 1 }), piece('magnet-uncoupler', 'uncoupler_track', 128, 800, { drive: 0 })],
      [piece('marked', 'track_straight', 0, 1200, { length: 128, marker: 9 })],
      [piece('bascule', 'bridge_bascule', 0, 1600, { drive: 1 }), piece('lift', 'bridge_lift', 0, 2000, { drive: 1 })]);
    const devices = automationDevices(project, fitProject(project));
    expect(devices.map(device => [device.id, device.kind, device.control])).toEqual([
      ['points', 'turnout', 'SG90 servo'],
      ['servo-uncoupler', 'uncoupler', 'Servo'],
      ['bascule', 'mechanism', 'Bluetooth motor'],
      ['marked:marker', 'colour-marker', 'Colour & distance sensor (88007)']]);
    expect(devices[0]).toMatchObject({ routeId: 'route-1', state: 'straight', colourId: null,
      states: [{ id: 'straight', label: 'Straight' }, { id: 'diverging', label: 'Diverging' }] });
    expect(devices[3]).toMatchObject({ label: 'Red marker', colourId: 9, states: [], state: null, routeId: 'route-4' });
    const three = layout([piece('three', 'turnout_three_way', 0, 0, { servo: 1 })]);
    expect(automationDevices(three, fitProject(three))[0].control).toBe('2 × SG90 servo');
  });
});
