import { describe, expect, it } from 'vitest';
import { createProject, type RoutePiece, type WorkshopProject } from '../src/domain/project';
import { pieceDefinition, piecePaths, stepState } from '../src/domain/pieces';
import { checkAssemblyFootprints } from '../src/domain/track-footprints';
import { rebuildPiecePoints, setPieceParam, setPieceState } from '../src/editor/operations';
import { fitProject } from '../src/fitting/fit';
import { routePath } from '../src/drive/traversal';

const straight = (id: string, x: number, y: number, length = 128): RoutePiece =>
  ({ id, family: 'track_straight', x, y, z: 0, heading: 0, params: { length } });

/** in-straight → uncoupler → out-straight along +x; optionally a parallel straight `spacing` mm to the drive side. */
function line(params: Record<string, number> = {}, extra: Partial<RoutePiece> = {}, spacing?: number): WorkshopProject {
  const project = createProject('Uncoupler');
  const pieces: RoutePiece[] = [straight('a', 1000, 1000),
    { id: 'u', family: 'uncoupler_track', x: 1128, y: 1000, z: 0, heading: 0, params, ...extra }, straight('b', 1256, 1000)];
  const route = { id: 'line', name: 'Line', pieces, points: [] };
  rebuildPiecePoints(project, route); project.routes = [route];
  if (spacing !== undefined) {
    const siding = { id: 'siding', name: 'Siding', pieces: [straight('s', 1000, 1000 - spacing, 384)], points: [] };
    rebuildPiecePoints(project, siding); project.routes.push(siding);
  }
  return project;
}

describe('uncoupler track', () => {
  it('is a printable mechanism whose only path runs while the flap is lowered', () => {
    const definition = pieceDefinition('uncoupler_track');
    expect(definition.group).toBe('mechanism');
    expect(definition.styles).toEqual(['detailed', 'fast']);
    expect(definition.states?.map(state => state.id)).toEqual(['lowered', 'raised']);
    let project = line();
    const enabled = () => piecePaths(project.routes[0].pieces[1], project).map(path => [path.id, path.enabled]);
    expect(enabled()).toEqual([['main', true]]);
    project = setPieceState(project, 'u', 'raised');
    expect(enabled()).toEqual([['main', false]]);
    expect(stepState(project.routes[0].pieces[1], 1)).toBe('lowered');
  });

  it('lets trains through lowered and ends the route at the raised flap with its message', () => {
    const lowered = routePath(fitProject(line()).sections, 'line');
    expect(lowered.gap).toBeNull();
    expect(lowered.sections.map(section => section.id)).toEqual(['a', 'u:main', 'b']);
    expect(lowered.endHalt).toBeUndefined();
    const raised = routePath(fitProject(setPieceState(line(), 'u', 'raised')).sections, 'line');
    expect(raised.gap).toBeNull();
    expect(raised.sections.map(section => section.id)).toEqual(['a']);
    expect(raised.endHalt).toBe('Uncoupler raised — lower it to pass');
  });

  it('prints in either state with the drive and state the CAD service builds', () => {
    for (const [state, switchState] of [['lowered', 0], ['raised', 1]] as const) for (const drive of [0, 1]) {
      const fit = fitProject(line({ drive }, { state, style: 'fast' }));
      const part = fit.partInstances.find(instance => instance.id === 'u')!;
      expect(part.family).toBe('uncoupler_track');
      expect(part.geometryAvailable).toBe(true);
      expect(part.parameters).toEqual({ connector_version: 1, fit_adjustment: part.parameters.fit_adjustment, drive, switch_state: switchState, lite: 1 });
      expect(fit.issues.filter(issue => issue.severity === 'error')).toEqual([]);
    }
  });

  it('keeps the servo drive inside the gap to a parallel track 16 studs away, but not 12', () => {
    const collisions = (project: WorkshopProject) => checkAssemblyFootprints(project).filter(issue => issue.code === 'assembly-track-collision');
    expect(collisions(line({ drive: 1 }, {}, 128))).toEqual([]);
    expect(collisions(line({ drive: 0 }, {}, 96))).toEqual([]);
    expect(collisions(line({ drive: 1 }, {}, 96))).toHaveLength(1);
    // Switching the drive changes the published travel envelope.
    const servo = setPieceParam(line({}, {}, 96), 'u', 'drive', 1);
    expect(collisions(servo)).toHaveLength(1);
  });
});
