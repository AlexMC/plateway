import { describe, expect, it } from 'vitest';
import { createProject, type RoutePiece, type WorkshopProject } from '../src/domain/project';
import { checkAssemblyFootprints } from '../src/domain/track-footprints';
import { pieceDefinition, piecePaths, piecePorts, portsMate } from '../src/domain/pieces';
import { FUNICULAR, funicularSupportHeight } from '../src/domain/pieces/families/funicular';
import { flipPiece, rebuildPiecePoints, setPieceParam } from '../src/editor/operations';
import { fitProject } from '../src/fitting/fit';
import { routePath } from '../src/drive/traversal';

const funicular = (params: Record<string, number> = {}): RoutePiece =>
  ({ id: 'f', family: 'funicular', x: 1000, y: 1000, z: 0, heading: 0.3, params });

function layout(params: Record<string, number> = {}, extra: RoutePiece[] = []): WorkshopProject {
  const project = createProject('Funicular');
  const route = { id: 'hill', name: 'Hill', pieces: [funicular(params), ...extra], points: [] };
  rebuildPiecePoints(project, route); project.routes = [route];
  return project;
}

describe('funicular', () => {
  it('is an experimental, cable-hauled assembly whose steep path mates nothing', () => {
    const definition = pieceDefinition('funicular');
    expect(definition.group).toBe('experimental');
    expect(definition.caution).toMatch(/string winch/);
    expect(definition.body).toBe('assembly');
    const project = layout();
    const [path] = piecePaths(project.routes[0].pieces[0], project);
    expect(path.cable).toBe(true);
    // 35 %: constant pitch, both buffers plus 64 studs of hauled track along the slope.
    const theta = Math.atan(.35), first = path.points[0], last = path.points.at(-1)!;
    expect(path.points.every(point => Math.abs(point.pitch! - theta) < 1e-12)).toBe(true);
    expect(first.z).toBeCloseTo(FUNICULAR.footMin + FUNICULAR.plankT * Math.cos(theta), 9);
    expect(Math.hypot(last.x - first.x, last.y - first.y, last.z - first.z)).toBeCloseTo(2 * 64 + 512, 6);
    const ports = piecePorts(project.routes[0].pieces[0], project);
    expect(ports.map(port => port.stop)).toEqual([true, true]);
    // Even a port placed exactly face to face joins nothing.
    const facing = { ...ports[1], heading: ports[1].heading + Math.PI };
    expect(portsMate(ports[1], facing, 1, .1)).toBe(false);
  });

  it('fits with the parameters the CAD service builds, and a train can run it', () => {
    const fit = fitProject(layout({ climb: 96, grade: 45, motor: 1, side: -1 }));
    expect(fit.issues.filter(issue => issue.severity === 'error')).toEqual([]);
    const part = fit.partInstances.find(instance => instance.id === 'f')!;
    expect(part.family).toBe('funicular');
    expect(part.interfaceKind).toBe('track-assembly');
    expect(part.parameters).toEqual({ connector_version: 1, fit_adjustment: part.parameters.fit_adjustment,
      length: 768, grade: 45, motor: 1, side: -1 });
    // Outward port pitch, as cad/models/funicular.ports returns it for validate_assembly.
    if (part.interfaceKind !== 'track-assembly') throw new Error('expected an assembly');
    expect(part.ports.map(port => [port.id, port.pose.pitch])).toEqual([['in', -Math.atan(.45)], ['out', Math.atan(.45)]]);
    const path = routePath(fit.sections, 'hill');
    expect(path.gap).toBeNull();
    expect(path.sections.map(section => section.id)).toEqual(['f:main']);
    expect(path.length).toBeCloseTo((128 + 768) * Math.cos(Math.atan(.45)), 6);
  });

  it('snaps out-of-step values to buildable ones and flips the motor to the other side', () => {
    let project = layout({ climb: 70, grade: 37.4 });
    expect(pieceDefinition('funicular').cad(project.routes[0].pieces[0], project)[0].parameters)
      .toEqual({ length: 512, grade: 37, motor: 0, side: 1 });
    project = setPieceParam(project, 'f', 'grade', 60);
    const steep = piecePaths(project.routes[0].pieces[0], project)[0];
    expect(steep.points[0].pitch).toBeCloseTo(Math.atan(.6), 12);
    project = flipPiece(project, 'f');
    expect(project.routes[0].pieces[0].params?.side).toBe(-1);
    // The top foot's support: the plank's bottom face under the seat's low end.
    expect(funicularSupportHeight({ params: { climb: 64, grade: 35 } })).toBeCloseTo((688 - 48) * Math.sin(Math.atan(.35)), 9);
  });
});

describe('funicular footprint', () => {
  /** A level funicular along +x and a 384 mm straight parallel to it, `offset` mm to its left (negative: right). */
  function beside(offset: number, side: number): WorkshopProject {
    const project = createProject('Funicular footprint');
    const hill = { id: 'hill', name: 'Hill', pieces: [{ ...funicular({ side }), heading: 0 }], points: [] };
    const siding = { id: 'siding', name: 'Siding', points: [],
      pieces: [{ id: 's', family: 'track_straight', x: 1300, y: 1000 + offset, z: 0, heading: 0, params: { length: 384 } }] };
    rebuildPiecePoints(project, hill); rebuildPiecePoints(project, siding); project.routes = [hill, siding];
    return project;
  }
  const collisions = (project: WorkshopProject) => checkAssemblyFootprints(project).filter(issue => issue.code === 'assembly-track-collision');

  it('keeps neighbouring track clear of the plank and the motor on its side', () => {
    // The top station's motor stands 17-83 mm out on the right (side 1) beside the last 64 mm of track.
    expect(collisions(beside(-96, 1))).toHaveLength(1);
    expect(collisions(beside(96, 1))).toEqual([]);
    expect(collisions(beside(96, -1))).toHaveLength(1);
    expect(collisions(beside(-128, 1))).toEqual([]);
  });
});
