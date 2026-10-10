import { arc, origin } from '../geometry';
import type { ShapePoint } from '../types';
import { R40, extend, turnoutDefinition } from './turnout-geometry';

/** One leg: an R40 22.5° arc and 32 mm of straight so the two legs' end ties clear each other. */
function leg(hand: number): ShapePoint[] {
  const points = [origin()];
  arc(points, R40, hand*Math.PI/8);
  extend(points, 32);
  return points;
}
const LEG_RUN = R40*Math.PI/8 + 32;

/** Symmetric wye: both legs turn 22.5° on R40 (reversing triangles, T-junctions). */
export const TURNOUT_WYE = turnoutDefinition({
  family: 'turnout_wye', label: 'Wye turnout', params: [],
  states: [{ id: 'left', label: 'Left' }, { id: 'right', label: 'Right' }],
  switches: [{ a: 'left', b: 'right', port: 'in' }], servoSide: () => 1,
  paths: () => [{ id: 'left', from: 'in', to: 'left', points: leg(1), states: ['left'] },
    { id: 'right', from: 'in', to: 'right', points: leg(-1), states: ['right'] }],
  description: () => 'R40 · 22.5° each way',
  run: () => LEG_RUN,
  end: () => leg(1).at(-1)!,
  cad: () => ({})
});
