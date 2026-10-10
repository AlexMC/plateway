import type { ParamSpec } from '../types';
import { HAND_PARAM, branchPoints, handOf, paramOf, straightPoints, turnoutDefinition } from './turnout-geometry';

/** Turnout radius family (studs): the official R40 shape with point blades, R56 oblique, R104 and R148 parallel. */
export const TURNOUT_RADII: readonly { value: number; label: string }[] = [
  { value: 40, label: 'R40 · standard 32-stud shape' }, { value: 56, label: 'R56 oblique' },
  { value: 104, label: 'R104 · parallel over 80 studs' }, { value: 148, label: 'R148 · parallel over 96 studs' }];
const PARAMS: readonly ParamSpec[] = [
  { key: 'radius', label: 'Radius', unit: 'studs', min: 40, max: 148, step: 1, default: 40, options: [...TURNOUT_RADII] },
  HAND_PARAM
];

export const TURNOUT_RADIUS = turnoutDefinition({
  family: 'turnout_radius', label: 'Turnout (radius family)', params: PARAMS,
  states: [{ id: 'straight', label: 'Straight' }, { id: 'diverging', label: 'Diverging' }],
  switches: [{ a: 'main', b: 'branch', port: 'in' }], servoSide: piece => -handOf(PARAMS, piece),
  paths: piece => {
    const { points, main } = branchPoints(paramOf(PARAMS, piece, 'radius'), handOf(PARAMS, piece));
    return [{ id: 'main', from: 'in', to: 'out', points: straightPoints(main), states: ['straight'] },
      { id: 'branch', from: 'in', to: 'branch', points, states: ['diverging'] }];
  },
  description: piece => `R${paramOf(PARAMS, piece, 'radius')} · ${branchPoints(paramOf(PARAMS, piece, 'radius'), 1).main / 8}-stud main · ${handOf(PARAMS, piece) > 0 ? 'left' : 'right'}`,
  run: piece => branchPoints(paramOf(PARAMS, piece, 'radius'), 1).main,
  cad: piece => ({ radius: paramOf(PARAMS, piece, 'radius'), hand: handOf(PARAMS, piece) }),
  flip: params => ({ ...params, hand: -(params.hand ?? 1) })
});
