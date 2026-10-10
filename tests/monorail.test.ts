import { describe, expect, it } from 'vitest';
import { createProject, type RoutePiece, type WorkshopProject } from '../src/domain/project';
import { pieceDefinition, piecePaths, piecePorts, portsMate, primaryEnd } from '../src/domain/pieces';
import { rebuildPiecePoints } from '../src/editor/operations';
import { fitProject } from '../src/fitting/fit';

const piece = (family: string, params: Record<string, number> = {}, extra: Partial<RoutePiece> = {}): RoutePiece =>
  ({ id: family, family, x: 0, y: 0, z: 0, heading: 0, params, ...extra });
const project = createProject('Monorail');
const port = (p: RoutePiece, id: string) => piecePorts(p, project).find(item => item.id === id)!;

/** Pieces chained end to start from (1000, 1000, 100). */
function line(pieces: RoutePiece[]): WorkshopProject {
  const result = createProject('Monorail line');
  let pose = { x: 1000, y: 1000, z: 100, heading: 0 };
  const placed = pieces.map((p, index) => {
    const next = { ...p, id: `p${index}`, ...pose };
    const end = primaryEnd(next, result);
    pose = { x: end.x, y: end.y, z: end.z, heading: end.heading };
    return next;
  });
  const route = { id: 'line', name: 'Line', pieces: placed, points: [] };
  rebuildPiecePoints(result, route); result.routes = [route];
  return result;
}

describe('monorail', () => {
  it('is an experimental, printable network of monorail-gauge paths only', () => {
    for (const family of ['monorail_straight', 'monorail_curve', 'monorail_ramp', 'monorail_switch']) {
      const definition = pieceDefinition(family);
      expect(definition.group).toBe('experimental');
      expect(definition.caution).toMatch(/monorail motor/);
      expect(definition.body).toBe('assembly');
      expect(piecePaths(piece(family), project).every(path => path.gauge === 'monorail')).toBe(true);
    }
  });

  it('places ports where the CAD builds them', () => {
    const near = (actual: { x: number; y: number; z: number; heading: number }, x: number, y: number, z: number, heading: number) => {
      expect(actual.x).toBeCloseTo(x, 3); expect(actual.y).toBeCloseTo(y, 3); expect(actual.z).toBeCloseTo(z, 3);
      expect(Math.cos(actual.heading - heading)).toBeCloseTo(1, 6);
    };
    near(port(piece('monorail_straight', { length: 16 }), 'out'), 128, 0, 0, 0);
    near(port(piece('monorail_curve', { angle: 90, hand: 1 }), 'out'), 224, 224, 0, Math.PI / 2);
    near(port(piece('monorail_curve', { angle: 45, hand: -1 }), 'out'), 224 * Math.sin(Math.PI / 4), -224 * (1 - Math.cos(Math.PI / 4)), 0, -Math.PI / 4);
    const ramp = port(piece('monorail_ramp', { part: 0, climb: 1 }), 'out');
    near(ramp, 256, 0, 48, 0);
    expect(ramp.pitch).toBeCloseTo(Math.atan(.375), 6);
    expect(port(piece('monorail_ramp', { part: 1, climb: 1 }), 'in').pitch).toBeCloseTo(-Math.atan(.375), 6);
    near(port(piece('monorail_switch', { hand: -1 }, { state: 'diverging' }), 'branch'), 256, -448 * (1 - Math.cos(Math.PI / 6)), 0, -Math.PI / 6);
  });

  it('mates only monorail ports', () => {
    const out = port(piece('monorail_straight'), 'out');
    const facing = { ...out, heading: out.heading + Math.PI };
    expect(portsMate(out, { ...facing, gauge: 'monorail' }, .5, .01)).toBe(true);
    for (const gauge of ['standard', 'narrow', 'dual'] as const) expect(portsMate(out, { ...facing, gauge }, .5, .01)).toBe(false);
  });

  it('switches between its straight and diverging routes, and Flip mirrors it', () => {
    const enabled = (state: string) => piecePaths(piece('monorail_switch', {}, { state }), project).map(path => [path.id, path.enabled]);
    expect(enabled('straight')).toEqual([['main', true], ['branch', false]]);
    expect(enabled('diverging')).toEqual([['main', false], ['branch', true]]);
    const definition = pieceDefinition('monorail_switch');
    expect(definition.handed).toBe(true);
    expect(definition.flip?.({ hand: 1 })).toEqual({ hand: -1 });
    expect(definition.cad(piece('monorail_switch', {}, { state: 'diverging' }), project))
      .toEqual([{ family: 'monorail_switch', parameters: { hand: 1, switch_state: 1, slot_width: 17.5, slot_depth: 6.4 } }]);
  });

  it('fits a climbing line as assemblies with pitched ports and no errors', () => {
    const fit = fitProject(line([piece('monorail_straight'), piece('monorail_ramp', { part: 0, climb: 1 }),
      piece('monorail_ramp', { part: 1, climb: 1 }), piece('monorail_curve', { angle: 90, hand: 1 })]));
    expect(fit.issues.filter(issue => issue.severity === 'error')).toEqual([]);
    const lower = fit.partInstances.find(instance => instance.id === 'p1')!;
    expect(lower.family).toBe('monorail_ramp');
    expect(lower.parameters).toMatchObject({ part: 0, climb: 1, slot_width: 17.5, slot_depth: 6.4, connector_version: 1 });
    if (lower.interfaceKind !== 'track-assembly') throw new Error('expected an assembly');
    expect(lower.ports.find(item => item.id === 'out')!.pose.pitch).toBeCloseTo(Math.atan(.375), 6);
    expect(fit.sections.filter(section => section.pieceId === 'p3').every(section => section.gauge === 'monorail')).toBe(true);
  });

  it('lets pieces sit on either switch leg without colliding with the other leg', () => {
    for (const state of ['straight', 'diverging'])
      for (const hand of [1, -1]) {
        const fit = fitProject(line([piece('monorail_switch', { hand }, { state }), piece('monorail_curve', { angle: 30, hand: state === 'diverging' ? -hand : hand }),
          piece('monorail_straight', { length: 16 })]));
        expect(fit.issues.filter(issue => issue.severity === 'error')).toEqual([]);
      }
  });
});
