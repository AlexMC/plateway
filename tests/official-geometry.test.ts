import { describe, expect, it } from 'vitest';
import { createProject, type RoutePiece } from '../src/domain/project';
import { OWNED_DEFINITIONS, counterpartFamily, piecePorts } from '../src/domain/pieces';

/**
 * Official port geometry (mm, degrees; heading = travel direction leaving the piece), derived from the
 * LDraw official .dat files (53401, 53400, 64022, 2859/53404, 32087), BlueBrick connection XML (7996)
 * and the L-Gauge track geometry tables. Left-hand turns and branches are +y.
 */
const OFFICIAL: Record<string, [string, number, number, number][]> = {
  brick_straight_nominal: [['in', 0, 0, 180], ['out', 128, 0, 0]],
  brick_curve_r40: [['in', 0, 0, 180], ['out', 122.46, 24.36, 22.5]],
  brick_flex: [['in', 0, 0, 180], ['out', 31.92, 1.57, 5.625]],
  brick_switch_left: [['in', 0, 0, 180], ['out', 256, 0, 0], ['branch', 261.54, 103.64, 22.5]],
  brick_switch_right: [['in', 0, 0, 180], ['out', 256, 0, 0], ['branch', 261.54, -103.64, -22.5]],
  brick_crossing90: [['in', 0, 0, 180], ['out', 128, 0, 0], ['north', 64, 64, 90], ['south', 64, -64, -90]],
  brick_double_crossover: [['in', 0, 0, 180], ['out', 384, 0, 0], ['parallel-in', 0, 128, 180], ['parallel-out', 384, 128, 0]]
};
const degrees = (radians: number) => ((radians * 180 / Math.PI) % 360 + 540) % 360 - 180;

describe('official brick track geometry', () => {
  const project = createProject('Official');
  for (const shape of OWNED_DEFINITIONS) for (const family of [shape.family, counterpartFamily(shape.family, 'printed')!]) {
    it(`${family} ports match the official ${shape.label}`, () => {
      const piece: RoutePiece = { id: family, family, x: 0, y: 0, z: 0, heading: 0,
        ...(shape.legacy?.sweep !== undefined ? { sweep: Math.PI / 8 } : {}), ...(shape.legacy?.bend !== undefined ? { bend: Math.PI / 32 } : {}) };
      const ports = piecePorts(piece, project);
      expect(ports.map(port => port.id).sort()).toEqual(OFFICIAL[shape.family].map(([id]) => id).sort());
      for (const [id, x, y, heading] of OFFICIAL[shape.family]) {
        const port = ports.find(item => item.id === id)!;
        expect(port.x).toBeCloseTo(x, 2);
        expect(port.y).toBeCloseTo(y, 2);
        expect(Math.abs(degrees(port.heading) - degrees(heading * Math.PI / 180))).toBeLessThan(0.001);
      }
    });
  }

  it('closes a circle of 16 R40 curves exactly', () => {
    let end = { x: 0, y: 0, heading: 0 };
    for (let index = 0; index < 16; index++) {
      const piece: RoutePiece = { id: String(index), family: 'brick_curve_r40', x: end.x, y: end.y, z: 0, heading: end.heading, sweep: Math.PI / 8 };
      const out = piecePorts(piece, project).find(port => port.id === 'out')!;
      end = { x: out.x, y: out.y, heading: out.heading };
    }
    expect(Math.hypot(end.x, end.y)).toBeLessThan(1e-9);
  });
});
