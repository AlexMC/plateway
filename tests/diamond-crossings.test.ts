import { describe, expect, it } from 'vitest';
import { createProject, type RoutePiece, type WorkshopProject } from '../src/domain/project';
import { pieceDefinition, piecePorts } from '../src/domain/pieces';
import { CURVE_CROSSING_KIND, DIAMOND_KIND, diamondMinLeg } from '../src/domain/pieces/families/diamond';
import { GAUNTLET_KIND, gauntletCrossingAngle } from '../src/domain/pieces/families/gauntlet';
import { rebuildPiecePoints } from '../src/editor/operations';
import { fitProject } from '../src/fitting/fit';
import { routePath, samplePath } from '../src/drive/traversal';

function authored(pieces: Omit<RoutePiece, 'id'>[]): WorkshopProject {
  const project = createProject('Crossings');
  const route = { id: 'route', name: 'Track', pieces: pieces.map((piece, index) => ({ id: `p${index}`, ...piece })), points: [] };
  rebuildPiecePoints(project, route); project.routes = [route];
  return project;
}
const SHAPES: [string, Record<string, number>, string][] = [
  ['track_diamond', { angle: 45, length: 160, cross: 160 }, 'crossing'],
  ['track_diamond', { angle: -22.5, length: 336, cross: 336 }, 'crossing'],
  ['track_diamond_curve', { angle: 45, length: 208, radius: 320, sweep: 45 }, 'crossing'],
  ['track_gauntlet', { spacing: 128, offset: 16, entry: 320, length: 128 }, 'parallel']
];

describe('fixed junctions: diamonds, curve crossings and gauntlet track', () => {
  it('fits each as one printed assembly whose two routes are always open', () => {
    for (const [family, params, second] of SHAPES) {
      const fit = fitProject(authored([{ family, x: 500, y: 500, z: 0, heading: 0.4, params }]));
      expect(fit.issues.filter(issue => issue.severity === 'error'), family).toEqual([]);
      expect(fit.partInstances.map(part => [part.family, part.interfaceKind]), family).toEqual([[family, 'track-assembly']]);
      expect(fit.sections.map(section => [section.pathId, section.enabled]), family).toEqual([['main', true], [second, true]]);
      // The piece's own rail crossing is legal; only unrelated overlaps are flagged.
      expect(fit.crossings, family).toEqual([]);
    }
  });

  it('drives across the crossing route through the main route\'s midpoint at the crossing angle', () => {
    const fit = fitProject(authored([{ family: 'track_diamond', x: 500, y: 500, z: 0, heading: 0, params: { angle: 45, length: 160, cross: 160 } }]));
    const crossing = fit.sections.find(section => section.pathId === 'crossing')!;
    const path = routePath([crossing], 'route');
    expect(path.gap).toBeNull();
    expect(samplePath(path, 80)).toMatchObject({ x: expect.closeTo(580, 6), y: expect.closeTo(500, 6), heading: expect.closeTo(Math.PI / 4, 6) });
  });

  it('keeps the joined track clear only when the legs are long enough for the angle', () => {
    const straight = (x: number) => ({ family: 'printed_brick_straight', x, y: 500, z: 0, heading: 0 });
    const collides = (length: number) => fitProject(authored([straight(500 - 128),
      { family: 'track_diamond', x: 500, y: 500, z: 0, heading: 0, params: { angle: 45, length, cross: length } }]))
      .issues.some(issue => issue.code === 'assembly-track-collision');
    expect(diamondMinLeg(45)).toBeCloseTo(154.03, 2);
    expect(collides(128)).toBe(true);
    expect(collides(160)).toBe(false);
    expect(DIAMOND_KIND.problem({ angle: 45, length: 128, cross: 128 })).toMatch(/need 160 mm/);
    expect(DIAMOND_KIND.problem({ angle: 45, length: 160, cross: 160 })).toBeNull();
  });

  it('accepts any angle from 15° and warns below 22.5°', () => {
    expect(DIAMOND_KIND.problem({ angle: 14.5, length: 1024, cross: 1024 })).toMatch(/15° to 90°/);
    expect(DIAMOND_KIND.problem({ angle: -15, length: 496, cross: 496 })).toBeNull();
    expect(DIAMOND_KIND.caution!({ angle: -15, length: 496, cross: 496 })).toMatch(/Experimental/);
    expect(DIAMOND_KIND.caution!({ angle: 22.5, length: 336, cross: 336 })).toBeNull();
    expect(CURVE_CROSSING_KIND.caution!({ angle: 20, length: 512, radius: 448, sweep: 30, bend: 1 })).toMatch(/Experimental/);
    // The gauntlet's entry rails cross at about 26° with its defaults; a sharper squeeze would be flagged.
    expect(gauntletCrossingAngle({ spacing: 128, offset: 16, entry: 320, length: 128 })).toBeCloseTo(25.9, 0);
    expect(GAUNTLET_KIND.caution!(GAUNTLET_KIND.initial)).toBeNull();
    expect(GAUNTLET_KIND.caution!({ ...GAUNTLET_KIND.initial, entry: 1024 })).toMatch(/Experimental/);
  });

  it('describes the same physical piece when authored from its far end or mirrored', () => {
    for (const [family, params] of SHAPES) {
      const definition = pieceDefinition(family);
      const near = authored([{ family, x: 500, y: 500, z: 0, heading: 0.3, params }]), nearPiece = near.routes[0].pieces[0];
      const out = piecePorts(nearPiece, near).find(port => port.id === 'out')!;
      const far = authored([{ family, x: out.x, y: out.y, z: 0, heading: out.heading + Math.PI, params: definition.reverseParams!(params) }]);
      const positions = (project: WorkshopProject, mirror = false) => piecePorts(project.routes[0].pieces[0], project)
        .map(port => [Math.round(port.x * 1000) / 1000, Math.round((mirror ? 1000 - port.y : port.y) * 1000) / 1000])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      expect(positions(far), family).toEqual(positions(near));
      const mirrored = authored([{ family, x: 500, y: 500, z: 0, heading: 0, params: definition.flip!(params) }]);
      const plain = authored([{ family, x: 500, y: 500, z: 0, heading: 0, params }]);
      expect(positions(mirrored, true), family).toEqual(positions(plain));
    }
  });
});
