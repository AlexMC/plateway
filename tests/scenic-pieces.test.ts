import { describe, expect, it } from 'vitest';
import { createProject, parseProject, serializeProject, type WorkshopProject } from '../src/domain/project';
import { BALLAST_SHOULDER, compositeCentreline, primaryEnd, pieceDefinition, piecePorts, portsMate, sliceTrackOptions, tieStations, type CompositeTrack } from '../src/domain/pieces';
import { fitProject } from '../src/fitting/fit';
import { placePiece, previewPiece, unoccupiedPiecePorts, type Placement, type TileFamily } from '../src/editor/operations';

function extend(project: WorkshopProject, family: TileFamily, placement: Partial<Placement> = {}): WorkshopProject {
  const end = primaryEnd(project.routes.at(-1)!.pieces.at(-1)!, project);
  return placePiece(project, family, { x: end.x, y: end.y, heading: end.heading, ...placement })[0];
}
const accessories = (project: WorkshopProject) => fitProject(project).partInstances.filter(part => part.interfaceKind === 'accessory');

describe('buffer stop', () => {
  const project = extend(placePiece(createProject('Siding'), 'printed_brick_straight', { x: 300, y: 300 })[0], 'buffer_stop', { params: { length: 64 } });
  const buffer = project.routes[0].pieces[1];

  it('ends the track: its far port mates nothing and is no open end, so nothing snaps onto it', () => {
    const far = piecePorts(buffer, project).find(port => port.id === 'out')!;
    expect(far.stop).toBe(true);
    expect(unoccupiedPiecePorts(project).map(({ part, port }) => `${part.family}:${port.id}`)).toEqual(['printed_brick_straight:in']);
    expect(portsMate(far, { ...far, heading: far.heading + Math.PI, stop: undefined }, 1, .01)).toBe(false);
    const preview = previewPiece(project, 'printed_brick_straight', { x: far.x, y: far.y, heading: far.heading });
    expect(preview.target).toBeNull();
  });

  it('still takes track on its connector end when placed first', () => {
    const alone = placePiece(createProject('Buffer first'), 'buffer_stop', { x: 300, y: 300 })[0];
    const start = piecePorts(alone.routes[0].pieces[0], alone).find(port => port.id === 'in')!;
    const preview = previewPiece(alone, 'printed_brick_straight', { x: start.x - 128, y: start.y, heading: 0 });
    expect(preview.target?.id).toBe('in');
    expect(preview.edge).toBe('start');
  });

  it('fits as one printed rail part with the shared brick profile', () => {
    const fit = fitProject(project);
    expect(fit.geometryFeasible).toBe(true);
    const part = fit.partInstances.find(instance => instance.family === 'buffer_stop')!;
    expect(part).toMatchObject({ interfaceKind: 'rail', geometryAvailable: true, parameters: { run: 64, connector_version: 1 } });
  });
});

describe('rerailer', () => {
  it.each([64, 128])('fits a %i mm rerailer between straights', length => {
    let project = placePiece(createProject('Rerail'), 'printed_brick_straight', { x: 300, y: 300 })[0];
    project = extend(extend(project, 'rerailer', { params: { length } }), 'printed_brick_straight');
    const fit = fitProject(project);
    expect(fit.geometryFeasible).toBe(true);
    expect(fit.partInstances.find(part => part.family === 'rerailer')?.parameters.run).toBe(length);
    expect(fit.issues.filter(issue => issue.code === 'port-discontinuity')).toEqual([]);
  });
});

describe('track options', () => {
  it('put a colour marker on the full sleeper nearest its station, never on a cut', () => {
    // 2000 mm on an A1 mini splits; the marker lands on one slice with a local station.
    const cuts = [0, 160, 320, 480];
    const { slices, marker } = sliceTrackOptions({ ballast: 1, marker: 9, marker_s: 170 }, 480, cuts);
    expect(slices.every(slice => slice.ballast === 1)).toBe(true);
    expect(marker).toEqual({ slice: 1, station: 192 });
    expect(slices[1]).toMatchObject({ marker: 9, marker_s: 32 });
    expect(slices.filter(slice => 'marker' in slice)).toHaveLength(1);
    // The chosen station is a full tie of the parent layout.
    expect(tieStations(480)).toContain(192);
    expect(sliceTrackOptions({ marker: 9, marker_s: 16 }, 32, [0, 32]).marker).toBeNull();
  });

  it('fit prints a marker insert seated in its sleeper and flags pieces too short for one', () => {
    const project = placePiece(createProject('Markers'), 'track_straight', { x: 300, y: 300, params: { length: 192, marker: 3, marker_s: 100 } })[0];
    const [insert] = accessories(project);
    expect(insert).toMatchObject({ family: 'marker_insert', parameters: { marker: 3 }, pose: { x: 396, y: 300, z: 3.2 } });
    const track = fitProject(project).partInstances.find(part => part.interfaceKind === 'rail')!;
    expect(track.parameters).toMatchObject({ marker: 3, marker_s: 96 });

    const short = placePiece(createProject('Short'), 'track_straight', { x: 300, y: 300, params: { length: 40, marker: 3 } })[0];
    expect(fitProject(short).issues).toContainEqual(expect.objectContaining({ code: 'marker-no-tie', severity: 'error' }));
    expect(accessories(short)).toEqual([]);
  });

  it('street wins over a guard rail, which is offered on curves only', () => {
    const straight = pieceDefinition('track_straight'), curve = pieceDefinition('track_curve');
    expect(straight.params.some(spec => spec.key === 'guard_rail')).toBe(false);
    expect(curve.params.some(spec => spec.key === 'guard_rail')).toBe(true);
    const project = placePiece(createProject('Street curve'), 'track_curve', { x: 300, y: 300, params: { street: 1, guard_rail: 1 } })[0];
    const part = fitProject(project).partInstances[0];
    expect(part.parameters.street).toBe(1);
    expect(part.parameters.guard_rail).toBeUndefined();
  });

  it('splits ballasted track so every part fits the plate with its shoulders', () => {
    const shoulders = (params: Record<string, number>) => {
      const track: CompositeTrack = { segments: Array.from({ length: params.segments }, (_, i) =>
        ({ len: params[`s${i}_len`], k0: params[`s${i}_k0`], k1: params[`s${i}_k1`] })),
      z0: 0, z1: 0, grade0: 0, grade1: 0, cant0: 0, cant1: 0, vcurve: 0 };
      const half = 63.8 / 2 + BALLAST_SHOULDER, xs: number[] = [], ys: number[] = [];
      for (const p of compositeCentreline(track)) for (const side of [-half, half]) {
        xs.push(p.x - Math.sin(p.heading) * side); ys.push(p.y + Math.cos(p.heading) * side);
      }
      return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
    };
    const usable = 180 - 14 - 10;
    const project = placePiece(createProject('Ballast'), 'track_curve', { x: 600, y: 600, params: { radius: 256, sweep: 32.5, ballast: 1 } })[0];
    project.printer = 'A1 mini';
    const parts = fitProject(project).partInstances;
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(Math.max(...shoulders(part.parameters))).toBeLessThanOrEqual(usable + 1e-5);
  });
});

describe('street track and level crossing', () => {
  it('street track always prints with the street surface and survives a save', () => {
    const project = placePiece(createProject('Tram'), 'street_track', { x: 300, y: 300, params: { radius: 448, sweep: 22.5 } })[0];
    const reloaded = parseProject(serializeProject(project));
    const [part] = fitProject(reloaded).partInstances;
    expect(part.parameters).toMatchObject({ street: 1, s0_k0: 1 / 448 });
    expect(pieceDefinition('street_track').params.map(spec => spec.key)).not.toContain('ballast');
  });

  it('a square crossing is one street straight plus an apron and a filler', () => {
    const project = placePiece(createProject('Crossing'), 'level_crossing', { x: 300, y: 300, params: { right: 1 } })[0];
    const fit = fitProject(project);
    expect(fit.geometryFeasible).toBe(true);
    expect(fit.partInstances.filter(part => part.interfaceKind === 'rail').map(part => part.parameters.street)).toEqual([1]);
    expect(accessories(project).map(part => [part.family, part.parameters.side, part.parameters.kind])).toEqual([
      ['road_tile', 1, 0], ['road_tile', -1, 1]]);
    expect(accessories(project)[0].pose).toEqual({ x: 300, y: 300, z: 0, heading: 0, pitch: 0 });
  });

  it('a 45° crossing splits its road tiles in halves and reversing swaps the sides', () => {
    const project = placePiece(createProject('Skew'), 'level_crossing', { x: 300, y: 300, params: { angle: 45, left: 1 } })[0];
    const tiles = accessories(project);
    expect(tiles).toHaveLength(4);
    expect(tiles.every(tile => tile.parameters.run === 256 && tile.parameters.half !== 0)).toBe(true);
    expect(pieceDefinition('level_crossing').reverseParams!({ angle: 45, left: 1, right: 0 })).toEqual({ angle: 45, left: 0, right: 1 });
  });
});
