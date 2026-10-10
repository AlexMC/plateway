import { describe, expect, it } from 'vitest';
import { pieceDefinition, piecePaths, primaryEnd, tieStations } from '../src/domain/pieces';
import { FLEX_TPU_FAMILY, FLEX_TPU_MIN_RADIUS } from '../src/domain/pieces/families/flex-tpu';
import { PLATE_EDGE_MARGIN_MM, PRINTER_ENVELOPES } from '../src/domain/printer';
import { createProject, type WorkshopProject } from '../src/domain/project';
import { placePiece } from '../src/editor/operations';
import { fitProject } from '../src/fitting/fit';

const definition = pieceDefinition(FLEX_TPU_FAMILY);
const flex = (params: Record<string, number>, printer: WorkshopProject['printer'] = 'X1 Carbon'): WorkshopProject =>
  placePiece({ ...createProject('Flex'), trackSystem: 'brick-v1', printer }, FLEX_TPU_FAMILY,
    { x: 600, y: 600, z: 0, heading: 0, params }, -1)[0];
const piece = (project: WorkshopProject) => project.routes[0].pieces[0];
const strip = (parameters: Record<string, number>) =>
  Array.from({ length: parameters.segments }, (_, i) => parameters[`s${i}_len`]).reduce((a, b) => a + b, 0);

describe('flexible TPU track', () => {
  it('derives its minimum radius from gauge, sleeper pitch and kerf, and only shows chosen sections', () => {
    expect(FLEX_TPU_MIN_RADIUS).toBe(320);
    expect(definition.group).toBe('experimental');
    expect(definition.caution).toMatch(/4 mm at R320/);
    expect(definition.params.find(spec => spec.key === 'len3')!.when).toEqual({ key: 'sections', values: [3, 4] });
    expect(definition.params.find(spec => spec.key === 'r1')!.when).toBeUndefined();
  });

  it('draws the shaped centreline: an S of two opposite arcs ends parallel, offset to the left', () => {
    const project = flex({ sections: 2, len1: 192, r1: 480, len2: 192, r2: -480 }), end = primaryEnd(piece(project), project);
    const turn = 192 / 480, offset = 2 * 480 * (1 - Math.cos(turn));
    expect(end.heading).toBeCloseTo(0, 6);
    expect(end.x - 600).toBeCloseTo(2 * 480 * Math.sin(turn), 1);
    expect(end.y - 600).toBeCloseTo(offset, 1);
    expect(definition.description(piece(project))).toBe('384 mm · tightest R480');
    expect(piecePaths(piece(project), project)).toHaveLength(1);
  });

  it('flags radii tighter than R320 in the card and as a fit error', () => {
    const tight = flex({ sections: 1, len1: 128, r1: -240 });
    expect(definition.problem!(piece(tight))).toMatch(/R240 .*R320/);
    const error = fitProject(tight).issues.find(issue => issue.severity === 'error');
    expect(error).toMatchObject({ code: 'piece-settings' });
    expect(error!.message).toMatch(/R240/);
    const limit = flex({ sections: 1, len1: 128, r1: 320 });
    expect(definition.problem!(piece(limit))).toBeNull();
    expect(fitProject(limit).issues.filter(issue => issue.severity === 'error')).toEqual([]);
  });

  it('splits at tie stations by the straight printed length and keeps the drawn curvature per strip', () => {
    for (const printer of ['X1 Carbon', 'A1 mini'] as const) {
      const project = flex({ sections: 3, len1: 480, r1: 320, len2: 96, r2: 0, len3: 448, r3: -640 }, printer);
      const fitted = fitProject(project);
      expect(fitted.issues.filter(issue => issue.severity === 'error')).toEqual([]);
      const parts = fitted.partInstances.filter(part => part.sectionId === piece(project).id);
      const usable = PRINTER_ENVELOPES[printer].x - 2 * PLATE_EDGE_MARGIN_MM - 10;
      const lengths = parts.map(part => strip(part.parameters));
      expect(parts.every(part => part.family === FLEX_TPU_FAMILY)).toBe(true);
      expect(lengths.reduce((a, b) => a + b, 0)).toBeCloseTo(1024, 6);
      // Fewest strips whose straight length fits; every strip whole pitches long, cut at the piece's tie stations.
      expect(parts).toHaveLength(Math.ceil(1024 / (Math.floor(usable / 32) * 32)));
      expect(lengths.every(length => length <= usable && Math.abs(length / 32 - Math.round(length / 32)) < 1e-9)).toBe(true);
      const cuts = lengths.slice(0, -1).map((_, i) => lengths.slice(0, i + 1).reduce((a, b) => a + b, 0));
      expect(cuts.every(cut => tieStations(1024).some(station => Math.abs(station - cut) < 1e-6))).toBe(true);
      const curvatures = parts.flatMap(part => Array.from({ length: part.parameters.segments }, (_, i) => part.parameters[`s${i}_k0`]));
      expect(Math.max(...curvatures.map(Math.abs))).toBeCloseTo(1 / 320, 9);
      expect(parts.every(part => part.parameters.ends === 3)).toBe(true);
    }
  });

  it('reverses and flips like other shaped pieces', () => {
    const params = { sections: 3, len1: 64, r1: 400, len2: 128, r2: 0, len3: 96, r3: -800 };
    expect(definition.reverseParams!(params)).toMatchObject({ len1: 96, r1: 800, len2: 128, r2: -0, len3: 64, r3: -400 });
    expect(definition.flip!(params)).toMatchObject({ r1: -400, r3: 800 });
  });
});
