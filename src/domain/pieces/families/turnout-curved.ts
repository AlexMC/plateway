import { arc, origin } from '../geometry';
import type { ParamSpec, ShapePoint } from '../types';
import { HAND_PARAM, R40, R56, extend, handOf, paramOf, turnoutDefinition } from './turnout-geometry';

const PARAMS: readonly ParamSpec[] = [
  { key: 'radius', label: 'Radius', unit: 'studs', min: 40, max: 56, step: 16, default: 40,
    options: [{ value: 40, label: 'R40' }, { value: 56, label: 'R56' }] },
  { key: 'sweep', label: 'Turn', unit: 'deg', min: 45, max: 90, step: 45, default: 90,
    options: [{ value: 45, label: '45°' }, { value: 90, label: '90°' }] },
  HAND_PARAM
];

/**
 * Both routes curve: the inner one is a plain arc, the outer one starts with a straight so the two exits end parallel,
 * 16 studs apart (mirrors turnout.spec_for 'turnout_curved').
 */
function routes(radiusStuds: number, sweepDeg: number, hand: number): { outer: ShapePoint[]; inner: ShapePoint[] } {
  const radius = radiusStuds === 56 ? R56 : R40, sweep = sweepDeg*Math.PI/180;
  const inner = [origin()], outer = [origin()];
  arc(inner, radius, hand*sweep);
  extend(outer, 128/Math.sin(sweep));
  arc(outer, radius, hand*sweep);
  return { outer, inner };
}

export const TURNOUT_CURVED = turnoutDefinition({
  family: 'turnout_curved', label: 'Curved turnout', params: PARAMS,
  states: [{ id: 'straight', label: 'Outer' }, { id: 'diverging', label: 'Inner' }],
  switches: [{ a: 'main', b: 'branch', port: 'in' }], servoSide: piece => -handOf(PARAMS, piece),
  paths: piece => {
    const { outer, inner } = routes(paramOf(PARAMS, piece, 'radius'), paramOf(PARAMS, piece, 'sweep'), handOf(PARAMS, piece));
    return [{ id: 'main', from: 'in', to: 'out', points: outer, states: ['straight'] },
      { id: 'branch', from: 'in', to: 'branch', points: inner, states: ['diverging'] }];
  },
  description: piece => `R${paramOf(PARAMS, piece, 'radius')} · ${paramOf(PARAMS, piece, 'sweep')}° · ${handOf(PARAMS, piece) > 0 ? 'left' : 'right'} · exits 16 studs apart`,
  run: piece => {
    const sweep = paramOf(PARAMS, piece, 'sweep')*Math.PI/180;
    return 128/Math.sin(sweep) + (paramOf(PARAMS, piece, 'radius') === 56 ? R56 : R40)*sweep;
  },
  cad: piece => ({ radius: paramOf(PARAMS, piece, 'radius'), sweep: paramOf(PARAMS, piece, 'sweep'), hand: handOf(PARAMS, piece) }),
  flip: params => ({ ...params, hand: -(params.hand ?? 1) })
});
