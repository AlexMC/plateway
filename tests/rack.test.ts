import { describe, expect, it } from 'vitest';
import { pieceDefinition, piecePaths, primaryEnd, sliceTrackOptions } from '../src/domain/pieces';
import { RACK, arc3d, rackOptions } from '../src/domain/pieces/rack-teeth';
import { createProject, type WorkshopProject } from '../src/domain/project';
import { placePiece } from '../src/editor/operations';
import { fitProject } from '../src/fitting/fit';
import { routeProblem } from '../src/drive/compat';

const car = (cog: boolean) => ({ id: cog ? 'loco' : 'wagon', name: 'Car', length: 160, width: 60, height: 90, wheelbase: 100, couplerGap: 10,
  ...(cog ? { cog: true as const } : {}) });

const brick = (): WorkshopProject => ({ ...createProject('Rack'), trackSystem: 'brick-v1' });
const issues = (project: WorkshopProject) => fitProject(project).issues;
function extend(project: WorkshopProject, family: string, params?: Record<string, number>): WorkshopProject {
  const end = primaryEnd(project.routes.at(-1)!.pieces.at(-1)!, project);
  return placePiece(project, family, { x: end.x, y: end.y, z: end.z, heading: end.heading, ...(params ? { params } : {}) }, 1)[0];
}
/** Level straight, rack Entry/Slope/Exit at `grade`, level straight. */
function rackLine(grade: number, slope = 256): WorkshopProject {
  let project = placePiece(brick(), 'track_straight', { x: 300, y: 500, z: 0, params: { length: 128 } })[0];
  project = extend(project, 'track_rack', { part: 0, grade });
  project = extend(project, 'track_rack', { part: 1, grade, length: slope });
  project = extend(project, 'track_rack', { part: 2, grade });
  return extend(project, 'track_straight', { length: 128 });
}
/** Global 3D tooth stations of a rack piece split into the given slices. */
function teeth(options: Record<string, number>, track: Parameters<typeof arc3d>[0], cuts: number[]): number[] {
  const { slices } = sliceTrackOptions(options, cuts.at(-1)!, cuts, track as never);
  const starts = arc3d(track, cuts), stations: number[] = [];
  slices.forEach((slice, index) => {
    for (let d = slice.rack_phase; d <= starts[index + 1] - starts[index] + 1e-9; d += slice.rack_pitch) stations.push(starts[index] + d);
  });
  return stations;
}

describe('rack railway', () => {
  it('climbs up to 20% with only a cog-train warning, and refuses steeper or tighter vertical curves', () => {
    const steep = issues(rackLine(20));
    expect(steep.filter(issue => issue.severity === 'error')).toEqual([]);
    expect(steep.some(issue => issue.code === 'rack-cog-only')).toBe(true);
    expect(issues(rackLine(4)).some(issue => issue.code === 'rack-cog-only')).toBe(false);
    const tight = extend(placePiece(brick(), 'track_straight', { x: 300, y: 500, z: 0, params: { length: 128 } })[0], 'track_rack', { part: 0, grade: 20, length: 128 });
    expect(pieceDefinition('track_rack').problem!(tight.routes[0].pieces[1])).toMatch(/vertical curve/);
  });

  it('keeps tooth spacing at the brick pitch across piece joints and across bed cuts', () => {
    for (const grade of [0, 12, -20]) {
      const project = rackLine(grade, 600), definition = pieceDefinition('track_rack');
      const pieces = project.routes[0].pieces.slice(1, 4);
      const all: number[] = [];
      let offset = 0;
      for (const piece of pieces) {
        const track = definition.composite!(piece, project), options = rackOptions(track, false, false);
        const length = track.segments.reduce((sum, segment) => sum + segment.len, 0);
        const local = teeth(options, track, [0, length / 3, length * 0.71, length]);
        all.push(...local.map(d => d + offset));
        offset += arc3d(track, [length])[0];
      }
      const gaps = all.slice(1).map((d, index) => d - all[index]);
      for (const gap of gaps) expect(Math.abs(gap - RACK.pitch)).toBeLessThan(0.05);
    }
  });

  it('marks its path as rack, keeps standard ports, prints cog bogies as accessories and reverses into the same track', () => {
    const project = rackLine(10), piece = project.routes[0].pieces[1], definition = pieceDefinition('track_rack');
    expect(piecePaths(piece, project).every(path => path.rack && path.gauge === 'standard')).toBe(true);
    const parts = definition.cad({ ...piece, params: { ...piece.params, bogies: 2 } }, project);
    expect(parts[0].parameters).toMatchObject({ rack: 1, rack_in: RACK.taper, rack_out: 0 });
    expect(parts.slice(1).map(part => part.family)).toEqual(['cog_bogie', 'cog_bogie', 'cog_bogie', 'cog_bogie']);
    const fitted = fitProject(project).partInstances.filter(part => part.sectionId === piece.id);
    expect(fitted.every(part => part.parameters.rack === 1)).toBe(true);
    const end = primaryEnd(piece, project);
    const back = { ...piece, id: 'b', x: end.x, y: end.y, z: end.z, heading: end.heading + Math.PI, params: definition.reverseParams!(piece.params ?? {}) };
    const forward = piecePaths(piece, project)[0].points, reversed = piecePaths(back, project)[0].points.slice().reverse();
    expect(Math.hypot(reversed[0].x - piece.x, reversed[0].y - piece.y, reversed[0].z - piece.z)).toBeLessThan(1e-6);
    expect(forward.at(-1)!.z).toBeCloseTo(reversed.at(-1)!.z, 6);
  });

  it('lets only cog trains up a steep rack in Test drive, any train on a gentle one, and keeps cog cars off turnouts', () => {
    const steep = rackLine(15), sections = fitProject(steep).sections, routeId = steep.routes[0].id;
    expect(routeProblem(sections, routeId, [car(false)])).toMatch(/cog car/);
    expect(routeProblem(sections, routeId, [car(true), car(false)])).toBeNull();
    const gentle = rackLine(4);
    expect(routeProblem(fitProject(gentle).sections, gentle.routes[0].id, [car(false)])).toBeNull();
    const switched = extend(steep, 'printed_switch_left');
    expect(routeProblem(fitProject(switched).sections, switched.routes[0].id, [car(true)])).toMatch(/hit the rails inside/);
  });
});
