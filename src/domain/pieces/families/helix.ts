import { tieStations } from '../composite';
import { DEG, compositePiece, studs, type Values } from './composite-piece';

/**
 * Helix section: a graded curve (+ sweep turns left) whose grade runs linearly from `grade0` to `grade1` (%): equal grades
 * climb steadily, unequal grades are a vertical easement (a parabola, radius = length / grade change). It prints flat as
 * a wedge. With `socket` on, its middle full sleeper reaches out into a column lug (composite `socket`): a ring that a
 * stack of printed column tubes passes through, inside or outside the curve, `column_offset` from the centreline.
 */
export const HELIX_COLUMN_OFFSET = 56;
export const HELIX_CURVE = compositePiece({
  family: 'helix_curve', label: 'Helix section', group: 'elevation', curved: true,
  params: [
    { key: 'radius', label: 'Radius', unit: 'mm', min: 320, max: 1472, step: 8, default: 576 },
    { key: 'sweep', label: 'Angle', unit: 'deg', min: -90, max: 90, step: 0.125, default: 11.25 },
    { key: 'grade0', label: 'Grade in', unit: '%', min: -6, max: 6, step: 0.01, default: 3.8 },
    { key: 'grade1', label: 'Grade out', unit: '%', min: -6, max: 6, step: 0.01, default: 3.8 },
    { key: 'socket', label: 'Column lug', unit: '', min: 0, max: 1, step: 1, default: 0,
      options: [{ value: 0, label: 'None' }, { value: 1, label: 'Middle sleeper' }] },
    { key: 'column_side', label: 'Column', unit: '', min: -1, max: 1, step: 2, default: 1, when: { key: 'socket', values: [1] },
      options: [{ value: 1, label: 'Inside the curve' }, { value: -1, label: 'Outside the curve' }] },
    { key: 'column_offset', label: 'Column from centre', unit: 'mm', min: 48, max: 96, step: 1, default: HELIX_COLUMN_OFFSET, when: { key: 'socket', values: [1] } }
  ],
  track: ({ radius, sweep, grade0, grade1 }) => {
    const curvature = Math.sign(sweep) / radius, len = radius * Math.abs(sweep) * DEG;
    return { segments: [{ len, k0: curvature, k1: curvature }], z0: 0, z1: len * (grade0 + grade1) / 200,
      grade0: grade0 / 100, grade1: grade1 / 100, cant0: 0, cant1: 0, vcurve: 0 };
  },
  // The lug sits on the full sleeper nearest the middle; left of travel is the inside of a left-hand curve.
  cadOptions: ({ radius, sweep, socket, column_side: side, column_offset: offset }): Values => {
    if (!socket) return {};
    const length = radius * Math.abs(sweep) * DEG, ties = tieStations(length);
    const middle = ties.reduce((best, tie) => Math.abs(tie - length / 2) < Math.abs(best - length / 2) ? tie : best, ties[0] ?? length / 2);
    return { socket: 1, socket_s: middle, socket_side: Math.sign(sweep || 1) * side, socket_offset: offset };
  },
  // Sections without a lug hang between their neighbours' columns: no generic supports under any helix section.
  ownSupports: () => true,
  description: ({ radius, sweep, grade0, grade1 }) =>
    `R${studs(radius)} · ${Math.abs(sweep)}° · ${grade0 === grade1 ? `${grade0}%` : `${grade0}→${grade1}%`}`,
  signed: 'sweep',
  // Driven the other way the curve turns the other way and the grades reverse; the column stays on the same side of the curve.
  reverseParams: values => ({ ...values, sweep: -values.sweep, grade0: -values.grade1, grade1: -values.grade0 }),
  notes: ['Prints flat as a wedge: the slope is in the top surface, the underside stays flat.',
    'A column lug takes a stack of printed helix column tubes; Print lists them with the track.']
});
