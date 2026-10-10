import { describe, expect, it } from 'vitest';
import { BRICK_LAYOUT, BRICK_TRACK } from '../src/domain/track';
import { braceBands, braceGeometry, braceStations, connectorCentre, connectorGeometry, curveTieLayout, endStudPoses, LITE_BRACE, studPoses, tieBands, tieIntervals, type PreviewPose } from '../src/editor/track-preview';

const R40_RUN = BRICK_LAYOUT.curveRadius * BRICK_LAYOUT.curveSweep;

/** Right-turning R40 samples, the LDraw 53400 frame: in-port at the origin heading +x. */
function r40Samples(): PreviewPose[] {
  const count = Math.ceil(R40_RUN / 16), radius = BRICK_LAYOUT.curveRadius;
  return Array.from({ length: count + 1 }, (_, index) => {
    const heading = -BRICK_LAYOUT.curveSweep * index / count;
    return { x: -radius * Math.sin(heading), y: -radius * (1 - Math.cos(heading)), z: 0, heading };
  });
}

describe('preview tie layout', () => {
  it('uses equal-angle ties only on the official R40 22.5° curve', () => {
    expect(curveTieLayout(BRICK_LAYOUT.curveRadius, BRICK_LAYOUT.curveSweep)).toBe('official-curve');
    expect(curveTieLayout(BRICK_LAYOUT.curveRadius, -BRICK_LAYOUT.curveSweep)).toBe('official-curve');
    expect(curveTieLayout(BRICK_LAYOUT.wideCurveRadius, BRICK_LAYOUT.curveSweep)).toBe('modular');
    expect(curveTieLayout(BRICK_LAYOUT.curveRadius, BRICK_LAYOUT.curveSweep / 2)).toBe('modular');
  });

  it('centres R40 full ties at 5.625° steps (LDraw 53400 stations 31.416, 62.832, 94.248)', () => {
    const intervals = tieIntervals(R40_RUN, 'official-curve');
    expect(intervals[0]).toEqual([0, BRICK_TRACK.endTieWidth]);
    expect(intervals.at(-1)![1]).toBeCloseTo(R40_RUN, 9);
    const full = intervals.slice(1, -1);
    expect(full.map(([start, end]) => (start + end) / 2)).toEqual([31.416, 62.832, 94.248].map(value => expect.closeTo(value, 3)));
    for (const [start, end] of full) expect(end - start).toBeCloseTo(BRICK_TRACK.tieWidth, 9);
  });

  it('keeps printed-only residuals in the central gap(s)', () => {
    expect(tieIntervals(128).slice(1, -1).map(([start, end]) => (start + end) / 2)).toEqual([32, 64, 96]);
    expect(tieIntervals(150).slice(1, -1).map(([start, end]) => (start + end) / 2)).toEqual([32, 75, 118]);
  });

  it('draws each R40 full tie as one rigid rectangle on its centre tangent', () => {
    const middle = connectorCentre(r40Samples(), R40_RUN);
    // End half ties sit under the rigid connector outline; full ties are the 15.8 mm bands.
    const bands = tieBands(middle, R40_RUN, 'official-curve').filter(band =>
      Math.hypot(band.at(-1)!.x - band[0].x, band.at(-1)!.y - band[0].y) > BRICK_TRACK.endTieWidth);
    expect(bands).toHaveLength(3);
    for (const [index, [a, b]] of bands.entries()) {
      expect(a.heading).toBeCloseTo(b.heading, 12);
      expect(a.heading).toBeCloseTo(-BRICK_LAYOUT.curveSweep * (index + 1) / 4, 3);
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(BRICK_TRACK.tieWidth, 9);
      expect(Math.atan2(b.y - a.y, b.x - a.x)).toBeCloseTo(a.heading, 9);
    }
  });

  it('places every official R40 stud where LDraw 53400 does', () => {
    const offsets = BRICK_TRACK.brickAttachment.studLateralOffsets;
    expect([...offsets].sort((a, b) => a - b)).toEqual([-28, -12, -4, 4, 12, 28]);
    const studs = studPoses(r40Samples(), R40_RUN, 'official-curve');
    expect(studs).toHaveLength(8 * offsets.length);
    // curve_studs.md: tie A in-port row and the T2 rows (lateral +28, +12, +4, -4, -12, -28).
    const ldraw: [number, number][] = [
      [4, 28], [4, 12], [4, 4], [4, -4], [4, -12], [4, -28],
      [30.129, 26.716], [28.561, 10.793], [27.777, 2.832], [26.993, -5.130], [26.209, -13.091], [24.640, -29.014],
      [38.091, 25.932], [36.522, 10.009], [35.738, 2.048], [34.954, -5.914], [34.170, -13.875], [32.602, -29.798],
      [63.968, 22.094], [60.847, 6.401], [59.286, -1.445], [57.725, -9.291], [56.165, -17.138], [53.043, -32.830],
      [71.815, 20.533], [68.693, 4.840], [67.132, -3.006], [65.572, -10.852], [64.011, -18.698], [60.890, -34.391],
      [97.191, 14.176], [92.547, -1.135], [90.224, -8.790], [87.902, -16.446], [85.580, -24.101], [80.935, -39.412],
      [104.847, 11.854], [100.202, -3.457], [97.880, -11.112], [95.558, -18.768], [93.235, -26.424], [88.591, -41.735],
      [129.478, 3.041], [123.355, -11.741], [120.294, -19.132], [117.232, -26.523], [114.171, -33.914], [108.048, -48.696]
    ];
    for (const [x, y] of ldraw) {
      const nearest = Math.min(...studs.map(stud => Math.hypot(stud.x - x, stud.y - y)));
      expect(nearest, `stud at ${x}, ${y}`).toBeLessThan(0.05);
    }
  });
});

describe('preview half-tie stud columns', () => {
  /** Top-of-stud vertices near a column of the half-tie row at x = 4 in the port frame. */
  const studTop = (flex: boolean, lateral: number) => {
    const position = connectorGeometry(0, flex).getAttribute('position');
    const { studRowOffset, studBaseZ, studHeight, studDiameter } = BRICK_TRACK.brickAttachment;
    return Array.from({ length: position.count }, (_, index) => index).some(index =>
      Math.hypot(position.getX(index) - studRowOffset, position.getY(index) - lateral) <= studDiameter / 2 + .1 &&
      position.getZ(index) > studBaseZ + studHeight - .05);
  };

  it('gives flex half ties only the LDraw 64022 columns, in 2D and 3D', () => {
    const { studLateralOffsets, flexStudLateralOffsets } = BRICK_TRACK.brickAttachment;
    expect([...flexStudLateralOffsets].sort((a, b) => a - b)).toEqual([-28, -4, 4, 28]);
    const flex: PreviewPose[] = [{ x: 0, y: 0, z: 0, heading: 0 }, { x: 32, y: 0, z: 0, heading: 0 }];
    const studs = studPoses(flex, 32, 'modular', flexStudLateralOffsets);
    expect(studs.map(stud => [Math.round(stud.x), Math.round(stud.y)]).sort((a, b) => a[0] - b[0] || a[1] - b[1]))
      .toEqual([4, 28].flatMap(x => [-28, -4, 4, 28].map(y => [x, y])));
    for (const lateral of studLateralOffsets) {
      expect(studTop(false, lateral), `straight end stud ${lateral}`).toBe(true);
      expect(studTop(true, lateral), `flex end stud ${lateral}`).toBe(flexStudLateralOffsets.includes(lateral));
    }
  });
});

describe('fast print preview', () => {
  const straight = (run: number): PreviewPose[] => Array.from({ length: 11 }, (_, index) => ({ x: run * index / 10, y: 0, z: 0, heading: 0 }));

  it('puts one brace at every full-tie station and none on the end ties', () => {
    for (const run of [128, 150]) {
      const centres = braceBands(connectorCentre(straight(run), run), run).map(([a, b]) => {
        expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(LITE_BRACE.width, 9);
        return (a.x + b.x) / 2;
      });
      expect(centres).toEqual(tieIntervals(run).slice(1, -1).map(([start, end]) => expect.closeTo((start + end) / 2, 9)));
    }
    const r40 = braceBands(connectorCentre(r40Samples(), R40_RUN), R40_RUN, 'official-curve');
    expect(r40.map(([a]) => a.heading)).toEqual([1, 2, 3].map(index => expect.closeTo(-BRICK_LAYOUT.curveSweep * index / 4, 3)));
  });

  it('spans braces between the rail supports and keeps them within the base height', () => {
    const geometry = braceGeometry(connectorCentre(straight(128), 128), 128)!;
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!, inner = BRICK_TRACK.railGauge / 2 - BRICK_TRACK.baseStringerWidth / 2;
    expect([box.min.y, box.max.y]).toEqual([expect.closeTo(-inner, 4), expect.closeTo(inner, 4)]);
    expect([box.min.z, box.max.z]).toEqual([expect.closeTo(0, 4), expect.closeTo(BRICK_TRACK.baseThickness, 4)]);
    expect([box.min.x, box.max.x]).toEqual([expect.closeTo(32 - LITE_BRACE.width / 2, 4), expect.closeTo(96 + LITE_BRACE.width / 2, 4)]);
    expect(braceGeometry(connectorCentre(straight(32), 32), 32)).toBeNull();
  });

  it('keeps only the end-tie studs', () => {
    const { studLateralOffsets } = BRICK_TRACK.brickAttachment;
    const ends = endStudPoses(straight(128));
    expect(ends.map(stud => Math.round(stud.x)).sort((a, b) => a - b)).toEqual([...studLateralOffsets.map(() => 4), ...studLateralOffsets.map(() => 124)]);
  });

  it('adds full-width ramp sleepers at most 16 mm apart, matching the CAD stations', () => {
    // cad/models/lite.py brace_layout for vertical_transition runs of 200 and 100 mm.
    expect(braceStations(200, 'modular', true)).toEqual([19.95, 32, 48, 64, 76, 88, 100, 112, 124, 136, 152, 168, 180.05]
      .map(value => expect.closeTo(value, 6)));
    expect(braceStations(100, 'modular', true)).toEqual([19.95, 32, 44, 56, 68, 80.05].map(value => expect.closeTo(value, 6)));
    const geometry = braceGeometry(connectorCentre(straight(200), 200), 200, 'modular', true)!;
    geometry.computeBoundingBox();
    expect([geometry.boundingBox!.min.y, geometry.boundingBox!.max.y])
      .toEqual([expect.closeTo(-BRICK_TRACK.bodyWidth / 2, 4), expect.closeTo(BRICK_TRACK.bodyWidth / 2, 4)]);
  });
});
